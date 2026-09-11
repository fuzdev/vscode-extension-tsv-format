// Minimal mock of the `vscode` module for the smoke test (test/smoke.ts). Backed
// by an in-memory "world" (files + dirs under one workspace folder, optionally
// with nested workspace folders) set per scenario. findFiles deliberately omits
// the folder-root file from its listing — harsher than VS Code, whose `**/` lists
// depth 0 — so the provider's explicit-root-read backstop is always exercised.
'use strict';

let world = { folder_path: '/repo', files: new Map(), dirs: new Set() };
let captured_provider;
let status_item;
let close_listener;

const enc = new TextEncoder();

class Uri {
	constructor(path) {
		this.path = path;
		this.fsPath = path;
		this.scheme = 'file';
	}
	toString() {
		return `file://${this.path}`;
	}
	static file(p) {
		return new Uri(p);
	}
	static joinPath(uri, ...parts) {
		return new Uri([uri.path, ...parts].join('/'));
	}
}

class RelativePattern {
	constructor(folder, pattern) {
		this.folder = folder;
		this.pattern = pattern;
	}
}

class Range {
	constructor(start, end) {
		this.start = start;
		this.end = end;
	}
}

const TextEdit = {
	replace(range, newText) {
		return { range, newText };
	}
};

const StatusBarAlignment = { Left: 1, Right: 2 };

// the shape of `vscode.FileSystemError.FileNotFound()`: the extension keys
// "absent" (silent) vs "unreadable" (warned) on this code
// (a world may ask for BARE errors instead — a virtual-FS provider that reports a
// missing file with no code at all, which the extension must still read as absent)
const not_found = (uri) =>
	world.bare_not_found_errors
		? new Error(`no such file: ${uri.path}`)
		: Object.assign(new Error(`ENOENT ${uri.path}`), { code: 'FileNotFound' });

// the workspace folders: the main one (absent after `__fire_workspace_folders_changed('removed')`,
// as the real `workspaceFolders` is updated before the event fires) plus any nested
// folders the world declares (`nested_folders`, paths under the main one — a monorepo
// workspace with the repo root and a package folder both open)
const folders = () => {
	const out = main_folder_removed
		? []
		: [{ uri: Uri.file(world.folder_path), name: 'repo', index: 0 }];
	for (const p of world.nested_folders ?? []) {
		out.push({ uri: Uri.file(p), name: p.slice(p.lastIndexOf('/') + 1), index: out.length });
	}
	return out;
};
let main_folder_removed = false;

const workspace = {
	get workspaceFolders() {
		return folders();
	},
	// the INNERMOST folder containing `uri`, as VS Code's longest-prefix lookup answers
	getWorkspaceFolder(uri) {
		let found;
		for (const f of folders()) {
			if (uri.path !== f.uri.path && !uri.path.startsWith(`${f.uri.path}/`)) continue;
			if (!found || f.uri.path.length > found.uri.path.length) found = f;
		}
		return found;
	},
	// the extension passes `null` as the exclude — the one value that disregards the
	// user's `files.exclude` (a string exclude leaves it in force) — and drops the
	// safety-net directories itself, so the listing here holds everything, node_modules
	// included, and a non-null exclude is a mock error rather than silently modeled
	async findFiles(relPattern, exclude) {
		if (exclude !== null) throw new Error(`mock: findFiles expects a null exclude, got ${exclude}`);
		// opt-in failure injection: exercises the web-host virtual-FS rejection path
		if (world.find_files_throws) throw new Error('findFiles failed (mock)');
		const m = /^\*\*\/\.\{([^}]*)\}$/.exec(relPattern.pattern);
		if (!m) throw new Error(`mock: unsupported findFiles glob ${relPattern.pattern}`);
		const names = new Set(m[1].split(',').map((n) => `.${n}`));
		const root = relPattern.folder.uri.path;
		const out = [];
		for (const p of world.files.keys()) {
			if (!p.startsWith(`${root}/`)) continue;
			const rel = p.slice(root.length + 1);
			// root-level files are left out on purpose (see the header)
			if (!rel.includes('/')) continue;
			if (names.has(rel.slice(rel.lastIndexOf('/') + 1))) out.push(Uri.file(p));
		}
		return out;
	},
	fs: {
		async stat(uri) {
			// `FileType.File` is 1 and `Directory` 2; a link carries the `SymbolicLink` bit
			// (64) beside its target's type, as VS Code's own stat does
			if (world.files.has(uri.path)) return { type: world.symlinks?.has(uri.path) ? 1 | 64 : 1 };
			if (world.dirs.has(uri.path)) return { type: 2 };
			throw not_found(uri);
		},
		// a file's content may be raw bytes (so a test can hand the extension invalid
		// UTF-8), and a path in `world.unreadable` is present but fails to read — the
		// two ways an ignore file is present-but-unreadable
		async readFile(uri) {
			const content = world.files.get(uri.path);
			// reading a directory fails as VS Code's does — `FileIsADirectory`, not a
			// not-found — so a directory named like an ignore file must be caught before a read
			if (content === undefined && world.dirs.has(uri.path)) {
				throw Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {
					code: 'FileIsADirectory'
				});
			}
			if (content === undefined) throw not_found(uri);
			if (world.unreadable?.has(uri.path)) {
				throw Object.assign(new Error(`EACCES: permission denied, open '${uri.path}'`), {
					code: 'NoPermissions'
				});
			}
			// the bytes are taken BEFORE the gate, so a reload held here has already
			// read the world as it was when it started — how a test makes an earlier
			// reload finish after a later one
			if (world.read_gate) await world.read_gate;
			return typeof content === 'string' ? enc.encode(content) : content;
		}
	},
	// watchers are kept with their pattern so `__fire_watcher` delivers an event only
	// to the ones whose glob matches, as VS Code does — the ignore-file glob and the
	// per-folder `.git` pattern must not hear each other's events
	createFileSystemWatcher(pattern) {
		const watcher = { pattern, create: [], change: [], delete: [] };
		watchers.push(watcher);
		const on = (kind) => (listener) => {
			watcher[kind].push(listener);
			return {
				dispose() {
					watcher[kind] = watcher[kind].filter((l) => l !== listener);
				}
			};
		};
		return {
			onDidCreate: on('create'),
			onDidChange: on('change'),
			onDidDelete: on('delete'),
			dispose() {
				watchers = watchers.filter((w) => w !== watcher);
			}
		};
	},
	onDidChangeWorkspaceFolders(listener) {
		workspace_folders_listener = listener;
		return {
			dispose() {
				if (workspace_folders_listener === listener) workspace_folders_listener = undefined;
			}
		};
	},
	onDidCloseTextDocument(listener) {
		close_listener = listener;
		return {
			dispose() {
				if (close_listener === listener) close_listener = undefined;
			}
		};
	},
	asRelativePath(uri) {
		return uri.path;
	}
};

