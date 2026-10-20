import fs from 'node:fs';

/**
 * Baseline for H-02: the pre-fix `gatherInstancedRows` that allocated one
 * subarray view per sprite.
 *
 * Follows the same rules as makeHypBaseline.mjs, and the same two failures:
 * a baseline has to be CHECKED, and content checks are not validity checks.
 */
const SRC = 'src/render/gpuQueueLayout.js';
const OUT = 'tests/results/hyp-baselines/H02.gpuQueueLayout.subarray.js';

// H-02 is closed: E-21 found gatherInstancedRows never ran in a frame, and
// review D5 moved it out of src/ (tests/helpers/gpuQueueReference.mjs). An
// overlay of src/render/gpuQueueLayout.js can no longer swap it, so there is
// nothing to baseline.
if (!fs.readFileSync(SRC, 'utf8').includes('export function gatherInstancedRows(')) {
  console.error('makeH02Baseline: H-02 is closed (E-21, review D5); gatherInstancedRows is not engine code.');
  process.exit(1);
}

const source = fs.readFileSync(SRC, 'utf8');

const FN = 'export function gatherInstancedRows(';
const at = source.indexOf(FN);
if (at < 0) throw new Error('gatherInstancedRows not found');
const open = source.indexOf('{', at);
let depth = 0;
let close = -1;
for (let i = open; i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}') {
    depth--;
    if (depth === 0) {
      close = i;
      break;
    }
  }
}
if (close < 0) throw new Error('could not find the end of gatherInstancedRows');

const PRE_FIX_BODY = `
  const sn = n | 0;
  const sfp = srcFp | 0;
  const dfp = dstFp | 0;
  if (!src || !dst || sn <= 0) return 0;
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * dfp;
    const spriteN = sfp < GPU_SPRITE_FLOATS ? sfp : GPU_SPRITE_FLOATS;
    dst.set(src.subarray(from, from + spriteN), to);`;

const tailStart = source.indexOf('if (shadowQ && dfp >= GPU_CASTER_FLOATS) {', open);
// Keep everything from the shadow block onward, including its closing braces.
// The `if (shadowQ ...)` line is deliberately NOT repeated in the prefix above -
// doing so duplicated it and left the braces unbalanced, which the checks below
// caught. That check is the only reason this file is trustworthy.
let baseline = source.slice(0, open + 1) + PRE_FIX_BODY + source.slice(tailStart);

// Strip the H-02 comment block, which now describes code that is not here.
baseline = baseline.replace(/\n\s*\/\/ H-02\.[\s\S]*?reads out of bounds\.\n/, '\n');

fs.mkdirSync('tests/results/hyp-baselines', { recursive: true });
fs.writeFileSync(OUT, baseline, 'utf8');

const w = fs.readFileSync(OUT, 'utf8');
const checks = [
  ['contains the subarray copy', w.includes('dst.set(src.subarray(from, from + spriteN), to);')],
  ['declares spriteN inside the loop', w.includes('const spriteN = sfp < GPU_SPRITE_FLOATS')],
  ['contains no unroll', !w.includes('f += 4')],
  ['no dangling H-02 comment', !w.includes('H-02.')],
  ['keeps the shadow block', w.includes('dst[to + shAt]')],
  ['declares sn/sfp/dfp', /const sn = n \| 0;/.test(w) && /const sfp = srcFp \| 0;/.test(w)],
  ['braces balanced', (() => { let d = 0; for (const c of w) { if (c === '{') d++; else if (c === '}') d--; } return d === 0; })()],
  ['differs from shipped', w.length !== source.length],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\n${OUT}  (${w.length} bytes; shipped ${source.length})`);
if (!ok) {
  console.error('\nBASELINE CHECK FAILED - do not sit against this file.');
  process.exit(1);
}
console.log('\nverified. run:');
console.log(
  '  node tests/bench/runPredatorAbab.mjs --name H02 --pairs 8 --owner pixi ' +
    '--scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene ' +
    '--override src/render/gpuQueueLayout.js=tests/results/hyp-baselines/H02.gpuQueueLayout.subarray.js',
);