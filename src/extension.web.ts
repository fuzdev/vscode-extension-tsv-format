import * as vscode from 'vscode';
import {
	format_css,
	format_svelte,
	format_typescript,
	IgnoreStack,
	init,
	reinstantiate
} from '@fuzdev/tsv_format_wasm';
import { activate_formatter, deactivate_formatter } from './format_provider.ts';

// Web extension host (vscode.dev / github.dev — a Web Worker): the browser build
// needs one async WASM init before the first format. We read the bundled `.wasm`
// through the extension's own URI — which resolves in any host without relying on
// `import.meta.url` (dead in a CJS bundle) — and init from the bytes. After this,
// every per-format call is synchronous, identical to the Node host's hot path.
export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
	const wasm_uri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'web', 'tsv_wasm_bg.wasm');
	const wasm_bytes = await vscode.workspace.fs.readFile(wasm_uri);
	await init({ module_or_path: wasm_bytes });
	// `reinstantiate` is synchronous, which the web host's Worker allows (a browser
	// main thread would not) — it never recompiles, reusing the module compiled here
	await activate_formatter(
		context,
		{ format_css, format_svelte, format_typescript, reinstantiate },
		IgnoreStack
	);
};

export const deactivate = deactivate_formatter;
