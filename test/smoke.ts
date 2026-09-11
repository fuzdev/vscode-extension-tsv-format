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
	// files that are symbolic links: the mock's `stat` sets the link bit, and a read
	// follows the link to the content
	symlinks: Set<string>;
	// when set, the mock's not-found errors carry no `code` (a provider that reports
	// a missing file with a bare error) — absence must still be silent
	bare_not_found_errors?: boolean;
	// when set, every `readFile` takes its bytes and then waits on this — holds a
	// reload in flight so a later-started one can finish first
	read_gate?: Promise<void>;
	// when set, the mock's `findFiles` rejects — simulating a web-host virtual-FS error
	find_files_throws?: boolean;
	// further workspace folders nested under the main one (a monorepo workspace with the
	// repo root and a package folder both open)
	nested_folders?: string[];
}

/** A file spec value for a file that is present but cannot be read. */
const UNREADABLE = Symbol('unreadable');

/** A file spec value for a symbolic link whose target holds `content`. */
const SYMLINK = Symbol('symlink');
type SymlinkSpec = { [SYMLINK]: string };
const symlink_to = (content: string): SymlinkSpec => ({ [SYMLINK]: content });

/** What a file spec can hold. */
type FileSpec = string | Uint8Array | typeof UNREADABLE | SymlinkSpec;

