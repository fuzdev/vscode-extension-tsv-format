import * as vscode from 'vscode';

/**
 * The three `string -> string` formatters exported by `@fuzdev/tsv_format_wasm`.
 * Both extension hosts supply the same functions — only WASM init timing differs.
 */
export interface TsvFormatters {
	format_typescript: (source: string) => string;
	format_css: (source: string) => string;
	format_svelte: (source: string) => string;
}

/**
 * The `IgnoreStack` class exported by `@fuzdev/tsv_format_wasm` — tsv's
 * hierarchical, git-faithful discovery matcher. Assembled per document from a
 * workspace folder's `.gitignore` files plus its `.formatignore` and
 * `.prettierignore` hierarchies, so the extension skips exactly the files
 * `tsv format` would. Layers go in shallowest-first; the two kinds are evaluated
 * `.gitignore`-then-tsv, so a tsv `!` can re-include a gitignore'd path.
 *
 * Only the members the extension uses are typed here. The stack is built and
 * freed per document (never unwound while traversing), so the package's
 * `pop_gitignore` / `pop_tsv` are omitted — as are `is_empty`, `should_format_file`
 * (the extension dispatches by `languageId`, not by extension, so it never needs
 * that helper's filter), `heuristic_shadow_warning` (the extension prunes silently —
 * that hint is about a `.gitignore` turning the build-output heuristic off, which
 * changes nothing a user configured), and `classify_dir` (the per-directory verdict
 * for a top-down *traverser*; the extension has no traversal and uses the per-file
 * `is_path_pruned` instead). The two **`.prettierignore`** hints are typed and used:
 * each names an ignore file whose rules go unread, which is a silent
 * misconfiguration rather than a pruning detail, so `report_ignore_hints` logs them
 * to the Output channel exactly as the CLI writes them to stderr.
 */
export interface IgnoreStack {
	push_gitignore(anchor: string, content: string): void;
	push_tsv(anchor: string, content: string): void;
	is_ignored(path: string, is_dir: boolean): boolean;
	/**
	 * Whether `rel` (a folder-root-relative file path) is skipped because some
	 * ancestor directory would be pruned by `tsv format`'s traversal — the safety
	 * nets (`.git`/`node_modules`/…), the build-output heuristic
	 * (`dist`/`build`/`target` + hidden dirs, with its `!`-re-include override), or
	 * the matcher. The shared per-file companion to the CLI's per-directory
	 * `classify_dir` (`tsv_discover::is_path_pruned`): it walks `rel`'s ancestor
	 * directories itself and reconstructs each level's heuristic state from the
	 * stack's own pushed `.gitignore` anchors, so the extension no longer rebuilds
	 * that walk (or the heuristic state machine) in TypeScript. Pair with
	 * `is_ignored(rel, false)` for the file-level match.
	 */
	is_path_pruned(rel: string): boolean;
	/**
	 * The heads-up text for a `.prettierignore` at a target root **outside** a git
	 * repo, where tsv reads only `.formatignore` and those rules therefore go unread;
	 * `undefined` when there is nothing to say. The receiver is unused — the package
	 * exposes it as a method so it rides the `IgnoreStack` class through the facade.
	 */
	prettierignore_outside_repo_warning(
		dir: string,
		in_repo: boolean,
		has_prettierignore: boolean,
		has_formatignore: boolean
	): string | undefined;
	/**
	 * The heads-up text for a directory holding both a `.formatignore` and a
	 * `.prettierignore` **inside** a repo, where the sibling `.formatignore` shadows
	 * the `.prettierignore`; `undefined` otherwise. Same shape as above.
	 */
	prettierignore_shadowed_warning(
		dir: string,
		in_repo: boolean,
		has_prettierignore: boolean,
		has_formatignore: boolean
	): string | undefined;
	free(): void;
}

/** The `IgnoreStack` class constructor (`new IgnoreStack()`). */
export type IgnoreStackCtor = new () => IgnoreStack;

