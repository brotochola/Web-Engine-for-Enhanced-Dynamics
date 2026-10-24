#!/usr/bin/env node
/**
 * The hypotheses register from the command line (docs/internal/hypotheses.json; format in
 * scripts/hypothesesRegister.mjs).
 *
 *   node scripts/hypotheses.mjs find <text>             hypotheses and records whose text holds it
 *   node scripts/hypotheses.mjs show <id>               a hypothesis with its records, or one record (R-0412)
 *   node scripts/hypotheses.mjs log [--since 2026-10-20] [--until 2026-10-24] [--limit 40]
 *                                                       records by date and time, newest first
 *   node scripts/hypotheses.mjs record --hyp E-123[,W9d] --title "…" [--verdict kept]
 *       [--date 2026-10-24 [--time 14:05]] [--commits 3e2dc99c,…] [--status kept] [--result "…"]
 *       (--text "…" | --text-file note.md)
 *                                                       add a record (date and time default to now) and
 *                                                       link it; --status and --result also update the
 *                                                       hypotheses it names
 *   node scripts/hypotheses.mjs import-log              rows written into HYPOTHESIS_LOG.md become records
 *
 * The register is one file that every session edits: write it through this tool, and commit it with
 * nothing else in the same commit.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  LOG_PATH, addRecord, findHypothesis, keyMatches, loadRegistry, localStamp, normalizeTitle,
  parseLogRows, saveRegistry,
} from './hypothesesRegister.mjs';

const PENDING = new Set(['open', 'running', 'blocked']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

const one = (s, n = 110) => {
  const t = String(s || '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const when = (r) => r.date + (r.time ? ' ' + r.time : '');
const sortKey = (r) => (r.date.length === 7 ? r.date + '-00' : r.date) + 'T' + (r.time || '00:00');
const hypName = (h) => h.id || `"${one(h.title, 50)}"`;

function linksOf(reg) {
  const m = new Map();
  for (const h of reg.hypotheses) for (const id of h.records || []) {
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(h);
  }
  return m;
}

function find(reg, text) {
  const t = text.toLowerCase();
  const hs = reg.hypotheses.filter((h) => [h.id, (h.aliases || []).join(' '), h.title, h.result, h.next, h.statusText].join(' ').toLowerCase().includes(t));
  const rs = (reg.records || []).filter((r) => [r.id, r.title, r.text].join(' ').toLowerCase().includes(t)).sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
  console.log(`${hs.length} hypotheses`);
  for (const h of hs.slice(0, 40)) console.log(`  ${(h.id || '—').padEnd(8)} ${h.status.padEnd(13)} ${one(h.title, 90)}`);
  if (hs.length > 40) console.log(`  … and ${hs.length - 40} more`);
  console.log(`${rs.length} records`);
  const links = linksOf(reg);
  for (const r of rs.slice(0, 40)) console.log(`  ${r.id} ${when(r).padEnd(16)} ${(r.verdict || '').padEnd(12)} ${one(r.title, 70)}  [${(links.get(r.id) || []).map(hypName).join(', ')}]`);
  if (rs.length > 40) console.log(`  … and ${rs.length - 40} more`);
}

function show(reg, key) {
  const rec = (reg.records || []).find((r) => r.id === key);
  const links = linksOf(reg);
  if (rec) {
    console.log(`${rec.id}  ${when(rec)}${rec.timeFrom ? ` (${rec.timeFrom})` : ''}  ${rec.verdict || ''}`);
    console.log(rec.title);
    console.log(`hypotheses: ${(links.get(rec.id) || []).map(hypName).join(', ') || 'none'}`);
    if (rec.commits) console.log(`commits: ${rec.commits.join(' ')}`);
    console.log('');
    console.log(rec.text);
    return;
  }
  const h = findHypothesis(reg, key);
  if (!h) { console.error(`no hypothesis or record is ${key}`); process.exitCode = 1; return; }
  console.log(`${h.id || '—'}  ${h.status}${h.rank ? `  rank ${h.rank}` : ''}  ${h.area || ''} ${h.kind || ''}  ${h.date || ''}`);
  console.log(h.title);
  if (h.aliases && h.aliases.length) console.log(`also: ${h.aliases.join(', ')}`);
  if (h.statusText) console.log(`status: ${h.statusText}`);
  if (h.result) console.log(`result: ${h.result}`);
  if (h.next) console.log(`next: ${h.next}`);
  if (h.refs) console.log(`docs: ${h.refs.join('  ')}`);
  const recs = (h.records || []).map((id) => reg.records.find((r) => r.id === id)).filter(Boolean).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  for (const r of recs) {
    console.log('');
    console.log(`--- ${r.id}  ${when(r)}  ${r.verdict || ''}  ${r.title}`);
    console.log(r.text);
  }
}

function log(reg, args) {
  const limit = Number(args.limit || 40);
  const rs = (reg.records || [])
    .filter((r) => (!args.since || r.date >= args.since) && (!args.until || r.date <= args.until))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1));
  const links = linksOf(reg);
  for (const r of rs.slice(0, limit)) console.log(`${r.id} ${when(r).padEnd(16)} ${(r.verdict || '').padEnd(12)} ${one(r.title, 70)}  [${(links.get(r.id) || []).map(hypName).join(', ')}]`);
  if (rs.length > limit) console.log(`… ${rs.length - limit} more (--limit)`);
}

function record(reg, args) {
  const text = args['text-file'] ? fs.readFileSync(String(args['text-file']), 'utf8').trim() : args.text;
  if (typeof text !== 'string' || !text) throw new Error('give the record text with --text or --text-file');
  const now = localStamp();
  const date = args.date ? String(args.date) : now.date;
  const time = args.time ? String(args.time) : args.date ? undefined : now.time;
  const hyps = args.hyp ? String(args.hyp).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (args.status && !reg.statuses[args.status]) throw new Error(`unknown status ${args.status}`);
  const r = addRecord(reg, {
    hypotheses: hyps,
    title: String(args.title || ''),
    date,
    time,
    timeFrom: time ? 'recorded' : undefined,
    verdict: args.verdict ? String(args.verdict) : undefined,
    text,
    commits: args.commits ? String(args.commits).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  });
  for (const k of hyps) {
    const h = findHypothesis(reg, k);
    if (args.status) {
      h.status = String(args.status);
      if (!PENDING.has(h.status)) delete h.rank;
    }
    if (args.result) h.result = String(args.result);
  }
  reg.updated = date;
  saveRegistry(reg);
  console.log(`${r.id} added (${when(r)}), linked to ${hyps.join(', ') || 'no hypothesis'}`);
}

function importLog(reg) {
  if (!fs.existsSync(LOG_PATH)) { console.log('no HYPOTHESIS_LOG.md'); return; }
  const text = fs.readFileSync(LOG_PATH, 'utf8');
  const rows = parseLogRows(text);
  if (!rows.length) { console.log('HYPOTHESIS_LOG.md holds no rows'); return; }
  for (const row of rows) {
    const named = reg.hypotheses.filter((h) => h.id && h.id.length >= 3 && keyMatches(normalizeTitle(row.title), h.id)).map((h) => h.id);
    const r = addRecord(reg, { hypotheses: named, title: row.title, date: row.date || localStamp().date, verdict: row.verdict || undefined, text: row.text || row.title });
    console.log(`${r.id} ${r.date} ${one(r.title, 70)}  [${named.join(', ')}]`);
  }
  // Keep the file's preamble (everything before the first row), drop the rows.
  const lines = text.split(/\r?\n/);
  fs.writeFileSync(LOG_PATH, lines.slice(0, rows[0].line - 1).join('\n').trimEnd() + '\n');
  saveRegistry(reg);
  console.log(`${rows.length} rows moved into the register`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const reg = loadRegistry();
  if (cmd === 'find' && rest.length) find(reg, rest.join(' '));
  else if (cmd === 'show' && rest.length) show(reg, rest.join(' '));
  else if (cmd === 'log') log(reg, args);
  else if (cmd === 'record') record(reg, args);
  else if (cmd === 'import-log') importLog(reg);
  else {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
    if (cmd) process.exitCode = 1;
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
