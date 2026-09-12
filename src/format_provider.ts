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
 * that helper's filter), `classify_dir` (the per-directory verdict for a top-down
 * *traverser*; the extension has no traversal and uses the per-file `is_path_pruned`
 * instead), and `shadow_warning`. That hint names a real misconfiguration: a
 * tsv-layer `!` re-include written under a directory the build-output heuristic prunes
 * (`!dist/keep.ts`) does nothing, since git's parent-directory rule bars a re-include
 * inside an excluded directory. The CLI raises it from its walk, at the pruned
 * directory; the extension has no walk, so such a file is skipped silently. The two
 * **`.prettierignore`** hints are typed and used:
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
const ignore_file_names = [gitignore_file_name, formatignore_file_name, prettierignore_file_name];
// the directories tsv's discovery never descends into, whatever the ignore files say
// (`tsv_discover::SAFETY_NET_DIRS`) — an ignore file under one is never read by the
// CLI, so the listing drops them (see `scan_ignore_files`)
const safety_net_dirs = new Set(['node_modules', '.git', '.sl', '.hg', '.svn', '.jj']);

// The cached ignore layers for one workspace folder, rebuilt off the save path.
interface FolderLayers {
	// whether `<folder>/.git` exists — the CLI's two-regime switch. Inside a repo
	// the extension honors `.gitignore` + hierarchical `.prettierignore`; outside
	// one it honors only `.formatignore` (hierarchically), exactly like the CLI.
	in_repo: boolean;
	// `.gitignore` text keyed by the directory holding it, relative to the folder
	// root (`''` = the folder root). Populated only when `in_repo`. An unreadable or
	// symlinked one (git does not follow a link) has no entry: its rules are dropped,
	// warned in the folder's `hints`.
	gitignores: Map<string, string>;
	// `.formatignore` text keyed by directory (hierarchical, both regimes). A
	// present-but-unreadable one (a read error, or invalid UTF-8 — reading is strict
	// UTF-8, as on both CLIs) has no entry: its rules are dropped, warned in the
	// folder's `hints`.
	formatignores: Map<string, string>;
	// `.prettierignore` text keyed by directory (hierarchical, inside a repo only) —
	// the UNSHADOWED ones only: a directory with a sibling `.formatignore` never has
	// its `.prettierignore` read, as on the CLI, and that is keyed on the
	// `.formatignore`'s PRESENCE, not its readability, so a read error can't silently
	// demote tsv's native file to prettier's. Empty outside a repo.
	prettierignores: Map<string, string>;
}

// The cached ignore state for one workspace folder: its layers and the heads-ups they carry.
interface FolderIgnore extends FolderLayers {
	// the warnings for ignore files whose rules cannot be applied (unreadable, or a
	// symlinked `.gitignore`) and the two `.prettierignore` hints (see `ignore_hints`) —
	// kept so a reload that changes nothing re-logs nothing: the watcher fires on every
	// ignore-file save, and the same unread file is one line, not one per save
	hints: string[];
}

// A heads-up about the ignore files of one folder-relative directory (`''` = the root),
// logged only where the CLI's walk reads them (see `ignore_hints`).
interface DirHint {
	dir: string;
	text: string;
}

// gitignore-aware discovery: the prebuilt ignore state per workspace folder,
// keyed by folder URI. The format provider must stay synchronous (no disk reads
// on save), so this is built/refreshed off the save path — at activation, on
// ignore-file changes, and on workspace-folder changes — and only read here. The
// per-document `IgnoreStack` is assembled from it synchronously, then freed.
let ignore_stack_ctor: IgnoreStackCtor | undefined;
const folder_ignores = new Map<string, FolderIgnore>();
// per folder, the generation of the latest reload started — a reload whose reads
// finished after a newer one began discards its result, so a burst of watcher
// events (an editor saving twice, a `git checkout` touching several ignore files)
// can never leave the EARLIER read as the cached state. Latest-started wins. The
// generations come from one counter across folders, so a folder removed and
// re-added while its reload is in flight gets a number that reload cannot match.
const folder_generations = new Map<string, number>();
let reload_generation = 0;
// per folder, the reload most recently started and not yet landed — what the initial
// load awaits (see `ignore_folder_settled`), so activation resolves with the LATEST
// snapshot cached, not merely after the first-started reload finished
const folder_reloads = new Map<string, Promise<void>>();
// per folder, the `.git` watcher that flips its regime (see `watch_folder_git`)
const git_watchers = new Map<string, vscode.Disposable>();
// strict, like both CLIs: an ignore file that is not valid UTF-8 is unreadable
// (warned, rules dropped), never decoded with replacement characters into
// patterns nobody wrote
const ignore_text_decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The directory of an ignore file at `uri_path`, relative to the folder `root`
 * (`''` = the folder root). URIs are `/`-separated. */
