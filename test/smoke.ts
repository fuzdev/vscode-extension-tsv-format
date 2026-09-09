// Smoke test for the gitignore-aware skip logic in `format_provider.ts`. Drives
// the REAL provider (with the real `IgnoreStack` WASM matcher) against a mock
// `vscode` + an in-memory file tree, across scenarios that mirror the native
// `tsv format` CLI. A supported, *unformatted* document yields edits when NOT
// ignored and none when ignored, so "no edits" ⟺ ignored. Run via `npm test`.
import { format_css, format_svelte, format_typescript, IgnoreStack } from '@fuzdev/tsv_format_wasm';
import { activate_formatter, deactivate_formatter } from '../src/format_provider.ts';
import * as vscode from 'vscode';

const FOLDER = '/repo';
const formatters = { format_css, format_svelte, format_typescript };
const make_context = () => ({ subscriptions: [] as Array<{ dispose(): void }> });

interface World {
	folder_path: string;
	// raw bytes let a test hand the extension an ignore file that is not valid UTF-8
	files: Map<string, string | Uint8Array>;
	dirs: Set<string>;
	// present files whose read fails (the mock throws a permission error)
	unreadable: Set<string>;
	// when set, the mock's `findFiles` rejects — simulating a web-host virtual-FS error
	find_files_throws?: boolean;
}

/** A file spec value for a file that is present but cannot be read. */
const UNREADABLE = Symbol('unreadable');

/** Build a world from a file spec; auto-derives parent dirs and (optionally) `.git`. */
const build_world = (
	files: Record<string, string | Uint8Array | typeof UNREADABLE>,
	is_repo: boolean,
	find_files_throws = false
): World => {
	const fmap = new Map<string, string | Uint8Array>();
	const unreadable = new Set<string>();
	const dirs = new Set<string>([FOLDER]);
	for (const [rel, content] of Object.entries(files)) {
		if (content === UNREADABLE) {
			fmap.set(`${FOLDER}/${rel}`, '');
			unreadable.add(`${FOLDER}/${rel}`);
		} else {
			fmap.set(`${FOLDER}/${rel}`, content);
		}
		const parts = rel.split('/');
		parts.pop();
		let acc = FOLDER;
		for (const p of parts) {
			acc = `${acc}/${p}`;
			dirs.add(acc);
		}
	}
	if (is_repo) dirs.add(`${FOLDER}/.git`);
	return { folder_path: FOLDER, files: fmap, dirs, unreadable, find_files_throws };
};

const UNFORMATTED_TS = 'const   x=1';
const UNFORMATTED_CSS = 'a{color:red}';
const UNFORMATTED_SVELTE = '<div   >x</div   >';

// typed accessors over the mock's test hooks
const set_world = (w: World): void =>
	(vscode as unknown as { __set_world(w: World): void }).__set_world(w);
const get_provider = (): { provideDocumentFormattingEdits(d: unknown): unknown[] | undefined } =>
	(
		vscode as unknown as {
			__get_provider(): { provideDocumentFormattingEdits(d: unknown): unknown[] | undefined };
		}
	).__get_provider();
const get_status = (): { visible: boolean; text: string } =>
	(
		vscode as unknown as { __get_status_item(): { visible: boolean; text: string } }
	).__get_status_item();
const fire_close = (doc: unknown): void =>
	(vscode as unknown as { __fire_close(d: unknown): void }).__fire_close(doc);
/** Every line written to the Output channel since the current world was installed. */
const output_lines = (): string[] =>
	(vscode as unknown as { __get_output_lines(): string[] }).__get_output_lines();
/** Fire the ignore-file watcher for `rel` (a folder reload, off the save path). */
const fire_ignore_change = (rel: string): void =>
	(vscode as unknown as { __fire_ignore_change(rel: string): void }).__fire_ignore_change(rel);
/** Let a watcher-triggered reload (a chain of mock-fs awaits) run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The hint texts come from the package itself — the extension never templates
// them, so the test asserts the shared matcher's exact line rather than a phrase.
const with_stack = <T>(f: (stack: IgnoreStack) => T): T => {
	const stack = new IgnoreStack();
	try {
		return f(stack);
	} finally {
		stack.free();
	}
};
const shadow_hint = (dir: string): string =>
	with_stack((s) => s.prettierignore_shadowed_warning(dir, true, true, true)) ?? '';
const outside_repo_hint = (dir: string): string =>
	with_stack((s) => s.prettierignore_outside_repo_warning(dir, false, true, false)) ?? '';
/** The CLI's line for a present-but-unreadable ignore file (`cli.js` `read_ignore_file`). */
const unreadable_hint = (display_path: string, reason: string): string =>
	`could not read ${display_path} (${reason}); its ignore rules are not applied`;
