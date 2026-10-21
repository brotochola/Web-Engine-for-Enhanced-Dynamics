import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Camera } from '../../src/core/camera.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { viewWorldToScreen } from '../../src/util/viewBounds.js';
import { mulberry32 } from '../bench/benchMath.js';

// E-51b. With the camera turned, the particle worker marked visible every
// particle in the box around the turned view (about 2x the view at 45 degrees
// on 16:9), so pre-render queued and Pixi drew them all, and in a dense scene
// they filled maxVisibleRenderables before on-screen particles got in. The
// turned path tests each particle in view space. Visible: exactly the particles
// whose turned screen position is within the canvas plus the culling margin, as
// viewWorldToScreen puts them.

const N = 4000;
const W = 1280;
const H = 720;
const CULL = 0.05;

function bootCamera(zoom, x, y, rot) {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  data[0] = zoom;
  data[1] = x;
  data[2] = y;
  data[5] = zoom;
  data[9] = rot;
  return data;
}

async function particleWorker(zoom, rot, seed) {
  const par = await loadWorker('particleWorker.js', 'particleWorker');
  const rng = mulberry32(seed);
  ParticleComponent.active = new Uint8Array(N);
  ParticleComponent.x = new Float32Array(N);
  ParticleComponent.y = new Float32Array(N);
  ParticleComponent.isItOnScreen = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    ParticleComponent.active[i] = i % 7 === 3 ? 0 : 1;
    ParticleComponent.x[i] = -1500 + rng() * 4000;
    ParticleComponent.y[i] = -1500 + rng() * 3000;
  }
  par.maxParticles = N;
  par.activeParticleIndices = new Uint16Array(N);
  par.activeParticlesData = new Int32Array(N + 1);
  par.visibleParticlesData = new Int32Array(N + 1);
  par.cameraData = bootCamera(zoom, 120, -80, rot);
  par.canvasWidth = W;
  par.canvasHeight = H;
  par.cullingRatio = CULL;
  par._frameCamValid = false;
  return par;
}

function visibleList(par) {
  const v = par.visibleParticlesData;
  return Array.from(v.subarray(1, 1 + v[0]));
}

/** Particles viewWorldToScreen puts on the canvas plus the margin; `eps` widens or narrows it. */
function inView(zoom, rot, eps) {
  const marginScale = zoom < 1 ? zoom : 1;
  const mx = W * CULL * marginScale;
  const my = H * CULL * marginScale;
  const out = { x: 0, y: 0 };
  const keep = new Set();
  for (let i = 0; i < N; i++) {
    if (!ParticleComponent.active[i]) continue;
    viewWorldToScreen(120, -80, zoom, rot, W, H, ParticleComponent.x[i], ParticleComponent.y[i], out);
    if (out.x > -mx - eps && out.x < W + mx + eps && out.y > -my - eps && out.y < H + my + eps) keep.add(i);
  }
  return keep;
}

test('a turned camera marks visible exactly the particles in the turned view', async () => {
  let seed = 51;
  for (const [rot, zoom] of [[Math.PI / 4, 1], [0.3, 0.7], [-1.1, 1.6], [Math.PI, 1], [2.2, 0.4]]) {
    const par = await particleWorker(zoom, rot, seed++);
    par.buildActiveAndVisibleParticleLists();
    const got = visibleList(par);
    // Float32 positions and another operation order: a hair either way.
    const outer = inView(zoom, rot, 1e-3);
    const inner = inView(zoom, rot, -1e-3);
    for (const i of got) assert.ok(outer.has(i), `rot ${rot} zoom ${zoom}: particle ${i} is off the turned view`);
    for (const i of inner) assert.ok(got.includes(i), `rot ${rot} zoom ${zoom}: particle ${i} in view is not visible`);
    for (let i = 0; i < N; i++) {
      assert.equal(ParticleComponent.isItOnScreen[i] === 1, ParticleComponent.active[i] === 1 && got.includes(i), `flag ${i}`);
    }
    const active = par.activeParticlesData;
    assert.equal(active[0], N - Math.floor((N + 3) / 7), 'every active particle is listed');
  }
});

test('at 45 degrees the turned view keeps far fewer than the box around it', async () => {
  const par = await particleWorker(1, Math.PI / 4, 9);
  par.buildActiveAndVisibleParticleLists();
  const turned = visibleList(par).length;
  // The box the old path used: the turned view's bounding box plus the margin.
  const bounds = par._frameCameraBounds();
  let inBox = 0;
  for (let i = 0; i < N; i++) {
    if (!ParticleComponent.active[i]) continue;
    const sx = ParticleComponent.x[i] * bounds.zoom - bounds.cameraOffsetX;
    const sy = ParticleComponent.y[i] * bounds.zoom - bounds.cameraOffsetY;
    if (sx > bounds.minX && sx < bounds.maxX && sy > bounds.minY && sy < bounds.maxY) inBox++;
  }
  assert.ok(turned > 0);
  assert.ok(turned < inBox * 0.65, `turned ${turned} of box ${inBox}`);
});

test('rotation 0 keeps the screen box', async () => {
  const par = await particleWorker(1, 0, 3);
  par.buildActiveAndVisibleParticleLists();
  const bounds = par._frameCameraBounds();
  const want = [];
  for (let i = 0; i < N; i++) {
    if (!ParticleComponent.active[i]) continue;
    const sx = ParticleComponent.x[i] * bounds.zoom - bounds.cameraOffsetX;
    const sy = ParticleComponent.y[i] * bounds.zoom - bounds.cameraOffsetY;
    if (sx > bounds.minX && sx < bounds.maxX && sy > bounds.minY && sy < bounds.maxY) want.push(i);
  }
  assert.deepEqual(visibleList(par), want);
});
