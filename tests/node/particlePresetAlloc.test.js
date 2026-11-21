import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// E-538, E-541: an emit, a flash and a bullet from presets allocate nothing. tests/helpers/particlePresetDriver.mjs
// fires Predator's shot (two muzzle sprites, the sparks, the muzzle's flash, the bullet) and a hit with every with* override, from presets, then
// counts what 10 000 more of them allocate with V8's sampling heap profiler (a sample every 32 bytes on average,
// objects a GC already collected included), in the engine's frames and the driver's.
//
// How the driver runs: the warm-up's calls tier the code up the way a game's per-shot code does (the interpreter boxes
// every double, so an emit there allocates whatever the engine does), with recompilation on the main thread so it has
// landed when the count starts. Chrome's V8 inlines a callee of 75 bytes of bytecode or less, whatever the caller's
// budget, when it is passed a heap number (--max-inlined-bytecode-size-small-with-heapnum-in-out, which Node 22's V8
// lacks: setterBytecodeSize.test.js); the preset fronts are under it (particlePresetFronts.test.js). Node's
// --max-inlined-bytecode-size-small=75 stands for that rule here. Without it, Node leaves the fronts of a caller past
// its budget out, and that caller boxes the doubles it passes them: the caller's garbage, not the engine's.
//
// The control: the same shot from literal configs (emit({...}), spawnIndex({...})) allocates its configs and ranges,
// so the count sees what a call allocates.

const DRIVER = fileURLToPath(new URL('../helpers/particlePresetDriver.mjs', import.meta.url));
const FLAGS = ['--no-concurrent-recompilation', '--max-inlined-bytecode-size-small=75'];

function runDriver(args) {
  const r = spawnSync(process.execPath, [...FLAGS, DRIVER, '--alloc', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split('\n').pop();
  return JSON.parse(line);
}

test('a shot from particle and flash presets allocates nothing once optimized', () => {
  const result = runDriver(['--form', 'preset', '--warm', '6000', '--ops', '10000']);
  const engine = result.top.filter((t) => t.site.includes(' src/'));
  assert.deepEqual(engine, [], `the engine's frames allocate: ${JSON.stringify(engine)}`);
  assert.ok(result.bytesPerOp < 1, `${result.bytesPerOp.toFixed(2)} bytes a shot: ${JSON.stringify(result.top)}`);
});

test('the control: the same shot from literal configs allocates (the count sees it)', () => {
  const result = runDriver(['--form', 'literal', '--warm', '3000', '--ops', '1000']);
  assert.ok(result.bytesPerOp > 1000, `the literal shot allocates ${result.bytesPerOp.toFixed(0)} bytes`);
});