const ignore_dir_rel = (root: string, uri_path: string): string => {
	const file_rel = folder_rel(root, uri_path);
	const slash = file_rel.lastIndexOf('/');
	return slash === -1 ? '' : file_rel.slice(0, slash);
};

/** A URI path relative to its workspace folder's path (URIs are always
 * `/`-separated, so the folder path is a plain prefix); a path outside the folder
 * is returned as-is. */
const folder_rel = (root: string, uri_path: string): string =>
	uri_path.startsWith(root) ? uri_path.slice(root.length).replace(/^\/+/, '') : uri_path;

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

/** Whether `dir_rel` (a folder-relative directory, `''` = the root) lies under a
 * safety-net directory — where the CLI's walk never goes. */
const is_under_safety_net = (dir_rel: string): boolean =>
	dir_rel !== '' && dir_rel.split('/').some((segment) => safety_net_dirs.has(segment));

/** Whether workspace folder `outer` contains `inner` (or is it). */
const folder_contains = (outer: vscode.WorkspaceFolder, inner: vscode.WorkspaceFolder): boolean =>
	outer.uri.scheme === inner.uri.scheme &&
	outer.uri.authority === inner.uri.authority &&
	(inner.uri.path === outer.uri.path ||
		inner.uri.path.startsWith(
			outer.uri.path.endsWith('/') ? outer.uri.path : `${outer.uri.path}/`
		));

/**
 * The workspace folders that are eval roots: every open folder not nested inside
 * another open folder. A nested folder (a monorepo workspace with the repo root and a
 * package folder both open) is covered by its ancestor, whose ignore files reach it
 * hierarchically — as they do for the CLI run from that ancestor — so it gets no state
 * of its own: it would evaluate its documents in the loose regime (no `.git` of its
 * own) and log an outside-repo hint for a `.prettierignore` the ancestor reads.
 */
const root_folders = (): vscode.WorkspaceFolder[] => {
	const folders = vscode.workspace.workspaceFolders ?? [];
	return folders.filter(
		(folder) => !folders.some((other) => other !== folder && folder_contains(other, folder))
	);
};

/** The eval root for `uri`: the OUTERMOST open workspace folder containing it (VS
 * Code's `getWorkspaceFolder` answers the innermost), or `undefined` outside them all. */
const root_folder_for = (uri: vscode.Uri): vscode.WorkspaceFolder | undefined => {
	let root = vscode.workspace.getWorkspaceFolder(uri);
	if (!root) return undefined;
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder !== root && folder_contains(folder, root)) root = folder;
	}
	return root;
};

/** Whether the workspace folder is a git repo (a `<folder>/.git` dir *or* file),
 * mirroring the CLI's `find_repo_root` — except the extension only checks the
 * folder itself, never walking up to a repo root above it (those ignore files
 * are out of scope and unwatchable from within the folder). Async (stats disk). */
const folder_is_repo = (folder: vscode.WorkspaceFolder): Promise<boolean> =>
	path_exists(vscode.Uri.joinPath(folder.uri, '.git'));

/**
 * The `stat` type at `uri` (a bitmask — a link carries `SymbolicLink` beside its target's
 * type), or `undefined` when the stat fails for any reason. A presence question, not a
 * read: where nothing is usually there, no provider's error shape for a missing entry is
 * ever classified.
 */
const stat_type = async (uri: vscode.Uri): Promise<vscode.FileType | undefined> => {
	try {
		return (await vscode.workspace.fs.stat(uri)).type;
	} catch {
		return undefined;
	}
};

/** Whether anything exists at `uri` — presence, the listing's question, not a read. */
const path_exists = async (uri: vscode.Uri): Promise<boolean> =>
	(await stat_type(uri)) !== undefined;

/** One timestamped line on the `tsv` Output channel (never revealed by this). */
const log_line = (text: string): void => {
	output_channel?.appendLine(`[${new Date().toISOString()}] ${text}`);
};

/**
 * One ignore file's read outcome, as the CLI grades it. `absent` is silent (nothing
 * there, a directory of that name, or deleted between the listing and the read);
 * `unreadable` is a present file whose rules cannot be applied (a read error, or invalid
 * UTF-8), which is warned rather than silently treated as absent; `symlink` is a
 * `.gitignore` that is a symbolic link, whose rules are not applied either and which is
 * warned too (see `gitignore_presence`); `content` is its text.
 */
