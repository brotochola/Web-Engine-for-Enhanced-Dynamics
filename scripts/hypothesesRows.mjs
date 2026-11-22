/**
 * The register's pure parts, with no Node import, so the page (docs/internal/hypotheses.html) runs the same
 * code as the command line: the rows of a doc and the refs that name them, and the journal's entries.
 *
 * A ref names a row, never a line: `EXECUTION_PLAN.md#E-82b` is the one row of that doc whose title is
 * `E-82b` or holds it as a whole token (a row's title is a table row's first cell, a bold lead before
 * `:**`, a heading, or a review item's bold id), so new rows above it do not move it.
 *
 * scripts/hypothesesRegister.mjs re-exports all of it and adds the file system.
 */

const EXCERPT_CHARS = 480;

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
 * One ref against the rows of its doc (`rows` null when the doc does not exist).
 * @returns {{ at?: { file: string, line: number, title: string, excerpt: string }, error?: string }}
 */
export function resolveRef(ref, rows) {
  const hash = ref.indexOf('#');
  const file = hash < 0 ? ref : ref.slice(0, hash);
  if (!rows) return { error: `${file} does not exist` };
  if (hash < 0) return { at: { file, line: 0, title: '', excerpt: '' } };
  const key = normalizeTitle(ref.slice(hash + 1));
  if (/^L\d+$/.test(key)) return { error: `${ref} is a line number; name the row by a key in its title (${file}#W9d)` };
  const hits = findRows(rows, key);
  if (hits.length !== 1) {
    const some = hits.slice(0, 3).map((r) => `line ${r.line} "${r.title.slice(0, 60)}"`).join('; ');
    return { error: `${ref} finds ${hits.length ? hits.length + ' rows (' + some + '): use more of the title' : 'no row'}` };
  }
  return { at: { file, line: hits[0].line, title: hits[0].title, excerpt: hits[0].excerpt } };
}

/**
 * Resolve every ref of a registry; `rowsOf(file)` gives a doc's rows (docRows), or null when it does not exist.
 * @returns {{ resolved: Record<string, { file: string, line: number, title: string, excerpt: string }>, errors: string[] }}
 */
export function resolveRefsWith(registry, rowsOf) {
  const resolved = {};
  const errors = [];
  for (const h of registry.hypotheses) {
    for (const ref of h.refs || []) {
      if (resolved[ref]) continue;
      const hash = ref.indexOf('#');
      const { at, error } = resolveRef(ref, rowsOf(hash < 0 ? ref : ref.slice(0, hash)));
      if (at) resolved[ref] = at;
      else errors.push(`${h.id || h.title}: ${error}`);
    }
  }
  return { resolved, errors };
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
