#!/usr/bin/env node
/**
 * Build docs/internal/hypotheses.html from docs/internal/hypotheses.json: one self-contained page
 * (data embedded, no server, no network) to read every speed hypothesis WeedJS has tested or plans
 * to test, the leads that may become new ones, and the tools that find them.
 *
 *   node scripts/buildHypothesesPage.mjs          write the page
 *   node scripts/buildHypothesesPage.mjs --open   write it and open it in the browser
 *
 * The JSON is the registry; the page is built from it and the docs when you want to read it, and is
 * not committed. An entry's refs name rows, not lines: `HYPOTHESIS_LOG.md#W9d` is the one row of
 * the log whose title is `W9d` or holds it as a whole token (a row's title is a table row's first
 * cell, a bold lead before `:**`, a heading, or a review item's bold id), so a row keeps its ref however many rows go in
 * above it. A key is an id, or the start of the title when the id alone finds several. The page resolves
 * each ref to its line and shows the row; tests/node/hypothesesRegistry.test.js fails when a ref
 * finds no row or several.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = path.join(root, 'docs/internal/hypotheses.json');
export const PAGE_PATH = path.join(root, 'docs/internal/hypotheses.html');
const DOCS_DIR = path.dirname(REGISTRY_PATH);
const EXCERPT_CHARS = 480;

/** A row title or a key without its markdown: no `*`, backticks or backslashes, single spaces. */
export const normalizeTitle = (s) => s.replace(/[*`\\]/g, '').replace(/\s+/g, ' ').trim();

/** The title of a row line (a table row's first cell, a bold lead, a heading), or '' for other lines. */
function rowTitle(line) {
  let t = '';
  if (line.startsWith('|')) {
    if (/^\|[\s:|-]*$/.test(line)) return '';
    t = line.split('|')[1] || '';
  } else if (line.startsWith('**')) {
    const end = line.indexOf(':**');
    if (end < 0) return '';
    t = line.slice(2, end);
    const close = t.indexOf('**');
    if (close >= 0) t = t.slice(0, close);
  } else if (/^#{1,4} /.test(line)) {
    t = line.replace(/^#{1,4} /, '');
  } else {
    // A review item: `- [x] **M13** — ...`.
    const item = /^- \[[ x]\] \*\*([^*]+)\*\*/.exec(line);
    if (item) t = item[1];
  }
  return normalizeTitle(t);
}

/** A doc's rows, each with its line (1-based), title and excerpt. */
export function docRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const title = rowTitle(lines[i]);
    if (!title) continue;
    let body = lines[i];
    if (body.startsWith('|')) body = body.split('|').slice(1, -1).map((c) => c.trim()).filter(Boolean).join(' · ');
    else if (body.startsWith('#')) {
      // A heading's excerpt is its section's first lines.
      for (let k = i + 1; k < lines.length && body.length < EXCERPT_CHARS && !/^#{1,4} /.test(lines[k]); k++) body += ' ' + lines[k];
    }
    body = body.replace(/[*\\]/g, '').replace(/\s+/g, ' ').trim();
    rows.push({ line: i + 1, title, excerpt: body.length > EXCERPT_CHARS ? body.slice(0, EXCERPT_CHARS) + '…' : body });
  }
  return rows;
}

const TOKEN_CHAR = /[A-Za-z0-9]/;
/** Does a row title hold the key as a whole token (`W9` is not in `W9d`, `E-82` is not in `E-82b`)? */
export function keyMatches(title, key) {
  for (let at = title.indexOf(key); at >= 0; at = title.indexOf(key, at + 1)) {
    if (!TOKEN_CHAR.test(title[at - 1] || '') && !TOKEN_CHAR.test(title[at + key.length] || '')) return true;
  }
  return false;
}

/** The rows a key names: those whose title is the key, else those that hold it as a whole token. */
export function findRows(rows, key) {
  const exact = rows.filter((r) => r.title === key);
  return exact.length ? exact : rows.filter((r) => keyMatches(r.title, key));
}

/**
 * Resolve every ref of a registry against the docs.
 * @returns {{ resolved: Record<string, { file: string, line: number, title: string, excerpt: string }>, errors: string[] }}
 */
export function resolveRefs(registry, docsDir = DOCS_DIR) {
  const docs = new Map();
  const rowsOf = (file) => {
    if (!docs.has(file)) {
      const full = path.join(docsDir, file);
      docs.set(file, fs.existsSync(full) ? docRows(fs.readFileSync(full, 'utf8')) : null);
    }
    return docs.get(file);
  };
  const resolved = {};
  const errors = [];
  for (const h of registry.hypotheses) {
    for (const ref of h.refs || []) {
      if (resolved[ref]) continue;
      const name = h.id || h.title;
      const hash = ref.indexOf('#');
      const file = hash < 0 ? ref : ref.slice(0, hash);
      const rows = rowsOf(file);
      if (!rows) { errors.push(`${name}: ${file} does not exist`); continue; }
      if (hash < 0) { resolved[ref] = { file, line: 0, title: '', excerpt: '' }; continue; }
      const key = normalizeTitle(ref.slice(hash + 1));
      if (/^L\d+$/.test(key)) { errors.push(`${name}: ${ref} is a line number; name the row by a key in its title (${file}#W9d)`); continue; }
      const hits = findRows(rows, key);
      if (hits.length !== 1) {
        const some = hits.slice(0, 3).map((r) => `line ${r.line} "${r.title.slice(0, 60)}"`).join('; ');
        errors.push(`${name}: ${ref} finds ${hits.length ? hits.length + ' rows (' + some + '): use more of the title' : 'no row'}`);
        continue;
      }
      resolved[ref] = { file, line: hits[0].line, title: hits[0].title, excerpt: hits[0].excerpt };
    }
  }
  return { resolved, errors };
}

