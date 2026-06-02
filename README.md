# Blade Intelephense Bridge

**Full PHP [Intelephense](https://marketplace.visualstudio.com/items?itemName=bmewburn.vscode-intelephense-client) intelligence inside `.blade.php` files** — the same completions, diagnostics, and navigation you get in plain `.php`, now in your Blade templates.

Blade files are registered under the `blade` language, which Intelephense ignores (its language server only attaches to `php`). This extension bridges that gap: it mirrors the PHP regions of your Blade file into a hidden `php` document that Intelephense *does* index, then routes completion, hover, definition, and signature requests through it — so everything just works.

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

All intelligence comes from your **already-running** Intelephense and Tailwind IntelliSense instances — no second language server, no duplicate index, no extra memory.

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
| `intelephense.diagnostics.run` | When to surface PHP errors in Blade files. `"onType"` shows them live; `"onSave"` shows them after edits (the bridge saves the mirror on change, so errors still appear). |
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

For each open Blade file the extension maintains a **hidden mirror** — a `.php` file containing only the PHP regions of the template, with non-PHP areas blanked out so **line and column positions stay identical**.

> **Where mirrors are stored:** mirrors are written to a single folder named **`spectabile-blade-bridge`** inside your operating system's temp directory (`%TEMP%` on Windows, `/tmp` or `$TMPDIR` on macOS/Linux) — **never inside your project**. The folder is created automatically on first use and removed when the extension deactivates. Nothing is ever written to your repository.

Because the mirror is a real `php` document that the extension opens, Intelephense receives it through its normal `didOpen` flow and resolves its symbols against your already-indexed workspace — so completions, hover, and go-to-definition see all your classes. Requests on the Blade file are proxied to the mirror at the same position, and the results — including diagnostics — are mapped back onto the Blade file verbatim.

The mirror is created on open, kept in sync on every edit, and removed on close. It never appears as a tab.

---

## Commands

| Command | Description |
| --- | --- |
| **Blade: Import Class** | Resolve the class under the cursor from the workspace index and insert its `use` statement. Prompts when the name is ambiguous. |
| **Blade Bridge: Diagnose** | Show bridge status (mirror path, language id, completion counts) for troubleshooting. |

---

## Notes

- Mirror files live in `spectabile-blade-bridge/` inside the **OS temp directory**, outside your project — nothing touches version control, and there is no dependency on any project folder existing.
- Diagnostics honour your `intelephense.diagnostics.run` setting; the mirror is saved on change so errors surface even under `"onSave"`.
- Cross-platform: the temp location resolves correctly on Windows, macOS, and Linux.
- Multi-root workspaces are supported — each Blade file gets its own mirror, keyed by its full path.

---

*Developed in collaboration with [Claude Code](https://claude.ai/code) (Anthropic).*