// VSCode `languageId` -> tsv formatter. ONLY these four are safe: tsv cannot
// format json/jsonc, html, jsx/tsx (typescriptreact/javascriptreact), or
// scss/less/postcss, so those language ids must never be registered or dispatched.
const formatter_keys_by_language: Record<string, keyof TsvFormatters> = {
	typescript: 'format_typescript',
	javascript: 'format_typescript',
	svelte: 'format_svelte',
	css: 'format_css'
};

// the failing document, so an unrelated successful save doesn't clear the indicator
let last_failure_uri: string | undefined;

let output_channel: vscode.OutputChannel | undefined;
let status_item: vscode.StatusBarItem | undefined;

// Discovery ignore files, mirroring the CLI. `.gitignore` is honored
// hierarchically (one per directory, git-faithful) but only inside a git repo;
// `.formatignore` is honored hierarchically in both regimes; `.prettierignore` is
// honored hierarchically inside a repo, each shadowed by a sibling `.formatignore`.
const gitignore_file_name = '.gitignore';
const formatignore_file_name = '.formatignore';
const prettierignore_file_name = '.prettierignore';

// The cached ignore state for one workspace folder, rebuilt off the save path.
interface FolderIgnore {
	// whether `<folder>/.git` exists — the CLI's two-regime switch. Inside a repo
	// the extension honors `.gitignore` + hierarchical `.prettierignore`; outside
	// one it honors only `.formatignore` (hierarchically), exactly like the CLI.
	in_repo: boolean;
	// `.gitignore` text keyed by the directory holding it, relative to the folder
	// root (`''` = the folder root). Populated only when `in_repo`.
	gitignores: Map<string, string>;
	// `.formatignore` text keyed by directory (hierarchical, both regimes).
	formatignores: Map<string, string>;
	// `.prettierignore` text keyed by directory (hierarchical, inside a repo only),
	// each shadowed per-directory by a sibling `.formatignore` in `tsv_layer_for_dir`.
	// Empty outside a repo.
	prettierignores: Map<string, string>;
	// the `.prettierignore` heads-ups this state carries (see `ignore_hints`), kept so
	// a reload that changes nothing re-logs nothing — the watcher fires on every
	// ignore-file save, and the same unread file is one line, not one per save
	hints: string[];
}

// gitignore-aware discovery: the prebuilt ignore state per workspace folder,
// keyed by folder URI. The format provider must stay synchronous (no disk reads
// on save), so this is built/refreshed off the save path — at activation, on
// ignore-file changes, and on workspace-folder changes — and only read here. The
// per-document `IgnoreStack` is assembled from it synchronously, then freed.
let ignore_stack_ctor: IgnoreStackCtor | undefined;
const folder_ignores = new Map<string, FolderIgnore>();
const ignore_text_decoder = new TextDecoder();

/** The directory of an ignore file at `uri_path`, relative to the folder `root`
 * (`''` = the folder root). URIs are `/`-separated. */
const ignore_dir_rel = (root: string, uri_path: string): string => {
	const file_rel = uri_path.startsWith(root)
		? uri_path.slice(root.length).replace(/^\/+/, '')
		: uri_path;
	const slash = file_rel.lastIndexOf('/');
	return slash === -1 ? '' : file_rel.slice(0, slash);
};

/** The ancestor directories of `rel` (a `/`-joined file path), shallowest first
 * and including the root `''` — the dirs whose ignore files can govern `rel`. */
const ancestor_dirs = (rel: string): string[] => {
	const dirs = [''];
	let acc = '';
	const parts = rel.split('/');
	parts.pop(); // drop the file name
	for (const part of parts) {
		acc = acc === '' ? part : `${acc}/${part}`;
		dirs.push(acc);
	}
	return dirs;
};

/** Whether the workspace folder is a git repo (a `<folder>/.git` dir *or* file),
 * mirroring the CLI's `find_repo_root` — except the extension only checks the
 * folder itself, never walking up to a repo root above it (those ignore files
 * are out of scope and unwatchable from within the folder). Async (stats disk). */
const folder_is_repo = async (folder: vscode.WorkspaceFolder): Promise<boolean> => {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.git'));
		return true;
	} catch {
		return false;
	}
};