/** Build a world from a file spec; auto-derives parent dirs and (optionally) `.git`. */
const build_world = (
	files: Record<string, FileSpec>,
	is_repo: boolean,
	find_files_throws = false,
	bare_not_found_errors = false
): World => {
	const fmap = new Map<string, string | Uint8Array>();
	const unreadable = new Set<string>();
	const symlinks = new Set<string>();
	const dirs = new Set<string>([FOLDER]);
	for (const [rel, content] of Object.entries(files)) {
		if (content === UNREADABLE) {
			fmap.set(`${FOLDER}/${rel}`, '');
			unreadable.add(`${FOLDER}/${rel}`);
		} else if (typeof content === 'object' && SYMLINK in content) {
			fmap.set(`${FOLDER}/${rel}`, content[SYMLINK]);
			symlinks.add(`${FOLDER}/${rel}`);
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
	return {
		folder_path: FOLDER,
		files: fmap,
		dirs,
		unreadable,
		symlinks,
		find_files_throws,
		bare_not_found_errors
	};
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
/** Deliver a watcher event for `rel` to every live watcher whose glob matches it. */
const fire_watcher = (kind: 'create' | 'change' | 'delete', rel: string): void =>
	(vscode as unknown as { __fire_watcher(k: string, r: string): void }).__fire_watcher(kind, rel);
const watcher_patterns = (): string[] =>
	(vscode as unknown as { __watcher_patterns(): string[] }).__watcher_patterns();
const fire_workspace_folders_changed = (kind: 'added' | 'removed'): void =>
	(
		vscode as unknown as { __fire_workspace_folders_changed(k: string): void }
	).__fire_workspace_folders_changed(kind);
/** Whether the live provider skips `rel` (no edits for unformatted content). */
const is_ignored = (rel: string): boolean =>
	(get_provider().provideDocumentFormattingEdits(make_doc(rel, 'typescript', UNFORMATTED_TS)) ?? [])
		.length === 0;
const IGNORE_GLOB = '**/.{gitignore,prettierignore,formatignore}';
const GIT_PATTERN = '<folder>/.git';
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
/** The CLI's line for a symlinked `.gitignore` (`tsv_discover::gitignore_symlink_warning`),
 * restated as the extension restates it: the pinned binding predates the method. */
const symlink_hint = (display_path: string): string =>
	`${display_path} is a symbolic link, which git does not follow in a working tree; its ignore rules are not applied`;
const permission_reason = (rel: string): string =>
	`EACCES: permission denied, open '${FOLDER}/${rel}'`;
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
	files: Record<string, FileSpec>,
	is_repo: boolean,
	cases: Array<[string, string, boolean]>,
	find_files_throws = false,
	// runs while the extension is still active, with the world for in-place edits —
	// the one way to exercise a watcher reload against the cached state
	while_active?: (world: World) => Promise<void>,
	bare_not_found_errors = false
): Promise<void> => {
	const world = build_world(files, is_repo, find_files_throws, bare_not_found_errors);
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
	// VS Code disposes the context's subscriptions on deactivation — do the same, and
	// hold the extension to leaving no watcher behind (the per-folder `.git` ones are
	// its own map, disposed through a subscription of their own)
	for (const subscription of ctx.subscriptions) subscription.dispose();
	expect(`${name}: no watcher outlives deactivation`, watcher_patterns().length === 0);
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
			fire_watcher('change', '.gitignore');
			await settle();
			expect_hints('hint: an unchanged reload logs nothing new', [shadow_hint('repo')]);
			// fixing the misconfiguration (the shadow removed) is silence, not a line
			world.files.delete(`${FOLDER}/.formatignore`);
			fire_watcher('change', '.formatignore');
			await settle();
			expect_hints('hint: a resolved shadow logs nothing', [shadow_hint('repo')]);
			// and re-introducing it is a change, so it is reported once more
			world.files.set(`${FOLDER}/.formatignore`, 'generated/\n');
			fire_watcher('change', '.formatignore');
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

	// 7. safety nets: node_modules always skipped (repo). Ignore files UNDER a safety
	//    net are never read by the CLI (it never descends), so they earn no hint here
	//    either — the listing drops them (it is unexcluded, so `files.exclude` can't
	//    hide an ignore file the CLI reads; the safety nets are filtered by hand)
	await run_scenario(
		'safety nets: node_modules skipped',
		{
			'.gitignore': '# nothing\n',
			'node_modules/pkg/index.ts': UNFORMATTED_TS,
			'node_modules/pkg/.formatignore': UNREADABLE,
			'node_modules/pkg/.prettierignore': 'x\n',
			'.hg/.formatignore': 'x\n',
			'.hg/.prettierignore': 'x\n',
			'src/app.css': UNFORMATTED_CSS
		},
		true,
		[
			['node_modules/pkg/index.ts', 'typescript', true],
			['src/app.css', 'css', false]
		]
	);
	expect_hints('hint: none for ignore files under a safety net', []);

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
			unreadable_hint('repo/.formatignore', permission_reason('.formatignore')),
			unreadable_hint('repo/.gitignore', permission_reason('.gitignore')),
			unreadable_hint('repo/b/.prettierignore', permission_reason('b/.prettierignore')),
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
		unreadable_hint('repo/.formatignore', permission_reason('.formatignore'))
	]);

	// 10c. symlinked .gitignore files (repo): git does not follow one in a working tree, so
	//      the CLI warns and applies none of the linked rules — they skip nothing, and with
	//      no anchor the build-output heuristic stays ON — while a symlinked .formatignore
	//      or .prettierignore is read through, as prettier reads its own. The root files
	//      take the explicit folder-root read and the nested ones the listing, so both
	//      paths are covered under both presence rules.
	await run_scenario(
		'symlinked .gitignore: warned and not applied; the tsv layer reads through links',
		{
			'.gitignore': symlink_to('g.ts\n'),
			'.prettierignore': symlink_to('p.ts\n'),
			'sub/.gitignore': symlink_to('s.ts\n'),
			'sub/.formatignore': symlink_to('f.ts\n'),
			'g.ts': UNFORMATTED_TS,
			'p.ts': UNFORMATTED_TS,
			'sub/s.ts': UNFORMATTED_TS,
			'sub/f.ts': UNFORMATTED_TS,
			'dist/out.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		true,
		[
			['g.ts', 'typescript', false], // the root link's rules are not applied
			['p.ts', 'typescript', true], // the linked root .prettierignore is read through
			['sub/s.ts', 'typescript', false], // nor the nested link's
			['sub/f.ts', 'typescript', true], // the linked .formatignore is read through
			['dist/out.ts', 'typescript', true], // heuristic ON: no .gitignore anchor
			['keep.ts', 'typescript', false]
		]
	);
	expect_hints(
		'hint: each symlinked .gitignore once',
		[symlink_hint('repo/.gitignore'), symlink_hint('repo/sub/.gitignore')].sort()
	);

	// 10d. a DIRECTORY named like an ignore file is not one (repo): it holds no rules, so
	//      it is absent and silent, as on the CLI — no "could not read" warning, no
	//      .formatignore presence shadowing the root .prettierignore, and no .gitignore
	//      anchor turning the build-output heuristic off. Only the folder-root probe can
	//      meet one (the listing holds files alone).
	await run_scenario(
		'a directory named like an ignore file is absent',
		{
			// a file inside each, so the world derives the directory
			'.gitignore/x': '',
			'.formatignore/x': '',
			'.prettierignore': 'p.ts\n',
			'p.ts': UNFORMATTED_TS,
			'dist/out.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		true,
		[
			['p.ts', 'typescript', true], // the root .prettierignore is read: nothing shadows it
			['dist/out.ts', 'typescript', true], // heuristic ON: no .gitignore anchor
			['keep.ts', 'typescript', false]
		]
	);
	expect_hints('hint: none for directories named like ignore files', []);

	// 10e. loose (non-repo): a symlinked .gitignore is not read at all outside a repo, so
	//      it earns no warning; a symlinked .formatignore is still read through; and a
	//      DIRECTORY named .prettierignore is no .prettierignore, so the outside-repo hint
	//      has nothing to report
	await run_scenario(
		'loose: no symlink warning, links read through, a .prettierignore directory is silent',
		{
			'.gitignore': symlink_to('g.ts\n'),
			'.prettierignore/x': '',
			'sub/.formatignore': symlink_to('f.ts\n'),
			'g.ts': UNFORMATTED_TS,
			'sub/f.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		false,
		[
			['g.ts', 'typescript', false], // .gitignore is not read outside a repo
			['sub/f.ts', 'typescript', true], // the linked .formatignore is read through
			['keep.ts', 'typescript', false]
		]
	);
	expect_hints('hint: none outside a repo for a linked .gitignore or a .prettierignore dir', []);

	// 10f. hints are the CLI's own: `tsv format <folder>` never descends into a directory a
	//      rule excludes, so it never reads — nor warns about — the ignore files inside
	//      one. The shadowed pair, the unreadable .gitignore and the symlinked one under
	//      the gitignored vendor/ stay silent, while the same shadow in a walked directory
	//      is reported
	await run_scenario(
		'hints: none for ignore files inside a directory a rule excludes',
		{
			'.gitignore': 'vendor/\n',
			'vendor/.formatignore': 'a.ts\n',
			'vendor/.prettierignore': '',
			'vendor/sub/.gitignore': UNREADABLE,
			'vendor/lnk/.gitignore': symlink_to('*\n'),
			'vendor/a.ts': UNFORMATTED_TS,
			'ok/.formatignore': '',
			'ok/.prettierignore': '',
			'ok/a.ts': UNFORMATTED_TS
		},
		true,
		[
			['vendor/a.ts', 'typescript', true],
			['ok/a.ts', 'typescript', false]
		]
	);
	expect_hints("hint: only the walked directory's shadow", [shadow_hint('repo/ok')]);

	// 10g. the same for a directory the build-output heuristic prunes (no .gitignore in
	//      scope, so it is on): dist/ and a hidden directory keep their ignore files'
	//      trouble to themselves, while an unreadable .formatignore in a walked directory
	//      is warned
	await run_scenario(
		'hints: none for ignore files inside a directory the heuristic prunes',
		{
			'dist/.formatignore': '',
			'dist/.prettierignore': '',
			'.cache/.formatignore': UNREADABLE,
			'src/.formatignore': UNREADABLE,
			'src/a.ts': UNFORMATTED_TS,
			'dist/out.ts': UNFORMATTED_TS
		},
		true,
		[
			['src/a.ts', 'typescript', false],
			['dist/out.ts', 'typescript', true]
		]
	);
	expect_hints("hint: only the walked directory's unreadable file", [
		unreadable_hint('repo/src/.formatignore', permission_reason('src/.formatignore'))
	]);

	// 11. the `.git` watcher flips the regime: `git init` in an open loose folder
	//     starts honoring .prettierignore and retires the outside-repo hint (a set
	//     that shrank to nothing is silence); removing .git reverses it and the hint
	//     is a change again, so it is logged once more
	await run_scenario(
		'.git appearing / vanishing flips the regime',
		{
			'.prettierignore': 'p.ts\n',
			'p.ts': UNFORMATTED_TS,
			'keep.ts': UNFORMATTED_TS
		},
		false,
		[
			['p.ts', 'typescript', false], // loose: .prettierignore not read
			['keep.ts', 'typescript', false]
		],
		false,
		async (world) => {
			expect(
				'watchers: the ignore glob and the folder .git entry',
				same_lines(watcher_patterns().sort(), [IGNORE_GLOB, GIT_PATTERN].sort())
			);
			expect_hints('hint: outside-repo before git init', [outside_repo_hint('repo')]);
			world.dirs.add(`${FOLDER}/.git`);
			fire_watcher('create', '.git');
			await settle();
			expect('git init: .prettierignore now honored', is_ignored('p.ts'));
			expect_hints('hint: nothing new after git init', [outside_repo_hint('repo')]);
			world.dirs.delete(`${FOLDER}/.git`);
			fire_watcher('delete', '.git');
			await settle();
			expect('rm .git: back to the loose regime', !is_ignored('p.ts'));
			expect_hints('hint: outside-repo reported again after rm .git', [
				outside_repo_hint('repo'),
				outside_repo_hint('repo')
			]);
		}
	);

	// 12. two reloads in flight: the EARLIER-started one finishes last (its reads are
	//     held at the gate after taking the old bytes) and must not overwrite the
	//     later one's state — latest-started wins, whatever order they finish in
	await run_scenario(
		'a stale reload finishing last does not win',
		{
			'.formatignore': 'a.ts\n',
			'a.ts': UNFORMATTED_TS,
			'b.ts': UNFORMATTED_TS
		},
		true,
		[
			['a.ts', 'typescript', true],
			['b.ts', 'typescript', false]
		],
		false,
		async (world) => {
			let release = (): void => {};
			world.read_gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			fire_watcher('change', '.formatignore'); // reload A: reads `a.ts`, then waits
			await settle();
			world.read_gate = undefined;
			world.files.set(`${FOLDER}/.formatignore`, 'b.ts\n');
			fire_watcher('change', '.formatignore'); // reload B: reads `b.ts`, finishes
			await settle();
			expect('race: the later reload landed', is_ignored('b.ts') && !is_ignored('a.ts'));
			release();
			await settle();
			expect('race: the earlier reload was discarded', is_ignored('b.ts') && !is_ignored('a.ts'));
		}
	);

	// 13. workspace folder removed / re-added: its state and .git watcher go with it
	//     and come back with the reload
	await run_scenario(
		'folder removed and re-added',
		{
			'.gitignore': 'dist/\n',
			'dist/out.ts': UNFORMATTED_TS
		},
		true,
		[['dist/out.ts', 'typescript', true]],
		false,
		async (world) => {
			// an ignore file under node_modules can't change the state (findFiles never
			// looks there), so its event must not cost a reload: plant a change the
			// reload WOULD pick up, fire the node_modules event, and expect nothing
			world.files.set(`${FOLDER}/.formatignore`, 'planted.ts\n');
			world.files.set(`${FOLDER}/planted.ts`, UNFORMATTED_TS);
			world.files.set(`${FOLDER}/node_modules/pkg/.gitignore`, '*\n');
			world.dirs.add(`${FOLDER}/node_modules`);
			world.dirs.add(`${FOLDER}/node_modules/pkg`);
			fire_watcher('change', 'node_modules/pkg/.gitignore');
			await settle();
			expect('node_modules event: no reload', !is_ignored('planted.ts'));
			fire_watcher('change', '.formatignore');
			await settle();
			expect('a real event: reloaded', is_ignored('planted.ts'));

			fire_workspace_folders_changed('removed');
			expect('removed: state dropped, nothing ignored', !is_ignored('dist/out.ts'));
			expect('removed: its .git watcher disposed', same_lines(watcher_patterns(), [IGNORE_GLOB]));
			fire_workspace_folders_changed('added');
			await settle();
			expect('re-added: state reloaded', is_ignored('dist/out.ts'));
			expect(
				're-added: .git watcher back',
				same_lines(watcher_patterns().sort(), [IGNORE_GLOB, GIT_PATTERN].sort())
			);
		}
	);

	// 14. a provider whose missing-file error carries no code: the explicit
	//     folder-root reads of files that are simply not there must stay silent —
	//     absence is a stat question, never an error-shape guess
	await run_scenario(
		'bare not-found errors: absent root files stay silent',
		{
			'.gitignore': 'dist/\n',
			'dist/out.ts': UNFORMATTED_TS,
			'src/app.ts': UNFORMATTED_TS
		},
		true,
		[
			['dist/out.ts', 'typescript', true],
			['src/app.ts', 'typescript', false]
		],
		false,
		async () => {
			expect_hints('hint: none for absent root files', []);
		},
		true
	);

	// 15. a folder's FIRST load still in flight when the folder is removed and added
	//     again: the re-add's load must not share a generation with the stale one
	//     (a per-folder counter reset on removal would hand both the number 1)
	await run_scenario(
		'removed and re-added while its first load is in flight',
		{
			'.formatignore': 'a.ts\n',
			'a.ts': UNFORMATTED_TS,
			'b.ts': UNFORMATTED_TS
		},
		true,
		[['a.ts', 'typescript', true]],
		false,
		async (world) => {
			fire_workspace_folders_changed('removed');
			let release = (): void => {};
			world.read_gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			fire_workspace_folders_changed('added'); // load A: the folder's first, holds
			await settle();
			world.read_gate = undefined;
			world.files.set(`${FOLDER}/.formatignore`, 'b.ts\n');
			fire_workspace_folders_changed('removed');
			fire_workspace_folders_changed('added'); // load B: also the folder's first
			await settle();
			expect('re-add race: the later load landed', is_ignored('b.ts') && !is_ignored('a.ts'));
			release();
			await settle();
			expect(
				're-add race: the stale first load was discarded',
				is_ignored('b.ts') && !is_ignored('a.ts')
			);
		}
	);

	// 16. a `.git` FILE (a worktree's or submodule's) counts as in-repo, as on both CLIs
	await run_scenario(
		'.git file counts as in-repo',
		{
			'.git': 'gitdir: ../.git/worktrees/x\n',
			'.gitignore': 'dist/\n',
			'dist/out.ts': UNFORMATTED_TS,
			'build/b.ts': UNFORMATTED_TS
		},
		false, // no `.git` DIRECTORY — the file alone decides
		[
			['dist/out.ts', 'typescript', true], // .gitignore honored
			['build/b.ts', 'typescript', false] // heuristic off: a .gitignore is in scope
		]
	);

	// 17. a folder removed while its reload is in flight: the stale reload must not
	//     resurrect the dropped state. Unobservable while the folder is gone (no document
	//     resolves to it), so the probe re-adds it with its fresh load held: until that
	//     lands, nothing must be ignored — a resurrected snapshot would answer instead
	await run_scenario(
		'removed mid-reload: the stale reload does not resurrect the state',
		{
			'.formatignore': 'a.ts\n',
			'a.ts': UNFORMATTED_TS
		},
		true,
		[['a.ts', 'typescript', true]],
		false,
		async (world) => {
			let release_stale = (): void => {};
			world.read_gate = new Promise<void>((resolve) => {
				release_stale = resolve;
			});
			fire_watcher('change', '.formatignore'); // holds at the gate
			await settle();
			fire_workspace_folders_changed('removed');
			expect('removed mid-reload: nothing ignored', !is_ignored('a.ts'));
			expect('removed mid-reload: no .git watcher', same_lines(watcher_patterns(), [IGNORE_GLOB]));
			release_stale();
			await settle(); // the stale reload finishes — and must drop its result
			let release_fresh = (): void => {};
			world.read_gate = new Promise<void>((resolve) => {
				release_fresh = resolve;
			});
			fire_workspace_folders_changed('added'); // the fresh load, held
			await settle();
			expect('re-added: no resurrected state before the fresh load lands', !is_ignored('a.ts'));
			release_fresh();
			await settle();
			expect('re-added: the fresh load landed', is_ignored('a.ts'));
		}
	);

	// 18. an ignore-file event DURING the initial load: the first-started reload is
	//     superseded and drops its result, so activation must wait for the newer one —
	//     it resolves with the folder's state cached, never with nothing
	{
		const world = build_world({ '.formatignore': 'a.ts\n', 'a.ts': UNFORMATTED_TS }, true);
		set_world(world);
		let release_initial = (): void => {};
		world.read_gate = new Promise<void>((resolve) => {
			release_initial = resolve;
		});
		const ctx = make_context();
		const activation = activate_formatter(ctx as never, formatters, IgnoreStack as never);
		await settle(); // the initial load holds at the gate
		let release_newer = (): void => {};
		world.read_gate = new Promise<void>((resolve) => {
			release_newer = resolve;
		});
		fire_watcher('change', '.formatignore'); // a newer reload, held at its own gate
		await settle();
		release_initial();
		await settle();
		let activated = false;
		void activation.then(() => {
			activated = true;
		});
		await settle();
		expect('mid-load event: activation waits for the newer reload', !activated);
		release_newer();
		await activation;
		expect('mid-load event: activation resolved with the state cached', is_ignored('a.ts'));
		deactivate_formatter();
		for (const subscription of ctx.subscriptions) subscription.dispose();
		expect('mid-load event: no watcher outlives deactivation', watcher_patterns().length === 0);
	}

	// 19. a nested workspace folder (the repo root AND a package folder both open): the
	//     OUTERMOST folder is the eval root, as `tsv format` run from the repo root — so
	//     the root .gitignore and a hierarchical .prettierignore reach the package's
	//     documents (VS Code's own lookup answers the innermost folder, which has no
	//     .git and would fall to the loose regime). The nested folder gets no state of
	//     its own: no .git watcher, no outside-repo hint for a .prettierignore the root reads
	{
		const world = build_world(
			{
				'.gitignore': '*.gen.ts\n',
				'packages/a/.prettierignore': 'p.ts\n',
				'packages/a/foo.gen.ts': UNFORMATTED_TS,
				'packages/a/p.ts': UNFORMATTED_TS,
				'packages/a/keep.ts': UNFORMATTED_TS
			},
			true
		);
		world.nested_folders = [`${FOLDER}/packages/a`];
		set_world(world);
		const ctx = make_context();
		await activate_formatter(ctx as never, formatters, IgnoreStack as never);
		expect('nested folder: root .gitignore reaches it', is_ignored('packages/a/foo.gen.ts'));
		expect(
			'nested folder: its .prettierignore is read via the root',
			is_ignored('packages/a/p.ts')
		);
		expect('nested folder: plain source formats', !is_ignored('packages/a/keep.ts'));
		expect_hints('hint: none — the nested .prettierignore is read, not outside a repo', []);
		expect(
			'nested folder: one .git watcher, for the root only',
			same_lines(watcher_patterns().sort(), [IGNORE_GLOB, GIT_PATTERN].sort())
		);
		// an event under the nested folder reloads the ROOT (whose state governs it)
		world.files.set(`${FOLDER}/packages/a/.formatignore`, 'keep.ts\n');
		fire_watcher('change', 'packages/a/.formatignore');
		await settle();
		expect('nested folder: an event there reloads the root', is_ignored('packages/a/keep.ts'));
		deactivate_formatter();
		for (const subscription of ctx.subscriptions) subscription.dispose();
		expect('nested folder: no watcher outlives deactivation', watcher_patterns().length === 0);
	}

	// 20. a parse-error indicator left by a document an ignore file then comes to cover:
	//     the skipped save formats nothing, so the indicator is cleared rather than left
	//     describing a file tsv no longer touches
	await run_scenario(
		'stale status on an ignored save',
		{ '.formatignore': '# nothing\n' },
		false,
		[],
		false,
		async (world) => {
			const provider = get_provider();
			const status = get_status();
			const bad = make_doc('bad.ts', 'typescript', 'const x = (');
			provider.provideDocumentFormattingEdits(bad);
			expect('stale status: a parse error shows the indicator', status.visible);
			world.files.set(`${FOLDER}/.formatignore`, 'bad.ts\n');
			fire_watcher('change', '.formatignore');
			await settle();
			expect(
				'stale status: the covered document is skipped',
				(provider.provideDocumentFormattingEdits(bad) ?? []).length === 0
			);
			expect('stale status: the skipped save clears the indicator', !status.visible);
		}
	);

	console.log(`${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
};

void main();
