// E-17 was measured and reverted. This checks that the shipped buildStampGrid
// is the recompute form again, the same form as the baseline copy.
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

// --- the shipped tree is the recompute form again ----------------------------
check('ship scatter pass recomputes the cell', /Math\.floor/.test(shipScatter));
check('ship scatter pass does not use a cache', !/cellOf/.test(shipScatter));
check('ship has no cell-index scratch', !/cellOf/.test(shipCode));
check('ship declares no _stampCellOf', !/_stampCellOf/.test(shipCode));
check('ship count pass still derives the cell', /Math\.floor\(\(sun\[b\] - minX\)/.test(fnBody(shipCode)));

const fn = (s) => {
  const start = s.indexOf('function buildStampGrid(');
  return s.slice(start, s.indexOf('\n}', start)).replace(/\s+/g, ' ').trim();
};
const fnBase = fn(baseCode);
const fnShip = fn(shipCode);
check(
  'ship buildStampGrid matches the baseline recompute',
  fnShip === fnBase,
  `${fnBase.length} baseline chars, ${fnShip.length} shipped`,
);

check('both files still export stampLightRange', /export function stampLightRange/.test(base) && /export function stampLightRange/.test(ship));
check('both files still define takeClosest', /function takeClosest/.test(base) && /function takeClosest/.test(ship));

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed) process.exitCode = 1;