type IgnoreRead =
	| { kind: 'absent' }
	| { kind: 'unreadable'; reason: string }
	| { kind: 'symlink' }
	| { kind: 'content'; content: string };

/** Whether a `workspace.fs` failure means the file is not there at all. */
const is_not_found = (err: unknown): boolean => {
	const code = (err as { code?: unknown } | null)?.code;
	// `vscode.FileSystemError.FileNotFound` carries `code: 'FileNotFound'`; a Node
	// error surfacing through a custom provider carries `'ENOENT'`
	return code === 'FileNotFound' || code === 'ENOENT';
};

/** Read one ignore file: its text, or why it could not be applied. */
const read_ignore_file = async (uri: vscode.Uri): Promise<IgnoreRead> => {
	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch (err) {
		if (is_not_found(err)) return { kind: 'absent' };
		return { kind: 'unreadable', reason: to_error_message(err) };
	}
	try {
		return { kind: 'content', content: ignore_text_decoder.decode(bytes) };
	} catch {
		return { kind: 'unreadable', reason: 'invalid UTF-8' };
	}
};

/** How an ignore-file entry is present, by the CLI's rule for its name. */
type IgnorePresence = 'absent' | 'file' | 'symlink';

/** A name's presence rule, graded from the entry's `stat` type. */
type IgnorePresenceRule = (type: vscode.FileType) => IgnorePresence;

/**
 * The tsv layer's presence rule (`is_ignore_file` on both CLIs): a regular file, reached
 * through a symbolic link when the name is one, as prettier reads its own. A directory of
 * that name holds no rules — reading it would fail and warn about rules that were never
 * there — so it is absent, as is a link that resolves to no file.
 */
const tsv_layer_presence: IgnorePresenceRule = (type) =>
	(type & vscode.FileType.File) !== 0 ? 'file' : 'absent';

/**
 * git's presence rule for `.gitignore` (`GitignorePresence` on both CLIs): git does not
 * follow a symbolic link to one in a working tree and applies none of its rules, so a link
 * is `symlink` whatever it points at — warned, its rules dropped — and anything else is
 * graded as the tsv layer grades it.
 */
const gitignore_presence: IgnorePresenceRule = (type) =>
	(type & vscode.FileType.SymbolicLink) !== 0 ? 'symlink' : tsv_layer_presence(type);

/** An entry's read, given its presence: a present file's text (or why it could not be
 * applied), otherwise the presence itself. */
const read_by_presence = (uri: vscode.Uri, presence: IgnorePresence): Promise<IgnoreRead> =>
	presence === 'file' ? read_ignore_file(uri) : Promise.resolve({ kind: presence });

/**
 * Read one listed ignore file, stat-ed and graded by its name's `presence` rule. The
 * listing already found it, so only a not-found stat (the file deleted since) is absence;
 * any other stat failure is left to the read, which reports it.
 */
const read_listed_ignore_file = async (
	uri: vscode.Uri,
	presence: IgnorePresenceRule
): Promise<IgnoreRead> => {
	let type: vscode.FileType;
	try {
		type = (await vscode.workspace.fs.stat(uri)).type;
	} catch (err) {
		return is_not_found(err) ? { kind: 'absent' } : read_ignore_file(uri);
	}
	return read_by_presence(uri, presence(type));
};

/**
 * The CLI's stderr line for a present-but-unreadable ignore file, restated by hand
 * (the two `tsv` bins template it themselves rather than taking it from the shared
 * matcher — `crates/tsv_wasm/npm/cli.js` `read_ignore_file`), so the editor's
 * Output line reads the same as the CLI's.
 */
const unreadable_warning = (display_path: string, reason: string): string =>
	`could not read ${display_path} (${reason}); its ignore rules are not applied`;

/**
 * The CLI's stderr line for a symlinked `.gitignore`, restated by hand: the shared matcher
 * phrases it for both `tsv` bins (`tsv_discover::gitignore_symlink_warning`), but the
 * pinned `@fuzdev/tsv_format_wasm` range predates that binding method.
 */
const gitignore_symlink_warning = (display_path: string): string =>
	`${display_path} is a symbolic link, which git does not follow in a working tree; its ignore rules are not applied`;

