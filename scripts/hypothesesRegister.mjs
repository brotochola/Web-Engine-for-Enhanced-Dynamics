/**
 * The hypotheses register, docs/internal/hypotheses.json: every speed hypothesis WeedJS has tested or
 * plans to test (`hypotheses`), and every record of the work on them (`records`): one sitting, kernel
 * run, gate or decision each, with its date, its time when known, its verdict and its numbers.
 *
 * A hypothesis lists its records by id (`records: ["R-0412"]`) and its other evidence by doc ref
 * (`refs`). A ref names a row, never a line: `EXECUTION_PLAN.md#E-82b` is the one row of that doc whose
 * title is `E-82b` or holds it as a whole token (a row's title is a table row's first cell, a bold lead
 * before `:**`, a heading, or a review item's bold id), so new rows above it do not move it.
 *
 * Used by scripts/hypotheses.mjs (the command line), scripts/buildHypothesesPage.mjs (the page) and
 * tests/node/hypothesesRegistry.test.js. HYPOTHESES_REGISTRY, HYPOTHESES_LOG and HYPOTHESES_DEVLOG
 * point it at other files (the tests use copies).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = process.env.HYPOTHESES_REGISTRY || path.join(root, 'docs/internal/hypotheses.json');
export const DOCS_DIR = path.join(root, 'docs/internal');
export const LOG_PATH = process.env.HYPOTHESES_LOG || path.join(DOCS_DIR, 'HYPOTHESIS_LOG.md');
export const DEVLOG_PATH = process.env.HYPOTHESES_DEVLOG || path.join(DOCS_DIR, 'DEVLOG.md');
const EXCERPT_CHARS = 480;

export function loadRegistry(file = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveRegistry(registry, file = REGISTRY_PATH) {
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n');
}

// ---------------------------------------------------------------------------------------------------
// Rows of the docs, and refs to them.

/** A row title or a key without its markdown: no `*`, backticks or backslashes, single spaces. */
export const normalizeTitle = (s) => s.replace(/[*`\\]/g, '').replace(/\s+/g, ' ').trim();

/** The title of a row line (a table row's first cell, a bold lead, a heading, a review item), or ''. */
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
/** Does a title hold the key as a whole token (`W9` is not in `W9d`, `E-82` is not in `E-82b`)? */
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

// ---------------------------------------------------------------------------------------------------
// Records.

export const RECORD_ID = /^R-\d{4,}$/;
export const RECORD_DATE = /^\d{4}-\d{2}(-\d{2})?$/;
export const RECORD_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The next free record id. */
export function nextRecordId(registry) {
  let max = 0;
  for (const r of registry.records || []) max = Math.max(max, Number(r.id.slice(2)));
  return 'R-' + String(max + 1).padStart(4, '0');
}

/** A hypothesis by id, then by a unique alias, then by its exact title; null when none or several. */
export function findHypothesis(registry, key) {
  const H = registry.hypotheses;
  const byId = H.filter((h) => h.id === key);
  if (byId.length === 1) return byId[0];
  const byAlias = H.filter((h) => (h.aliases || []).includes(key));
  if (byAlias.length === 1) return byAlias[0];
  const byTitle = H.filter((h) => h.title === key);
  return byTitle.length === 1 ? byTitle[0] : null;
}

/** Local date and time (YYYY-MM-DD, HH:MM) of a Date. */
export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/**
 * Add a record and link it to its hypotheses. Throws on an unknown hypothesis or a bad field.
 * @returns {object} the record
 */
export function addRecord(registry, { hypotheses = [], title, date, time, verdict, text, commits, timeFrom } = {}) {
  if (!title) throw new Error('a record needs a title');
  if (!text) throw new Error('a record needs its text');
  if (!date || !RECORD_DATE.test(date)) throw new Error(`bad date ${date}`);
  if (time != null && !RECORD_TIME.test(time)) throw new Error(`bad time ${time}`);
  if (verdict != null && !registry.statuses[verdict]) throw new Error(`unknown verdict ${verdict}`);
  const targets = hypotheses.map((k) => {
    const h = findHypothesis(registry, k);
    if (!h) throw new Error(`no hypothesis is ${k} (an id, a unique alias or an exact title)`);
    return h;
  });
  registry.records = registry.records || [];
  const record = { id: nextRecordId(registry), date, ...(time ? { time } : {}), ...(time && timeFrom ? { timeFrom } : {}), title };
  if (verdict) record.verdict = verdict;
  record.text = text;
  if (commits && commits.length) record.commits = commits;
  registry.records.push(record);
  for (const h of targets) h.records = [...(h.records || []), record.id];
  return record;
}

const VERDICTS = [
  [/\bkept\b[^.;]{0,24}\bhygiene\b|\bhygiene keep\b/, 'kept-hygiene'],
  [/\bkept\b[^.;]{0,24}\bkernel\b|\bkernel[, ]+product[- ]neutral\b/, 'kept-kernel'],
  [/\bkept\b|\bkeep\b|\bconfirmed\b/, 'kept'],
  [/\brejected\b/, 'rejected'],
  [/\bdropped\b|\breverted\b/, 'dropped'],
  [/\bsuperseded\b/, 'superseded'],
  [/\bscreened\b|\bparked\b/, 'screened'],
  [/\bmixed\b/, 'mixed'],
  [/\btie\b/, 'tie'],
  [/\bvoid\b|\bfail(ed)?\b/, 'fail'],
  [/\bpassed\b|\bneutral\b/, 'passed'],
  [/\banswered\b|\bmeasured\b|\bclosed\b/, 'answered'],
];

/**
 * The verdict a record's text states: the first verdict word of its lead (`**rejected …; code kept
 * outside**` is rejected), else the last bold verdict in the text; null if none.
 */
export function verdictOf(text) {
  const plain = (s) => s.replace(/`[^`]*`/g, ' ').toLowerCase();
  const pick = (s) => {
    let best = null;
    let at = Infinity;
    for (const [re, v] of VERDICTS) {
      const m = re.exec(s);
      if (m && m.index < at) { at = m.index; best = v; }
    }
    return best;
  };
  const lead = /^\s*\*\*([^*]+)\*\*/.exec(text);
  const head = plain(lead ? lead[1] : text.slice(0, 90));
  const first = pick(head);
  if (first) return first;
  const bold = [...text.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) => pick(plain(m[1]))).filter(Boolean);
  return bold.length ? bold[bold.length - 1] : null;
}