/** The page for a registry and its resolved refs (a string). */
export function renderPage(registry, resolved = {}) {
  // A `</script>` inside the data would end the tag early.
  const data = JSON.stringify({ registry, resolved }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeedJS hypotheses</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df; --accent: #2f6fed;
  --kept: #1f8a4c; --keptbg: #e3f4ea; --drop: #b3402a; --dropbg: #fbe7e2; --open: #2f6fed; --openbg: #e6eefd;
  --run: #a86b00; --runbg: #fdf1d8; --block: #7a4fd0; --blockbg: #efe7fb; --gray: #6b6b66; --graybg: #ecece8;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #151515; --panel: #1e1e1d; --text: #ececea; --muted: #a2a29c; --line: #333331; --accent: #7aa5ff;
    --kept: #6fd39a; --keptbg: #1b3326; --drop: #f19a85; --dropbg: #3a221c; --open: #8db3ff; --openbg: #1d2a45;
    --run: #f0c060; --runbg: #3a2e14; --block: #c3a6ff; --blockbg: #2c2342; --gray: #b0b0aa; --graybg: #2a2a28; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; }
.wrap { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 2px; }
.sub { color: var(--muted); font-size: 13px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.bar input, .bar select { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); }
.bar input { flex: 1 1 260px; min-width: 0; }
nav { display: flex; gap: 4px; margin-top: 10px; overflow-x: auto; }
nav button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--text); padding: 6px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
nav button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
main { padding: 16px; }
.counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.s-kept, .s-kept-kernel, .s-kept-hygiene { color: var(--kept); background: var(--keptbg); }
.s-dropped, .s-rejected, .s-fail { color: var(--drop); background: var(--dropbg); }
.s-open { color: var(--open); background: var(--openbg); }
.s-running { color: var(--run); background: var(--runbg); }
.s-blocked { color: var(--block); background: var(--blockbg); }
.s-tie, .s-mixed, .s-screened, .s-superseded, .s-answered, .s-note { color: var(--gray); background: var(--graybg); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
.card .top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.rank { font-weight: 700; color: var(--accent); min-width: 2ch; }
.id { font: 600 13px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
.alias { color: var(--muted); font: 12px ui-monospace, Consolas, monospace; }
.title { font-weight: 600; }
.meta { color: var(--muted); font-size: 12px; }
.next { margin-top: 6px; }
.result { margin-top: 6px; color: var(--muted); font-size: 14px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
tr.row { cursor: pointer; }
tr.row:hover td { background: var(--bg); }
tr.detail td { background: var(--bg); font-size: 14px; }
td.res { color: var(--muted); font-size: 14px; }
a { color: var(--accent); }
.links a { margin-right: 10px; font-size: 13px; }
.ev { margin-top: 6px; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: 13px; }
.empty { color: var(--muted); padding: 20px 4px; }
code { font: 13px ui-monospace, Consolas, monospace; }
@media (max-width: 720px) { .hide-sm { display: none; } th, td { padding: 7px 6px; } }
</style>
</head>
<body>
<header><div class="wrap">
  <h1>WeedJS hypotheses</h1>
  <div class="sub" id="sub"></div>
  <nav id="tabs">
    <button data-tab="next" class="on">Next up</button>
    <button data-tab="all">All</button>
    <button data-tab="leads">Leads</button>
    <button data-tab="find">How to find new ones</button>
  </nav>
  <div class="bar" id="filters">
    <input id="q" type="search" placeholder="Search id, title, result…">
    <select id="fstatus"><option value="">Any status</option><option value="@pending">Pending (open, running, blocked)</option><option value="@kept">Kept</option><option value="@notkept">Not kept (dropped, rejected, fail)</option><option value="@neutral">Tie, mixed, screened</option></select>
    <select id="farea"><option value="">Any worker</option></select>
    <select id="fkind"><option value="">Any kind</option><option value="wasm">WASM / C</option><option value="js">JS</option><option value="gpu">GPU</option><option value="dx">DX</option></select>
  </div>
</div></header>
<main><div class="wrap" id="view"></div></main>
<script id="data" type="application/json">${data}</script>
<script>
(() => {
  const { registry: reg, resolved } = JSON.parse(document.getElementById('data').textContent);
  const H = reg.hypotheses;
  const GROUPS = { '@pending': ['open', 'running', 'blocked'], '@kept': ['kept', 'kept-kernel', 'kept-hygiene'], '@notkept': ['dropped', 'rejected', 'fail'], '@neutral': ['tie', 'mixed', 'screened'] };
  const LABEL = { 'kept-kernel': 'kept (kernel)', 'kept-hygiene': 'kept (hygiene)' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const md = (s) => esc(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Evidence links: the doc in VS Code at the row's line, and the file itself.
  const base = decodeURIComponent(location.pathname).replace(/\\/docs\\/internal\\/hypotheses\\.html$/, '');
  const links = (refs) => (refs || []).map((r) => {
    const at = resolved[r] || { file: r.split('#')[0], line: 0 };
    const line = at.line ? ':' + at.line : '';
    const key = r.includes('#') ? r.slice(r.indexOf('#') + 1) : '';
    const label = at.file.replace(/\\.md$/, '') + (at.line ? ' line ' + at.line : '') + (key && key.length <= 24 ? ' (' + key + ')' : '');
    return '<a href="vscode://file' + esc(base) + '/docs/internal/' + esc(at.file) + esc(line) + '" title="' + esc(at.title || '') + '">' + esc(label) + '</a><a href="./' + esc(at.file) + '">file</a>';
  }).join('');
  // The rows themselves, under an entry opened in the table.
  const evidence = (refs) => (refs || []).map((r) => resolved[r] && resolved[r].excerpt ? '<div class="ev"><b>' + esc(resolved[r].file.replace(/\\.md$/, '')) + ':</b> ' + md(resolved[r].excerpt) + '</div>' : '').join('');
  const chip = (s) => '<span class="chip s-' + esc(s) + '" title="' + esc(reg.statuses[s] || '') + '">' + esc(LABEL[s] || s) + '</span>';

  const counts = H.reduce((m, h) => ((m[h.status] = (m[h.status] || 0) + 1), m), {});
  const pending = (counts.open || 0) + (counts.running || 0) + (counts.blocked || 0);
  const kept = (counts.kept || 0) + (counts['kept-kernel'] || 0) + (counts['kept-hygiene'] || 0);
  document.getElementById('sub').textContent = H.length + ' hypotheses · ' + pending + ' pending · ' + kept + ' kept · updated ' + reg.updated;
  const areas = [...new Set(H.map((h) => h.area).filter(Boolean))].sort();
  document.getElementById('farea').insertAdjacentHTML('beforeend', areas.map((a) => '<option>' + esc(a) + '</option>').join(''));

  let tab = 'next';
  let sortKey = 'default';
  let sortDir = 1;
  const open = new Set();
  const q = document.getElementById('q');
  const fs = document.getElementById('fstatus');
  const fa = document.getElementById('farea');
  const fk = document.getElementById('fkind');

  function filtered(list) {
    const text = q.value.trim().toLowerCase();
    const st = fs.value;
    return list.filter((h) => {
      if (st && !(GROUPS[st] ? GROUPS[st].includes(h.status) : h.status === st)) return false;
      if (fa.value && h.area !== fa.value) return false;
      if (fk.value && h.kind !== fk.value) return false;
      if (!text) return true;
      return [h.id, (h.aliases || []).join(' '), h.title, h.result, h.next, h.statusText].join(' ').toLowerCase().includes(text);
    });
  }
  function card(h) {
    return '<div class="card"><div class="top">' + (h.rank ? '<span class="rank">' + h.rank + '</span>' : '') +
      '<span class="id">' + esc(h.id || '—') + '</span>' + ((h.aliases || []).length ? '<span class="alias">' + esc(h.aliases.join(' · ')) + '</span>' : '') +
      chip(h.status) + '<span class="title">' + md(h.title) + '</span><span class="meta">' + esc([h.area, h.kind, h.date].filter(Boolean).join(' · ')) + '</span></div>' +
      (h.next ? '<div class="next"><b>Next:</b> ' + md(h.next) + '</div>' : '') +
      (h.result ? '<div class="result">' + md(h.result) + '</div>' : '') + '<div class="links">' + links(h.refs) + '</div></div>';
  }
  function renderNext() {
    const list = filtered(H.filter((h) => GROUPS['@pending'].includes(h.status)));
    const ranked = list.filter((h) => h.rank).sort((a, b) => a.rank - b.rank);
    const rest = list.filter((h) => !h.rank);
    return '<div class="counts">' + chip('running') + ' ' + (counts.running || 0) + ' ' + chip('open') + ' ' + (counts.open || 0) + ' ' + chip('blocked') + ' ' + (counts.blocked || 0) + '</div>' +
      (ranked.length ? '<h3>Ranked queue</h3>' + ranked.map(card).join('') : '') +
      (rest.length ? '<h3>Also pending</h3>' + rest.map(card).join('') : '') +
      (list.length ? '' : '<div class="empty">Nothing pending matches.</div>');
  }
  function renderAll() {
    const list = filtered(H.slice());
    const key = { id: (h) => h.id || '~', status: (h) => h.status, area: (h) => h.area || '', date: (h) => h.date || '', title: (h) => h.title || '' }[sortKey];
    if (key) list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sortDir);
    const head = '<tr><th data-k="id">Id</th><th data-k="status">Status</th><th data-k="title">Hypothesis</th><th data-k="area" class="hide-sm">Worker</th><th data-k="date" class="hide-sm">Date</th><th class="hide-sm">Result</th></tr>';
    const rows = list.map((h, i) => {
      const k = (h.id || '') + '|' + h.title;
      const row = '<tr class="row" data-key="' + esc(k) + '"><td class="id">' + esc(h.id || '—') + '</td><td>' + chip(h.status) + '</td><td>' + md(h.title) +
        '</td><td class="hide-sm">' + esc(h.area || '') + '</td><td class="hide-sm">' + esc(h.date || '') + '</td><td class="res hide-sm">' + md((h.result || '').slice(0, 140)) + ((h.result || '').length > 140 ? '…' : '') + '</td></tr>';
      const detail = open.has(k) ? '<tr class="detail"><td colspan="6">' + ((h.aliases || []).length ? '<div><b>Also:</b> ' + esc(h.aliases.join(', ')) + '</div>' : '') +
        (h.statusText ? '<div><b>Status:</b> ' + md(h.statusText) + '</div>' : '') + (h.next ? '<div><b>Next:</b> ' + md(h.next) + '</div>' : '') +
        '<div>' + md(h.result) + '</div><div class="links">' + links(h.refs) + '</div>' + evidence(h.refs) + '</td></tr>' : '';
      return row + detail;
    }).join('');
    return '<div class="counts">' + Object.keys(reg.statuses).filter((s) => counts[s]).map((s) => chip(s) + ' ' + counts[s]).join(' &nbsp; ') + '</div>' +
      (list.length ? '<table>' + head + rows + '</table>' : '<div class="empty">No hypothesis matches.</div>');
  }
  function renderLeads() {
    return '<p class="sub">Findings that are not hypotheses yet: where the next ones come from.</p>' + reg.leads.map((l) =>
      '<div class="card"><div class="meta">' + esc(l.source) + '</div><div class="title">' + md(l.finding) + '</div>' + (l.next ? '<div class="next"><b>Next:</b> ' + md(l.next) + '</div>' : '') + '</div>').join('');
  }
  function renderFind() {
    return '<p class="sub">' + md(reg.about) + '</p>' + reg.howToFindNew.map((t) => '<div class="card"><div class="title"><code>' + esc(t.tool) + '</code></div><div class="result">' + md(t.what) + '</div></div>').join('') +
      '<h3>Status words</h3><div class="card">' + Object.entries(reg.statuses).map(([s, d]) => '<div>' + chip(s) + ' ' + esc(d) + '</div>').join('') + '</div>';
  }
  function render() {
    document.getElementById('filters').style.display = tab === 'next' || tab === 'all' ? '' : 'none';
    const view = document.getElementById('view');
    view.innerHTML = tab === 'next' ? renderNext() : tab === 'all' ? renderAll() : tab === 'leads' ? renderLeads() : renderFind();
    view.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
      sortDir = sortKey === th.dataset.k ? -sortDir : 1;
      sortKey = th.dataset.k;
      render();
    }));
    view.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => {
      const k = tr.dataset.key;
      if (open.has(k)) open.delete(k); else open.add(k);
      render();
    }));
  }
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
  [q, fs, fa, fk].forEach((el) => el.addEventListener('input', render));
  render();
})();
</script>
</body>
</html>
`;
}

function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const { resolved, errors } = resolveRefs(registry);
  for (const e of errors) console.warn(`ref: ${e}`);
  fs.writeFileSync(PAGE_PATH, renderPage(registry, resolved));
  console.log(`wrote ${path.relative(root, PAGE_PATH)} (${registry.hypotheses.length} hypotheses; built locally, not committed)`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', PAGE_PATH]]
      : process.platform === 'darwin' ? ['open', [PAGE_PATH]] : ['xdg-open', [PAGE_PATH]];
    execFile(cmd, args);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