/**
 * One listing of every ignore file under `folder`, keyed by file name. The exclude is
 * `null` deliberately: VS Code applies the `files.exclude` setting on top of any exclude
 * glob and disregards it only for `null`, so a user's `**​/dist` there would hide an
 * ignore file the CLI reads (`search.exclude` never applies to `findFiles`, and
 * `.gitignore` is not consulted). The safety-net directories are dropped from the
 * listing here instead of by an exclude glob — the walk never descends into them, so an
 * ignore file under one is never read by the CLI either. One scan for the three names,
 * so the unexcluded walk (`node_modules` included) is paid once per reload.
 * Symbolic links follow the user's `search.followSymlinks` (on by default), which
 * `findFiles` hands ripgrep as `--follow`. Turned off, the listing holds no symlinked
 * file of any name: a symlinked `.gitignore` loses only its warning (its rules are
 * dropped either way), but a nested symlinked `.formatignore` / `.prettierignore`, which
 * the CLI reads through the link, goes unapplied and shadows no sibling. The folder-root
 * files are stat-ed directly (`collect_ignore_files`), so they are unaffected.
 * Never rejects: a `findFiles` failure is logged and yields empty listings, so the
 * caller still degrades to the folder-root files plus structural pruning instead of
 * aborting activation.
 */
const scan_ignore_files = async (
	folder: vscode.WorkspaceFolder
): Promise<Map<string, vscode.Uri[]>> => {
	const root = folder.uri.path;
	const out = new Map<string, vscode.Uri[]>(ignore_file_names.map((name) => [name, []]));
	let found: vscode.Uri[];
	try {
		found = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, `**/.{gitignore,prettierignore,formatignore}`),
			null
		);
	} catch (err) {
		// a `findFiles` rejection (likeliest on the web host's virtual FS) must not
		// abort activation or leak an unhandled rejection from a watcher reload — keep
		// `reload_ignore_folder` non-throwing. The caller still reads the folder-root
		// files directly and installs a state object, so this degrades to "root ignore
		// files only" plus the always-on safety-net / build-output pruning, never to
		// "format everything"
		log_line(`could not scan for ignore files under ${folder.name}: ${to_error_message(err)}`);
		return out;
	}
	for (const uri of found) {
		const rel = folder_rel(root, uri.path);
		const slash = rel.lastIndexOf('/');
		if (is_under_safety_net(slash === -1 ? '' : rel.slice(0, slash))) continue;
		out.get(rel.slice(slash + 1))?.push(uri);
	}
	return out;
};

/**
 * Every present ignore file of one name under `folder`, keyed by the directory holding
 * it — its `IgnoreRead`, an absent one dropped: the `listed` URIs read concurrently,
 * plus an explicit folder-root read wherever the listing has none (inside a repo the root
 * `.gitignore` / `.prettierignore`, both regimes the root `.formatignore`) — a backstop, so
 * the root files survive a `findFiles` rejection. Every one is stat-ed
 * before it is read and graded by `presence`, the name's rule, so a directory of that
 * name is absent and a symlinked `.gitignore` is `symlink` in the listing and at the
 * root alike. The root file is usually NOT there, so ANY failure of its stat is
 * absence, never a read whose failure is then classified: a provider that reports a
 * missing file with a bare error (no `FileNotFound` / `ENOENT` code) would otherwise
 * turn every absent root file into a present-but-unreadable one — three false warnings
 * per reload, and a phantom `.formatignore` shadowing a phantom `.prettierignore`.
 * `is_not_found` stays the answer for a listed file that vanishes after the listing.
 */
const collect_ignore_files = async (
	folder: vscode.WorkspaceFolder,
	name: string,
	listed: vscode.Uri[],
	presence: IgnorePresenceRule
): Promise<Map<string, IgnoreRead>> => {
	const root = folder.uri.path;
	const files = new Map<string, IgnoreRead>();
	// read concurrently — off the save path, but the reload's length is the window
	// in which a save still sees the previous state
	const reads = await Promise.all(
		listed.map(
			async (uri) =>
				[ignore_dir_rel(root, uri.path), await read_listed_ignore_file(uri, presence)] as const
		)
	);
	for (const [dir, read] of reads) {
		if (read.kind !== 'absent') files.set(dir, read);
	}
	if (!files.has('')) {
		const root_uri = vscode.Uri.joinPath(folder.uri, name);
		const type = await stat_type(root_uri);
		if (type !== undefined) {
			const root_read = await read_by_presence(root_uri, presence(type));
			if (root_read.kind !== 'absent') files.set('', root_read);
		}
	}
	return files;
};