const TABLE_STATUS = {
  kept: 'kept', 'kept-kernel': 'kept-kernel', 'kept-hygiene': 'kept-hygiene', dropped: 'dropped', worse: 'dropped',
  mixed: 'mixed', tie: 'tie', screened: 'screened', 'rejected-in-kernel': 'rejected', rejected: 'rejected',
  superseded: 'superseded', 'not-measured': 'note', fail: 'fail', FAIL: 'fail',
};
const DATE_IN = /\b(\d{4}-\d{2}(?:-\d{2})?)\b/;

/** A bold lead's title and date: `Pixi's pack, W9d (2026-10-23)` → title `Pixi's pack, W9d`, date `2026-10-23`. */
function splitLead(lead) {
  const m = /\s*\(([^()]*)\)\s*$/.exec(lead);
  if (m) {
    const inner = m[1];
    const d = DATE_IN.exec(inner);
    if (d) {
      const rest = inner.replace(d[1], '').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s*,\s*,/g, ',');
      return { title: lead.slice(0, m.index).trim() + (rest ? ` (${rest})` : ''), date: d[1] };
    }
  }
  const d = DATE_IN.exec(lead);
  return { title: lead.trim(), date: d ? d[1] : null };
}

/**
 * The records written as rows of a hypothesis-log markdown file: bold-lead paragraphs
 * (`**Title (2026-10-23):** text`, with the lines and paragraphs that follow until the next row) and
 * table rows (`| Name | Claim | Status | When | How | ... |`, read by the table's header). Lines before
 * the first row are the file's preamble and are not records. A row without a date takes the date of the
 * row before it (the log runs newest first).
 * @returns {{ title: string, date: string|null, verdict: string|null, text: string, line: number }[]}
 */
