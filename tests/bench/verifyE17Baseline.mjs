// Verify the E-17 baseline copy really is the pre-hypothesis form, so an A/B
// against it measures the hypothesis and not a broken file.
//
// The previous two baseline verifiers in this campaign were written as inline
// `node -e` one-liners, and PowerShell ate the `${...}` inside a template literal,
// producing a baseline containing the literal text `particle:\` and a scene that
// parsed. That is the whole reason this is a script.
//
// Stripping comments first is not optional either: E-17's own comment quotes the
// removed form verbatim, so a raw scan counts the documentation as code. That trap
// bit three separate test files in this campaign before it was written down as a rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = path.join(ROOT, 'tests/results/hyp-baselines/E17.gpuShadowCasters.js');
const SHIP = path.join(ROOT, 'src/render/gpuShadowCasters.js');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const base = fs.readFileSync(BASE, 'utf8');
const ship = fs.readFileSync(SHIP, 'utf8');
const baseCode = strip(base);
const shipCode = strip(ship);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

// --- the baseline must be the OLD code ---------------------------------------
// Scope the scatter-pass slice to buildStampGrid. A whole-file `lastIndexOf` finds a
// LATER loop in stampLightRange, which is why the first run of this check reported
// the shipped tree as "still has Math.floor" - the function was correct and the
// slice was not.
function fnBody(code) {
  const start = code.indexOf('function buildStampGrid(');
  if (start < 0) return '';
  return code.slice(start, code.indexOf('\n}', start));
}
const scatterAt = (code) => {
  const body = fnBody(code);
  return body.slice(body.lastIndexOf('for (let c = 0; c < nSun; c++) {'));
};
const baseScatter = scatterAt(baseCode);
const shipScatter = scatterAt(shipCode);
check('baseline scatter pass recomputes the cell', /Math\.floor/.test(baseScatter));
check('baseline scatter pass does not use a cache', !/cellOf/.test(baseScatter));
check('baseline has no cell-index scratch', !/cellOf/.test(baseCode));
check('baseline declares no _stampCellOf', !/_stampCellOf/.test(baseCode));

// --- the shipped tree must be the NEW code -----------------------------------
check('ship scatter pass uses the cache', /cursor\[cellOf\[c\]\]/.test(shipScatter));
check('ship scatter pass has no Math.floor', !/Math\.floor/.test(shipScatter));
check('ship scatter pass no longer reads sun', !/sun\[b\]/.test(shipScatter));
check('ship count pass records the cell', /cellOf\[c\] = cell;/.test(shipCode));
check('ship declares _stampCellOf', /let _stampCellOf = null;/.test(shipCode));
// And the count pass still does the work the cache depends on.
check('ship count pass still derives the cell', /Math\.floor\(\(sun\[b\] - minX\)/.test(fnBody(shipCode)));

const fnStart = (code) => code.indexOf('function buildStampGrid(');
const outsideBase = baseCode.slice(0, fnStart(baseCode));
const outsideShip = shipCode.slice(0, fnStart(shipCode));

// --- nothing else moved -------------------------------------------------------
// The header is SUPPOSED to differ, by exactly the scratch declaration. So assert
// that: remove the declaration and its comment from the shipped header and the two
// must be identical. Anything else differing would mean the A/B measures more than
// the hypothesis.
const scratchDecl = /let _stampCellOf = null;/;
const shippedHeaderStripped = outsideShip
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(scratchDecl, '')
  .replace(/\n{2,}/g, '\n')
  .trim();
const baseHeaderStripped = outsideBase
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\n{2,}/g, '\n')
  .trim();
check(
  'the header differs ONLY by the scratch declaration',
  shippedHeaderStripped === baseHeaderStripped,
  `baseline has ${baseHeaderStripped.length} chars of header, shipped has ${shippedHeaderStripped.length} after removing the declaration`,
);

// And the function body is shorter by roughly the removed derivation block.
const fn = (s) => {
  const start = s.indexOf('function buildStampGrid(');
  return s.slice(start, s.indexOf('\n}', start)).replace(/\s+/g, ' ').trim();
};
const fnBase = fn(baseCode);
const fnShip = fn(shipCode);
check(
  'the function body is strictly shorter',
  fnShip.length < fnBase.length,
  `${fnBase.length} -> ${fnShip.length} chars`,
);
// One cell derivation is TWO Math.floor calls (col and row), so removing the whole
// scatter-pass derivation removes two of each. An expectation of 1 failed here, and
// the reason is worth stating: the count is per-axis, not per-cell.
const countOf = (s, re) => (s.match(re) || []).length;
check(
  'ship body lost exactly two Math.floor (one cell derivation = col + row)',
  countOf(fnBase, /Math\.floor/g) - countOf(fnShip, /Math\.floor/g) === 2,
  `${countOf(fnBase, /Math\.floor/g)} -> ${countOf(fnShip, /Math\.floor/g)}`,
);
check(
  'ship body lost exactly two STAMP_CELL divisions',
  countOf(fnBase, /\/ STAMP_CELL/g) - countOf(fnShip, /\/ STAMP_CELL/g) === 2,
  `${countOf(fnBase, /\/ STAMP_CELL/g)} -> ${countOf(fnShip, /\/ STAMP_CELL/g)}`,
);
check('ship body kept the bounds pass intact', countOf(fnShip, /Math\.floor/g) >= 2);

check('both files still export stampLightRange', /export function stampLightRange/.test(base) && /export function stampLightRange/.test(ship));
check('both files still define takeClosest', /function takeClosest/.test(base) && /function takeClosest/.test(ship));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed) process.exitCode = 1;