'use strict';

// ---------------------------------------------------------------------------
// Blade Intelephense Bridge
//
// Intelephense's LanguageClient documentSelector is hardcoded to
// { language: "php" } — it ignores `blade` documents entirely. So we cannot
// ask it about a .blade.php file directly.
//
// Strategy: maintain a hidden ".php" MIRROR document per blade file. The mirror
// holds the blade file's PHP-only projection (non-PHP regions blanked to keep
// line/column positions identical). Because the mirror's languageId is "php"
// and we openTextDocument() it, Intelephense's own client fires didOpen and
// adds it to its working set — so executeCommand against the mirror URI returns
// the full, workspace-aware completion set (classes, methods, vars), and emits
// real PHP diagnostics, which we relay back onto the blade file.
// ---------------------------------------------------------------------------

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INTELEPHENSE_ID = 'bmewburn.vscode-intelephense-client';

// Mirrors live in ONE folder in the OS temp dir — never inside the project.
const BRIDGE_DIR = path.join(os.tmpdir(), 'spectabile-blade-bridge');

// ---------------------------------------------------------------------------
// PHP projection — blank lines/cols replace non-PHP, positions stay in sync
// ---------------------------------------------------------------------------

function extractPhp(text) {
  const lines = text.split('\n');
  const out = [];
  let inPhp = false;

  for (const line of lines) {
    let processed = '';
    let col = 0;
    const len = line.length;

    while (col < len) {
      if (!inPhp) {
        const open1 = line.indexOf('<?php', col);
        const open2 = line.indexOf('<?=', col);
        let next = -1, tagLen = 0;
        if (open1 !== -1 && (open2 === -1 || open1 <= open2)) { next = open1; tagLen = 5; }
        else if (open2 !== -1) { next = open2; tagLen = 3; }
        if (next === -1) break;
        processed += ' '.repeat(next - col) + line.slice(next, next + tagLen);
        col = next + tagLen;
        inPhp = true;
      } else {
        const close = line.indexOf('?>', col);
        if (close === -1) { processed += line.slice(col); col = len; }
        else { processed += line.slice(col, close + 2); col = close + 2; inPhp = false; }
      }
    }

    out.push(processed || (inPhp ? line : ''));
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Mirror management
// ---------------------------------------------------------------------------

/** @type {Map<string, { path: string, uri: vscode.Uri, doc?: vscode.TextDocument }>} */
const mirrors = new Map(); // blade uri string -> mirror record

let bridgeDirReady = false;

/** Ensure the single OS-temp bridge dir exists. Safe to call repeatedly. */
function ensureBridgeDir() {
  if (bridgeDirReady) return BRIDGE_DIR;
  if (!fs.existsSync(BRIDGE_DIR)) fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  bridgeDirReady = true;
  return BRIDGE_DIR;
}

function mirrorPathFor(doc) {
  const dir = ensureBridgeDir();
  const base = path.basename(doc.uri.fsPath).replace(/\.blade\.php$/, '') + '.php';
  // Hash the full blade path so mirrors from different files never collide.
  const unique = Buffer.from(doc.uri.fsPath).toString('base64').replace(/[/+=]/g, '_').slice(-16);
  return path.join(dir, unique + '_' + base);
}

/**
 * Mirror the PHP projection into an OPEN php TextDocument so Intelephense
 * tracks it (didOpen) and re-lints it (didChange) on every edit. Returns Uri.
 *
 * The content must be pushed into the *open document* via a WorkspaceEdit —
 * not just written to disk — because VS Code does not reload an already-open
 * file-backed document when its bytes change underneath it, so Intelephense
 * would otherwise keep linting stale content (and diagnostics would drift).
 */
async function syncMirror(doc) {
  const key = doc.uri.toString();
  let rec = mirrors.get(key);
  if (!rec) {
    const p = mirrorPathFor(doc);
    rec = { path: p, uri: vscode.Uri.file(p) };
    mirrors.set(key, rec);
  }

  const projected = extractPhp(doc.getText());

  // First time: write to disk then open so Intelephense fires didOpen.
  if (!rec.doc || rec.doc.isClosed) {
    fs.writeFileSync(rec.path, projected, 'utf8');
    rec.doc = await vscode.workspace.openTextDocument(rec.uri);
    if (rec.doc.languageId !== 'php') {
      rec.doc = await vscode.languages.setTextDocumentLanguage(rec.doc, 'php');
    }
    return rec.uri;
  }

  // Subsequent edits: update the OPEN document in-memory so Intelephense
  // re-lints fresh content (fires didChange). Skip if unchanged.
  if (rec.doc.getText() !== projected) {
    const full = new vscode.Range(
      new vscode.Position(0, 0),
      rec.doc.lineAt(rec.doc.lineCount - 1).range.end
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(rec.uri, full, projected);
    await vscode.workspace.applyEdit(edit);
    // Save so Intelephense re-lints even under diagnostics.run = "onSave".
    // The mirror is a throwaway file in the OS temp dir, so saving is safe.
    try { await rec.doc.save(); } catch (_) {}
  }
  return rec.uri;
}

function disposeMirror(bladeUriStr) {
  const rec = mirrors.get(bladeUriStr);
  if (rec) {
    try { fs.unlinkSync(rec.path); } catch (_) {}
    mirrors.delete(bladeUriStr);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics relay — copy mirror diagnostics onto the blade file
// ---------------------------------------------------------------------------

let bladeDiagnostics;

function relayDiagnostics(bladeDoc, rec) {
  if (!bladeDiagnostics || !rec) return;
  const mirrorDiags = vscode.languages.getDiagnostics(rec.uri);
  // positions are 1:1 with the blade file, so copy ranges verbatim
  bladeDiagnostics.set(bladeDoc.uri, mirrorDiags.map(d => {
    const nd = new vscode.Diagnostic(d.range, d.message, d.severity);
    nd.source = 'intelephense (blade)';
    nd.code = d.code;
    return nd;
  }));
}

// ---------------------------------------------------------------------------
// Workspace-symbol class resolution (the source for UNIMPORTED classes)
//
// executeCompletionItemProvider does NOT return unimported-class auto-import
// suggestions when invoked programmatically. The workspace symbol provider
// does index every class, so we query it by exact name and synthesize the
// completion items (with a `use ...;` additionalTextEdit) ourselves.
// ---------------------------------------------------------------------------

/** Short-lived cache so consecutive keystrokes don't re-query the index. */
const symbolCache = new Map(); // query -> { at, value }
const SYMBOL_TTL = 4000;

/** Return [{ name, fqn }] for class-like symbols whose name === query (exact). */
async function resolveClassFqns(query) {
  const cached = symbolCache.get(query);
  if (cached && Date.now() - cached.at < SYMBOL_TTL) return cached.value;

  const syms = await vscode.commands.executeCommand(
    'vscode.executeWorkspaceSymbolProvider', query
  );
  const out = [];
  const seen = new Set();
  for (const s of syms ?? []) {
    if (s.kind !== vscode.SymbolKind.Class
      && s.kind !== vscode.SymbolKind.Interface
      && s.kind !== vscode.SymbolKind.Enum) continue;
    if (s.name !== query) continue; // exact class-name match only
    const container = (s.containerName ?? '').replace(/^\\+/, '');
    const fqn = container ? `${container}\\${s.name}` : s.name;
    if (seen.has(fqn)) continue;
    seen.add(fqn);
    out.push({ name: s.name, fqn });
  }
  symbolCache.set(query, { at: Date.now(), value: out });
  return out;
}

/** Already-imported FQNs in the blade doc, so we don't re-suggest them. */
function importedFqns(doc) {
  const set = new Set();
  for (const line of doc.getText().split('\n')) {
    const m = line.trim().match(/^use\s+([\w\\]+)\s*;/);
    if (m) set.add(m[1].replace(/^\\+/, ''));
  }
  return set;
}

/**
 * Build completion items for unimported classes matching the typed word.
 * Only fires for a capitalized identifier that is NOT in a member-access
 * (`::` / `->`) or already-qualified (`\`) context.
 */
async function unimportedClassItems(doc, position) {
  const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!wordRange) return [];
  const word = doc.getText(wordRange);
  if (!/^[A-Z]/.test(word) || word.length < 2) return [];

  // Bail if the char before the word is part of a qualified / member expression.
  const before = wordRange.start.character > 0
    ? doc.lineAt(wordRange.start.line).text.slice(0, wordRange.start.character)
    : '';
  if (/(::|->|\\)\s*$/.test(before)) return [];

  const matches = await resolveClassFqns(word);
  if (!matches.length) return [];

  const already = importedFqns(doc);
  const items = [];
  let i = 0;
  for (const { name, fqn } of matches) {
    if (already.has(fqn)) continue; // already imported — Intelephense handles it
    const item = new vscode.CompletionItem(
      { label: name, description: fqn },
      vscode.CompletionItemKind.Class
    );
    item.detail = fqn;
    item.documentation = new vscode.MarkdownString(`Auto-import \`use ${fqn};\``);
    item.insertText = name;
    item.filterText = name;
    item.sortText = '0_' + String(i).padStart(3, '0'); // rank above snippets/keywords
    item.preselect = i === 0;                            // highlight the first match
    item.range = wordRange;                              // replace the typed word exactly
    const useEdit = computeUseTextEdit(doc, fqn);
    if (useEdit) item.additionalTextEdits = [useEdit];
    items.push(item);
    i++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// use-statement insertion
// ---------------------------------------------------------------------------

const leadingWs = s => (s.match(/^[ \t]*/) || [''])[0];

/**
 * Where to insert a `use` line and what indentation to use.
 * Indentation is copied from the reference line: the last existing `use`
 * (so new imports line up with siblings), else the first non-blank line
 * after `<?php`. Returns { line, indent } or null (dup / nowhere to put it).
 */
function useInsertSpot(doc, fqn) {
  const lines = doc.getText().split('\n');
  const useStatement = `use ${fqn};`;
  if (lines.some(l => l.trim() === useStatement)) return null; // already imported

  let lastUseLine = -1, phpOpenLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '<?php' || t.startsWith('<?php ')) phpOpenLine = i;
    if (/^use\s+[\w\\]+\s*;/.test(t)) lastUseLine = i;
  }

  if (lastUseLine >= 0) {
    return { line: lastUseLine + 1, indent: leadingWs(lines[lastUseLine]) };
  }
  if (phpOpenLine >= 0) {
    // Match the indentation of the first non-blank body line after <?php.
    let indent = '';
    for (let i = phpOpenLine + 1; i < lines.length; i++) {
      if (lines[i].trim()) { indent = leadingWs(lines[i]); break; }
    }
    return { line: phpOpenLine + 1, indent };
  }
  return null;
}

/** Side-effect-free TextEdit for a completion item's additionalTextEdits. */
function computeUseTextEdit(doc, fqn) {
  const spot = useInsertSpot(doc, fqn);
  if (!spot) return null;
  return vscode.TextEdit.insert(new vscode.Position(spot.line, 0), `${spot.indent}use ${fqn};\n`);
}

/** WorkspaceEdit for the Import Class command (shows a message on dup). */
function buildUseEdit(doc, fqn) {
  const spot = useInsertSpot(doc, fqn);
  if (!spot) {
    vscode.window.showInformationMessage(`Already imported: ${fqn}`);
    return null;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(spot.line, 0), `${spot.indent}use ${fqn};\n`);
  return edit;
}

// ---------------------------------------------------------------------------
// normalizeItem — rebuild a proxied completion item as a live CompletionItem
//
// Items returned by executeCompletionItemProvider are detached snapshots; their
// textEdit/range/insertText must be reconstructed into real vscode types or
// VS Code silently fails to apply them (popup closes, nothing inserted).
// Positions are 1:1 between blade and mirror, so ranges copy verbatim.
// ---------------------------------------------------------------------------

function asRange(r) {
  if (!r) return undefined;
  if (r instanceof vscode.Range) return r;
  if (r.start && r.end) {
    return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  }
  // { inserting, replacing } form
  if (r.replacing) return asRange(r.replacing);
  if (r.inserting) return asRange(r.inserting);
  return undefined;
}

// Completion kinds (VS Code API enum) that represent something callable.
const CALLABLE_KINDS = new Set([
  vscode.CompletionItemKind.Method,
  vscode.CompletionItemKind.Function,
  vscode.CompletionItemKind.Constructor,
]);

/** label.detail string ("($a, $b)") if the label is a CompletionItemLabel. */
function labelDetailOf(label) {
  return (label && typeof label === 'object' && typeof label.detail === 'string')
    ? label.detail : undefined;
}

/** True when label.detail looks like a parameter list "(...)". */
function labelDetailIsSignature(label) {
  const d = labelDetailOf(label);
  return typeof d === 'string' && /^\s*\(/.test(d);
}

/**
 * Build a `name(${1:arg}, ${2:arg})` snippet from a signature string. Accepts
 * either a full "find($a, $b)" or a bare param list "($a, $b)". Returns a
 * SnippetString, a plain `name($0)` if no params, or null if not a signature.
 */
function snippetFromSignature(name, sig) {
  if (typeof sig !== 'string') return null;
  const m = sig.match(/\(([^)]*)\)/);
  if (!m) return null;
  const inside = m[1].trim();
  if (!inside) return new vscode.SnippetString(`${name}($0)`);
  // split top-level params (no nested parens expected in PHP sigs here)
  const params = inside.split(',').map(p => p.trim()).filter(Boolean);
  let i = 1;
  const body = params.map(p => {
    // strip type hints / defaults, keep the $var token for the placeholder
    const v = (p.match(/\$\w+/) || [p])[0];
    // Escape snippet metacharacters in placeholder text — notably the leading
    // `$` of a PHP var, which would otherwise start a nested tab-stop and
    // render empty. Escape \, $ and } per the TextMate snippet grammar.
    const safe = v.replace(/[\\$}]/g, '\\$&');
    return '${' + (i++) + ':' + safe + '}';
  }).join(', ');
  return new vscode.SnippetString(`${name}(${body})$0`);
}

function normalizeItem(it, doc, position) {
  const label = it.label;
  const labelText = typeof label === 'string' ? label : label?.label ?? '';
  const item = new vscode.CompletionItem(label, it.kind);

  if (it.detail !== undefined) item.detail = it.detail;
  if (it.documentation !== undefined) item.documentation = it.documentation;
  if (it.sortText !== undefined) item.sortText = it.sortText;
  if (it.filterText !== undefined) item.filterText = it.filterText;
  if (it.preselect !== undefined) item.preselect = it.preselect;
  if (it.commitCharacters !== undefined) item.commitCharacters = it.commitCharacters;
  if (it.command !== undefined) item.command = it.command;
  if (it.additionalTextEdits) {
    item.additionalTextEdits = it.additionalTextEdits.map(e =>
      vscode.TextEdit.replace(asRange(e.range), e.newText)
    );
  }

  // Preserve the replacement range so the typed prefix is overwritten cleanly.
  const range = asRange(it.textEdit?.range) || asRange(it.range)
    || doc.getWordRangeAtPosition(position);
  if (range) item.range = range;

  // Decide insertion text.
  const te = it.textEdit;
  if (te && te.newText !== undefined && /\$\{?\d/.test(te.newText)) {
    // Intelephense already gave us a snippet — honour it verbatim.
    item.insertText = new vscode.SnippetString(te.newText);
  } else if (CALLABLE_KINDS.has(it.kind) || labelDetailIsSignature(label)) {
    // Method/function with no snippet from the server: synthesize args from
    // the signature. Intelephense puts it in label.detail ("($a, $b)"), with
    // the top-level `detail` field left undefined.
    const sig = labelDetailOf(label) ?? it.detail;
    item.insertText = snippetFromSignature(labelText, sig)
      || new vscode.SnippetString(`${labelText}($0)`);
  } else if (te && te.newText !== undefined) {
    item.insertText = te.newText;
  } else if (it.insertText !== undefined) {
    const text = typeof it.insertText === 'string' ? it.insertText : it.insertText.value;
    item.insertText = (it.insertTextFormat === 2 || /\$\{?\d/.test(text || ''))
      ? new vscode.SnippetString(text) : text;
  }

  return item;
}

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tailwind classRegex bootstrap
//
// Injects a classRegex pattern into the global user settings so the Tailwind
// IntelliSense extension offers class completions inside any string literal in
// blade/php/js files — not just inside HTML class="..." attributes.
// Idempotent: skips the write if the pattern is already present.
// ---------------------------------------------------------------------------

const TW_CLASS_REGEX_PATTERN = ["[\"'`]([^\"'`\\n]+)[\"'`]", "([^\"'`\\n]+)"];

function installTailwindClassRegex() {
  const twConfig = vscode.workspace.getConfiguration('tailwindCSS');
  const current = twConfig.inspect('experimental.classRegex');
  const existing = (current?.globalValue ?? current?.defaultValue ?? []);

  const sentinel = TW_CLASS_REGEX_PATTERN[0];
  const alreadyInstalled = existing.some(entry =>
    Array.isArray(entry) ? entry[0] === sentinel : entry === sentinel
  );
  if (alreadyInstalled) return;

  const next = [...existing, TW_CLASS_REGEX_PATTERN];
  twConfig.update('experimental.classRegex', next, vscode.ConfigurationTarget.Global);
}

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const intelExt = vscode.extensions.getExtension(INTELEPHENSE_ID);
  if (!intelExt) {
    vscode.window.showErrorMessage('Blade Bridge: PHP Intelephense not found.');
    return;
  }
  if (!intelExt.isActive) await intelExt.activate();

  installTailwindClassRegex();

  bladeDiagnostics = vscode.languages.createDiagnosticCollection('blade-bridge');
  context.subscriptions.push(bladeDiagnostics);

  const ensure = () => (intelExt.isActive ? Promise.resolve() : intelExt.activate());

  // Pre-sync open blade docs
  for (const d of vscode.workspace.textDocuments) {
    if (d.languageId === 'blade') { try { await syncMirror(d); } catch (_) {} }
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async d => {
      if (d.languageId === 'blade') { try { await syncMirror(d); } catch (_) {} }
    }),
    vscode.workspace.onDidChangeTextDocument(async e => {
      if (e.document.languageId === 'blade') { try { await syncMirror(e.document); } catch (_) {} }
    }),
    vscode.workspace.onDidCloseTextDocument(d => {
      if (d.languageId === 'blade') disposeMirror(d.uri.toString());
    }),
    // When the mirror's diagnostics update, relay them onto the blade file.
    vscode.languages.onDidChangeDiagnostics(e => {
      for (const changedUri of e.uris) {
        for (const [bladeUriStr, rec] of mirrors) {
          if (rec.uri.toString() === changedUri.toString()) {
            const bladeDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === bladeUriStr);
            if (bladeDoc) relayDiagnostics(bladeDoc, rec);
          }
        }
      }
    })
  );

  const selector = { language: 'blade', scheme: 'file' };

  // --- Completion ---
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(doc, position, _token, ctx) {
        await ensure();
        const uri = await syncMirror(doc);

        let items = [];
        let incomplete = false;
        try {
          const result = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider', uri, position, ctx.triggerCharacter
          );
          const raw = result?.items ?? (Array.isArray(result) ? result : []);
          incomplete = result?.isIncomplete ?? false;
          items = raw.map(it => normalizeItem(it, doc, position));
        } catch (_) {}

        // Augment with unimported class names from the workspace index.
        try {
          const extra = await unimportedClassItems(doc, position);
          if (extra.length) items = items.concat(extra);
        } catch (_) {}

        return new vscode.CompletionList(items, incomplete);
      },
    }, '.', '>', ':', '$', '\\', "'", '"')
  );

  // --- Hover ---
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(doc, position) {
        await ensure();
        const uri = await syncMirror(doc);
        try {
          const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
          return hovers?.[0] ?? null;
        } catch (_) { return null; }
      },
    })
  );

  // --- Definition ---
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(doc, position) {
        await ensure();
        const uri = await syncMirror(doc);
        try {
          const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
          // A definition that lands inside the mirror itself should remap to the blade file.
          return (defs ?? []).map(loc => {
            if (loc.uri && loc.uri.toString() === uri.toString()) {
              return new vscode.Location(doc.uri, loc.range);
            }
            return loc;
          });
        } catch (_) { return []; }
      },
    })
  );

  // --- Signature help ---
  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(selector, {
      async provideSignatureHelp(doc, position) {
        await ensure();
        const uri = await syncMirror(doc);
        try {
          return await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', uri, position);
        } catch (_) { return null; }
      },
    }, '(', ',')
  );

  // --- Import Class ---
  context.subscriptions.push(
    vscode.commands.registerCommand('bladeBridge.importClass', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'blade') return;
      const doc = editor.document;
      const pos = editor.selection.active;

      await ensure();
      await syncMirror(doc);

      const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
      const word = wordRange ? doc.getText(wordRange) : '';
      if (!word) { vscode.window.showWarningMessage('Blade Bridge: No class name under cursor'); return; }

      const matches = await resolveClassFqns(word);
      if (!matches.length) {
        vscode.window.showWarningMessage(`Blade Bridge: No class named "${word}" in the workspace index`);
        return;
      }

      // If several classes share the name (e.g. Spectabile\Foundation\Str vs
      // Illuminate\Support\Str), let the user pick.
      let fqn;
      if (matches.length === 1) {
        fqn = matches[0].fqn;
      } else {
        const pick = await vscode.window.showQuickPick(
          matches.map(m => ({ label: m.name, description: m.fqn, fqn: m.fqn })),
          { title: `Import which "${word}"?`, placeHolder: 'Select the class to import' }
        );
        if (!pick) return;
        fqn = pick.fqn;
      }

      const edit = buildUseEdit(doc, fqn);
      if (edit) {
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage(`Imported: use ${fqn};`);
      }
    })
  );

  // --- Diagnose ---
  context.subscriptions.push(
    vscode.commands.registerCommand('bladeBridge.diagnose', async () => {
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      const lines = [
        `intelephense active: ${intelExt.isActive}`,
        `mirrors: ${mirrors.size}`,
        `languageId: ${doc?.languageId ?? 'n/a'}`,
      ];
      if (doc?.languageId === 'blade') {
        const uri = await syncMirror(doc);
        const rec = mirrors.get(doc.uri.toString());
        lines.push(`mirror: ${uri.toString()}`);
        lines.push(`mirror open: ${rec?.doc ? !rec.doc.isClosed : false}`);
        lines.push(`mirror langId: ${rec?.doc?.languageId ?? 'n/a'}`);
        lines.push(`mirror diags: ${vscode.languages.getDiagnostics(uri).length}`);
        const pos = editor.selection.active;
        const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
        const word = wordRange ? doc.getText(wordRange) : '(none)';
        lines.push(`word under cursor: "${word}"`);
        try {
          const result = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider', uri, pos
          );
          const items = result?.items ?? result ?? [];
          lines.push(`mirror completions: ${items.length}`);
        } catch (e) { lines.push(`completion error: ${e.message}`); }
        try {
          const fqns = await resolveClassFqns(word);
          lines.push(`exact-name classes for "${word}": ${fqns.length}`);
          for (const f of fqns.slice(0, 8)) lines.push(`  ▸ ${f.fqn}`);
        } catch (e) { lines.push(`symbol error: ${e.message}`); }
      }
      vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
      console.log('[BladeBridge Diagnose]\n' + lines.join('\n'));
    })
  );
}

function deactivate() {
  for (const rec of mirrors.values()) {
    try { fs.unlinkSync(rec.path); } catch (_) {}
  }
  mirrors.clear();
  // Remove the (now-empty) temp bridge dir; ignore if it has stray files.
  try { fs.rmdirSync(BRIDGE_DIR); } catch (_) {}
}

module.exports = { activate, deactivate };
