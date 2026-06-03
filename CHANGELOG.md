# Changelog

## 3.0.11

- **`@php` / `@endphp` directive support** — PHP inside `@php ... @endphp` blocks is now projected into the virtual document alongside `<?php ?>` blocks. Completions, hover, go-to-definition, and diagnostics work inside Blade directives as well as standard PHP tags.
- **Completion timing fix** — a `documentSymbols` round-trip after `textDocument/didOpen` acts as a synchronisation barrier so the server finishes parsing a freshly opened document before the first completion request fires. Eliminates the first-trigger miss on new files.
- **Extension settings** — added `bladeBridge.debug` (output channel logging, default off) and `bladeBridge.diagnostics.enabled` (toggle PHP diagnostics in Blade files, default on).
- **README** — Settings section updated to document the two new settings; "Who is this for?" rewritten to welcome Laravel users and clarify the extension's scope.

## 3.0.10

- **Complete rewrite — private LSP server.** Replaced the mirror/temp-file approach with a dedicated Intelephense child process owned by the extension, communicating over stdio. No editor tabs opened, no save dialogs, no Problems-panel pollution from the mirror file.
- **P1008 false-positive filtering** — "Undefined variable" diagnostics suppressed at the client level (Intelephense sends the code as a string `"P1008"`).
- **Blade-aware `use`-statement insertion** — detects whether the first `<?php` block is inside Blade template markup (preceded by `@directive` lines). If so, or if no top-level PHP block exists at all, creates `<?php\nuse Foo;\n?>` at line 0. Subsequent imports append after the last existing `use` line with matching indentation.
- **Method argument snippets** — completion items for callable methods show parameter hints in the dropdown detail line and insert full tab-stop snippets (e.g. `truncate($string, $length, $stopanywhere, $ellipsis)`) on acceptance. Signature parsed from `resolved.documentation` when Intelephense omits `detail` for project-defined methods.
- **Class auto-import** — overlapping-range error on import fixed; fallback `resolveClassFqns` lookup added for files with no existing `use` lines.

## 2.8.5

- **Behaviour fix** — removed silent write to user `settings.json`. The extension no longer auto-injects `tailwindCSS.experimental.classRegex` on activation. Users who want Tailwind completions in PHP/JS strings should add the entry manually (documented in README Settings section).

## 2.8.4

- **README** — screenshot images now use `width` attribute (GitHub strips `style`); images render at capped width without upscaling. Tailwind CSS IntelliSense added to Requirements; `tailwindCSS.experimental.classRegex` setting documented with exact injected value.

## 2.8.3

- **Bug fix** — accepting a class completion no longer opens the Intelephense mirror file in a new tab. The internal navigation command Intelephense attaches to class items was being forwarded verbatim; it now gets stripped from proxied completion items.
- **README** — Tailwind CSS IntelliSense added to Requirements; Settings section now documents the `tailwindCSS.experimental.classRegex` pattern the extension writes automatically, including the exact JSON value.
- Updated media screenshots.

## 2.8.2

- **README cleanup** — removed framework-specific references; extension is framework-agnostic. Shortened the closing credit line.

## 2.8.0

- **Mirrors moved out of the project.** The hidden PHP mirror files are now stored in a single `spectabile-blade-bridge` folder inside the OS temp directory (`%TEMP%` / `/tmp` / `$TMPDIR`) instead of `storage/blade-bridge/` in the workspace. No project footprint, no dependency on any project folder existing, and the same class resolution / diagnostics as before. Cross-platform on Windows, macOS, and Linux. The temp folder is created on first use and removed on deactivate.

## 2.7.2

- **Method-call snippets** now insert editable argument placeholders parsed from the signature (`Str::find($find, $str, $caseSensitive)`), with snippet metacharacters in PHP variable names escaped so placeholder text renders correctly.
- **Unimported-class completion + auto-import**: typing a class name lists every matching class from the workspace index with its fully-qualified name; accepting inserts the `use` statement, matching the file's existing indentation.
- **Import Class** command resolves via the workspace symbol index and prompts when a name is ambiguous (e.g. two `Str` classes).
- **PHP diagnostics** reliably relayed onto Blade lines — the hidden mirror is updated in-memory and saved on edit so Intelephense re-lints fresh content even under `diagnostics.run: "onSave"`.
- Proxied completion items rebuilt into live `CompletionItem` instances so insertion/replacement applies correctly.
- Added marketplace icon, README, and metadata. Removed the unused `vscode-languageclient` dependency.

## 2.x (development)

- Reworked the core from a temp-file/second-server design to a **hidden in-workspace mirror** routed through the already-running Intelephense, fixing cross-file class resolution and diagnostics.

## 1.0.x

- Initial temp-file proof of concept.
