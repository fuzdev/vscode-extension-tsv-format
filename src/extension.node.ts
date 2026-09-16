import type * as vscode from 'vscode';
import {
	format_css,
	format_svelte,
	format_typescript,
	IgnoreStack,
	reinstantiate
} from '@fuzdev/tsv-format-wasm';
import { activate_formatter, deactivate_formatter } from './format_provider.ts';

// Node extension host (desktop, VSCode Server, remote-SSH / WSL / Codespaces):
// the package's Node entry initializes WASM synchronously at import, so the
// formatters are ready the instant `activate` runs. Activation still awaits the
// one-time ignore-file load (so the skip cache is ready before the first save);
// the per-format path stays synchronous.
export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
	await activate_formatter(
		context,
		{ format_css, format_svelte, format_typescript, reinstantiate },
		IgnoreStack
	);
};

export const deactivate = deactivate_formatter;
