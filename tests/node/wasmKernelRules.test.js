import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { kernelRuleProblems, readWasmStructure } from '../../scripts/wasmKernelRules.mjs';

// E-76 T6: kernel modules own no memory. The rules run on hand-assembled modules here (one per
// violation), and on every committed module that scripts/buildWasm.mjs built.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const uleb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const str = (s) => [...uleb(s.length), ...Buffer.from(s, 'utf8')];
const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
const vec = (items) => [...uleb(items.length), ...items.flat()];

/**
 * A module with one `() -> ()` function exported as `kernel`. Options plant one violation each.
 */
function moduleBytes({
  shared = true,
  max = 8192,
  extraImport = false,
  start = false,
  global = false,
  data = false,
  extraExport = false,
  exportMemory = false,
  names = true,
} = {}) {
  const imports = [];
  if (extraImport) imports.push([...str('env'), ...str('f'), 0x00, 0x00]);
  imports.push([...str('env'), ...str('memory'), 0x02, shared ? 0x03 : 0x01, 0x01, ...uleb(max)]);
  const fnIndex = extraImport ? 1 : 0;
  const exports = [[...str('kernel'), 0x00, fnIndex]];
  if (extraExport) exports.push([...str('_start'), 0x00, fnIndex]);
  if (exportMemory) exports.push([...str('memory'), 0x02, 0x00]);
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(...section(1, vec([[0x60, 0x00, 0x00]])));
  bytes.push(...section(2, vec(imports)));
  bytes.push(...section(3, vec([[0x00]])));
  if (global) bytes.push(...section(6, vec([[0x7f, 0x01, 0x41, 0x00, 0x0b]])));
  bytes.push(...section(7, vec(exports)));
  if (start) bytes.push(...section(8, uleb(fnIndex)));
  bytes.push(...section(10, vec([[0x02, 0x00, 0x0b]])));
  if (data) bytes.push(...section(11, vec([[0x00, 0x41, 0x00, 0x0b, ...vec([[0x2a]])]])));
  if (names) {
    const fnNames = [0x01, ...uleb(vec([[fnIndex, ...str('kernel')]]).length), ...vec([[fnIndex, ...str('kernel')]])];
    bytes.push(...section(0, [...str('name'), ...fnNames]));
  }
  return new Uint8Array(bytes);
}

const SPEC = { exports: ['kernel'], maxMemoryPages: 8192, names: true };

test('a module that only imports the shared memory and exports its kernel passes', () => {
  const bytes = moduleBytes();
  assert.deepEqual(kernelRuleProblems(bytes, SPEC), []);
  const s = readWasmStructure(bytes);
  assert.deepEqual(s.imports.map((i) => `${i.module}.${i.field}`), ['env.memory']);
  assert.deepEqual(s.imports[0].limits, { min: 1, max: 8192, shared: true, memory64: false });
  assert.deepEqual(s.exports, [{ name: 'kernel', kind: 'function', index: 0 }]);
});

test('each planted violation is reported', () => {
  const cases = [
    [{ extraImport: true }, /imports other than env\.memory: env\.f/],
    [{ shared: false }, /not shared/],
    [{ max: 4096 }, /maximum is 4096 pages, the manifest says 8192/],
    [{ start: true }, /start function/],
    [{ global: true }, /defines 1 global/],
    [{ data: true }, /data segment/],
    [{ extraExport: true }, /does not list: _start/],
    [{ exportMemory: true }, /exports a memory: memory/],
    [{ names: false }, /no name section/],
  ];
  for (const [opts, re] of cases) {
    const problems = kernelRuleProblems(moduleBytes(opts), SPEC);
    assert.equal(problems.length, 1, `${JSON.stringify(opts)}: ${problems.join('; ')}`);
    assert.match(problems[0], re);
  }
  assert.match(kernelRuleProblems(moduleBytes(), { ...SPEC, exports: ['kernel', 'other'] }).join(), /does not export other/);
});

test('every module built by scripts/buildWasm.mjs passes the kernel rules', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'wasm', 'modules.json'), 'utf8'));
  for (const mod of manifest.modules) {
    if (mod.builtBy) continue;
    const bytes = fs.readFileSync(path.join(root, mod.output));
    const problems = kernelRuleProblems(bytes, { exports: mod.exports, maxMemoryPages: mod.maxMemoryPages, names: true });
    assert.deepEqual(problems, [], `${mod.output}: ${problems.join('; ')}`);
  }
});
