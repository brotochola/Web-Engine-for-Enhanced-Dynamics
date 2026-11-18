// N-272: the self-shadow march works out before its loop where it leaves the face map (a straight line on the screen leaves
// it once), so the loop has no test of its own per step: a branch on the data inside it cost the HD 620 about 5 % of its
// drawn frames. GLSL and WGSL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

// The shaders' mapExit in JS.
const mapExit = (c0, dc) => (dc > 1e-9 ? (1 - c0) / dc : dc < -1e-9 ? -c0 / dc : 1e9);

test('N-272: every step before the exit is on the map, every step after it off, whichever way the march goes', () => {
  const dirs = [[0.01, 0.003], [-0.02, 0.005], [0.0, -0.013], [0.007, 0.0], [-0.004, -0.009], [0, 0]];
  for (const [c0x, c0y] of [[0.5, 0.5], [0.02, 0.97], [0.99, 0.01]]) {
    for (const [dx, dy] of dirs) {
      const tEnd = Math.min(mapExit(c0x, dx), mapExit(c0y, dy));
      for (let t = 0; t < 300; t += 0.5) {
        const x = c0x + dx * t;
        const y = c0y + dy * t;
        const on = x >= 0 && x < 1 && y >= 0 && y < 1;
        if (Math.abs(t - tEnd) < 1e-6) continue; // the edge itself
        assert.equal(on, t < tEnd, `from ${c0x},${c0y} along ${dx},${dy} at t ${t} (exit ${tEnd})`);
      }
    }
  }
});

test('N-272: the march loops to its exit with no test of the map per step, in both languages', () => {
  for (const [name, loopEnd, head] of [
    ['lightingBasic.frag.glsl', 'if (t >= tEnd) break;', 'float selfShadowToward('],
    ['lightingBasic.wgsl', 'if (t >= tEnd) { break; }', 'fn selfShadowToward('],
  ]) {
    const src = shader(name);
    const from = src.indexOf(head);
    assert.ok(from >= 0, name);
    const body = src.slice(from, src.indexOf('\n}\n', from));
    assert.ok(body.includes('tEnd = min(reach, min(mapExit(fc0.x, dfc.x), mapExit(fc0.y, dfc.y)));'), name);
    assert.ok(body.includes(loopEnd), name);
    assert.ok(!/lessThan\(fc|fc < vec2|greaterThanEqual\(fc|fc >= vec2/.test(body), `${name}: no bounds test in the loop`);
    assert.ok(body.includes('fc0 + dfc * t'), `${name}: the map point steps linearly`);
  }
});