// every line the extension writes to its Output channel, so a test can assert on the
// ignore-file hints (which are logged, never thrown or shown)
let output_lines = [];
// the live file-system watchers (see `createFileSystemWatcher`)
let watchers = [];
let workspace_folders_listener;

/** Whether a watcher's glob matches a path — the two shapes the extension uses:
 * `**​/.{a,b,c}` (a basename set anywhere) and `RelativePattern(folder, '.git')`
 * (one exact entry directly under the folder). */
const watcher_matches = (pattern, uri_path) => {
	if (pattern instanceof RelativePattern) {
		return uri_path === `${pattern.folder.uri.path}/${pattern.pattern}`;
	}
	const m = /^\*\*\/\.\{([^}]*)\}$/.exec(pattern);
	if (!m) throw new Error(`mock: unsupported watcher glob ${pattern}`);
	const basename = uri_path.slice(uri_path.lastIndexOf('/') + 1);
	return m[1].split(',').some((name) => `.${name}` === basename);
};

const window = {
	createOutputChannel() {
		return {
			appendLine(line) {
				output_lines.push(line);
			},
			show() {},
			dispose() {}
		};
	},
	createStatusBarItem() {
		status_item = {
			text: '',
			tooltip: '',
			command: '',
			visible: false,
			show() {
				this.visible = true;
			},
			hide() {
				this.visible = false;
			},
			dispose() {}
		};
		return status_item;
	}
};

const commands = {
	registerCommand() {
		return { dispose() {} };
	}
};

const languages = {
	registerDocumentFormattingEditProvider(_selector, provider) {
		captured_provider = provider;
		return { dispose() {} };
	}
};

module.exports = {
	Uri,
	// the `workspace.fs.stat` type bits the extension reads
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	RelativePattern,
	Range,
	TextEdit,
	StatusBarAlignment,
	workspace,
	window,
	commands,
	languages,
	// test hooks
	__set_world(w) {
		world = w;
		output_lines = [];
		watchers = [];
		workspace_folders_listener = undefined;
		main_folder_removed = false;
	},
	__get_output_lines() {
		return output_lines;
	},
	/** Deliver a `create` / `change` / `delete` event for `rel` under the folder root
	 * to every live watcher whose pattern matches it. */
	__fire_watcher(kind, rel) {
		const uri = Uri.file(`${world.folder_path}/${rel}`);
		for (const watcher of watchers) {
			if (!watcher_matches(watcher.pattern, uri.path)) continue;
			for (const listener of watcher[kind]) listener(uri);
		}
	},
	/** The live (undisposed) watchers' patterns, so a test can assert on disposal. */
	__watcher_patterns() {
		return watchers.map((w) =>
			typeof w.pattern === 'string' ? w.pattern : `<folder>/${w.pattern.pattern}`
		);
	},
	/** Remove / re-add the main mock folder: `workspaceFolders` reflects it first, then
	 * the workspace-folders listener fires, as in VS Code. */
	__fire_workspace_folders_changed(kind) {
		const folder = { uri: Uri.file(world.folder_path), name: 'repo', index: 0 };
		main_folder_removed = kind === 'removed';
		workspace_folders_listener?.({
			added: kind === 'added' ? [folder] : [],
			removed: kind === 'removed' ? [folder] : []
		});
	},
	__get_provider() {
		return captured_provider;
	},
	__get_status_item() {
		return status_item;
	},
	__fire_close(doc) {
		if (close_listener) close_listener(doc);
	}
};
