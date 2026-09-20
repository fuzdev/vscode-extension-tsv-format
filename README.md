# fuzdev.tsv-format

This is a VSCode extension with format-on-save for TypeScript/JS, Svelte, and CSS
using [tsv](https://github.com/fuzdev/tsv), a Rust formatter
similar to Prettier + prettier-plugin-svelte.

tsv has one canonical, non-configurable style (like `gofmt` and Python's Black).
There's no `.prettierrc`, no settings, no plugin discovery.
It runs in both the desktop and the web extension hosts
(like `vscode.dev` and `github.dev`) using wasm.
(tsv's native builds ship separately as the [`@fuzdev/tsv`](https://www.npmjs.com/package/@fuzdev/tsv)
npm package, outside this extension.)

## Install

`fuzdev.tsv-format` on:

- [VSCode marketplace](https://marketplace.visualstudio.com/items?itemName=fuzdev.tsv-format)
- [Open VSX Registry](https://open-vsx.org/extension/fuzdev/tsv-format)

## What it formats

- TypeScript - `.ts`/`.mts`/`.cts`
- JS - `.js`/`.mjs`/`.cjs`
- Svelte - `.svelte`
- CSS - `.css`

These are planned for the future:

- `.json`/`.jsonc`
- `.html`

tsv will not support:

- `.jsx`/`.tsx` (`typescriptreact`/`javascriptreact`)
- `.scss`/`.less`

## Setup

This extension registers a formatter but doesn't change your settings. To make
it the default formatter and format on save, add this to your `settings.json`:

```jsonc
{
  "editor.formatOnSave": true,
  "[typescript]": {"editor.defaultFormatter": "fuzdev.tsv-format"},
  "[javascript]": {"editor.defaultFormatter": "fuzdev.tsv-format"},
  "[svelte]": {"editor.defaultFormatter": "fuzdev.tsv-format"},
  "[css]": {"editor.defaultFormatter": "fuzdev.tsv-format"}
}
```

You can also run **Format Document** manually. There is no **Format Selection**
support - for now tsv formats whole files only.

## How it behaves

- **Format on save** is VSCode's built-in feature; this extension just provides
  the formatter. It applies edits synchronously, so a save can't race against an
  in-flight format.
- **Ignore directives** (`format-ignore` and the `prettier-ignore` alias) are
  honored by tsv itself.
- **Ignore files** are respected: a file your project ignores via `.gitignore`
  (hierarchically, like git, inside a repo), a `.formatignore` (hierarchically), or
  a `.prettierignore` (also hierarchically, inside a repo) is skipped on save *and* on Format Document —
  matching what `tsv format` would skip on the command line (including its
  build-output skips like `dist/` and `build/`).
- **Parse errors** never interrupt you: the file is left unchanged, a small
  `⚠ tsv` item appears in the status bar, and the details go to the **tsv**
  Output channel (click the status item, or run **tsv format: Show Output**).

## Contributing

[fuz.dev/contributing](https://www.fuz.dev/contributing)

## License

[MIT](LICENSE)
