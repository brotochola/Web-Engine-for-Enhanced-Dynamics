#!/usr/bin/env node
/**
 * Build docs/internal/hypotheses.html from docs/internal/hypotheses.json: one self-contained page
 * (data embedded, no server, no network) to read every speed hypothesis WeedJS has tested or plans
 * to test, the leads that may become new ones, and the tools that find them.
 *
 *   node scripts/buildHypothesesPage.mjs           write the page
 *   node scripts/buildHypothesesPage.mjs --check   exit 1 when the page is out of date
 *
 * Edit the JSON, never the page: tests/node/hypothesesRegistry.test.js fails when they disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = path.join(root, 'docs/internal/hypotheses.json');
export const PAGE_PATH = path.join(root, 'docs/internal/hypotheses.html');

/** The page for a registry (a string; the same input always gives the same bytes). */
export function renderPage(registry) {
  // A `</script>` inside the data would end the tag early.
  const data = JSON.stringify(registry).replace(/</g, '\\u003c');
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
    <select id="fkind"><option value="">Any kind</option><option value="wasm">WASM / C</option><option value="js">JS</option><option value="gpu">GPU</option></select>
  </div>
</div></header>
<main><div class="wrap" id="view"></div></main>
<script id="data" type="application/json">${data}</script>
<script>
(() => {
  const reg = JSON.parse(document.getElementById('data').textContent);
  const H = reg.hypotheses;
  const GROUPS = { '@pending': ['open', 'running', 'blocked'], '@kept': ['kept', 'kept-kernel', 'kept-hygiene'], '@notkept': ['dropped', 'rejected', 'fail'], '@neutral': ['tie', 'mixed', 'screened'] };
  const LABEL = { 'kept-kernel': 'kept (kernel)', 'kept-hygiene': 'kept (hygiene)' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const md = (s) => esc(s).replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Evidence links: the doc in VS Code at its line, and the file itself.
  const base = decodeURIComponent(location.pathname).replace(/\\/docs\\/internal\\/hypotheses\\.html$/, '');
  const links = (refs) => (refs || []).map((r) => {
    const [file, anchor] = r.split('#L');
    const line = anchor ? ':' + anchor : '';
    const label = file.replace(/\\.md$/, '') + (anchor ? ' line ' + anchor : '');
    return '<a href="vscode://file' + esc(base) + '/docs/internal/' + esc(file) + esc(line) + '">' + esc(label) + '</a><a href="./' + esc(file) + '">file</a>';
  }).join('');
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
        '<div>' + md(h.result) + '</div><div class="links">' + links(h.refs) + '</div></td></tr>' : '';
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
  const page = renderPage(registry);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(PAGE_PATH) ? fs.readFileSync(PAGE_PATH, 'utf8') : '';
    if (current !== page) {
      console.error('docs/internal/hypotheses.html is out of date: run node scripts/buildHypothesesPage.mjs');
      process.exit(1);
    }
    console.log('hypotheses.html is up to date');
    return;
  }
  fs.writeFileSync(PAGE_PATH, page);
  console.log(`wrote ${path.relative(root, PAGE_PATH)} (${registry.hypotheses.length} hypotheses)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
