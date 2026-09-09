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
			throw new Error(`ENOENT ${uri.path}`);
		},
		async readFile(uri) {
			const content = world.files.get(uri.path);
			if (content === undefined) throw new Error(`ENOENT ${uri.path}`);
			return enc.encode(content);
		}
	},
	createFileSystemWatcher() {
		// the extension registers one listener for all three events; keep the
		// change one so a test can fire an ignore-file reload (`__fire_ignore_change`)
		const sub = () => ({ dispose() {} });
		return {
			onDidCreate: sub,
			onDidChange(listener) {
				ignore_change_listener = listener;
				return { dispose() {} };
			},
			onDidDelete: sub,
			dispose() {}
		};
	},
	onDidChangeWorkspaceFolders() {
		return { dispose() {} };
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
// the watcher's change listener, so a test can trigger a folder reload
let ignore_change_listener;

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
	},
	__get_output_lines() {
		return output_lines;
	},
	/** Fire the ignore-file watcher for `rel` under the folder root (a reload). */
	__fire_ignore_change(rel) {
		ignore_change_listener?.(Uri.file(`${world.folder_path}/${rel}`));
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