const PERMISSION_REASON = (rel: string): string => `EACCES: permission denied, open '${FOLDER}/${rel}'`;
/** The Output lines are `[<iso timestamp>] <hint>`; compare on the hint alone. */
const hint_lines = (): string[] => output_lines().map((line) => line.replace(/^\[[^\]]*\] /, ''));
const expect_hints = (label: string, expected: string[]): void =>
	expect(`${label}: ${JSON.stringify(hint_lines())}`, same_lines(hint_lines(), expected));
const same_lines = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/** A minimal mock `TextDocument` for one path / language / content. */
const make_doc = (rel: string, languageId: string, content: string) => ({
	uri: vscode.Uri.file(`${FOLDER}/${rel}`),
	languageId,
	fileName: `${FOLDER}/${rel}`,
	getText: () => content,
	positionAt: (n: number) => ({ line: 0, character: n })
});

let pass = 0;
let fail = 0;
const check = (label: string, ignored: boolean, expected: boolean): void => {
	if (ignored === expected) pass++;
	else {
		fail++;
		console.log(`FAIL ${label} (ignored=${ignored}, want=${expected})`);
	}
};
const expect = (label: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`FAIL ${label}`);
	}
};

const run_scenario = async (
	name: string,
	files: Record<string, string | Uint8Array | typeof UNREADABLE>,
	is_repo: boolean,
	cases: Array<[string, string, boolean]>,
	find_files_throws = false,
	// runs while the extension is still active, with the world for in-place edits —
	// the one way to exercise a watcher reload against the cached state
	while_active?: (world: World) => Promise<void>
): Promise<void> => {
	const world = build_world(files, is_repo, find_files_throws);
	set_world(world);
	const ctx = make_context();
	// activation awaits the initial ignore-file load, so the cache is ready here
	await activate_formatter(ctx as never, formatters, IgnoreStack as never);
	const provider = get_provider();
	for (const [rel, languageId, expected] of cases) {
		const content =
			languageId === 'css'
				? UNFORMATTED_CSS
				: languageId === 'svelte'
					? UNFORMATTED_SVELTE
					: UNFORMATTED_TS;
		const edits = provider.provideDocumentFormattingEdits(make_doc(rel, languageId, content)) ?? [];
		check(`${name}: ${rel}`, edits.length === 0, expected);
	}
	if (while_active) await while_active(world);
	deactivate_formatter();
};

// Dispatch + parse-error + status behavior, independent of the ignore files: a
// loose folder with no ignore files (nothing pruned), all docs at the root.
const run_dispatch_cases = async (): Promise<void> => {
	set_world(build_world({}, false));
	const ctx = make_context();
	await activate_formatter(ctx as never, formatters, IgnoreStack as never);
	const provider = get_provider();
	const status = get_status();
	const edits = (doc: unknown): unknown[] => provider.provideDocumentFormattingEdits(doc) ?? [];

	// supported + unformatted -> one full-document edit
	expect(
		'dispatch: ts unformatted -> edits',
		edits(make_doc('app.ts', 'typescript', UNFORMATTED_TS)).length === 1
	);
	// already-formatted -> no edits (a clean file is never marked dirty)
	expect(
		'dispatch: ts already formatted -> no edits',
		edits(make_doc('app.ts', 'typescript', format_typescript(UNFORMATTED_TS))).length === 0
	);
	// css dispatches too
	expect(
		'dispatch: css unformatted -> edits',
		edits(make_doc('app.css', 'css', UNFORMATTED_CSS)).length === 1
	);
	// unsupported languageId, no extension fallback -> no edits
	expect(
		'dispatch: json unsupported -> no edits',
		edits(make_doc('data.json', 'json', UNFORMATTED_TS)).length === 0
	);
	// `.svelte` extension fallback when the languageId isn't `svelte` (Svelte ext absent)
	expect(
		'dispatch: .svelte fallback -> edits',
		edits(make_doc('weird.svelte', 'plaintext', UNFORMATTED_SVELTE)).length === 1
	);

	// parse error -> no edits (file left unchanged) + the status indicator is shown
	const bad = make_doc('bad.ts', 'typescript', 'const x = (');
	expect('dispatch: parse error -> no edits', edits(bad).length === 0);
	expect('dispatch: parse error -> status shown', status.visible && status.text.includes('tsv'));
	// closing the failing document clears the indicator
	fire_close(bad);
	expect('dispatch: close clears status', !status.visible);

	deactivate_formatter();
};