/** Read one ignore file's text, or `undefined` when it is absent/unreadable. */
const read_ignore_file = async (uri: vscode.Uri): Promise<string | undefined> => {
	try {
		return ignore_text_decoder.decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
};

/** Every ignore file of one name under `folder` (excluding node_modules), keyed
 * by the directory holding it. `findFiles`' `**​/` prefix can miss the folder-root
 * file, so the caller reads that one explicitly. Never rejects: a `findFiles`
 * failure is logged and yields an empty map, so the caller still degrades to the
 * folder-root file plus structural pruning instead of aborting activation. */
const find_ignore_files = async (
	folder: vscode.WorkspaceFolder,
	name: string
): Promise<Map<string, string>> => {
	const root = folder.uri.path;
	const out = new Map<string, string>();
	let found: vscode.Uri[];
	try {
		found = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, `**/${name}`),
			'**/node_modules/**'
		);
	} catch (err) {
		// a `findFiles` rejection (likeliest on the web host's virtual FS) must not
		// abort activation or leak an unhandled rejection from a watcher reload — keep
		// `reload_ignore_folder` non-throwing. The caller still reads the folder-root
		// file directly and installs a state object, so this degrades to "root ignore
		// files only" plus the always-on safety-net / build-output pruning, never to
		// "format everything"
		output_channel?.appendLine(
			`[${new Date().toISOString()}] could not scan for ${name} under ${folder.name}: ${to_error_message(err)}`
		);
		return out;
	}
	for (const uri of found) {
		const text = await read_ignore_file(uri);
		if (text !== undefined) out.set(ignore_dir_rel(root, uri.path), text);
	}
	return out;
};

/**
 * Rebuilds the cached ignore state for a workspace folder: its `in_repo` flag, the
 * `.formatignore` hierarchy (both regimes), and — only inside a repo — the
 * `.gitignore` hierarchy plus the `.prettierignore` hierarchy (each shadowed
 * per-directory by a sibling `.formatignore`). The workspace folder is the eval
 * root. Async (reads files); never on the save path.
 *
 * @mutates folder_ignores
 */
const reload_ignore_folder = async (folder: vscode.WorkspaceFolder): Promise<void> => {
	if (!ignore_stack_ctor) return;
	const in_repo = await folder_is_repo(folder);
	const formatignores = await find_ignore_files(folder, formatignore_file_name);
	// `**/` can miss the folder-root file — read it explicitly (both regimes), so a
	// repo-root/folder-root `.formatignore` is honored (and shadows `.prettierignore`)
	if (!formatignores.has('')) {
		const root_fmt = await read_ignore_file(
			vscode.Uri.joinPath(folder.uri, formatignore_file_name)
		);
		if (root_fmt !== undefined) formatignores.set('', root_fmt);
	}

	const gitignores = new Map<string, string>();
	const prettierignores = new Map<string, string>();
	// outside a repo `.prettierignore` is never READ (only `.formatignore` is), but its
	// presence is exactly what the outside-repo hint is about, so ask once either way
	let root_prettierignore_present = false;
	if (in_repo) {
		for (const [dir, text] of await find_ignore_files(folder, gitignore_file_name)) {
			gitignores.set(dir, text);
		}
		// `**/` can miss the folder-root file — read it explicitly
		if (!gitignores.has('')) {
			const root_gi = await read_ignore_file(vscode.Uri.joinPath(folder.uri, gitignore_file_name));
			if (root_gi !== undefined) gitignores.set('', root_gi);
		}
		// `.prettierignore` is hierarchical inside a repo (like `.formatignore`);
		// per-directory shadowing by a sibling `.formatignore` is applied in
		// `tsv_layer_for_dir`, so read every one here.
		for (const [dir, text] of await find_ignore_files(folder, prettierignore_file_name)) {
			prettierignores.set(dir, text);
		}
		// `**/` can miss the folder-root file — read it explicitly
		if (!prettierignores.has('')) {
			const root_pi = await read_ignore_file(
				vscode.Uri.joinPath(folder.uri, prettierignore_file_name)
			);
			if (root_pi !== undefined) prettierignores.set('', root_pi);
		}
	}

	if (in_repo) {
		root_prettierignore_present = prettierignores.has('');
	} else {
		root_prettierignore_present =
			(await read_ignore_file(vscode.Uri.joinPath(folder.uri, prettierignore_file_name))) !==
			undefined;
	}

	const hints = ignore_hints(
		folder,
		in_repo,
		formatignores,
		prettierignores,
		root_prettierignore_present
	);
	const key = folder.uri.toString();
	const previous = folder_ignores.get(key);
	folder_ignores.set(key, {
		in_repo,
		gitignores,
		formatignores,
		prettierignores,
		hints
	});
	// log the set only when it changed — a reload the watcher fires for an unrelated
	// `.gitignore` save carries the same hints, and repeating them is noise; a set
	// that shrank to nothing is silence, not a line (nothing is unread any more)
	if (hints.length > 0 && (previous === undefined || !same_lines(previous.hints, hints))) {
		for (const hint of hints) {
			output_channel?.appendLine(`[${new Date().toISOString()}] ${hint}`);
		}
	}
};

