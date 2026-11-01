#!/usr/bin/env node
// mergeRegister.mjs — a git merge driver for docs/internal/hypotheses.json: the two sides' hypotheses and records are
// merged by key (a hypothesis by its id, or its title when it has none; a record by its id), not as lines of text.
// Two branches that both add entries at the end of the arrays (main and visual_editor) conflict as text every time;
// by key they merge, and only a real clash stops the merge:
//   - an entry both sides changed in the same field, differently (lists of ids, refs and aliases are united);
//   - an entry one side removed and the other changed;
//   - a record id both sides added with different content (renumber one side's records first).
// .gitattributes names the driver; each clone defines it once:
//   git config merge.hypotheses.name "the register, merged by key"
//   git config merge.hypotheses.driver "node scripts/mergeRegister.mjs %O %A %B"
// Usage: node scripts/mergeRegister.mjs <base> <ours> <theirs>. Writes the merge into <ours>; exit 1 on a clash, with
// each clash on stderr and ours kept for every clashing field.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** List fields whose values are united rather than clashed. */
const UNITED = new Set(['records', 'refs', 'aliases', 'commits']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hypothesisKey = (h) => h.id ?? `title:${h.title}`;
const recordKey = (r) => r.id;

function unite(a = [], b = []) {
  const out = [...a];
  for (const x of b) if (!out.some((y) => same(x, y))) out.push(x);
  return out;
}

/** One entry both sides have: field by field against the base. */
function mergeEntry(o, a, b, where, clashes) {
  const out = {};
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[f];
    const bv = b[f];
    const ov = o?.[f];
    if (same(av, bv) || same(bv, ov)) {
      if (av !== undefined) out[f] = av;
    } else if (same(av, ov)) {
      if (bv !== undefined) out[f] = bv;
    } else if (UNITED.has(f) && (av === undefined || Array.isArray(av)) && (bv === undefined || Array.isArray(bv))) {
      out[f] = unite(av, bv);
    } else {
      clashes.push(`${where}: both sides changed ${f}`);
      if (av !== undefined) out[f] = av;
    }
  }
  return out;
}

/** Two lists of entries by key: ours in its order, then what only theirs added, in theirs's order. */
function mergeList(base = [], ours = [], theirs = [], key, kind, clashes) {
  const O = new Map(base.map((x) => [key(x), x]));
  const B = new Map(theirs.map((x) => [key(x), x]));
  const A = new Map(ours.map((x) => [key(x), x]));
  const out = [];
  for (const [k, a] of A) {
    const b = B.get(k);
    const o = O.get(k);
    if (b === undefined) {
      if (o === undefined || !same(a, o)) {
        if (o !== undefined) clashes.push(`${kind} ${k}: theirs removed it, ours changed it`);
        out.push(a);
      }
      // else theirs removed it, ours left it as it was: removed
    } else if (same(a, b)) out.push(a);
    else if (kind === 'record' && o === undefined) {
      clashes.push(`record ${k}: both sides added a record with this id (renumber one side's first)`);
      out.push(a);
    } else out.push(mergeEntry(o, a, b, `${kind} ${k}`, clashes));
  }
  for (const [k, b] of B) {
    if (A.has(k)) continue;
    const o = O.get(k);
    if (o === undefined) out.push(b);
    else if (!same(b, o)) {
      clashes.push(`${kind} ${k}: ours removed it, theirs changed it`);
      out.push(b);
    }
    // else ours removed it, theirs left it as it was: removed
  }
  return out;
}

/**
 * Merge three registers.
 * @returns {{ merged: object, clashes: string[] }}
 */
export function mergeRegisters(base, ours, theirs) {
  const clashes = [];
  const merged = {};
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (k === 'hypotheses') merged[k] = mergeList(base[k], ours[k], theirs[k], hypothesisKey, 'hypothesis', clashes);
    else if (k === 'records') merged[k] = mergeList(base[k], ours[k], theirs[k], recordKey, 'record', clashes);
    else if (k === 'updated') merged[k] = [ours[k], theirs[k]].filter(Boolean).sort().pop();
    else if (same(ours[k], theirs[k]) || same(theirs[k], base[k])) {
      if (ours[k] !== undefined) merged[k] = ours[k];
    } else if (same(ours[k], base[k])) {
      if (theirs[k] !== undefined) merged[k] = theirs[k];
    } else {
      clashes.push(`${k}: both sides changed it`);
      merged[k] = ours[k];
    }
  }
  return { merged, clashes };
}

function readRegister(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return text.trim() ? JSON.parse(text) : {};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!oursPath || !theirsPath) {
    console.error('usage: node scripts/mergeRegister.mjs <base> <ours> <theirs>');
    process.exit(2);
  }
  let base, ours, theirs;
  try {
    [base, ours, theirs] = [readRegister(basePath), readRegister(oursPath), readRegister(theirsPath)];
  } catch (e) {
    console.error(`mergeRegister: a side is not JSON (${e.message}); merge the register by hand`);
    process.exit(1);
  }
  const { merged, clashes } = mergeRegisters(base, ours, theirs);
  fs.writeFileSync(oursPath, JSON.stringify(merged, null, 2) + '\n');
  if (clashes.length) {
    console.error(`mergeRegister: ${clashes.length} clash(es) in the register, ours kept for each:\n  ${clashes.join('\n  ')}`);
    process.exit(1);
  }
}
