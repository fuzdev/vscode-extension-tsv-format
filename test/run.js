// Builds and runs the smoke test (test/smoke.ts). esbuild bundles it with
// `vscode` aliased to the mock and `@fuzdev/tsv-format-wasm` inlined (CJS +
// import.meta.url shim, like the extension's Node build), copies the `.wasm` next
// to the bundle, and runs it under Node. Output goes to the OS temp dir so nothing
// lands in the repo or the shipped `.vsix`. Exits non-zero if any case fails.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const repo = path.dirname(__dirname);
const esbuild = require(path.join(repo, 'node_modules/esbuild'));

const out_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv-ext-smoke-'));
const out_file = path.join(out_dir, 'smoke.cjs');

const wasm_src = path.join(
	path.dirname(require.resolve('@fuzdev/tsv-format-wasm/package.json', { paths: [repo] })),
	'tsv_wasm_bg.wasm'
);
fs.copyFileSync(wasm_src, path.join(out_dir, 'tsv_wasm_bg.wasm'));

esbuild
	.build({
		entryPoints: [path.join(repo, 'test/smoke.ts')],
		outfile: out_file,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		absWorkingDir: repo,
		alias: { vscode: path.join(repo, 'test/mock_vscode.cjs') },
		banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
		define: { 'import.meta.url': 'import_meta_url' },
		logLevel: 'warning'
	})
	.then(() => {
		const out = execFileSync('node', [out_file], { encoding: 'utf-8' });
		process.stdout.write(out);
		fs.rmSync(out_dir, { recursive: true, force: true });
	})
	.catch((err) => {
		if (err.stdout) process.stdout.write(err.stdout);
		if (err.stderr) process.stderr.write(err.stderr);
		fs.rmSync(out_dir, { recursive: true, force: true });
		process.exit(1);
	});