const same_lines = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * The `.prettierignore` heads-ups tsv's CLI writes to stderr — an ignore file
 * whose rules go unread, which is a silent misconfiguration the editor would
 * otherwise never surface. Two cases, both phrased by the shared matcher so the
 * wording cannot drift from the CLI's:
 *
 * - **Outside a repo**, a `.prettierignore` at the folder root is not read at all
 *   (only `.formatignore` is), unless a sibling `.formatignore` already explains it.
 * - **Inside a repo**, a directory holding both files has its `.prettierignore`
 *   shadowed by the sibling `.formatignore`.
 *
 * Computed off the save path (a folder reload only) and logged by the caller to
 * the Output channel, which is not revealed — a hint is information, not a
 * failure, so it must not steal focus from the parse-error indicator.
 * Best-effort: a stack that cannot be built is simply no hint. Sorted, so an
 * unchanged tree yields an identical list whatever order `findFiles` returned.
 */
const ignore_hints = (
	folder: vscode.WorkspaceFolder,
	in_repo: boolean,
	formatignores: Map<string, string>,
	prettierignores: Map<string, string>,
	root_prettierignore_present: boolean
): string[] => {
	const hints: string[] = [];
	if (!ignore_stack_ctor) return hints;
	const stack = new ignore_stack_ctor();
	try {
		if (in_repo) {
			// per directory: both files present means the tsv layer read the .formatignore
			for (const dir of prettierignores.keys()) {
				const hint = stack.prettierignore_shadowed_warning(
					dir === '' ? folder.name : `${folder.name}/${dir}`,
					true,
					true,
					formatignores.has(dir)
				);
				if (hint !== undefined) hints.push(hint);
			}
		} else {
			// outside a repo the cache holds no .prettierignore at all (it is never
			// read), so the folder-root file's presence is the one thing to ask about
			const hint = stack.prettierignore_outside_repo_warning(
				folder.name,
				false,
				root_prettierignore_present,
				formatignores.has('')
			);
			if (hint !== undefined) hints.push(hint);
		}
	} finally {
		stack.free();
	}
	return hints.sort();
};

const clear_ignore_folder = (folder: vscode.WorkspaceFolder): void => {
	folder_ignores.delete(folder.uri.toString());
};

const clear_ignore_folders = (): void => {
	folder_ignores.clear();
};

/** The tsv-layer text for one directory: its `.formatignore`, or — when no sibling
 * `.formatignore` is present — its `.prettierignore` (per-directory shadowing). */
const tsv_layer_for_dir = (state: FolderIgnore, dir: string): string | undefined => {
	const formatignore = state.formatignores.get(dir);
	if (formatignore !== undefined) return formatignore;
	return state.prettierignores.get(dir);
};

/**
 * Whether the document is excluded by its workspace folder's ignore files
 * (hierarchical `.gitignore` inside a repo + the hierarchical `.formatignore` /
 * `.prettierignore` tsv layers) or by the CLI's traversal pruning
 * (safety nets + build-output heuristic, via the shared `stack.is_path_pruned`).
 * Synchronous — reads only the prebuilt cache, assembling and freeing a per-call
 * `IgnoreStack`. Documents outside every workspace folder (loose/untitled) are
 * never ignored.
 */