const main = async (): Promise<void> => {
	// 0. dispatch / parse-error / status behavior (not ignore-file related)
	await run_dispatch_cases();

	// 1. repo + .gitignore: gitignored dist/ skipped; non-gitignored build/ formatted
	//    (heuristic OFF in a repo with a .gitignore)
	await run_scenario(
		'gitignore prunes dist, heuristic off for build',
		{
			'.gitignore': 'dist/\n',
			'dist/out.ts': UNFORMATTED_TS,
			'build/src.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS
		},
		true,
		[
			['dist/out.ts', 'typescript', true],
			['build/src.ts', 'typescript', false],
			['src/app.ts', 'typescript', false]
		]
	);
	// no .prettierignore anywhere: nothing is unread, so nothing is logged
	expect_hints('hint: none for a plain gitignore repo', []);

	// 2. .formatignore shadows .prettierignore (repo)
	await run_scenario(
		'formatignore shadows prettierignore',
		{
			'.prettierignore': 'p_only.ts\n',
			'.formatignore': 'generated/\n',
			'generated/skip.ts': UNFORMATTED_TS,
			'p_only.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		true,
		[
			['generated/skip.ts', 'typescript', true],
			['p_only.ts', 'typescript', false],
			['keep.ts', 'typescript', false]
		],
		false,
		async (world) => {
			// the shadowing is silent in behavior, so the Output channel is where a
			// user can see it — the shared matcher's exact line, as the CLI's stderr
			expect_hints('hint: the shadowed root .prettierignore', [shadow_hint('repo')]);
			// a reload that changes nothing (any ignore-file save fires the watcher)
			// must not repeat the line
			fire_ignore_change('.gitignore');
			await settle();
			expect_hints('hint: an unchanged reload logs nothing new', [shadow_hint('repo')]);
			// fixing the misconfiguration (the shadow removed) is silence, not a line
			world.files.delete(`${FOLDER}/.formatignore`);
			fire_ignore_change('.formatignore');
			await settle();
			expect_hints('hint: a resolved shadow logs nothing', [shadow_hint('repo')]);
			// and re-introducing it is a change, so it is reported once more
			world.files.set(`${FOLDER}/.formatignore`, 'generated/\n');
			fire_ignore_change('.formatignore');
			await settle();
			expect_hints('hint: a re-introduced shadow is reported again', [
				shadow_hint('repo'),
				shadow_hint('repo')
			]);
		}
	);

	// 3. hierarchical .gitignore re-include
	await run_scenario(
		'hierarchical gitignore re-include',
		{
			'.gitignore': '*.gen.ts\n',
			'sub/.gitignore': '!keep.gen.ts\n',
			'sub/keep.gen.ts': UNFORMATTED_TS,
			'sub/drop.gen.ts': UNFORMATTED_TS,
			'a.gen.ts': UNFORMATTED_TS
		},
		true,
		[
			['sub/keep.gen.ts', 'typescript', false],
			['sub/drop.gen.ts', 'typescript', true],
			['a.gen.ts', 'typescript', true]
		]
	);
	expect_hints('hint: none for hierarchical gitignores', []);

	// 4. hierarchical .formatignore (nested layer + deeper re-include)
	await run_scenario(
		'hierarchical formatignore',
		{
			'.formatignore': '*.snap.ts\n',
			'src/.formatignore': '!keep.snap.ts\n',
			'a.snap.ts': UNFORMATTED_TS,
			'src/keep.snap.ts': UNFORMATTED_TS,
			'src/drop.snap.ts': UNFORMATTED_TS
		},
		true,
		[
			['a.snap.ts', 'typescript', true],
			['src/keep.snap.ts', 'typescript', false],
			['src/drop.snap.ts', 'typescript', true]
		]
	);

	// 4b. hierarchical .prettierignore (repo): a nested .prettierignore is honored
	//     like .formatignore (subskip.ts pruned), a deeper `!` re-includes over a
	//     shallower layer (keep.gen.ts), and a sibling .formatignore shadows only its
	//     own directory's .prettierignore (b/.formatignore beats b/.prettierignore)
	await run_scenario(
		'hierarchical prettierignore',
		{
			'.prettierignore': '*.gen.ts\n',
			'sub/.prettierignore': '!keep.gen.ts\nsubskip.ts\n',
			'b/.formatignore': 'bf.ts\n',
			'b/.prettierignore': 'bp.ts\n',
			'a.gen.ts': UNFORMATTED_TS,
			'sub/keep.gen.ts': UNFORMATTED_TS,
			'sub/drop.gen.ts': UNFORMATTED_TS,
			'sub/subskip.ts': UNFORMATTED_TS,
			'sub/keep.ts': UNFORMATTED_TS,
			'b/bf.ts': UNFORMATTED_TS,
			'b/bp.ts': UNFORMATTED_TS
		},
		true,
		[
			['a.gen.ts', 'typescript', true], // root .prettierignore *.gen.ts
			['sub/keep.gen.ts', 'typescript', false], // deeper sub/.prettierignore !keep.gen.ts re-includes
			['sub/drop.gen.ts', 'typescript', true], // still ignored by root *.gen.ts
			['sub/subskip.ts', 'typescript', true], // nested .prettierignore honored hierarchically
			['sub/keep.ts', 'typescript', false],
			['b/bf.ts', 'typescript', true], // b/.formatignore
			['b/bp.ts', 'typescript', false] // b/.prettierignore shadowed by sibling b/.formatignore
		]
	);
	// only b/ holds both files: one hint, naming that directory, and none for the
	// root or sub/ .prettierignore, which are read
	expect_hints('hint: exactly the shadowed b/.prettierignore', [shadow_hint('repo/b')]);

	// 5. loose (non-repo): .formatignore honored; .gitignore/.prettierignore NOT read;
	//    heuristic ON (build/dist/hidden skipped)
	await run_scenario(
		'loose: formatignore + heuristic, gitignore/prettierignore not read',
		{
			'.formatignore': 'gen/\n',
			'.gitignore': 'src/\n',
			'.prettierignore': 'keep.ts\n',
			'gen/out.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS,
			'build/b.ts': UNFORMATTED_TS,
			'dist/d.ts': UNFORMATTED_TS,
			'.hidden/h.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		false,
		[
			['gen/out.ts', 'typescript', true],
			['src/app.ts', 'typescript', false],
			['build/b.ts', 'typescript', true],
			['dist/d.ts', 'typescript', true],
			['.hidden/h.ts', 'typescript', true],
			['keep.ts', 'typescript', false]
		]
	);
	// the sibling .formatignore already explains the unread .prettierignore: no hint
	expect_hints('hint: none when a .formatignore sits beside it', []);

	// 5b. loose (non-repo) with a LONE .prettierignore: tsv reads only .formatignore
	//     outside a repo, so those rules go unread — the one case the outside-repo hint
	//     fires (a sibling .formatignore would already explain it, as in scenario 5)
	await run_scenario(
		'loose: lone prettierignore is unread',
		{
			'.prettierignore': 'keep.ts\n',
			'keep.ts': UNFORMATTED_TS
		},
		false,
		[['keep.ts', 'typescript', false]]
	);
	expect_hints('hint: the lone .prettierignore outside a repo', [outside_repo_hint('repo')]);

	// 6. loose: a .formatignore `!build/` re-includes over the heuristic
	await run_scenario(
		'loose: !build/ re-includes over heuristic',
		{
			'.formatignore': '!build/\n',
			'build/out.ts': UNFORMATTED_TS,
			'dist/d.ts': UNFORMATTED_TS,
			'src.ts': UNFORMATTED_TS
		},
		false,
		[
			['build/out.ts', 'typescript', false],
			['dist/d.ts', 'typescript', true],
			['src.ts', 'typescript', false]
		]
	);

	// 7. safety nets: node_modules always skipped (repo)
	await run_scenario(
		'safety nets: node_modules skipped',
		{
			'.gitignore': '# nothing\n',
			'node_modules/pkg/index.ts': UNFORMATTED_TS,
			'src/app.css': UNFORMATTED_CSS
		},
		true,
		[
			['node_modules/pkg/index.ts', 'typescript', true],
			['src/app.css', 'css', false]
		]
	);

	// 8. file under a gitignored directory is skipped (ancestor prune); svelte dispatch
	await run_scenario(
		'file under gitignored dir + svelte dispatch',
		{
			'.gitignore': 'vendored/\n',
			'vendored/v.svelte': '<div   >x</div   >',
			'app.svelte': '<div   >x</div   >'
		},
		true,
		[
			['vendored/v.svelte', 'svelte', true],
			['app.svelte', 'svelte', false]
		]
	);

	// 9. findFiles rejects (web-host virtual-FS error): activation must still
	//    succeed and the provider register. Degraded mode = the folder-root ignore
	//    files (read directly, not via findFiles) + the always-on safety-net /
	//    build-output pruning still apply; only NESTED ignore files are missed —
	//    never "format everything". (If activation rejected, this scenario would
	//    throw before any check ran.)
	await run_scenario(
		'findFiles rejects: root ignore + safety nets survive, nested missed',
		{
			'.gitignore': 'dist/\n',
			'sub/.gitignore': 'nested.ts\n',
			'dist/out.ts': UNFORMATTED_TS,
			'node_modules/pkg/index.ts': UNFORMATTED_TS,
			'sub/nested.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS
		},
		true,
		[
			['dist/out.ts', 'typescript', true], // root .gitignore honored despite findFiles failing
			['node_modules/pkg/index.ts', 'typescript', true], // safety net always applies
			['sub/nested.ts', 'typescript', false], // nested .gitignore missed (degraded) -> formats
			['src/app.ts', 'typescript', false] // normal source
		],
		true
	);

	// 10. present-but-UNREADABLE ignore files (repo): CLI parity. An unreadable file
	//     is warned and its rules dropped, never silently treated as absent; an
	//     unreadable .formatignore still SHADOWS its sibling .prettierignore (precedence
	//     is by presence, not readability — a read error can't demote tsv's native
	//     file to prettier's); an unreadable .gitignore leaves the build-output
	//     heuristic ON (no anchor); a shadowed .prettierignore is never read, so it
	//     earns the shadow hint alone, while an unshadowed unreadable one is warned
	const INVALID_UTF8 = new Uint8Array([0x73, 0x75, 0x62, 0x2f, 0xff, 0xfe, 0x0a]);
	await run_scenario(
		'unreadable ignore files: warned, dropped, presence still shadows',
		{
			'.gitignore': UNREADABLE,
			'.formatignore': UNREADABLE,
			'.prettierignore': 'p_only.ts\n',
			'sub/.formatignore': INVALID_UTF8,
			'sub/.prettierignore': 'sub_p.ts\n',
			'b/.prettierignore': UNREADABLE,
			'c/.formatignore': 'c_f.ts\n',
			'c/.prettierignore': UNREADABLE,
			'p_only.ts': UNFORMATTED_TS,
			'sub/sub_p.ts': UNFORMATTED_TS,
			'sub/keep.ts': UNFORMATTED_TS,
			'b/keep.ts': UNFORMATTED_TS,
			'c/c_f.ts': UNFORMATTED_TS,
			'dist/out.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		true,
		[
			['p_only.ts', 'typescript', false], // root .prettierignore shadowed by the unreadable .formatignore
			['sub/sub_p.ts', 'typescript', false], // same, by the invalid-UTF-8 sub/.formatignore
			['sub/keep.ts', 'typescript', false],
			['b/keep.ts', 'typescript', false], // b/.prettierignore unreadable: rules dropped
			['c/c_f.ts', 'typescript', true], // c/.formatignore readable and applied
			['dist/out.ts', 'typescript', true], // heuristic ON: the root .gitignore is unreadable, no anchor
			['keep.ts', 'typescript', false]
		]
	);
	expect_hints(
		'hint: every unreadable file warned once, presence-keyed shadows, no read of a shadowed one',
		[
			unreadable_hint('repo/.formatignore', PERMISSION_REASON('.formatignore')),
			unreadable_hint('repo/.gitignore', PERMISSION_REASON('.gitignore')),
			unreadable_hint('repo/b/.prettierignore', PERMISSION_REASON('b/.prettierignore')),
			unreadable_hint('repo/sub/.formatignore', 'invalid UTF-8'),
			shadow_hint('repo'),
			shadow_hint('repo/c'),
			shadow_hint('repo/sub')
		].sort()
	);

	// 10b. loose (non-repo) with an unreadable root .formatignore beside a
	//      .prettierignore: the .formatignore is warned, and its PRESENCE already
	//      explains the unread .prettierignore, so the outside-repo hint stays quiet
	await run_scenario(
		'loose: unreadable formatignore is warned and still explains the prettierignore',
		{
			'.formatignore': UNREADABLE,
			'.prettierignore': 'keep.ts\n',
			'keep.ts': UNFORMATTED_TS
		},
		false,
		[['keep.ts', 'typescript', false]]
	);
	expect_hints('hint: the unreadable .formatignore alone', [
		unreadable_hint('repo/.formatignore', PERMISSION_REASON('.formatignore'))
	]);

	console.log(`${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
};

void main();
