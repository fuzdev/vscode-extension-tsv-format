// Bundles the extension as CommonJS for both VSCode hosts:
//   - dist/node/extension.js  (platform=node)    -> WASM inits sync at import
//   - dist/web/extension.js   (platform=browser) -> `await init(bytes)` at activation
// VSCode loads extension entry points as CommonJS (the web Worker host still
// can't load ESM), so `import.meta.url` is dead in both bundles. We therefore
// don't rely on it for WASM: the `.wasm` is copied next to each bundle and loaded
// by file path (Node) or `context.extensionUri` (web). See README.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// the format-only WASM lives next to the package's package.json
const wasm_path = path.join(
	path.dirname(require.resolve('@fuzdev/tsv-format-wasm/package.json')),
	'tsv_wasm_bg.wasm'
);

/** Copies `tsv_wasm_bg.wasm` next to a bundle after each (re)build. */
const copy_wasm_plugin = (out_dir) => ({
	name: 'copy-wasm',
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length) return;
			fs.mkdirSync(out_dir, { recursive: true });
			fs.copyFileSync(wasm_path, path.join(out_dir, 'tsv_wasm_bg.wasm'));
		});
	}
});

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	external: ['vscode'],
	logLevel: 'info'
};

/** @type {Array<import('esbuild').BuildOptions>} */
const targets = [
	{
		...shared,
		entryPoints: ['src/extension.node.ts'],
		outfile: 'dist/node/extension.js',
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		// The package's Node entry inits WASM at import via `readFileSync(new
		// URL('./tsv_wasm_bg.wasm', import.meta.url))`. CJS has no live import.meta,
		// so resolve it to the bundle's own file URL -> reads dist/node/*.wasm.
		banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
		define: { 'import.meta.url': 'import_meta_url' },
		plugins: [copy_wasm_plugin(path.resolve('dist/node'))]
	},
	{
		...shared,
		entryPoints: ['src/extension.web.ts'],
		outfile: 'dist/web/extension.js',
		platform: 'browser',
		format: 'cjs',
		target: 'es2022',
		// The browser entry's `new URL(import.meta.url)` default is dead code here
		// (we always hand init the bytes), so silence the empty-import-meta warning.
		logOverride: { 'empty-import-meta': 'silent' },
		plugins: [copy_wasm_plugin(path.resolve('dist/web'))]
	}
];

const main = async () => {
	if (watch) {
		const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
		await Promise.all(contexts.map((c) => c.watch()));
		console.log('[esbuild] watching both targets...');
		return;
	}
	await Promise.all(targets.map((t) => esbuild.build(t)));
	console.log('[esbuild] build complete');
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
