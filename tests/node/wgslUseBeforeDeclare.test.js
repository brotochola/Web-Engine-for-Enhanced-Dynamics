import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findWgslUseBeforeDeclare, prependComputePrelude } from '../../src/render/webgpu/wgslPrelude.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const BROKEN_FIRE_PARTICLE = `
@compute @workgroup_size(64)
fn raster_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  let heat = (f32(p.userData & 0xFFu) / 255.0);
  if (heat <= 0.0) { return; }
  let p = particles[i];
}
`;

test('findWgslUseBeforeDeclare: p.userData before let p (burningBoxes bug)', () => {
  const issues = findWgslUseBeforeDeclare(BROKEN_FIRE_PARTICLE);
  assert.ok(
    issues.some((e) => e.name === 'p'),
    `expected 'p' used before declaration, got ${JSON.stringify(issues)}`,
  );
});

test('findWgslUseBeforeDeclare: params and for-loop var are fine', () => {
  const wgsl = `
fn raster_particles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = particles[i32(gid.x)];
  let heat = f32(p.userData & 0xFFu);
  for (var oy = -1; oy <= 1; oy++) {
    let y = p.y + f32(oy);
  }
}
`;
  assert.deepEqual(findWgslUseBeforeDeclare(wgsl), []);
});

test('ComputeLayer.compile checks use-before-declare and names the pass', () => {
  const src = readFileSync(join(root, 'src/render/webgpu/computeLayer.js'), 'utf8');
  const compileAt = src.indexOf('async compile()');
  const earlyAt = src.indexOf('findWgslUseBeforeDeclare', compileAt);
  const gpuAt = src.indexOf('createShaderModule', compileAt);
  assert.ok(compileAt >= 0 && earlyAt > compileAt && earlyAt < gpuAt);
  assert.match(src, /compute pass "\$\{entry\}"/);
});

test('repo WGSL: no let/var/const used before declaration in the same fn', () => {
  const files = [];
  for (const rel of ['demos', 'tests/bench', 'src']) {
    const dir = join(root, rel);
    for (const name of readdirSync(dir, { recursive: true })) {
      if (typeof name === 'string' && name.endsWith('.wgsl')) {
        files.push(join(dir, name));
      }
    }
  }
  assert.ok(files.length > 0, 'no .wgsl files found');
  const failures = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const issues = findWgslUseBeforeDeclare(src);
    if (issues.length) {
      failures.push(`${file}: ${issues.map((e) => `${e.name}@${e.line}`).join(', ')}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('burningBoxes compute shaders stay clean after engine prelude', () => {
  const shaderDir = join(root, 'demos/burningBoxesScene/shaders');
  const names = readdirSync(shaderDir).filter((n) => n.endsWith('.wgsl') && n !== 'fireLook.wgsl');
  assert.ok(names.includes('fireParticles.wgsl'));
  for (const name of names) {
    const raw = readFileSync(join(shaderDir, name), 'utf8');
    if (!raw.includes('@compute')) continue;
    const issues = findWgslUseBeforeDeclare(prependComputePrelude(raw, null, null));
    assert.deepEqual(issues, [], `${name} after prelude: ${JSON.stringify(issues)}`);
  }
});
