# Changelog

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
