#!/usr/bin/env node
/**
 * Raw results under tests/results are not kept (HOW_WE_MEASURE: a sitting's numbers go into its record the same day;
 * never link them), but nothing removed them: CPU traces and screenshots piled up into a folder `du` could not size in
 * two minutes (2026-11-12). This removes the entries not touched for `days` (7 by default), looking two levels down
 * only, so it stays quick: a folder whose children are all folders (predator-abab, kernels…) is pruned child by child,
 * by each child's own modification time; any other entry as a whole. A link is unlinked, never followed.
 * runPredatorAbab calls it before a sitting.
 *
 *   node tests/bench/pruneTestResults.mjs [--days 7] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const resultsDir = path.join(repoRoot, 'tests', 'results');

function remove(p, dryRun) {
  if (dryRun) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

function isContainer(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return ents.length > 0 && ents.every((e) => e.isDirectory() && !e.isSymbolicLink());
}

/**
 * Remove the entries of `dir` (tests/results by default) not modified for `days`.
 * @returns {string[]} the paths removed (or that would be, with dryRun)
 */
export function pruneTestResults({ days = 7, dryRun = false, dir = resultsDir, now = Date.now() } = {}) {
  const cutoff = now - days * 86400000;
  const removed = [];
  let top;
  try {
    top = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const consider = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.mtimeMs < cutoff) {
      try {
        remove(p, dryRun);
        removed.push(p);
      } catch (e) {
        console.warn(`[pruneTestResults] ${p} was left: ${String(e?.message || e).split('\n')[0]}`);
      }
    }
  };
  for (const ent of top) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink() && isContainer(p)) {
      for (const child of fs.readdirSync(p)) consider(path.join(p, child));
    } else {
      consider(p);
    }
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--days');
  const days = at >= 0 ? Number(argv[at + 1]) : 7;
  const dryRun = argv.includes('--dry-run');
  if (!(days >= 0)) throw new Error('--days takes a number of days');
  const removed = pruneTestResults({ days, dryRun });
  for (const p of removed) console.log(`${dryRun ? 'would remove' : 'removed'} ${path.relative(repoRoot, p)}`);
  console.log(`${removed.length} entr${removed.length === 1 ? 'y' : 'ies'} ${dryRun ? 'older than' : 'removed, older than'} ${days} days`);
}
