# fuzdev.tsv-format

> VSCode extension: format-on-save for TypeScript/JS, Svelte, and CSS,
> backed by tsv (`@fuzdev/tsv_format_wasm`). Scoped deliberately to **just
> formatting** — one canonical, non-configurable style.

**Status**: v1 implemented — builds both hosts, smoke-tested, packages to a
`.vsix`. Marketplace id is `fuzdev.tsv-format` (the manifest `name` must be
hyphenated — VSCode forbids `_` in extension names; the `displayName` is free
text).

Registers a single synchronous `DocumentFormattingEditProvider` and relies on
VSCode's built-in `editor.formatOnSave`; the extension never listens for save
events itself. tsv is non-configurable, so the extension exposes no settings.
Targets both the Node host (desktop / VSCode Server / remote) and the web host
(vscode.dev / github.dev).

It honors the same ignore files the CLI does, via the `IgnoreStack` export from
`@fuzdev/tsv_format_wasm` — the same matcher, in the CLI's two regimes keyed on
`.git`. **Inside a repo** (a `<folder>/.git` exists): `.gitignore`
**hierarchically** (one per directory, git-faithful) + `.formatignore`
**hierarchically** + `.prettierignore` **hierarchically**, each shadowed by a
*sibling* `.formatignore` in the same directory; tsv layers apply after
`.gitignore`, so a `!` re-includes.
**Outside a repo**: only `.formatignore` (hierarchically); `.gitignore` /
`.prettierignore` are not read — exactly as the CLI does. It skips ignored files
on save **and** on explicit "Format Document": the provider can't tell the two
apart, and a save-hook would break the sync design, so both skip — matching
prettier-vscode. The ignore files are the one config input; they govern *which*
files format, never *how*.

Where the CLI writes a `.prettierignore` heads-up to stderr, the extension writes the
same line — phrased by the shared matcher, never templated here — to its **Output
channel**: outside a repo a lone root `.prettierignore` is not read at all, and inside
a repo one shadowed by a sibling `.formatignore` is not read in that directory. Both
are silent misconfigurations a user cannot otherwise see. The channel is not revealed
for them (a hint is information, not a failure, and must not steal focus from the
parse-error indicator), and they are computed on a folder reload, never on the save
path. The hint set is part of the folder's cached state and is logged only when it
changes — the watcher fires on every ignore-file save, and an unread file is one line,
not one per save; a set that shrinks to nothing is silence, not a line. The
`heuristic_shadow_warning` hint is deliberately *not* surfaced — it reports
a `.gitignore` turning the build-output heuristic off, which changes nothing the user
configured.

An ignore file that is **present but unreadable** — a read error, or invalid UTF-8
(reading is strict UTF-8, as on both CLIs, never a lenient decode into patterns nobody
wrote) — follows the CLI too: its rules are dropped and the CLI's own line
(`could not read <path> (<reason>); its ignore rules are not applied`, restated by hand
from `cli.js` since the two `tsv` bins template it themselves) joins the hint set. An
absent file stays silent (`FileSystemError.FileNotFound`, or `ENOENT` through a custom
provider), and so does a **directory** of that name: as on the CLI, a present ignore file
is a regular file, reached through a link when the name is one — graded from its `stat`
before any read, so a directory is never a false `could not read` line (nor, as a
`.formatignore`, a phantom shadow). Precedence is by **presence**, not readability: an unreadable
`.formatignore` still shadows its sibling `.prettierignore`, an unreadable `.gitignore`
still leaves the build-output heuristic on for its subtree (no anchor is pushed), and
a shadowed `.prettierignore` is never read at all, so it earns the shadow hint alone.
This is what keeps a save touching the same files `tsv format` would.