/**
 * One name's reads as the texts to push (the layers), pushing the CLI's warning
 * line onto `warnings` for every file whose rules cannot be applied — an unreadable
 * one, or a symlinked `.gitignore` git would not follow — so its rules are dropped,
 * never silently treated as absent (on the CLI a `--check` reproducibility hazard;
 * here the difference between what a save touches and what `tsv format` would).
 * Presence is the reads map's own key set, so a caller that needs it (the shadow) reads
 * the keys, not this. The display path is folder-relative, like the other hints'.
 */
const ignore_texts = (
	folder: vscode.WorkspaceFolder,
	name: string,
	reads: Map<string, IgnoreRead>,
	warnings: DirHint[]
): Map<string, string> => {
	const texts = new Map<string, string>();
	for (const [dir, read] of reads) {
		if (read.kind === 'content') {
			texts.set(dir, read.content);
			continue;
		}
		const display = dir === '' ? `${folder.name}/${name}` : `${folder.name}/${dir}/${name}`;
		if (read.kind === 'unreadable') {
			warnings.push({ dir, text: unreadable_warning(display, read.reason) });
		} else if (read.kind === 'symlink') {
			warnings.push({ dir, text: gitignore_symlink_warning(display) });
		}
	}
	return texts;
};

/**
 * Rebuilds the cached ignore state for a workspace folder: its `in_repo` flag, the
 * `.formatignore` hierarchy (both regimes), and — only inside a repo — the
 * `.gitignore` hierarchy plus the `.prettierignore` hierarchy (each shadowed
 * per-directory by a sibling `.formatignore`). The workspace folder is the eval
 * root. Async (reads files); never on the save path. Tracked in `folder_reloads`
 * while in flight so `ignore_folder_settled` can wait for the latest one.
 *
 * @mutates folder_ignores
 */
const reload_ignore_folder = (folder: vscode.WorkspaceFolder): Promise<void> => {
	const IgnoreStack = ignore_stack_ctor;
	if (!IgnoreStack) return Promise.resolve();
	const key = folder.uri.toString();
	const reload: Promise<void> = run_ignore_reload(folder, IgnoreStack).finally(() => {
		if (folder_reloads.get(key) === reload) folder_reloads.delete(key);
	});
	folder_reloads.set(key, reload);
	return reload;
};

/**
 * Resolves once no reload is in flight for `folder` — after the LATEST-started one has
 * landed (or the folder was dropped). A reload superseded mid-read discards its result
 * at the generation guard, so awaiting only the first-started one would let activation
 * resolve with nothing cached when an ignore file is written during the initial load.
 */
const ignore_folder_settled = async (folder: vscode.WorkspaceFolder): Promise<void> => {
	const key = folder.uri.toString();
	let pending: Promise<void> | undefined;
	while ((pending = folder_reloads.get(key)) !== undefined) await pending;
};

const run_ignore_reload = async (
	folder: vscode.WorkspaceFolder,
	IgnoreStack: IgnoreStackCtor
): Promise<void> => {
	const key = folder.uri.toString();
	const generation = ++reload_generation;
	folder_generations.set(key, generation);

	const [in_repo, listed] = await Promise.all([folder_is_repo(folder), scan_ignore_files(folder)]);
	const none = new Map<string, IgnoreRead>();
	const collect = (name: string, presence: IgnorePresenceRule) =>
		collect_ignore_files(folder, name, listed.get(name) ?? [], presence);
	// every read at once (off the save path, but shorter is a shorter stale window);
	// `.gitignore` and `.prettierignore` are read inside a repo only — outside one the
	// folder-root `.prettierignore`'s PRESENCE is still asked, for the hint
	const [formatignore_reads, gitignore_reads, prettierignore_reads, root_prettierignore_present] =
		await Promise.all([
			collect(formatignore_file_name, tsv_layer_presence),
			in_repo ? collect(gitignore_file_name, gitignore_presence) : none,
			in_repo ? collect(prettierignore_file_name, tsv_layer_presence) : none,
			in_repo
				? false
				: stat_type(vscode.Uri.joinPath(folder.uri, prettierignore_file_name)).then(
						(type) => type !== undefined && tsv_layer_presence(type) === 'file'
					)
		]);
	// a newer reload started while this one was reading: its reads are the later
	// snapshot, so this one's result is dropped rather than raced onto the cache
	if (folder_generations.get(key) !== generation) return;

	// the warnings an ignore file that cannot be applied earns (see `IgnoreRead`),
	// gathered here and folded into the folder's hint set below
	const warnings: DirHint[] = [];
	// presence is the listing — an unreadable `.formatignore` is present, and it is
	// presence that shadows a sibling `.prettierignore` (as on the CLI, so a read
	// error can't silently demote tsv's native file to prettier's)
	const formatignore_present = new Set(formatignore_reads.keys());
	const formatignores = ignore_texts(folder, formatignore_file_name, formatignore_reads, warnings);
	// an unreadable or symlinked `.gitignore` drops its rules AND leaves the build-output
	// heuristic on for its subtree (no anchor is pushed), as on the CLI
	const gitignores = ignore_texts(folder, gitignore_file_name, gitignore_reads, warnings);
	// which directories hold a `.prettierignore` at all — the shadow hint is keyed on
	// presence (a shadowed one is never read, so it can earn no read warning), and
	// outside a repo none is read, but the folder-root one's presence is exactly what
	// the outside-repo hint is about
	const prettierignore_present = new Set(prettierignore_reads.keys());
	if (root_prettierignore_present) prettierignore_present.add('');
	// `.prettierignore` is hierarchical inside a repo (like `.formatignore`), read
	// wherever no sibling `.formatignore` is present — the per-directory shadow is
	// applied HERE, on presence: a shadowed one goes unread on the CLI too, its
	// presence alone reported by the shadow hint
	for (const dir of formatignore_present) prettierignore_reads.delete(dir);
	const prettierignores = ignore_texts(
		folder,
		prettierignore_file_name,
		prettierignore_reads,
		warnings
	);

	const layers: FolderLayers = { in_repo, gitignores, formatignores, prettierignores };
	const hints = ignore_hints(
		IgnoreStack,
		folder,
		layers,
		formatignore_present,
		prettierignore_present,
		warnings
	);
	const previous = folder_ignores.get(key);
	folder_ignores.set(key, { ...layers, hints });
	// log the set only when it changed — a reload the watcher fires for an unrelated
	// `.gitignore` save carries the same hints, and repeating them is noise; a set
	// that shrank to nothing is silence, not a line (nothing is unread any more)
	if (hints.length > 0 && (previous === undefined || !same_lines(previous.hints, hints))) {
		for (const hint of hints) log_line(hint);
	}
};