export function parseLogRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let header = null;
  let current = null;
  let pendingBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6} /.test(l)) { current = null; header = null; continue; }
    if (l.startsWith('|')) {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      if (/^\|[\s:|-]*$/.test(l)) continue;
      if (!header || /^(Name|Hypothesis)$/i.test(cells[0])) { header = cells; current = null; continue; }
      out.push(tableRecord(header, cells, l, i + 1));
      current = null;
      continue;
    }
    const lead = l.startsWith('**') ? l.indexOf(':**') : -1;
    if (lead > 0 && !l.slice(2, lead).includes('**')) {
      const { title, date } = splitLead(normalizeLeadText(l.slice(2, lead)));
      const text = l.slice(lead + 3).trim();
      current = { title, date, verdict: verdictOf(text), text, line: i + 1 };
      out.push(current);
      pendingBlank = false;
      continue;
    }
    if (!l.trim()) { pendingBlank = true; continue; }
    if (current) {
      current.text += (pendingBlank ? '\n\n' : '\n') + l;
      pendingBlank = false;
    }
  }
  let last = null;
  for (const r of out) {
    if (r.date) last = r.date;
    else r.date = last;
  }
  return out;
}

/** Keep a lead's markdown but drop its bold markers. */
const normalizeLeadText = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

function tableRecord(header, cells, raw, line) {
  const col = (name) => {
    const k = header.findIndex((h) => h.toLowerCase().startsWith(name));
    return k >= 0 ? cells[k] || '' : '';
  };
  const title = normalizeLeadText(cells[0] || '');
  // A cell with a `|` inside it splits the row: then the header's columns no longer line up.
  if (cells.length !== header.length) {
    const status = cells.find((c) => TABLE_STATUS[c]);
    const d = cells.map((c) => DATE_IN.exec(c)).find(Boolean);
    return { title, date: d ? d[1] : null, verdict: status ? TABLE_STATUS[status] : null, text: cells.slice(1).filter(Boolean).join(' · '), line };
  }
  const when = col('when');
  const d = DATE_IN.exec(when);
  const parts = [];
  const add = (label, value) => { if (value) parts.push(`**${label}:** ${value}`); };
  add('Claim', col('claim'));
  if (when && d && when.replace(d[1], '').trim()) add('When', when);
  add('How', col('how'));
  add('Numbers', col('numbers'));
  add('Why', col('why'));
  add('Evidence', col('link'));
  return { title, date: d ? d[1] : null, verdict: TABLE_STATUS[col('status')] || null, text: parts.join('\n\n'), line };
}

// ---------------------------------------------------------------------------------------------------
// The journal (DEVLOG.md), for the page's timeline.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** `Saturday 24 October 2026` (or `24`, or `24 October`, filled from the end of a range) → its parts. */
function journalDay(s, fill = {}) {
  const m = /^(?:\w+day,? )?(\d{1,2})(?: (\w+))?(?: (\d{4}))?$/.exec(s.trim());
  if (!m) return null;
  const month = m[2] ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : fill.month;
  const year = m[3] ? Number(m[3]) : fill.year;
  if (!month || !year) return null;
  return { day: Number(m[1]), month, year };
}
const isoDay = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/**
 * DEVLOG.md's entries and the text under each. Headings are `## Saturday 24 October 2026 (morning) —
 * Title`, `## Sunday 23 – Monday 24 August 2026 — Title` (a span of days), or `## Tuesday 28 July 2026,
 * 2:32 AM — Title` (a time).
 * @returns {{ date: string, until?: string, part: string, time?: string, title: string, text: string }[]}
 */
export function parseJournal(markdown) {
  const out = [];
  let cur = null;
  for (const l of markdown.split(/\r?\n/)) {
    if (l.startsWith('## ')) {
      cur = null;
      const dash = l.indexOf(' — ');
      if (dash > 0) {
        let when = l.slice(3, dash).trim();
        const title = l.slice(dash + 3).trim();
        let part = '';
        let time;
        const p = /\s*\(([^)]+)\)$/.exec(when);
        if (p) { part = p[1]; when = when.slice(0, p.index); }
        const t = /,\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(when);
        if (t) {
          const h = (Number(t[1]) % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
          time = `${String(h).padStart(2, '0')}:${t[2]}`;
          when = when.slice(0, t.index);
        }
        const [a, b] = when.split(/\s+–\s+/);
        const end = journalDay(b || a);
        const start = b ? journalDay(a, end || {}) : end;
        if (start) {
          cur = { date: isoDay(start), ...(b && end ? { until: isoDay(end) } : {}), part, ...(time ? { time } : {}), title, text: '' };
          out.push(cur);
        }
      }
      continue;
    }
    if (/^# /.test(l)) { cur = null; continue; }
    if (cur) cur.text += (cur.text ? '\n' : '') + l;
  }
  for (const e of out) e.text = e.text.trim();
  return out;
}
