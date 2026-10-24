#!/usr/bin/env node
/**
 * Build docs/internal/hypotheses.html from the register (docs/internal/hypotheses.json) and the journal
 * (docs/internal/DEVLOG.md): one self-contained page (data embedded, no server, no network) with what is
 * next, every hypothesis and its records, a timeline of everything that was done and tested, by day and
 * time when known, and the leads that may become new hypotheses.
 *
 *   node scripts/buildHypothesesPage.mjs          write the page
 *   node scripts/buildHypothesesPage.mjs --open   write it and open it in the browser
 *
 * The page is built when you want to read it and is not committed. The register's format, and how refs
 * name rows of the docs, are described in scripts/hypothesesRegister.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEVLOG_PATH, REGISTRY_PATH, docRows, findRows, keyMatches, loadRegistry, normalizeTitle, parseJournal, resolveRefs } from './hypothesesRegister.mjs';

export { REGISTRY_PATH, docRows, findRows, keyMatches, normalizeTitle, resolveRefs };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGE_PATH = path.join(root, 'docs/internal/hypotheses.html');

const STYLE = `
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df; --accent: #2f6fed;
  --kept: #1f8a4c; --keptbg: #e3f4ea; --drop: #b3402a; --dropbg: #fbe7e2; --open: #2f6fed; --openbg: #e6eefd;
  --run: #a86b00; --runbg: #fdf1d8; --block: #7a4fd0; --blockbg: #efe7fb; --gray: #6b6b66; --graybg: #ecece8;
  --jour: #8a5a00; --jourbg: #f6ecd9;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #151515; --panel: #1e1e1d; --text: #ececea; --muted: #a2a29c; --line: #333331; --accent: #7aa5ff;
    --kept: #6fd39a; --keptbg: #1b3326; --drop: #f19a85; --dropbg: #3a221c; --open: #8db3ff; --openbg: #1d2a45;
    --run: #f0c060; --runbg: #3a2e14; --block: #c3a6ff; --blockbg: #2c2342; --gray: #b0b0aa; --graybg: #2a2a28;
    --jour: #e8c27a; --jourbg: #35291a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; }
.wrap { max-width: 1180px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 2px; }
h3 { margin: 18px 0 8px; font-size: 15px; }
.sub { color: var(--muted); font-size: 13px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.bar input, .bar select { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); }
.bar input { flex: 1 1 260px; min-width: 0; }
nav { display: flex; gap: 4px; margin-top: 10px; overflow-x: auto; }
nav button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--text); padding: 6px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
nav button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
main { padding: 16px; }
.counts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; align-items: center; }
.chip { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
.s-kept, .s-kept-kernel, .s-kept-hygiene { color: var(--kept); background: var(--keptbg); }
.s-dropped, .s-rejected, .s-fail { color: var(--drop); background: var(--dropbg); }
.s-open { color: var(--open); background: var(--openbg); }
.s-running { color: var(--run); background: var(--runbg); }
.s-blocked { color: var(--block); background: var(--blockbg); }
.s-tie, .s-mixed, .s-screened, .s-superseded, .s-answered, .s-note, .s-passed { color: var(--gray); background: var(--graybg); }
.s-journal { color: var(--jour); background: var(--jourbg); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
.top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
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
.rec { margin-top: 10px; padding: 8px 10px; border-left: 3px solid var(--line); background: var(--panel); border-radius: 0 8px 8px 0; }
.rec p, .tl-text p { margin: 6px 0 0; }
.empty { color: var(--muted); padding: 20px 4px; }
code { font: 13px ui-monospace, Consolas, monospace; }
.day { position: sticky; top: 0; margin: 18px 0 6px; font-weight: 700; font-size: 14px; color: var(--muted); }
.tl { display: grid; grid-template-columns: 64px 1fr; gap: 0 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin: 0 0 8px; }
.tl-time { font: 600 13px ui-monospace, Consolas, monospace; color: var(--muted); padding-top: 2px; }
.tl-text { color: var(--text); font-size: 14px; margin-top: 4px; }
.tl-text.short { color: var(--muted); }
.hyp { font: 600 12px ui-monospace, Consolas, monospace; color: var(--accent); cursor: pointer; }
.more { cursor: pointer; color: var(--accent); font-size: 13px; }
.commits { margin-top: 6px; color: var(--muted); font: 12px ui-monospace, Consolas, monospace; }
@media (max-width: 720px) { .hide-sm { display: none; } th, td { padding: 7px 6px; } .tl { grid-template-columns: 1fr; } }
`;

/** The page's script, written as a function so it needs no escaping inside the template. */
function client() {
  const data = JSON.parse(document.getElementById('data').textContent);
  const reg = data.registry;
  const resolved = data.resolved;
  const journal = data.journal;
  const H = reg.hypotheses;
  const R = reg.records || [];
  const hypsOf = new Map();
  for (const h of H) for (const id of h.records || []) {
    if (!hypsOf.has(id)) hypsOf.set(id, []);
    hypsOf.get(id).push(h);
  }
  const recById = new Map(R.map((r) => [r.id, r]));
  const GROUPS = { '@pending': ['open', 'running', 'blocked'], '@kept': ['kept', 'kept-kernel', 'kept-hygiene'], '@notkept': ['dropped', 'rejected', 'fail'], '@neutral': ['tie', 'mixed', 'screened', 'passed', 'answered', 'note', 'superseded'] };
  const LABEL = { 'kept-kernel': 'kept (kernel)', 'kept-hygiene': 'kept (hygiene)' };
  const PART = { 'small hours': '03:00', 'early morning': '07:00', morning: '09:00', 'late morning': '11:00', midday: '12:30', noon: '12:30', afternoon: '15:00', 'late afternoon': '17:00', evening: '19:00', night: '22:00', 'late night': '23:30' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const md = (s) => String(s || '').split(/\n{2,}/).map((p) => '<p>' + p.split('\n').map(inline).join('<br>') + '</p>').join('');
  const plain = (s) => String(s || '').replace(/[*`]/g, '').replace(/\s+/g, ' ');
  const chip = (s) => '<span class="chip s-' + esc(s) + '" title="' + esc(reg.statuses[s] || (s === 'journal' ? 'An entry of the journal (DEVLOG.md).' : '')) + '">' + esc(LABEL[s] || s) + '</span>';
  const base = decodeURIComponent(location.pathname).replace(/\/docs\/internal\/hypotheses\.html$/, '');
  const links = (refs) => (refs || []).map((r) => {
    const at = resolved[r] || { file: r.split('#')[0], line: 0 };
    const key = r.includes('#') ? r.slice(r.indexOf('#') + 1) : '';
    const label = at.file.replace(/\.md$/, '') + (at.line ? ' line ' + at.line : '') + (key && key.length <= 24 ? ' (' + key + ')' : '');
    return '<a href="vscode://file' + esc(base) + '/docs/internal/' + esc(at.file) + (at.line ? ':' + at.line : '') + '" title="' + esc(at.title || '') + '">' + esc(label) + '</a><a href="./' + esc(at.file) + '">file</a>';
  }).join('');
  const evidence = (refs) => (refs || []).map((r) => (resolved[r] && resolved[r].excerpt ? '<div class="ev"><b>' + esc(resolved[r].file.replace(/\.md$/, '')) + ':</b> ' + inline(resolved[r].excerpt) + '</div>' : '')).join('');
  const when = (r) => r.date + (r.time ? ' ' + r.time : '');
  const sortKey = (date, time) => (date.length === 7 ? date + '-00' : date) + 'T' + (time || '00:00');
  const dayLabel = (d) => d.length === 7
    ? new Date(d + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ' (day not recorded)'
    : new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hypLabel = (h) => h.id || h.title.slice(0, 40);
  const hypChips = (hs) => (hs || []).map((h) => '<span class="hyp" data-hyp="' + esc(h.id || h.title) + '" title="' + esc(h.title) + '">' + esc(hypLabel(h)) + '</span>').join(' ');

  const counts = H.reduce((m, h) => ((m[h.status] = (m[h.status] || 0) + 1), m), {});
  const pending = (counts.open || 0) + (counts.running || 0) + (counts.blocked || 0);
  const kept = (counts.kept || 0) + (counts['kept-kernel'] || 0) + (counts['kept-hygiene'] || 0);
  document.getElementById('sub').textContent = H.length + ' hypotheses · ' + R.length + ' records · ' + journal.length + ' journal entries · ' + pending + ' pending · ' + kept + ' kept · register updated ' + reg.updated + ' · page built ' + data.builtAt;
  const areas = [...new Set(H.map((h) => h.area).filter(Boolean))].sort();
  document.getElementById('farea').insertAdjacentHTML('beforeend', areas.map((a) => '<option>' + esc(a) + '</option>').join(''));
  const months = [...new Set([...R.map((r) => r.date.slice(0, 7)), ...journal.map((j) => j.date.slice(0, 7))])].sort().reverse();
  document.getElementById('fmonth').insertAdjacentHTML('beforeend', months.map((m) => '<option>' + esc(m) + '</option>').join(''));

  let tab = 'timeline';
  let sortKeyAll = 'default';
  let sortDir = 1;
  const open = new Set();
  const expanded = new Set();
  const q = document.getElementById('q');
  const fs = document.getElementById('fstatus');
  const fa = document.getElementById('farea');
  const fk = document.getElementById('fkind');
  const fm = document.getElementById('fmonth');
  const fw = document.getElementById('fshow');

  const statusOk = (s) => !fs.value || (GROUPS[fs.value] ? GROUPS[fs.value].includes(s) : s === fs.value);
  function filteredHyps(list) {
    const text = q.value.trim().toLowerCase();
    return list.filter((h) => {
      if (!statusOk(h.status)) return false;
      if (fa.value && h.area !== fa.value) return false;
      if (fk.value && h.kind !== fk.value) return false;
      if (!text) return true;
      const recs = (h.records || []).map((id) => (recById.get(id) || {}).title).join(' ');
      return [h.id, (h.aliases || []).join(' '), h.title, h.result, h.next, h.statusText, recs].join(' ').toLowerCase().includes(text);
    });
  }
  function recordBlock(r) {
    return '<div class="rec"><div class="top"><span class="id">' + esc(r.id) + '</span><span class="meta">' + esc(when(r)) + '</span>' + (r.verdict ? chip(r.verdict) : '') + '<span class="title">' + inline(r.title) + '</span></div>' +
      '<div class="tl-text">' + md(r.text) + '</div>' + (r.commits ? '<div class="commits">commits ' + esc(r.commits.join(' ')) + '</div>' : '') + '</div>';
  }
  function lastRecord(h) {
    const rs = (h.records || []).map((id) => recById.get(id)).filter(Boolean).sort((a, b) => (sortKey(a.date, a.time) < sortKey(b.date, b.time) ? 1 : -1));
    return rs[0];
  }
  function card(h) {
    const last = lastRecord(h);
    return '<div class="card"><div class="top">' + (h.rank ? '<span class="rank">' + h.rank + '</span>' : '') +
      '<span class="id">' + esc(h.id || '—') + '</span>' + ((h.aliases || []).length ? '<span class="alias">' + esc(h.aliases.join(' · ')) + '</span>' : '') +
      chip(h.status) + '<span class="title">' + inline(h.title) + '</span><span class="meta">' + esc([h.area, h.kind, h.date, last ? (h.records.length + ' records, last ' + when(last)) : ''].filter(Boolean).join(' · ')) + '</span></div>' +
      (h.next ? '<div class="next"><b>Next:</b> ' + inline(h.next) + '</div>' : '') +
      (h.result ? '<div class="result">' + inline(h.result) + '</div>' : '') + '<div class="links">' + links(h.refs) + '</div></div>';
  }
  function renderNext() {
    const list = filteredHyps(H.filter((h) => GROUPS['@pending'].includes(h.status)));
    const ranked = list.filter((h) => h.rank).sort((a, b) => a.rank - b.rank);
    const rest = list.filter((h) => !h.rank);
    return '<div class="counts">' + chip('running') + ' ' + (counts.running || 0) + ' ' + chip('open') + ' ' + (counts.open || 0) + ' ' + chip('blocked') + ' ' + (counts.blocked || 0) + '</div>' +
      (ranked.length ? '<h3>Ranked queue</h3>' + ranked.map(card).join('') : '') +
      (rest.length ? '<h3>Also pending</h3>' + rest.map(card).join('') : '') +
      (list.length ? '' : '<div class="empty">Nothing pending matches.</div>');
  }
  function timelineItems() {
    const text = q.value.trim().toLowerCase();
    const items = [];
    if (fw.value !== 'journal') {
      for (const r of R) {
        if (fm.value && r.date.slice(0, 7) !== fm.value) continue;
        if (fs.value && !statusOk(r.verdict || '')) continue;
        const hs = hypsOf.get(r.id) || [];
        if (fa.value && !hs.some((h) => h.area === fa.value)) continue;
        if (fk.value && !hs.some((h) => h.kind === fk.value)) continue;
        if (text && ![r.id, r.title, r.text, hs.map((h) => h.id + ' ' + h.title + ' ' + (h.aliases || []).join(' ')).join(' ')].join(' ').toLowerCase().includes(text)) continue;
        items.push({ key: r.id, kind: 'record', date: r.date, time: r.time, sort: sortKey(r.date, r.time), r, hs });
      }
    }
    if (fw.value !== 'records' && !fs.value && !fa.value && !fk.value) {
      journal.forEach((j, k) => {
        if (fm.value && j.date.slice(0, 7) !== fm.value) return;
        if (text && !(j.title + ' ' + j.text).toLowerCase().includes(text)) return;
        items.push({ key: 'J' + k, kind: 'journal', date: j.date, part: j.part, sort: sortKey(j.date, j.time || PART[j.part] || '12:00'), j });
      });
    }
    items.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0));
    return items;
  }
  function renderTimeline() {
    const items = timelineItems();
    let out = '<div class="counts"><span class="meta">' + items.length + ' items, newest first. Times are local; a record\'s time is when it was written down, or the time of the commit it names. Click an item to read it whole.</span></div>';
    let day = null;
    for (const it of items) {
      if (it.date !== day) { day = it.date; out += '<div class="day">' + esc(dayLabel(day)) + '</div>'; }
      const isOpen = expanded.has(it.key);
      if (it.kind === 'record') {
        const r = it.r;
        const timeTitle = r.time ? (r.timeFrom === 'commit' ? 'the time of a commit this record names' : 'when this record was written down') : 'time not recorded';
        const body = isOpen ? md(r.text) + (r.commits ? '<div class="commits">commits ' + esc(r.commits.join(' ')) + '</div>' : '') : esc(plain(r.text).slice(0, 260)) + (plain(r.text).length > 260 ? '… <span class="more">more</span>' : '');
        out += '<div class="tl" data-key="' + esc(it.key) + '"><div class="tl-time" title="' + esc(timeTitle) + '">' + esc(r.time || '—') + '</div><div><div class="top">' +
          (r.verdict ? chip(r.verdict) : '') + '<span class="title">' + inline(r.title) + '</span> ' + hypChips(it.hs) + '<span class="meta">' + esc(r.id) + '</span></div>' +
          '<div class="tl-text' + (isOpen ? '' : ' short') + '">' + body + '</div></div></div>';
      } else {
        const j = it.j;
        const body = isOpen ? md(j.text) : esc(plain(j.text).slice(0, 260)) + (plain(j.text).length > 260 ? '… <span class="more">more</span>' : '');
        out += '<div class="tl" data-key="' + esc(it.key) + '"><div class="tl-time" title="the time or part of the day the journal gives">' + esc(j.time || j.part || '—') + '</div><div><div class="top">' + chip('journal') +
          '<span class="title">' + inline(j.title) + '</span>' + (j.until ? '<span class="meta">until ' + esc(dayLabel(j.until)) + '</span>' : '') + '</div><div class="tl-text' + (isOpen ? '' : ' short') + '">' + body + '</div></div></div>';
      }
    }
    return out + (items.length ? '' : '<div class="empty">Nothing matches.</div>');
  }
  function renderAll() {
    const list = filteredHyps(H.slice());
    const key = { id: (h) => h.id || '~', status: (h) => h.status, area: (h) => h.area || '', date: (h) => h.date || '', title: (h) => h.title || '', records: (h) => (h.records || []).length }[sortKeyAll];
    if (key) list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * sortDir);
    const head = '<tr><th data-k="id">Id</th><th data-k="status">Status</th><th data-k="title">Hypothesis</th><th data-k="area" class="hide-sm">Worker</th><th data-k="date" class="hide-sm">Date</th><th data-k="records" class="hide-sm">Records</th><th class="hide-sm">Result</th></tr>';
    const rows = list.map((h) => {
      const k = (h.id || '') + '|' + h.title;
      const row = '<tr class="row" data-key="' + esc(k) + '"><td class="id">' + esc(h.id || '—') + '</td><td>' + chip(h.status) + '</td><td>' + inline(h.title) +
        '</td><td class="hide-sm">' + esc(h.area || '') + '</td><td class="hide-sm">' + esc(h.date || '') + '</td><td class="hide-sm">' + ((h.records || []).length || '') + '</td><td class="res hide-sm">' + inline((h.result || '').slice(0, 140)) + ((h.result || '').length > 140 ? '…' : '') + '</td></tr>';
      const recs = (h.records || []).map((id) => recById.get(id)).filter(Boolean).sort((a, b) => (sortKey(a.date, a.time) < sortKey(b.date, b.time) ? -1 : 1));
      const detail = open.has(k) ? '<tr class="detail"><td colspan="7">' + ((h.aliases || []).length ? '<div><b>Also:</b> ' + esc(h.aliases.join(', ')) + '</div>' : '') +
        (h.statusText ? '<div><b>Status:</b> ' + inline(h.statusText) + '</div>' : '') + (h.next ? '<div><b>Next:</b> ' + inline(h.next) + '</div>' : '') +
        (h.result ? '<div>' + inline(h.result) + '</div>' : '') + recs.map(recordBlock).join('') + '<div class="links">' + links(h.refs) + '</div>' + evidence(h.refs) + '</td></tr>' : '';
      return row + detail;
    }).join('');
    return '<div class="counts">' + Object.keys(reg.statuses).filter((s) => counts[s]).map((s) => chip(s) + ' ' + counts[s]).join(' &nbsp; ') + '</div>' +
      (list.length ? '<table>' + head + rows + '</table>' : '<div class="empty">No hypothesis matches.</div>');
  }
  function renderLeads() {
    return '<p class="sub">Findings that are not hypotheses yet: where the next ones come from.</p>' + reg.leads.map((l) =>
      '<div class="card"><div class="meta">' + esc(l.source) + '</div><div class="title">' + inline(l.finding) + '</div>' + (l.next ? '<div class="next"><b>Next:</b> ' + inline(l.next) + '</div>' : '') + '</div>').join('');
  }
  function renderFind() {
    return '<div class="card">' + md(reg.about) + '</div>' + reg.howToFindNew.map((t) => '<div class="card"><div class="title"><code>' + esc(t.tool) + '</code></div><div class="result">' + inline(t.what) + '</div></div>').join('') +
      '<h3>Status and verdict words</h3><div class="card">' + Object.entries(reg.statuses).map(([s, d]) => '<div>' + chip(s) + ' ' + esc(d) + '</div>').join('') + '</div>';
  }
  function render() {
    const filtersOn = tab === 'next' || tab === 'all' || tab === 'timeline';
    document.getElementById('filters').style.display = filtersOn ? '' : 'none';
    fm.style.display = fw.style.display = tab === 'timeline' ? '' : 'none';
    const view = document.getElementById('view');
    view.innerHTML = tab === 'next' ? renderNext() : tab === 'timeline' ? renderTimeline() : tab === 'all' ? renderAll() : tab === 'leads' ? renderLeads() : renderFind();
    view.querySelectorAll('th[data-k]').forEach((th) => th.addEventListener('click', () => {
      sortDir = sortKeyAll === th.dataset.k ? -sortDir : 1;
      sortKeyAll = th.dataset.k;
      render();
    }));
    view.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => {
      const k = tr.dataset.key;
      if (open.has(k)) open.delete(k); else open.add(k);
      render();
    }));
    view.querySelectorAll('.tl').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const hyp = e.target.closest('.hyp');
      if (hyp) { showHypothesis(hyp.dataset.hyp); return; }
      const k = el.dataset.key;
      if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
      render();
    }));
  }
  function showHypothesis(key) {
    const h = H.find((x) => x.id === key) || H.find((x) => x.title === key);
    if (!h) return;
    selectTab('all');
    q.value = h.id || h.title;
    open.add((h.id || '') + '|' + h.title);
    render();
  }
  function selectTab(t) {
    tab = t;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
  }
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    selectTab(b.dataset.tab);
    render();
  });
  [q, fs, fa, fk, fm, fw].forEach((el) => el.addEventListener('input', render));
  selectTab(tab);
  render();
}

/** The page for a registry, its resolved refs and the journal (a string). */
export function renderPage(registry, resolved = {}, journal = [], builtAt = '') {
  // A `</script>` inside the data would end the tag early.
  const data = JSON.stringify({ registry, resolved, journal, builtAt }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeedJS hypotheses</title>
<style>${STYLE}</style>
</head>
<body>
<header><div class="wrap">
  <h1>WeedJS hypotheses</h1>
  <div class="sub" id="sub"></div>
  <nav id="tabs">
    <button data-tab="timeline">Timeline</button>
    <button data-tab="next">Next up</button>
    <button data-tab="all">All hypotheses</button>
    <button data-tab="leads">Leads</button>
    <button data-tab="find">How this works</button>
  </nav>
  <div class="bar" id="filters">
    <input id="q" type="search" placeholder="Search ids, titles, results, records…">
    <select id="fstatus"><option value="">Any status or verdict</option><option value="@pending">Pending (open, running, blocked)</option><option value="@kept">Kept</option><option value="@notkept">Not kept (dropped, rejected, fail)</option><option value="@neutral">Tie, mixed, screened, passed, answered</option></select>
    <select id="farea"><option value="">Any worker</option></select>
    <select id="fkind"><option value="">Any kind</option><option value="wasm">WASM / C</option><option value="js">JS</option><option value="gpu">GPU</option><option value="dx">DX</option></select>
    <select id="fmonth"><option value="">Any month</option></select>
    <select id="fshow"><option value="">Records and journal</option><option value="records">Records only</option><option value="journal">Journal only</option></select>
  </div>
</div></header>
<main><div class="wrap" id="view"></div></main>
<script id="data" type="application/json">${data}</script>
<script>(${client.toString()})();</script>
</body>
</html>
`;
}

function main() {
  const registry = loadRegistry();
  const { resolved, errors } = resolveRefs(registry);
  for (const e of errors) console.warn(`ref: ${e}`);
  const journal = fs.existsSync(DEVLOG_PATH) ? parseJournal(fs.readFileSync(DEVLOG_PATH, 'utf8')) : [];
  const now = new Date();
  const builtAt = now.toISOString().slice(0, 10) + ' ' + now.toTimeString().slice(0, 5);
  fs.writeFileSync(PAGE_PATH, renderPage(registry, resolved, journal, builtAt));
  console.log(`wrote ${path.relative(root, PAGE_PATH)} (${registry.hypotheses.length} hypotheses, ${(registry.records || []).length} records, ${journal.length} journal entries; built locally, not committed)`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', PAGE_PATH]]
      : process.platform === 'darwin' ? ['open', [PAGE_PATH]] : ['xdg-open', [PAGE_PATH]];
    execFile(cmd, args);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