const same_lines = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * The heads-ups tsv's CLI writes to stderr, as one sorted list: the read warnings
 * (`ignore_texts`) plus the two `.prettierignore` hints — an ignore file
 * whose rules go unread, which is a silent misconfiguration the editor would
 * otherwise never surface. The two hints are phrased by the shared matcher so the
 * wording cannot drift from the CLI's, and keyed on PRESENCE (a file's listing, not
 * its readability), exactly as the CLI keys them:
 *
 * - **Outside a repo**, a `.prettierignore` at the folder root is not read at all
 *   (only `.formatignore` is), unless a sibling `.formatignore` already explains it.
 * - **Inside a repo**, a directory holding both files has its `.prettierignore`
 *   shadowed by the sibling `.formatignore` — a present-but-unreadable
 *   `.formatignore` included.
 *
 * Only the CLI's own: `tsv format <folder>` reads the ignore files of a directory only
 * when it descends into one, so a hint about a directory its walk prunes — by a rule, or
 * by the build-output heuristic — is dropped (`is_dir_walked`). The listing reads those
 * files all the same, harmlessly, since a layer under a pruned directory changes no
 * verdict.
 *
 * Computed off the save path (a folder reload only) and logged by the caller to
 * the Output channel, which is not revealed — a hint is information, not a
 * failure, so it must not steal focus from the parse-error indicator.
 * Sorted, so an unchanged tree yields an identical list whatever order `findFiles`
 * returned.
 */
const ignore_hints = (
	IgnoreStack: IgnoreStackCtor,
	folder: vscode.WorkspaceFolder,
	layers: FolderLayers,
	formatignore_present: Set<string>,
	prettierignore_present: Set<string>,
	warnings: DirHint[]
): string[] => {
	const hints = [...warnings];
	const stack = new IgnoreStack();
	try {
		if (layers.in_repo) {
			// per directory: both files present means the tsv layer took the .formatignore
			for (const dir of prettierignore_present) {
				const text = stack.prettierignore_shadowed_warning(
					dir === '' ? folder.name : `${folder.name}/${dir}`,
					true,
					true,
					formatignore_present.has(dir)
				);
				if (text !== undefined) hints.push({ dir, text });
			}
		} else {
			// outside a repo no .prettierignore is read, so the folder-root file's
			// presence is the one thing to ask about
			const text = stack.prettierignore_outside_repo_warning(
				folder.name,
				false,
				prettierignore_present.has(''),
				formatignore_present.has('')
			);
			if (text !== undefined) hints.push({ dir: '', text });
		}
	} finally {
		stack.free();
	}
	return hints
		.filter(({ dir }) => is_dir_walked(IgnoreStack, layers, dir))
		.map(({ text }) => text)
		.sort();
};

