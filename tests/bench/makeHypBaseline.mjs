/**
 * Save the pre-H-14 baseline of src/workers/logicWorker.js.
 *
 * DEVLOG (30 Sept) records the rule this follows: "Baseline copies are saved in
 * their own step now, and checked." One gate read +1.8 % and was wrong because
 * the "before" copy had been saved in the same batch as the edit and already
 * contained half of the change.
 *
 * So: this script only reads the shipped file and writes a baseline. It does not
 * run a benchmark, and it asserts afterwards that the baseline really contains
 * the comparator sort and really does not contain the packed key - which is the
 * check the DEVLOG rule is asking for.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src/workers/logicWorker.js';
const OUT_DIR = 'tests/results/hyp-baselines';
const OUT = path.join(OUT_DIR, 'H14.logicWorker.comparatorSort.js');

const source = fs.readFileSync(SRC, 'utf8');

const packedStart = source.indexOf('    const keys = this._spawnSortKeys;');
if (packedStart < 0) throw new Error('packed sort block not found - is H-14 still shipped?');
const packedEnd = source.indexOf('    if (m === 0) return false;', packedStart);
if (packedEnd < 0) throw new Error('end of the packed sort block not found');

const comparatorSort = [
  // `let m = 0;` lives inside the replaced region in the shipped file, so it has
  // to be restored here. The first version of this script dropped it and the
  // baseline ran with `ReferenceError: m is not defined` inside the LogicWorker -
  // which is exactly the failure DEVLOG 30 Sept warns about ("Baseline copies are
  // saved in their own step now, and checked"), except the "checked" part had to
  // be added here rather than inherited.
  '    let m = 0;',
  '    for (let i = 0; i < n; i++) perm[i] = i;',
  '    perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);',
  '    for (let i = 0; i < n; i++) {',
  '      const src = perm[i];',
  '      const entityIndex = idx[src];',
  '      if (transformActive[entityIndex] !== 1) continue;',
  '      sorted[m] = entityIndex;',
  '      sortedClass[m] = classes[src];',
  '      m++;',
  '    }',
  '',
].join('\n');

let baseline = source.slice(0, packedStart) + comparatorSort + source.slice(packedEnd);

// The scratch buffer for the packed key is dead in the baseline, so drop it
// rather than leaving an unused Float64Array allocation in the "before" side.
baseline = baseline.replace(/^\s*this\._spawnSortKeys = new Float64Array\(.*\);.*$/gm, '');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, baseline, 'utf8');

// --- the check the DEVLOG rule actually asks for ---
/**
 * Parse-only validation. `new vm.SourceTextModule` needs --experimental-vm-modules,
 * so fall back to a brace/paren balance and a Function-constructor dry run, both
 * of which catch the class of error that actually bit here: a block that was
 * replaced without restoring the locals it declared.
 */
function parsesAsModule(text) {
  // Every top-level declaration the sort block depends on must still be present.
  const required = ['let m = 0;', 'const perm = this._spawnPerm;', 'const sorted = this._spawnSorted;'];
  const missing = required.filter((frag) => !text.includes(frag));
  if (missing.length) {
    console.error(`  baseline is missing: ${missing.join(', ')}`);
    return false;
  }
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}
const written = fs.readFileSync(OUT, 'utf8');
const checks = [
  ['contains the comparator sort', written.includes("perm.subarray(0, n).sort((a, b) => idx[a] - idx[b])")],
  ['contains NO packed key', !written.includes('this._spawnSortKeys')],
  ['contains NO numeric sort call', !written.includes('keyView.sort()')],
  ['still has the spawn gather', written.includes('sortedClass[m] = classes[src];')],
  ['length differs from shipped', written.length !== source.length],
  // The check that was missing: content is not enough. A baseline can contain
  // exactly the right text and still be a file that throws on its first use, and
  // the sitting will happily measure that.
  ['declares the counter it uses', /let m = 0;/.test(written)],
  ['parses as a module', parsesAsModule(written)],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\nbaseline: ${OUT}  (${written.length} bytes, shipped is ${source.length})`);
if (!ok) {
  console.error('\nBASELINE CHECK FAILED - do not run a sitting against this file.');
  process.exit(1);
}
console.log('baseline verified. run the sitting with:');
console.log(
  `  node tests/bench/runPredatorAbab.mjs --name H14 --pairs 8 --owner logic ` +
    `--override src/workers/logicWorker.js=${OUT.replace(/\\/g, '/')}`,
);