A **symlinked `.gitignore`** follows the CLI as well. git never reads a `.gitignore`
through a symbolic link in a working tree (gitignore(5)), so neither `tsv` bin applies one,
and neither does the extension: a listed or folder-root `.gitignore` whose `stat` carries
the `SymbolicLink` bit is dropped like an unreadable one — no anchor, so the build-output
heuristic stays on for its subtree — and the CLI's own line (`<path> is a symbolic link,
which git does not follow in a working tree; its ignore rules are not applied`, restated by
hand, since the pinned binding predates `gitignore_symlink_warning`) joins the hint set.
`.formatignore` and `.prettierignore` keep reading through links, as prettier does.

The **workspace folder is treated as the eval root** (the common case where it is
the repo root). The CLI walks up to the `.git` repo root; the extension does not —
ignore files in ancestors *above* an opened subdirectory are out of scope (and
unwatchable from within the folder), so `in_repo` is just "`<folder>/.git`
exists" — re-evaluated on every reload, and a per-folder watcher on that one
`.git` entry (non-recursive, never `**/.git`) fires a reload when it appears or
vanishes, so `git init` in an open loose folder flips the regime at once rather
than at the next ignore-file save. A subdir-opened repo therefore falls back to the loose regime
(`.formatignore` + heuristic, no `.gitignore`) — the conservative side (it skips
more, never formats build output the CLI would skip). In a multi-root workspace the
eval root is the **outermost** open folder containing the document: a package
folder opened beside its repo root (VS Code's own lookup answers the innermost)
is covered by the root, whose ignore files reach it hierarchically as they do for
the CLI run from there, so a nested folder gets no state, watcher or hint of its
own — only folders not nested inside another open folder are tracked, re-derived
on every workspace-folder change.

To match "skip exactly what `tsv format` skips," the extension defers the **whole**
directory-prune decision — both the per-file ancestor *walk* and the prune *verdict*
— to the shared `IgnoreStack.is_path_pruned(rel)` (the tsv workspace's
`tsv_discover` crate). Given the per-document stack, that one call walks `rel`'s
ancestor directories, reconstructs each level's heuristic state from the stack's own
pushed `.gitignore` anchors, and applies the safety nets
(`.git`/`node_modules`/`.sl`/`.hg`/`.svn`/`.jj`), the build-output heuristic
(`dist`/`build`/`target` + hidden dirs with its `!`-re-include override), and the
matcher. So the extension **no longer rebuilds any of that in TypeScript** — not the
walk, and not the `heuristic_active` state machine it used to thread by hand (the one
shared-policy seam it previously kept; it briefly used the per-directory
`classify_dir` for this before `is_path_pruned` existed). The skip check is just
`is_ignored(rel, false) || is_path_pruned(rel)`. (`classify_dir` stays the CLI's
per-directory primitive for a real top-down walk; the extension has none.)

**An open document is not a named path.** The CLI bounds a path an argument *names* by
the ignore files alone — the safety nets and the build-output heuristic prune only what a
walk discovers, so `tsv format node_modules/pkg/a.ts` formats — while the extension keeps
the walk model: a save grades a document by the prunes a `tsv format <folder>` walk
applies on the way down to it (by path, so a document under a symlinked directory, which
that walk does not follow, still formats). Opening a file is not a statement of intent to format it (go-to-definition
lands in `node_modules`, a stack trace in `dist`), and a save that rewrote a vendored or
generated file wholesale would be a surprise; prettier-vscode skips `node_modules` for
the same reason. The skip stays silent, as it is for an ignore-file match, so the CLI's
excluded-argument warning has no counterpart here.

One thing the CLI decides that the extension cannot: `tsv format` reads a path's own
extension and parses `.mjs`/`.mts` as **modules with no script retry**, since those are ES
modules by name. The extension has no path — it dispatches on `languageId`, where `.mjs`
arrives as `javascript` and `.mts` as `typescript` — and calls the bare
`format_typescript(source)`, which takes the module-then-script fallback. So a `.mjs`
holding a legacy sloppy script (a `with` statement, a leading-zero literal) is
unformattable from the CLI and formats on save here. Closing that would mean threading
the file name into the dispatch and passing `{sourceType: 'module'}` — an option the
pinned `@fuzdev/tsv_format_wasm` range does not yet accept, so it waits on the range bump.

## Layout

- `src/format_provider.ts` — host-agnostic core: the provider, languageId →
  `format_*` dispatch (ts/js/css/svelte only), `.svelte` fileName fallback (now
  defensive — the manifest `contributes.languages` owns the `.svelte` → `svelte`
  association, so the id is present even without the Svelte extension),
  status-bar + `tsv` Output channel for parse failures and the `.prettierignore`
  heads-ups, and the gitignore-aware skip logic. Per workspace folder it caches `{in_repo, gitignores, formatignores,
  prettierignores}` — the `.gitignore` / `.formatignore` / `.prettierignore` texts
  keyed by directory (one `findFiles` listing for the three names, plus an
  explicit folder-root read as a backstop for a listing that misses depth 0;
  `.prettierignore` hierarchically inside a repo, each shadowed per-directory by a
  sibling `.formatignore`), the `.git` regime flag and the hint set. The listing's
  exclude is `null` on purpose: `findFiles` applies the user's `files.exclude` on
  top of any exclude glob and disregards it only for `null` (`search.exclude` never
  applies, `.gitignore` is not consulted), and a `**/dist` there would hide an
  ignore file the CLI reads. The safety-net directories are dropped from the
  listing by hand instead — the walk never descends into them, so an ignore file
  under one is never read by the CLI either — at the price of one unexcluded walk
  (`node_modules` included) per reload. The state is prebuilt off the save path
  and refreshed via a `FileSystemWatcher` over
  `**/.{gitignore,prettierignore,formatignore}` (events under a safety net are
  skipped — the listing drops them, so they can't change the state) plus the
  per-folder `.git` watcher, both installed before the initial load so nothing
  written during it is missed. A reload reads every ignore file concurrently, each
  stat-ed first and graded by its name's presence rule (`tsv_layer_presence` /
  `gitignore_presence`: a directory of that name is absent, a symlinked `.gitignore`
  is warned — one stat per listed file on top of its read); for the folder-root files
  `**/` misses, any stat failure is absence, so an absent one
  is silent whatever error shape a virtual-FS provider uses for a missing file
  (classifying a bare error as "unreadable" would fabricate three warnings per
  reload and a phantom `.formatignore` shadow). A generation counter — one across
  folders, so a folder removed and re-added mid-load can't reuse a number — makes
  the latest-STARTED reload win: one whose reads finished after a newer one began
  drops its result, so a burst of events (an editor saving twice, a `git checkout`
  touching several ignore files) can never leave the earlier snapshot cached. On save it assembles a
  per-document `IgnoreStack` from that cache (synchronously), runs `is_ignored` +
  `is_path_pruned`, and frees it, so the provider stays synchronous. Activation
  **awaits** that initial load before registering the provider, closing the
  startup window where a save could beat the cache — and waits for the
  folder's *latest* reload, not merely the first-started one: an ignore file
  written during the load fires a newer reload that supersedes the initial
  one, whose result is then dropped at the generation guard, so awaiting only
  it would resolve with nothing cached; a `findFiles` rejection there
  (likeliest on the web host's virtual FS) is caught and logged, degrading to the
  folder-root ignore files plus the always-on safety-net/heuristic pruning — never
  aborting activation or formatting everything. A folder added later is loaded
  without awaiting (the event handler can't hold VS Code), so a document in it
  saved before that lands formats once un-ignored — left open deliberately, since
  a silently skipped format would be the worse outcome; removing a folder drops
  its state, its in-flight reload and its `.git` watcher.
- `src/extension.node.ts` — Node entry; WASM inits synchronously at import.
- `src/extension.web.ts` — web entry; reads the bundled `.wasm` via
  `context.extensionUri` + `workspace.fs` and `await init(bytes)` once.
- `esbuild.js` — dual CJS build; copies `tsv_wasm_bg.wasm` next to each bundle.
- `icon.png` — 128×128 marketplace icon (`package.json` `icon`); shipped in the
  `.vsix` (not excluded by `.vscodeignore`).

## Manifest shape

Beyond `main`/`browser`/`activationEvents`, the manifest carries:

- `contributes.languages` — declares the `.svelte` → `svelte` association, so a
  `.svelte` file gets the `svelte` languageId (and fires `onLanguage:svelte`)
  **without** the Svelte extension. VSCode core ships no `.svelte` association —
  only the Svelte extension does — so without this, `onLanguage:svelte` would
  never fire for a lone `.svelte` file and the provider would never activate.
  Language contributions merge by id, so this coexists with the Svelte extension
  (adds nothing when it's present). The `{pattern: '**/*.svelte'}` selector and
  the `.svelte` fileName fallback are now redundant backstops.
- `capabilities.untrustedWorkspaces.supported: true` — format-on-save must keep
  working in a Restricted-Mode (untrusted) workspace, the default for a freshly
  opened/cloned folder. Safe to declare: tsv is non-configurable, runs no
  project-supplied code, and reads ignore files as data only.
- `capabilities.virtualWorkspaces: true` — explicit support for the web host's
  virtual workspaces (vscode.dev / github.dev), matching the `browser` entry.

## Committing

`git add` and `git commit` are denied by `.claude/settings.local.json` in this
repo — make the edits and stop, the user commits.

## Build & publish

- TypeScript extension, bundled with esbuild as **CommonJS** for two targets:
  `main` (Node host) and `browser` (web host). Output stays CJS because the web
  Worker extension host still can't load ESM (Node-host ESM landed in 1.100, but
  not the web Worker host) — so `import.meta.url` is dead in both bundles and the
  WASM is loaded explicitly rather than via the package's `new URL(import.meta.url)`
  path. The Node build shims `import.meta.url` to the bundle's own file URL so the
  package's import-time `readFileSync` finds the copied `.wasm`.
- `npm run build` (production) / `npm run watch` / `npm run check` (typecheck +
  build + the `test/run.js` smoke test). `npm run package` builds + runs `npx
  @vscode/vsce package` (vsce is not a dependency — it's invoked transiently).
- Single runtime dependency: `@fuzdev/tsv_format_wasm` — the format-only tsv WASM
  (the smallest of the three variants). Dev deps: esbuild, typescript,
  @types/node (24.x, matching the host), @types/vscode (pinned to the
  `engines.vscode` floor, not latest).
- Published to the VSCode Marketplace (`vsce`) and Open VSX (`ovsx`). Version
  bumps and publishing are the maintainer's responsibility.

### Publishing & updating

The runtime dependency is **vendored into the bundle**: esbuild inlines
`@fuzdev/tsv_format_wasm` and copies its `.wasm` into `dist/{node,web}/`, and
`.vscodeignore` excludes `node_modules/**`. So the `.vsix` ships whatever WASM is
in `node_modules` *at build time* — the published extension does not resolve the
dependency at install time. Two consequences:

- **The bundled WASM must have published provenance.** A tree with a
  locally-built WASM linked into `node_modules` builds fine but can carry
  exports the reported version never published — a `.vsix` built from it ships
  an unpublished WASM. **Before a marketplace publish:** run a clean `npm
  install` so `package-lock.json` resolves the range from the registry. The
  go/no-go check is "`npm ci` succeeds against the registry."
- **Updating the formatter = rebuild, not a user dependency bump.** To pick up a
  new tsv release, bump the `@fuzdev/tsv_format_wasm` range (caret ranges on 0.x
  don't cross minors, so each tsv minor needs a range bump), `npm install`, `npm
  run check`, then re-`package`/publish. There is no runtime auto-update of the
  formatter — its version is frozen into each `.vsix`.

Publish flow (maintainer-owned): `npm run check` → bump `version` → `npm run
package` (or `vsce publish`) for the Marketplace → `ovsx publish` for Open VSX.
Keep the published WASM in sync across both registries. The `engines.vscode`
floor (`^1.90.0`) and `@types/vscode` track the **minimum** supported host, not
latest; raise both together only when a newer host API is actually needed.

**Pre-publish checklist** (live confirmation, can't be driven headlessly):
desktop **multi-root** + the **web** host (vscode.dev / github.dev) — F5 via
`.vscode/launch.json` ("Run Extension (Desktop)" / "(Web)").