const clear_ignore_folder = (key: string): void => {
	folder_ignores.delete(key);
	// a reload still in flight for the dropped folder must not resurrect its state
	folder_generations.delete(key);
	folder_reloads.delete(key);
	git_watchers.get(key)?.dispose();
	git_watchers.delete(key);
};

const clear_ignore_folders = (): void => {
	folder_ignores.clear();
	folder_generations.clear();
	folder_reloads.clear();
	for (const watcher of git_watchers.values()) watcher.dispose();
	git_watchers.clear();
};

/**
 * Brings the tracked folders in line with the current eval roots (`root_folders`):
 * a folder that is no longer a root — removed, or now nested inside a newly added
 * ancestor — drops its state, in-flight reload and `.git` watcher; a root not yet
 * tracked gets its watcher and a reload. The `.git` watcher's presence is the
 * "tracked" mark, since a root always has one.
 *
 * @mutates folder_ignores, git_watchers
 */
const sync_ignore_folders = (): void => {
	const roots = root_folders();
	const root_keys = new Set(roots.map((folder) => folder.uri.toString()));
	const tracked = new Set([
		...folder_ignores.keys(),
		...folder_reloads.keys(),
		...git_watchers.keys()
	]);
	for (const key of tracked) {
		if (!root_keys.has(key)) clear_ignore_folder(key);
	}
	for (const folder of roots) {
		if (git_watchers.has(folder.uri.toString())) continue;
		watch_folder_git(folder);
		void reload_ignore_folder(folder);
	}
};

/**
 * Watch one folder's `.git` entry, whose appearance or removal flips the folder's
 * regime (`in_repo`): `git init` in an open loose folder starts honoring
 * `.gitignore` + `.prettierignore` and drops the outside-repo hint, and removing
 * `.git` does the reverse — without this the flip waited for the next ignore-file
 * save. A non-recursive per-folder pattern (`<folder>/.git` alone, a directory or
 * a worktree's / submodule's `.git` file), never `**​/.git`, which would reach every
 * nested repo and `node_modules`. Replaces any watcher the folder already has.
 *
 * @mutates git_watchers
 */
const watch_folder_git = (folder: vscode.WorkspaceFolder): void => {
	const key = folder.uri.toString();
	git_watchers.get(key)?.dispose();
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(folder, '.git')
	);
	const reload = (): void => {
		void reload_ignore_folder(folder);
	};
	const subscriptions = [watcher, watcher.onDidCreate(reload), watcher.onDidDelete(reload)];
	git_watchers.set(key, {
		dispose() {
			for (const subscription of subscriptions) subscription.dispose();
		}
	});
};

/** The tsv-layer text for one directory: its `.formatignore`, or its
 * `.prettierignore` — which the reload stored only where no sibling `.formatignore`
 * is present (the per-directory shadow is applied at load, on presence). */
const tsv_layer_for_dir = (layers: FolderLayers, dir: string): string | undefined =>
	layers.formatignores.get(dir) ?? layers.prettierignores.get(dir);

/**
 * Runs `f` over a stack holding the layers that govern `rel`, a folder-relative file
 * path — its ancestor directories' `.gitignore` files (inside a repo) and tsv layers — and
 * frees the stack however `f` returns. Synchronous: `layers` is the prebuilt cache.
 */
const with_ignore_stack = <T>(
	IgnoreStack: IgnoreStackCtor,
	layers: FolderLayers,
	rel: string,
	f: (stack: IgnoreStack) => T
): T => {
	const stack = new IgnoreStack();
	try {
		const dirs = ancestor_dirs(rel);
		// `.gitignore` layers shallow→deep (repo only), then tsv layers shallow→deep;
		// the matcher evaluates all gitignores before all tsv layers regardless of
		// push interleaving, so a tsv `!` re-includes over `.gitignore`
		if (layers.in_repo) {
			for (const dir of dirs) {
				const content = layers.gitignores.get(dir);
				if (content !== undefined) stack.push_gitignore(dir, content);
			}
		}
		for (const dir of dirs) {
			const content = tsv_layer_for_dir(layers, dir);
			// TODO: the binding past the pinned range replaces `push_tsv` with
			// `push_formatignore` / `push_prettierignore` — on that range bump, push each map's
			// text by its own kind (and retype `IgnoreStack`), so a layer names its file
			if (content !== undefined) stack.push_tsv(dir, content);
		}
		return f(stack);
	} finally {
		stack.free();
	}
};

