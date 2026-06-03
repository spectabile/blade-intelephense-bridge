'use strict';

// ---------------------------------------------------------------------------
// Blade Intelephense Bridge v3.0 — Private LSP Server
//
// Instead of mirroring blade files into VS Code TextDocuments (which caused
// tabs, save-dialogs, and Problems-panel pollution), we spawn our own private
// Intelephense process and speak LSP to it directly over stdio.
//
// No temp files are opened in the editor. The PHP projection of each blade
// file lives purely in the server's in-memory document store (via didOpen /
// didChange). Diagnostics come back via publishDiagnostics notifications and
// are placed on our own DiagnosticCollection mapped to the real blade URIs.
// ---------------------------------------------------------------------------

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');

const INTELEPHENSE_ID = 'bmewburn.vscode-intelephense-client';

// ═══════════════════════════════════════════════════════════════════════════
// PHP PROJECTION
// Blanks non-PHP regions so line/column positions stay identical to the
// blade source — no position mapping needed anywhere downstream.
// ═══════════════════════════════════════════════════════════════════════════

function extractPhp(text) {
  const lines = text.split('\n');
  const out   = [];
  let inPhp   = false;

  for (const line of lines) {
    let processed = '';
    let col = 0;
    const len = line.length;

    while (col < len) {
      if (!inPhp) {
        const open1 = line.indexOf('<?php', col);
        const open2 = line.indexOf('<?=',  col);
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

// ═══════════════════════════════════════════════════════════════════════════
// JSON-RPC / LSP TRANSPORT
// Parses Content-Length framed messages from stdout, dispatches responses
// to pending promise handlers and notifications to registered listeners.
// ═══════════════════════════════════════════════════════════════════════════

class LspTransport {
  constructor(proc) {
    this._proc    = proc;
    this._buf     = Buffer.alloc(0);
    this._pending = new Map(); // id → { resolve, reject }
    this._notifs  = new Map(); // method → handler
    this._nextId  = 1;

    proc.stdout.on('data', chunk => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._pump();
    });
    proc.stderr?.on('data', () => {}); // suppress server log noise
  }

  _pump() {
    while (true) {
      const sep = this._buf.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const header = this._buf.slice(0, sep).toString('ascii');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this._buf = this._buf.slice(sep + 4); continue; }
      const bodyLen = parseInt(m[1], 10);
      if (this._buf.length < sep + 4 + bodyLen) break;
      const body = this._buf.slice(sep + 4, sep + 4 + bodyLen).toString('utf8');
      this._buf  = this._buf.slice(sep + 4 + bodyLen);
      try { this._dispatch(JSON.parse(body)); } catch (_) {}
    }
  }

  _dispatch(msg) {
    if (msg.method !== undefined) {
      // Notification or server-initiated request
      const h = this._notifs.get(msg.method);
      if (msg.id != null) {
        // Server-initiated request — let the handler return the result value
        const result = h ? h(msg.params) : null;
        this._write({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      } else if (h) {
        h(msg.params);
      }
    } else if (msg.id != null) {
      // Response to one of our requests
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error'));
        else           p.resolve(msg.result);
      }
    }
  }

  _write(obj) {
    const body  = JSON.stringify(obj);
    const bytes = Buffer.byteLength(body, 'utf8');
    this._proc.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params: params ?? null });
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  on(method, handler) {
    this._notifs.set(method, handler);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE INTELEPHENSE SERVER CLIENT
// Spawns the Intelephense JS server (found inside the bmewburn extension)
// as a child process and exposes async LSP methods.
// ═══════════════════════════════════════════════════════════════════════════

class IntelephenseClient {
  constructor(serverPath, workspaceFolders, storagePath) {
    this._serverPath       = serverPath;
    this._workspaceFolders = workspaceFolders; // [{ uri, name }]
    this._storagePath      = storagePath;       // extension global storage dir for index cache
    this._transport        = null;
    this._proc             = null;
    this._ready            = false;
    this._startPromise     = null;
    this._versions         = new Map(); // virtualUri → doc version number
    this._diagCb           = null;
  }

  start() {
    this._startPromise = this._doStart();
    return this._startPromise;
  }

  async _doStart() {
    this._proc = cp.spawn(
      process.execPath, // reuse VS Code's own Node.js binary
      [this._serverPath, '--stdio'],
      { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this._proc.on('error', e => console.error('[BladeBridge] server spawn error:', e.message));
    this._proc.on('exit',  c => {
      this._ready = false;
      if (c !== 0 && c !== null) console.warn('[BladeBridge] server exited with code', c);
    });

    this._transport = new LspTransport(this._proc);

    // Wire up server-push notifications we care about
    this._transport.on('textDocument/publishDiagnostics', p => this._diagCb?.(p));
    // Silently absorb progress / log noise from the server
    for (const m of ['$/progress', 'window/logMessage', 'window/showMessage',
                     'window/showMessageRequest', 'telemetry/event']) {
      this._transport.on(m, () => {});
    }
    // workspace/configuration: disable undefinedVariables for blade context
    // (blade views always receive variables from controllers — they are not false positives)
    this._transport.on('workspace/configuration', params =>
      (params?.items ?? []).map(item =>
        (!item?.section || item.section === 'intelephense')
          ? { diagnostics: { undefinedVariables: false } }
          : null
      )
    );

    const rootUri = this._workspaceFolders[0]?.uri
      ?? vscode.Uri.file(os.homedir()).toString();

    await this._transport.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'blade-intelephense-bridge', version: '3.0.0' },
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { willSave: false, didSave: false },
          completion: {
            completionItem: {
              snippetSupport:      true,
              labelDetailsSupport: true,
              resolveSupport:      { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
          },
          hover:         { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } },
          definition:    {},
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: { workspaceFolders: true, configuration: true, symbol: {} },
      },
      initializationOptions: {
        storagePath:       this._storagePath,
        globalStoragePath: this._storagePath,
        licenceKey:        this._readLicenceKey(),
        clearCache:        false,
      },
      workspaceFolders: this._workspaceFolders,
    });

    this._transport.notify('initialized', {});
    this._ready = true;
  }

  _readLicenceKey() {
    try { return vscode.workspace.getConfiguration('intelephense').get('licenceKey') || undefined; }
    catch (_) { return undefined; }
  }

  onDiagnostics(cb) { this._diagCb = cb; }

  async _whenReady() {
    if (this._ready) return;
    if (this._startPromise) await this._startPromise;
  }

  async openDoc(uri, text) {
    await this._whenReady();
    this._versions.set(uri, 1);
    this._transport.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'php', version: 1, text },
    });
  }

  async changeDoc(uri, text) {
    await this._whenReady();
    const v = (this._versions.get(uri) ?? 0) + 1;
    this._versions.set(uri, v);
    this._transport.notify('textDocument/didChange', {
      textDocument:   { uri, version: v },
      contentChanges: [{ text }], // full document sync
    });
  }

  closeDoc(uri) {
    if (!this._ready) return;
    this._versions.delete(uri);
    this._transport.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async completion(uri, position, triggerChar) {
    await this._whenReady();
    return this._transport.request('textDocument/completion', {
      textDocument: { uri },
      position,
      context: triggerChar
        ? { triggerKind: 2, triggerCharacter: triggerChar }
        : { triggerKind: 1 },
    });
  }

  async resolveCompletion(lspItem) {
    await this._whenReady();
    return this._transport.request('completionItem/resolve', lspItem);
  }

  async hover(uri, position) {
    await this._whenReady();
    return this._transport.request('textDocument/hover', { textDocument: { uri }, position });
  }

  async definition(uri, position) {
    await this._whenReady();
    return this._transport.request('textDocument/definition', { textDocument: { uri }, position });
  }

  async signatureHelp(uri, position, triggerChar) {
    await this._whenReady();
    return this._transport.request('textDocument/signatureHelp', {
      textDocument: { uri },
      position,
      context: { triggerKind: triggerChar ? 2 : 1, triggerCharacter: triggerChar || undefined },
    });
  }

  async workspaceSymbol(query) {
    await this._whenReady();
    return this._transport.request('workspace/symbol', { query });
  }

  dispose() {
    this._ready = false;
    if (!this._proc) return;
    try {
      this._transport.request('shutdown', null).catch(() => {});
      setTimeout(() => {
        try { this._transport.notify('exit', {}); } catch (_) {}
        setTimeout(() => { if (!this._proc.killed) this._proc.kill(); }, 300);
      }, 200);
    } catch (_) {
      this._proc.kill();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVER DISCOVERY
// Tries several known layouts of the bmewburn Intelephense extension.
// ═══════════════════════════════════════════════════════════════════════════

function findServerPath() {
  const ext = vscode.extensions.getExtension(INTELEPHENSE_ID);
  if (!ext) return null;
  const base = ext.extensionPath;
  const candidates = [
    path.join(base, 'node_modules', 'intelephense', 'lib', 'intelephense.js'),
    path.join(base, 'server', 'out', 'server.js'),
    path.join(base, 'out', 'server.js'),
    path.join(base, 'dist', 'server.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIRTUAL DOCUMENT MANAGEMENT
// Each blade file gets a virtual PHP doc with a stable file:// URI in the
// OS temp dir. The URI exists only in the private server's memory — we never
// write it to disk or open it in the editor.
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Map<string, { virtualUri: string, content: string }>} */
const virtualDocs = new Map(); // bladeUri → record

/** @type {IntelephenseClient | null} */
let lspClient = null;

const VIRT_DIR = path.join(os.tmpdir(), 'blade-bridge-virt');

function virtualUriFor(doc) {
  const hash = Buffer.from(doc.uri.fsPath).toString('base64').replace(/[/+=]/g, '_').slice(-16);
  const name = path.basename(doc.uri.fsPath).replace(/\.blade\.php$/, '');
  return vscode.Uri.file(path.join(VIRT_DIR, `${hash}_${name}.php`)).toString();
}

async function syncVirtualDoc(doc) {
  const key       = doc.uri.toString();
  const projected = extractPhp(doc.getText());
  let rec = virtualDocs.get(key);

  if (!rec) {
    const virtualUri = virtualUriFor(doc);
    rec = { virtualUri, content: projected };
    virtualDocs.set(key, rec);
    await lspClient.openDoc(virtualUri, projected);
  } else if (rec.content !== projected) {
    rec.content = projected;
    await lspClient.changeDoc(rec.virtualUri, projected);
  }

  return rec.virtualUri;
}

function disposeVirtualDoc(bladeUriStr) {
  const rec = virtualDocs.get(bladeUriStr);
  if (rec) {
    lspClient?.closeDoc(rec.virtualUri);
    virtualDocs.delete(bladeUriStr);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS
// The private server fires publishDiagnostics notifications; we remap them
// onto the real blade file URIs in our own DiagnosticCollection.
// ═══════════════════════════════════════════════════════════════════════════

let bladeDiagnostics = null;

function handleDiagnostics({ uri, diagnostics }) {
  if (!bladeDiagnostics) return;
  for (const [bladeKey, rec] of virtualDocs) {
    if (rec.virtualUri !== uri) continue;
    const bladeDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === bladeKey);
    if (!bladeDoc) {
      bladeDiagnostics.delete(vscode.Uri.parse(bladeKey));
      return;
    }
    bladeDiagnostics.set(bladeDoc.uri, diagnostics
      .filter(d => d.code !== 1008 && String(d.code) !== 'P1008')  // P1008 Undefined variable — always false positive in blade
      .map(d => {
        const range = new vscode.Range(
          d.range.start.line, d.range.start.character,
          d.range.end.line,   d.range.end.character
        );
        const diag = new vscode.Diagnostic(range, d.message, lspSevToVscode(d.severity));
        diag.source = 'intelephense (blade)';
        if (d.code != null) diag.code = d.code;
        return diag;
      }));
    return;
  }
}

function lspSevToVscode(s) {
  return s === 1 ? vscode.DiagnosticSeverity.Error
       : s === 2 ? vscode.DiagnosticSeverity.Warning
       : s === 3 ? vscode.DiagnosticSeverity.Information
       :           vscode.DiagnosticSeverity.Hint;
}

// ═══════════════════════════════════════════════════════════════════════════
// LSP → VS CODE COMPLETION CONVERSION
// Raw LSP CompletionItems need range / snippet / kind translation before
// VS Code can use them. Positions are 1:1 (projection preserves layout),
// so ranges copy verbatim.
// ═══════════════════════════════════════════════════════════════════════════

// VS Code CompletionItemKind values that represent something callable
const CALLABLE_KINDS = new Set([
  vscode.CompletionItemKind.Method,      // 1
  vscode.CompletionItemKind.Function,    // 2
  vscode.CompletionItemKind.Constructor, // 3
]);

function lspKindToVscode(k) {
  // LSP kinds are 1-based; VS Code kinds are 0-based with identical ordering.
  return typeof k === 'number' ? k - 1 : vscode.CompletionItemKind.Text;
}

function lspRangeToVscode(r) {
  if (!r) return undefined;
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

function lspContentToMarkdown(c) {
  if (!c) return undefined;
  if (typeof c === 'string') return new vscode.MarkdownString(c);
  if (c.kind === 'markdown' || c.kind === 'plaintext') return new vscode.MarkdownString(c.value ?? '');
  if (c.language) return new vscode.MarkdownString('```' + c.language + '\n' + (c.value ?? '') + '\n```');
  return new vscode.MarkdownString(String(c.value ?? c));
}

function labelDetailOf(label) {
  return label && typeof label === 'object' && typeof label.detail === 'string'
    ? label.detail : undefined;
}

function labelDetailIsSignature(label) {
  const d = labelDetailOf(label);
  return typeof d === 'string' && /^\s*\(/.test(d);
}

function paramsFromSig(name, sig) {
  if (typeof sig !== 'string') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = sig.match(new RegExp(escaped + '\\(([^)]*)\\)'));
  if (!m) {
    const stripped = sig.replace(/^\s*\([a-z][a-z ]*\)\s*/i, '');
    m = stripped.match(/\(([^)]*)\)/);
  }
  if (!m) return null;
  const inside = m[1].trim();
  if (!inside) return [];
  return inside.split(',').map(p => p.trim()).filter(Boolean);
}

function snippetFromSignature(name, sig) {
  const params = paramsFromSig(name, sig);
  if (params === null) return null;
  if (!params.length) return new vscode.SnippetString(`${name}($0)`);
  let i = 1;
  const body = params.map(p => {
    const v = (p.match(/\$\w+/) || [p])[0];
    const safe = v.replace(/[\\$}]/g, '\\$&');
    return '${' + (i++) + ':' + safe + '}';
  }).join(', ');
  return new vscode.SnippetString(`${name}(${body})$0`);
}

function lspItemToVscode(it, doc, position) {
  const labelText = typeof it.label === 'string' ? it.label : it.label?.label ?? '';
  const kind      = lspKindToVscode(it.kind);
  const item      = new vscode.CompletionItem(it.label, kind);

  if (it.detail        != null) item.detail        = it.detail;
  if (it.documentation != null) item.documentation = lspContentToMarkdown(it.documentation);
  if (it.sortText      != null) item.sortText       = it.sortText;
  if (it.filterText    != null) item.filterText     = it.filterText;
  if (it.preselect     != null) item.preselect      = it.preselect;
  if (it.commitCharacters != null) item.commitCharacters = it.commitCharacters;

  // Range: InsertReplaceEdit has both insert+replace; pass both so VS Code can choose
  const te = it.textEdit;
  if (te?.insert && te?.replace) {
    item.range = {
      inserting: lspRangeToVscode(te.insert),
      replacing: lspRangeToVscode(te.replace),
    };
  } else {
    const rawRange = te?.range ?? it.range?.replace ?? it.range?.insert ?? it.range;
    const vsRange  = lspRangeToVscode(rawRange);
    if (vsRange) item.range = vsRange;
  }

  // additionalTextEdits (auto-import use statements — may arrive here or via resolve)
  if (it.additionalTextEdits?.length) {
    item.additionalTextEdits = it.additionalTextEdits.map(e =>
      vscode.TextEdit.replace(lspRangeToVscode(e.range), e.newText)
    );
  }

  // insertText / snippet
  const rawInsert = te?.newText ?? it.insertText ?? labelText;
  const isSnippet = it.insertTextFormat === 2 || /\$\{?\d/.test(rawInsert);
  const sig0      = labelDetailOf(it.label) ?? it.detail;
  const isCallable = CALLABLE_KINDS.has(kind) || labelDetailIsSignature(it.label);
  // Give our param-snippet priority over Intelephense's bare "method($0)" snippet
  const betterSnippet = isCallable ? snippetFromSignature(labelText, sig0) : null;

  if (betterSnippet) {
    item.insertText = betterSnippet;
  } else if (isSnippet) {
    item.insertText = new vscode.SnippetString(rawInsert);
  } else if (isCallable) {
    item.insertText = new vscode.SnippetString(`${labelText}($0)`);
  } else {
    item.insertText = rawInsert;
  }

  // Keep original LSP item + blade document for completionItem/resolve
  item._lspItem  = it;
  item._bladeDoc = doc;

  return item;
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKSPACE SYMBOL CLASS RESOLUTION
// Queries the private Intelephense server (which has indexed the full project)
// for class symbols matching the typed name. Falls back to VS Code's shared
// workspace symbol provider if the private server returns nothing.
// ═══════════════════════════════════════════════════════════════════════════

const symbolCache = new Map(); // query → { at, value }
const SYMBOL_TTL  = 4000;

// LSP SymbolKind values for class-like symbols (Class=5, Enum=10, Interface=11)
const LSP_CLASS_KINDS = new Set([5, 10, 11]);

async function resolveClassFqns(query) {
  const cached = symbolCache.get(query);
  if (cached && Date.now() - cached.at < SYMBOL_TTL) return cached.value;

  const out  = [];
  const seen = new Set();

  function collect(name, containerName) {
    if (name !== query) return;
    const container = (containerName ?? '').replace(/^\\+/, '');
    const fqn = container ? `${container}\\${name}` : name;
    if (!seen.has(fqn)) { seen.add(fqn); out.push({ name, fqn }); }
  }

  // Primary: private server's workspace/symbol (has the full project indexed)
  try {
    const syms = await lspClient.workspaceSymbol(query);
    for (const s of syms ?? []) {
      if (!LSP_CLASS_KINDS.has(s.kind)) continue;
      collect(typeof s.name === 'string' ? s.name : (s.name?.label ?? ''), s.containerName);
    }
  } catch (_) {}

  // Fallback: VS Code shared workspace symbol provider
  if (!out.length) {
    try {
      const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
      for (const s of syms ?? []) {
        if (s.kind !== vscode.SymbolKind.Class
          && s.kind !== vscode.SymbolKind.Interface
          && s.kind !== vscode.SymbolKind.Enum) continue;
        collect(s.name, s.containerName);
      }
    } catch (_) {}
  }

  symbolCache.set(query, { at: Date.now(), value: out });
  return out;
}

function importedFqns(doc) {
  const set = new Set();
  for (const line of doc.getText().split('\n')) {
    const m = line.trim().match(/^use\s+([\w\\]+)\s*;/);
    if (m) set.add(m[1].replace(/^\\+/, ''));
  }
  return set;
}

async function unimportedClassItems(doc, position) {
  const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!wordRange) return [];
  const word = doc.getText(wordRange);
  if (!/^[A-Z]/.test(word) || word.length < 2) return [];

  const before = wordRange.start.character > 0
    ? doc.lineAt(wordRange.start.line).text.slice(0, wordRange.start.character) : '';
  if (/(::|->|\\)\s*$/.test(before)) return [];

  const matches = await resolveClassFqns(word);
  if (!matches.length) return [];

  const already = importedFqns(doc);
  const items   = [];
  let i = 0;
  for (const { name, fqn } of matches) {
    if (already.has(fqn)) continue;
    const item = new vscode.CompletionItem(
      { label: name, description: fqn },
      vscode.CompletionItemKind.Class
    );
    item.detail          = fqn;
    item.documentation   = new vscode.MarkdownString(`Auto-import \`use ${fqn};\``);
    item.insertText      = name;
    item.filterText      = name;
    item.sortText        = '0_' + String(i).padStart(3, '0');
    item.preselect       = i === 0;
    item.range           = wordRange;
    const useEdit = computeUseTextEdit(doc, fqn);
    if (useEdit) item.additionalTextEdits = [useEdit];
    items.push(item);
    i++;
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// USE-STATEMENT INSERTION  (unchanged from v2)
// ═══════════════════════════════════════════════════════════════════════════

const leadingWs = s => (s.match(/^[ \t]*/) || [''])[0];

function useInsertSpot(doc, fqn) {
  const lines = doc.getText().split('\n');
  const useStatement = `use ${fqn};`;
  if (lines.some(l => l.trim() === useStatement)) return null;

  // 1. Already has `use` lines → append after the last one (preserves indentation).
  let lastUseLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*use\s+[\w\\]+\s*;/.test(lines[i])) lastUseLine = i;
  }
  if (lastUseLine >= 0) {
    return { line: lastUseLine + 1, indent: leadingWs(lines[lastUseLine]) };
  }

  // 2. No `use` lines yet — find the *first* <?php block that has no Blade directives
  //    above it (a <?php preceded by @foreach, @component etc. is inside template content).
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '<?php' || t.startsWith('<?php ')) {
      const hasBladeAbove = lines.slice(0, i).some(l => /^[ \t]*@[a-z]/.test(l));
      if (!hasBladeAbove) {
        let indent = '';
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim()) { indent = leadingWs(lines[j]); break; }
        }
        return { line: i + 1, indent };
      }
      break; // First <?php is inside template markup — don't use it
    }
  }

  // 3. Pure Blade template with no top-level PHP block → create one at line 0.
  return { line: 0, indent: '', createPhpBlock: true };
}

function computeUseTextEdit(doc, fqn) {
  const spot = useInsertSpot(doc, fqn);
  if (!spot) return null;
  const text = spot.createPhpBlock
    ? `<?php\nuse ${fqn};\n?>\n`
    : `${spot.indent}use ${fqn};\n`;
  return vscode.TextEdit.insert(new vscode.Position(spot.line, 0), text);
}

function buildUseEdit(doc, fqn) {
  const spot = useInsertSpot(doc, fqn);
  if (!spot) {
    vscode.window.showInformationMessage(`Already imported: ${fqn}`);
    return null;
  }
  const edit = new vscode.WorkspaceEdit();
  const text = spot.createPhpBlock
    ? `<?php\nuse ${fqn};\n?>\n`
    : `${spot.indent}use ${fqn};\n`;
  edit.insert(doc.uri, new vscode.Position(spot.line, 0), text);
  return edit;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENSION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const serverPath = findServerPath();
  if (!serverPath) {
    vscode.window.showErrorMessage(
      'Blade Intelephense Bridge: PHP Intelephense extension not found. ' +
      'Please install bmewburn.vscode-intelephense-client.'
    );
    return;
  }

  bladeDiagnostics = vscode.languages.createDiagnosticCollection('blade-bridge');
  context.subscriptions.push(bladeDiagnostics);

  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => ({
    uri:  f.uri.toString(),
    name: f.name,
  }));

  const storagePath = context.globalStorageUri?.fsPath;
  lspClient = new IntelephenseClient(serverPath, folders, storagePath);
  lspClient.onDiagnostics(handleDiagnostics);
  context.subscriptions.push({ dispose: () => lspClient.dispose() });

  // Start the private server — non-blocking; providers await _whenReady internally
  lspClient.start().catch(e => {
    vscode.window.showErrorMessage(`Blade Bridge: failed to start Intelephense server — ${e.message}`);
  });

  // Pre-sync any blade files already open at activation time
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === 'blade') syncVirtualDoc(doc).catch(() => {});
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'blade') syncVirtualDoc(doc).catch(() => {});
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.languageId === 'blade') syncVirtualDoc(e.document).catch(() => {});
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.languageId === 'blade') disposeVirtualDoc(doc.uri.toString());
    }),
  );

  const selector = { language: 'blade', scheme: 'file' };

  // ── Completion ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(doc, position, _token, ctx) {
        try { await syncVirtualDoc(doc); } catch (_) { return null; }
        const rec = virtualDocs.get(doc.uri.toString());
        if (!rec) return null;

        let vsItems    = [];
        let incomplete = false;
        try {
          const result   = await lspClient.completion(rec.virtualUri, position, ctx.triggerCharacter);
          const lspItems = Array.isArray(result) ? result : (result?.items ?? []);
          incomplete     = result?.isIncomplete ?? false;
          vsItems        = lspItems.map(it => lspItemToVscode(it, doc, position));
        } catch (_) {}

        // Augment with unimported class completions from the workspace index
        try {
          const extra = await unimportedClassItems(doc, position);
          if (extra.length) vsItems = vsItems.concat(extra);
        } catch (_) {}

        return new vscode.CompletionList(vsItems, incomplete);
      },

      async resolveCompletionItem(item) {
        if (!item._lspItem || !lspClient) return item;
        try {
          const resolved = await lspClient.resolveCompletion(item._lspItem);
          if (resolved?.additionalTextEdits?.length) {
            // Re-compute use-statement insertions via our blade-aware helper so the
            // insertion always lands after all existing `use` lines with matching indentation.
            const bladeDoc = item._bladeDoc;
            item.additionalTextEdits = resolved.additionalTextEdits.flatMap(e => {
              const useMatch = e.newText?.trim().match(/^use\s+([\w\\]+(?:\\[\w\\]+)*)\s*;/);
              if (useMatch && bladeDoc) {
                const edit = computeUseTextEdit(bladeDoc, useMatch[1]);
                return edit ? [edit] : [];
              }
              return [vscode.TextEdit.replace(lspRangeToVscode(e.range), e.newText)];
            });
          }

          // Fallback: Intelephense sometimes omits additionalTextEdits for class completions
          // when there are no existing `use` lines. Look up the FQN ourselves and add one.
          if (!item.additionalTextEdits?.length && item._bladeDoc) {
            const CLASS_KINDS = new Set([
              vscode.CompletionItemKind.Constructor,
              vscode.CompletionItemKind.Class,
              vscode.CompletionItemKind.Interface,
            ]);
            if (CLASS_KINDS.has(item.kind)) {
              const lspIt     = item._lspItem;
              const labelText = typeof lspIt.label === 'string' ? lspIt.label : lspIt.label?.label ?? '';
              if (labelText) {
                const matches = await resolveClassFqns(labelText);
                const already = importedFqns(item._bladeDoc);
                for (const { fqn } of matches) {
                  if (!already.has(fqn)) {
                    const edit = computeUseTextEdit(item._bladeDoc, fqn);
                    if (edit) { item.additionalTextEdits = [edit]; break; }
                  }
                }
              }
            }
          }

          if (resolved?.detail || resolved?.label || resolved?.documentation) {
            if (resolved.detail) item.detail = resolved.detail;
            // Update insertText with full-signature snippet.
            // Intelephense omits detail for project methods — fall back to documentation text
            // which contains the full signature as a PHP code block.
            if (CALLABLE_KINDS.has(item.kind)) {
              const lspIt     = item._lspItem;
              const labelText = typeof lspIt.label === 'string' ? lspIt.label : lspIt.label?.label ?? '';
              if (labelText) {
                const docText = typeof resolved.documentation === 'string'
                  ? resolved.documentation
                  : (resolved.documentation?.value ?? '');
                const sig = labelDetailOf(resolved.label ?? lspIt.label)
                  ?? resolved.detail
                  ?? (docText || undefined);
                const snippet = snippetFromSignature(labelText, sig);
                if (snippet) {
                  item.insertText = snippet;
                  // Show params in the dropdown detail line (visible before insertion)
                  if (!item.detail) {
                    const params = paramsFromSig(labelText, sig);
                    if (params?.length) item.detail = `(${params.join(', ')})`;
                  }
                }
              }
            }
            if (resolved.documentation) item.documentation = lspContentToMarkdown(resolved.documentation);
          }
        } catch (_) {}
        return item;
      },
    }, '.', '>', ':', '$', '\\', "'", '"')
  );

  // ── Hover ─────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(doc, position) {
        try { await syncVirtualDoc(doc); } catch (_) { return null; }
        const rec = virtualDocs.get(doc.uri.toString());
        if (!rec) return null;
        try {
          const result = await lspClient.hover(rec.virtualUri, position);
          if (!result?.contents) return null;
          const raw      = result.contents;
          const contents = Array.isArray(raw) ? raw : [raw];
          return new vscode.Hover(
            contents.map(lspContentToMarkdown).filter(Boolean),
            lspRangeToVscode(result.range)
          );
        } catch (_) { return null; }
      },
    })
  );

  // ── Definition ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(doc, position) {
        try { await syncVirtualDoc(doc); } catch (_) { return []; }
        const rec = virtualDocs.get(doc.uri.toString());
        if (!rec) return [];
        try {
          const result = await lspClient.definition(rec.virtualUri, position);
          const locs   = Array.isArray(result) ? result : (result ? [result] : []);
          return locs.map(loc => {
            // Remap virtual URI back to the blade file itself
            const uri = loc.uri === rec.virtualUri
              ? doc.uri
              : vscode.Uri.parse(loc.uri);
            return new vscode.Location(uri, lspRangeToVscode(loc.range));
          });
        } catch (_) { return []; }
      },
    })
  );

  // ── Signature Help ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(selector, {
      async provideSignatureHelp(doc, position, _token, ctx) {
        try { await syncVirtualDoc(doc); } catch (_) { return null; }
        const rec = virtualDocs.get(doc.uri.toString());
        if (!rec) return null;
        try {
          const result = await lspClient.signatureHelp(rec.virtualUri, position, ctx.triggerCharacter);
          if (!result?.signatures?.length) return null;
          const help      = new vscode.SignatureHelp();
          help.signatures = result.signatures.map(sig => {
            const si = new vscode.SignatureInformation(
              sig.label,
              sig.documentation ? lspContentToMarkdown(sig.documentation) : undefined
            );
            si.parameters = (sig.parameters ?? []).map(p =>
              new vscode.ParameterInformation(
                p.label,
                p.documentation ? lspContentToMarkdown(p.documentation) : undefined
              )
            );
            return si;
          });
          help.activeSignature = result.activeSignature ?? 0;
          help.activeParameter = result.activeParameter ?? 0;
          return help;
        } catch (_) { return null; }
      },
    }, '(', ',')
  );

  // ── Import Class command ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('bladeBridge.importClass', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'blade') return;
      const doc = editor.document;
      const pos = editor.selection.active;

      const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
      const word      = wordRange ? doc.getText(wordRange) : '';
      if (!word) { vscode.window.showWarningMessage('Blade Bridge: No class name under cursor'); return; }

      const matches = await resolveClassFqns(word);
      if (!matches.length) {
        vscode.window.showWarningMessage(`Blade Bridge: No class named "${word}" in the workspace index`);
        return;
      }

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

  // ── Diagnose command ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('bladeBridge.diagnose', async () => {
      const editor = vscode.window.activeTextEditor;
      const doc    = editor?.document;
      const lines  = [
        `server path: ${serverPath}`,
        `lsp ready: ${lspClient?._ready ?? false}`,
        `virtual docs: ${virtualDocs.size}`,
        `languageId: ${doc?.languageId ?? 'n/a'}`,
      ];

      if (doc?.languageId === 'blade') {
        try { await syncVirtualDoc(doc); } catch (_) {}
        const rec = virtualDocs.get(doc.uri.toString());
        if (rec) {
          lines.push(`virtual uri: ${rec.virtualUri}`);
          const pos       = editor.selection.active;
          const wordRange = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
          const word      = wordRange ? doc.getText(wordRange) : '(none)';
          lines.push(`word under cursor: "${word}"`);
          try {
            const result = await lspClient.completion(rec.virtualUri, pos, undefined);
            const items  = Array.isArray(result) ? result : (result?.items ?? []);
            lines.push(`lsp completions at cursor: ${items.length}`);
            for (const it of items.slice(0, 6)) {
              const label = typeof it.label === 'string' ? it.label : it.label?.label ?? '?';
              lines.push(`  ▸ ${label} (kind ${it.kind})`);
            }
          } catch (e) { lines.push(`completion error: ${e.message}`); }
          try {
            const fqns = await resolveClassFqns(word);
            lines.push(`workspace classes matching "${word}": ${fqns.length}`);
            for (const f of fqns.slice(0, 8)) lines.push(`  ▸ ${f.fqn}`);
          } catch (e) { lines.push(`symbol error: ${e.message}`); }
        }
      }

      vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
      console.log('[BladeBridge Diagnose]\n' + lines.join('\n'));
    })
  );
}

function deactivate() {
  lspClient?.dispose();
  lspClient       = null;
  bladeDiagnostics = null;
  virtualDocs.clear();
}

module.exports = { activate, deactivate };
