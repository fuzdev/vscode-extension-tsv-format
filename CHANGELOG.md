# fuzdev.tsv-format

Each release freezes one [tsv](https://github.com/fuzdev/tsv) version into its
`.vsix` — the formatter is bundled, not resolved at install time, so new tsv
fixes arrive only in a new extension release. Every entry names the tsv version
it ships.

## Unreleased

- chore: bundle tsv 0.4.1 (was 0.4.0) — formatting and parsing fixes, tracking
  Svelte 5.57.0. No extension changes; ignore-file handling is unchanged

## 0.1.0

- feat: initial release, bundling tsv 0.4.0 — format-on-save for TypeScript/JS,
  Svelte and CSS in both the desktop and web (`vscode.dev` / `github.dev`)
  extension hosts, via a single non-configurable `DocumentFormattingEditProvider`
- feat: honor the same ignore files the tsv CLI does — `.gitignore`,
  `.formatignore` and `.prettierignore` hierarchically inside a repo,
  `.formatignore` alone outside one — plus tsv's directory pruning, so a save
  touches exactly the files `tsv format` would
- feat: report parse failures and engine traps on a `⚠ tsv` status item and a
  `tsv` Output channel, recovering the WASM engine so one bad document can't
  break format-on-save for the rest of the session