const is_document_ignored = (document: vscode.TextDocument): boolean => {
	if (!ignore_stack_ctor) return false;
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) return false;
	const state = folder_ignores.get(folder.uri.toString());
	if (!state) return false;
	// No emptiness short-circuit: the build-output heuristic prunes on directory
	// *names* (dist/build/target/hidden), so it can apply even with zero ignore
	// files — the full check below is cheap (an empty stack resolves fast).
	// URIs are always `/`-separated, so the folder path is a prefix of the doc's
	const root = folder.uri.path;
	const doc_path = document.uri.path;
	const rel = doc_path.startsWith(root)
		? doc_path.slice(root.length).replace(/^\/+/, '')
		: doc_path;

	const stack = new ignore_stack_ctor();
	try {
		const dirs = ancestor_dirs(rel);
		// `.gitignore` layers shallow→deep (repo only), then tsv layers shallow→deep;
		// the matcher evaluates all gitignores before all tsv layers regardless of
		// push interleaving, so a tsv `!` re-includes over `.gitignore`
		if (state.in_repo) {
			for (const dir of dirs) {
				const content = state.gitignores.get(dir);
				if (content !== undefined) stack.push_gitignore(dir, content);
			}
		}
		for (const dir of dirs) {
			const content = tsv_layer_for_dir(state, dir);
			if (content !== undefined) stack.push_tsv(dir, content);
		}
		// file-level match, then the shared per-file directory-prune walk (safety
		// nets + build-output heuristic + matcher), which reconstructs the heuristic
		// state from the stack's own `.gitignore` anchors — no walk hand-rolled here
		return stack.is_ignored(rel, false) || stack.is_path_pruned(rel);
	} finally {
		stack.free();
	}
};

/**
 * Loads ignore state for the current workspace folders and wires up refresh on
 * ignore-file and workspace-folder changes. Registers its disposables on the
 * extension context. Async: awaits the initial folder load so the cache is ready
 * by the time activation resolves (subsequent refreshes stay off the save path).
 *
 * @mutates context.subscriptions
 */
const activate_ignore = async (
	context: vscode.ExtensionContext,
	IgnoreStack: IgnoreStackCtor
): Promise<void> => {
	ignore_stack_ctor = IgnoreStack;
	// await the initial load so the cache is populated before the provider can run:
	// activation finishes before VSCode invokes a formatter, so this closes the
	// startup window where an ignored file could format once before its cache landed
	await Promise.all((vscode.workspace.workspaceFolders ?? []).map(reload_ignore_folder));

	// one watcher covers .gitignore + the tsv files in every folder; any change
	// re-reads that folder's whole state off the save path (works in both hosts)
	const watcher = vscode.workspace.createFileSystemWatcher(
		'**/.{gitignore,prettierignore,formatignore}'
	);
	const on_change = (uri: vscode.Uri): void => {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder) void reload_ignore_folder(folder);
	};
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(on_change),
		watcher.onDidChange(on_change),
		watcher.onDidDelete(on_change),
		vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.added) void reload_ignore_folder(folder);
			for (const folder of event.removed) clear_ignore_folder(folder);
		})
	);
};

const to_error_message = (value: unknown): string =>
	value instanceof Error ? value.message : String(value);

/**
 * Resolves the tsv formatter for a document, dispatching on `languageId` and
 * falling back to the `.svelte` file extension. The extension contributes the
 * `.svelte` → `svelte` language association itself (`package.json`
 * `contributes.languages`), so a `.svelte` file carries the `svelte` languageId
 * — and fires `onLanguage:svelte` — with or without the Svelte extension
 * installed; the fileName fallback is now defensive only (e.g. a `.svelte`
 * document forced to some other id). ts/js/css ids are built into VSCode.
 */
const formatter_for_document = (
	document: vscode.TextDocument,
	formatters: TsvFormatters
): ((source: string) => string) | undefined => {
	const key =
		formatter_keys_by_language[document.languageId] ??
		(document.fileName.endsWith('.svelte') ? 'format_svelte' : undefined);
	return key ? formatters[key] : undefined;
};