/**
 * Whether `tsv format <folder>` descends into `dir` (folder-relative, `''` = the root) and
 * so reads its ignore files: no directory on the way down, `dir` itself included, is
 * pruned — by a rule, a safety net or the build-output heuristic. Asked of a file directly
 * inside `dir`, whose ancestor directories `is_path_pruned` grades.
 */
const is_dir_walked = (
	IgnoreStack: IgnoreStackCtor,
	layers: FolderLayers,
	dir: string
): boolean => {
	if (dir === '') return true;
	const rel = `${dir}/_`;
	return !with_ignore_stack(IgnoreStack, layers, rel, (stack) => stack.is_path_pruned(rel));
};

/**
 * Whether the document is excluded by its workspace folder's ignore files
 * (hierarchical `.gitignore` inside a repo + the hierarchical `.formatignore` /
 * `.prettierignore` tsv layers) or by the CLI's traversal pruning
 * (safety nets + build-output heuristic, via the shared `stack.is_path_pruned`).
 * An open document is graded as a walk from the folder would reach it, not as a named
 * CLI argument (which the ignore files alone bound): opening a file under
 * `node_modules` or a build directory is not intent to reformat it on save.
 * Synchronous — reads only the prebuilt cache, assembling and freeing a per-call
 * `IgnoreStack`. Documents outside every workspace folder (loose/untitled) are
 * never ignored.
 */
const is_document_ignored = (document: vscode.TextDocument): boolean => {
	if (!ignore_stack_ctor) return false;
	const folder = root_folder_for(document.uri);
	if (!folder) return false;
	const state = folder_ignores.get(folder.uri.toString());
	if (!state) return false;
	// No emptiness short-circuit: the build-output heuristic prunes on directory
	// *names* (dist/build/target/hidden), so it can apply even with zero ignore
	// files — the full check below is cheap (an empty stack resolves fast).
	const rel = folder_rel(folder.uri.path, document.uri.path);
	// file-level match, then the shared per-file directory-prune walk (safety
	// nets + build-output heuristic + matcher), which reconstructs the heuristic
	// state from the stack's own `.gitignore` anchors — no walk hand-rolled here
	return with_ignore_stack(
		ignore_stack_ctor,
		state,
		rel,
		(stack) => stack.is_ignored(rel, false) || stack.is_path_pruned(rel)
	);
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
	// one watcher covers .gitignore + the tsv files in every folder; any change
	// re-reads that folder's whole state off the save path (works in both hosts).
	// The watchers go in BEFORE the initial load, so an ignore file or `.git` written
	// during that load is not missed until the next event — a reload they fire
	// meanwhile is just a newer generation, and the initial load waits for it
	const watcher = vscode.workspace.createFileSystemWatcher(
		'**/.{gitignore,prettierignore,formatignore}'
	);
	const on_change = (uri: vscode.Uri): void => {
		// the listing drops ignore files under the safety nets, so one there can't
		// change the state — skip the reload rather than re-scan the folder per
		// package during an install (VS Code's default `files.watcherExclude` covers
		// node_modules, but that is the user's setting to clear)
		const folder = root_folder_for(uri);
		if (!folder) return;
		if (is_under_safety_net(ignore_dir_rel(folder.uri.path, uri.path))) return;
		void reload_ignore_folder(folder);
	};
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(on_change),
		watcher.onDidChange(on_change),
		watcher.onDidDelete(on_change),
		// an added folder's load is not awaited (the event handler can't hold
		// VS Code), so a document in it saved before the load lands formats
		// once un-ignored — the window activation closes for the initial
		// folders, left open here: a folder is added by a user gesture, and a
		// skipped format would be the worse silent outcome
		vscode.workspace.onDidChangeWorkspaceFolders(sync_ignore_folders),
		// the per-folder `.git` watchers, disposed with the extension
		{ dispose: clear_ignore_folders }
	);
	sync_ignore_folders();

	// await the initial load so the cache is populated before the provider can run:
	// activation finishes before VSCode invokes a formatter, so this closes the
	// startup window where an ignored file could format once before its cache landed
	await Promise.all(root_folders().map(ignore_folder_settled));
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
	log_line(document.uri.fsPath);
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
	// TODO: once the pinned range carries it, log `path_shadow_warning(rel,
	// loose_root)` when `is_path_pruned` skips a save, deduped per folder reload
	if (is_document_ignored(document)) {
		// a skipped document is not formatted at all, so a parse-error indicator it left
		// before an ignore file came to cover it no longer describes anything
		clear_format_failure(document);
		return [];
	}
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
