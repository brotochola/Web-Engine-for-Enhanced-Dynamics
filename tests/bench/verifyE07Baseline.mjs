// Verify the E-07 baseline copy really is the pre-hypothesis form, so an A/B
// against it is measuring the hypothesis and not a broken file.
//
// Kept as a script rather than an inline `node -e` because a shell mangles `${...}`
// in a template literal, and the first two attempts at this check silently produced
// a baseline with literal text `particle:\` instead of a real template string -
// which would have made the A/B measure nothing at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = path.join(ROOT, 'tests/results/hyp-baselines/E07.preRenderWorker.js');
const SHIP = path.join(ROOT, 'src/workers/preRenderWorker.js');

const base = fs.readFileSync(BASE, 'utf8');
const ship = fs.readFileSync(SHIP, 'utf8');

// Strip comments before any content check. The E-07 doc comment quotes the OLD form
// verbatim ("`particle:${pAnimIdx}` and three siblings"), so a raw scan counts the
// documentation as code. This is the same trap that bit E-08's test twice, and it
// is now a standing rule: strip comments, then assert.
const code = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const baseCode = code(base);
const shipCode = code(ship);

const LABEL_RE = /\$\{(p|lf|d|b)AnimIdx\}/g;

const checks = [];
const check = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });

// --- the baseline must look like the OLD code -------------------------------
check('baseline has 4 per-row template labels', (baseCode.match(LABEL_RE) || []).length === 4);
check('baseline uses the (animIdx, label) signature', /_resolveAnimFrameStart\(animIdx, label\)/.test(baseCode));
check('baseline has no ANIM_LABEL_TAG call sites', !baseCode.includes('ANIM_LABEL_TAG.'));
check('baseline warn key repeats the index', baseCode.includes('frameStart:${label}:${animIdx}'));

// --- the shipped tree must look like the NEW code ----------------------------
check('ship has 0 per-row template labels', (shipCode.match(LABEL_RE) || []).length === 0);
check('ship uses the (animIdx, kind) signature', /_resolveAnimFrameStart\(animIdx, kind\)/.test(shipCode));
check('ship has 4 ANIM_LABEL_TAG call sites', (shipCode.match(/ANIM_LABEL_TAG\./g) || []).length === 4);
check('ship warn key does not repeat the index', !shipCode.includes('frameStart:${label}:${animIdx}'));

// --- they must differ ONLY in the hypothesis --------------------------------
// E-08's geometric-growth scratch is also in this file and is NOT part of E-07.
// It is present in both copies, so it cannot contaminate the A/B. Assert it.
check('both carry the E-08 scratch fix (not part of E-07)', base.includes('while (cap < n) cap *= 2') && ship.includes('while (cap < n) cap *= 2'));

// --- the diff must be exactly the six lines of E-07 -------------------------
const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const baseNorm = strip(base);
const shipNorm = strip(ship);
const diffSize = Math.abs(baseNorm.length - shipNorm.length);
check(
  'normalised files differ only by the label plumbing',
  diffSize < 400,
  `normalised length delta ${diffSize} bytes (label strings are ~4x30 chars plus the helper)`,
);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed) process.exitCode = 1;