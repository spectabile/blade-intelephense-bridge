# Blade Intelephense Bridge

**Full PHP [Intelephense](https://marketplace.visualstudio.com/items?itemName=bmewburn.vscode-intelephense-client) intelligence inside `.blade.php` files** — the same completions, diagnostics, and navigation you get in plain `.php`, now in your Blade templates.

Blade files are registered under the `blade` language, which Intelephense ignores (its language server only attaches to `php`). This extension bridges that gap: it spawns a **private Intelephense language server** as a child process and feeds it a PHP projection of each Blade file over the LSP protocol — so completions, hover, go-to-definition, signature help, and diagnostics all work inside `.blade.php` exactly as they do in plain `.php` files.

---

## Screenshots

**Import an unimported class — auto-inserts the `use` statement**

<img src="https://github.com/spectabile/blade-intelephense-bridge/raw/HEAD/media/2.1.php-import-class-steps.gif" alt="Import class steps" width="1024">

**Add a method call — snippet with tab stops for each argument**

<img src="https://github.com/spectabile/blade-intelephense-bridge/raw/HEAD/media/2.2.php-add-method-steps.gif" alt="Add method steps" width="720">

**Tailwind class completions inside a PHP string**

<img src="https://github.com/spectabile/blade-intelephense-bridge/raw/HEAD/media/2.3.php-tailwind-css-steps.gif" alt="Tailwind CSS in PHP" width="1024">

**Tailwind class completions inside a JS string**

<img src="https://github.com/spectabile/blade-intelephense-bridge/raw/HEAD/media/2.4.js-tailwind-css-steps.gif" alt="Tailwind CSS in JS" width="920">

---

## Who is this for?

This extension is built for **custom PHP frameworks that use the Blade template engine** where Blade files contain plain PHP calling your own classes and helpers, and you want first-class PHP intelligence in them.

> **Not for stock Laravel.** Laravel projects are better served by dedicated Laravel tooling (e.g. [Laravel](https://marketplace.visualstudio.com/items?itemName=laravel.vscode-laravel) and community extensions like [Laravel Blade Snippets](https://marketplace.visualstudio.com/items?itemName=onecentlin.laravel-blade)), which understand Blade directives, facades, views, and routes natively. This bridge is intentionally framework-agnostic — it does not know about Laravel's `@directives`, facades, or container — it simply exposes raw PHP/class intelligence inside Blade markup.

---

## Features

- **Class & method completion** — `Str::`, `$model->`, your project classes, vendor classes, PHP built-ins.
- **Method-call snippets** — accepting a method inserts its full call with editable argument placeholders: `Str::find($find, $str, $caseSensitive)`, Tab through each.
- **Unimported-class completion + auto-import** — type a class name (e.g. `Str`) and pick from every matching class in your workspace, shown with its fully-qualified name. Accepting inserts the `use Spectabile\Foundation\Str;` statement automatically, matching your file's existing indentation.
- **Hover documentation** — full type info and PHPDoc on hover.
- **Go to definition** — jump straight to the class, method, or function source.
- **Signature help** — parameter hints as you type call arguments.
- **PHP diagnostics** — real Intelephense errors and warnings, relayed onto the exact lines of your Blade file.
- **Import Class command** — right-click a class name → **Blade: Import Class**. If several classes share the name, pick which one to import.
- **Tailwind class completions in PHP & JS strings** — if you use [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) and add a one-line `classRegex` entry to your `settings.json` (see [Settings](#settings)), Tailwind completions fire inside any string literal in `.blade.php`, `.php`, and `.js` files — not just inside HTML `class="..."` attributes. Works for `$var = 'flex items-center'`, ternary branches, and JS property assignments alike.

PHP intelligence comes from a **private Intelephense instance** that the bridge spawns at activation time — it indexes the same workspace folders and honours the same licence key as your main Intelephense installation. Tailwind completions continue to come from your existing Tailwind CSS IntelliSense instance.

---

## Requirements

- [**PHP Intelephense**](https://marketplace.visualstudio.com/items?itemName=bmewburn.vscode-intelephense-client) (`bmewburn.vscode-intelephense-client`) must be installed and active. This extension is a bridge to it, not a replacement.
- A Blade language grammar that registers `.blade.php` under the `blade` language id (for example [Laravel Blade Snippets](https://marketplace.visualstudio.com/items?itemName=onecentlin.laravel-blade) — only its grammar is needed; its Laravel snippets are independent of this bridge).
- [**Tailwind CSS IntelliSense**](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) (`bradlc.vscode-tailwindcss`) — optional. Required only for Tailwind class completions inside PHP and JS string literals. See [Settings](#settings) for the one-line entry to add to your `settings.json`.

---

## Settings

This extension has **no settings of its own** — it works out of the box once Intelephense, a Blade grammar, and Tailwind CSS IntelliSense are installed.

### `tailwindCSS.experimental.classRegex`

If you use Tailwind CSS and want completions to fire inside PHP or JS string literals — not just inside HTML `class="..."` attributes — add this to your `settings.json`:

```jsonc
"tailwindCSS.experimental.classRegex": [
  ["[\"'`]([^\"'`\\n]+)[\"'`]", "([^\"'`\\n]+)"]
]
```

Without this entry, Tailwind IntelliSense only completes inside HTML attributes and is silent in blade/PHP/JS string contexts. With it, completions work for `$var = 'flex items-center'`, ternary branches, and JS property assignments alike.

Its behaviour does, however, follow a few of **Intelephense's** settings:

| Intelephense setting | Effect on the bridge |
| --- | --- |
| `intelephense.diagnostics.run` | When to surface PHP errors in Blade files. `"onType"` shows them live; `"onSave"` shows them after edits (the bridge updates the virtual document on every change, so errors still appear either way). |
| `intelephense.diagnostics.enable` | Master switch for diagnostics. If `false`, no errors are relayed onto Blade files. |
| `intelephense.files.exclude` | Folders Intelephense will not index. Keep your project source out of this list so classes resolve in Blade files. |

You do **not** need to add the OS temp folder to any `include`/`exclude` list — the bridge opens each mirror explicitly, so Intelephense picks it up regardless.

For Tailwind completions to appear automatically inside JS strings (without pressing `Ctrl+Space`), ensure `"other"` is enabled in your `[javascript]` quick suggestions:

```jsonc
"[javascript]": {
  "editor.quickSuggestions": {
    "strings": true,
    "other": "on"
  }
}
```

If `.blade.php` files open as plain `php` (or `html`) instead of `blade`, ensure your Blade grammar's file association is active:

```jsonc
"files.associations": {
  "*.blade.php": "blade"
}
```

---

## How it works

For each open Blade file the extension maintains a **virtual PHP document** — a projection of the template's PHP regions with non-PHP areas blanked out so **line and column positions stay identical** to the original Blade file. No position translation is ever needed.

> **No files are written to disk.** Virtual documents exist only in the private Intelephense server's in-memory document store — they are never written to the filesystem, never appear as editor tabs, and never touch your repository.

At activation the extension locates the Intelephense JS server binary that ships inside the `bmewburn.vscode-intelephense-client` extension and spawns it as a child process. The two processes communicate over JSON-RPC/LSP on stdio with `Content-Length`-framed messages — exactly as VS Code would, but without any editor UI involvement.

When a Blade file **opens**, its PHP projection is sent to the private server via `textDocument/didOpen`. On every **edit**, the full updated projection is sent via `textDocument/didChange`. On **close**, `textDocument/didClose` is sent and the record is discarded.

All LSP providers (completions, hover, definition, signature help) look up the virtual URI for the current Blade file, delegate the request to the private server at the same cursor position, and return results verbatim — position remapping is unnecessary because the projection preserves layout exactly.

**Diagnostics** arrive as `textDocument/publishDiagnostics` push notifications from the private server. They are remapped to the real Blade file URI and placed into VS Code's diagnostic collection. The `P1008 / undefinedVariables` diagnostic is suppressed globally — Blade view variables are always injected at runtime by the controller and are never declared in the template.

---

## Commands

| Command | Description |
| --- | --- |
| **Blade: Import Class** | Resolve the class under the cursor from the workspace index and insert its `use` statement. Prompts when the name is ambiguous. |
| **Blade Bridge: Diagnose** | Show bridge status (mirror path, language id, completion counts) for troubleshooting. |

---

## Notes

- Virtual PHP documents live only in the private Intelephense server's memory — no files are written to disk, nothing touches version control.
- Diagnostics honour your `intelephense.diagnostics.run` setting; the virtual document is updated on every edit so errors surface even under `"onSave"`.
- Cross-platform: the extension works on Windows, macOS, and Linux.
- Multi-root workspaces are supported — each Blade file gets its own virtual document, keyed by its full path.

---

*Developed in collaboration with [Claude Code](https://claude.ai/code) (Anthropic).*
