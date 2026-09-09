// Minimal mock of the `vscode` module for the smoke test (test/smoke.ts). Backed
// by an in-memory "world" (files + dirs under one workspace folder) set per
// scenario. findFiles deliberately mirrors VSCode's `**/` glob, which MISSES the
// folder-root file — so the provider's explicit-root-read fallback is exercised
// (the absence of which was a real bug this test caught).
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
const not_found = (uri) => Object.assign(new Error(`ENOENT ${uri.path}`), { code: 'FileNotFound' });

const folders = () => [{ uri: Uri.file(world.folder_path), name: 'repo', index: 0 }];

const workspace = {
	get workspaceFolders() {
		return folders();
	},
	getWorkspaceFolder(uri) {
		const f = folders()[0];
		return uri.path === f.uri.path || uri.path.startsWith(`${f.uri.path}/`) ? f : undefined;
	},
	async findFiles(relPattern, _exclude) {
		// opt-in failure injection: exercises the web-host virtual-FS rejection path
		if (world.find_files_throws) throw new Error('findFiles failed (mock)');
		const name = relPattern.pattern.replace(/^\*\*\//, '');
		const root = relPattern.folder.uri.path;
		const out = [];
		for (const p of world.files.keys()) {
			if (!p.startsWith(`${root}/`)) continue;
			const rel = p.slice(root.length + 1);
			if (rel.includes('node_modules/')) continue;
			// `**/` requires at least one dir segment — root-level files are missed
			if (!rel.includes('/')) continue;
			if (rel.slice(rel.lastIndexOf('/') + 1) === name) out.push(Uri.file(p));
		}
		return out;
	},
	fs: {
		async stat(uri) {
			if (world.files.has(uri.path)) return { type: 1 };
			if (world.dirs.has(uri.path)) return { type: 2 };
			throw not_found(uri);
		},
		// a file's content may be raw bytes (so a test can hand the extension invalid
		// UTF-8), and a path in `world.unreadable` is present but fails to read — the
		// two ways an ignore file is present-but-unreadable
		async readFile(uri) {
			const content = world.files.get(uri.path);
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
		return watchers.map((w) => (typeof w.pattern === 'string' ? w.pattern : `<folder>/${w.pattern.pattern}`));
	},
	/** Fire the workspace-folders listener with the one mock folder added/removed. */
	__fire_workspace_folders_changed(kind) {
		const folder = folders()[0];
		workspace_folders_listener?.({ added: kind === 'added' ? [folder] : [], removed: kind === 'removed' ? [folder] : [] });
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