const report_format_failure = (document: vscode.TextDocument, err: unknown): void => {
	last_failure_uri = document.uri.toString();
	output_channel?.appendLine(`[${new Date().toISOString()}] ${document.uri.fsPath}`);
	output_channel?.appendLine(to_error_message(err));
	output_channel?.appendLine('');
	if (status_item) {
		const relative = vscode.workspace.asRelativePath(document.uri);
		status_item.text = '$(warning) tsv';
		status_item.tooltip = `tsv: could not format ${relative} (parse error) — click to view output`;
		status_item.show();
	}
};

const clear_format_failure = (document: vscode.TextDocument): void => {
	if (last_failure_uri === document.uri.toString()) {
		last_failure_uri = undefined;
		status_item?.hide();
	}
};

/**
 * Computes the format-on-save edits for a document. Synchronous by design: tsv
 * formats in-process with no async window, so VSCode applies the edits against
 * the same document version it requested them for — closing the bulk-edit race
 * that an async formatter is exposed to.
 *
 * On a parse error it reports to the status bar + Output channel and returns no
 * edits, leaving the file untouched. An unchanged result also returns no edits,
 * so a clean file is never marked dirty.
 */
const format_document = (
	document: vscode.TextDocument,
	formatters: TsvFormatters
): vscode.TextEdit[] => {
	const format = formatter_for_document(document, formatters);
	if (!format) return [];
	// honor .gitignore / .formatignore / .prettierignore on save (and explicit
	// Format Document — VSCode routes both through this provider with no way to
	// tell them apart, so both skip an ignored file, matching prettier-vscode)
	if (is_document_ignored(document)) return [];
	const source = document.getText();
	let formatted: string;
	try {
		formatted = format(source);
	} catch (err) {
		report_format_failure(document, err);
		return [];
	}
	clear_format_failure(document);
	if (formatted === source) return [];
	const full_range = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
	return [vscode.TextEdit.replace(full_range, formatted)];
};

/**
 * Registers the single document-formatting provider plus its status-bar
 * indicator, Output channel, and command. Host-agnostic: each entry passes the
 * already-initialized formatters, so this never touches WASM init. Async — it
 * awaits the one-time ignore-file load so the skip cache is ready before the
 * (synchronous) provider can run; the per-format path itself stays synchronous.
 *
 * @mutates context.subscriptions
 */
export const activate_formatter = async (
	context: vscode.ExtensionContext,
	formatters: TsvFormatters,
	IgnoreStack: IgnoreStackCtor
): Promise<void> => {
	output_channel = vscode.window.createOutputChannel('tsv');
	status_item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	status_item.command = 'tsv_format.show_output';

	context.subscriptions.push(
		output_channel,
		status_item,
		vscode.commands.registerCommand('tsv_format.show_output', () => {
			output_channel?.show(true);
		}),
		// clear the parse-error indicator when the failing document is closed, so a
		// lingering ⚠ doesn't outlive a file the user never re-saves
		vscode.workspace.onDidCloseTextDocument(clear_format_failure)
	);

	await activate_ignore(context, IgnoreStack);

	const provider: vscode.DocumentFormattingEditProvider = {
		provideDocumentFormattingEdits(document) {
			return format_document(document, formatters);
		}
	};

	// One provider for every supported language. No `scheme` filter, so it covers
	// both the desktop `file` scheme and the web host's virtual schemes. The
	// extension contributes the `.svelte` → `svelte` association itself
	// (`contributes.languages`), so the `svelte` id is present without the Svelte
	// extension; the `**/*.svelte` pattern is a defensive backstop for that id.
	const selector: vscode.DocumentSelector = [
		{ language: 'typescript' },
		{ language: 'javascript' },
		{ language: 'svelte' },
		{ language: 'css' },
		{ pattern: '**/*.svelte' }
	];

	context.subscriptions.push(
		vscode.languages.registerDocumentFormattingEditProvider(selector, provider)
	);
};

export const deactivate_formatter = (): void => {
	// the channel/status item/watcher are disposed via `context.subscriptions`;
	// just reset refs and drop the cached ignore state (the per-call IgnoreStack
	// objects are already freed in `is_document_ignored`)
	clear_ignore_folders();
	ignore_stack_ctor = undefined;
	output_channel = undefined;
	status_item = undefined;
	last_failure_uri = undefined;
};
