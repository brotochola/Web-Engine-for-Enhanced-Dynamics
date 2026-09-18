/**
 * Kernel A/B/C: world-space fill (A) vs instanced pack v1 (B) vs pose-per-body (C).
 * Load: 256 bodies × 32 local tris = 8192 instances. rotC/rotS prefilled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mulberry32, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  packColliderFill,
  COLLIDER_FILL_FLOATS,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';

const BODIES = 256;
const TRIS_PER_BODY = 32;
const INSTANCES = BODIES * TRIS_PER_BODY;
const FIXTURES = INSTANCES;
const INV = 0xffff;
const EPS = 1e-4;

const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(here, '../results/collider-fill-pack');

function makeViews(rng) {
  const n = BODIES;
  const fx = FIXTURES;
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n),
    meshVisible: new Uint8Array(n),
    meshLayerMask: new Uint16Array(n),
    meshTint: new Uint32Array(n),
    meshAlpha: new Float32Array(n),
    fixtureCount: new Uint16Array(n),
    fixtureHead: new Uint16Array(n),
    fixtureNext: new Uint16Array(fx),
    fixtureActive: new Uint8Array(fx),
    vertCount: new Uint8Array(fx),
    vertexX: new Float32Array(fx * 8),
    vertexY: new Float32Array(fx * 8),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    offsetX: new Float32Array(n),
    offsetY: new Float32Array(n),
    meshBits: 1,
    maxFixtures: fx,
  };
  views.meshActive.fill(1);
  views.meshVisible.fill(1);
  views.meshLayerMask.fill(1);
  views.meshTint.fill(0x88aa66);
  views.meshAlpha.fill(1);
  views.fixtureHead.fill(INV);
  views.fixtureNext.fill(INV);

  let fi = 0;
  for (let i = 0; i < n; i++) {
    const ang = rng() * Math.PI * 2;
    views.x[i] = rng() * 2000;
    views.y[i] = rng() * 1200;
    views.rotC[i] = Math.cos(ang);
    views.rotS[i] = Math.sin(ang);
    let head = INV;
    for (let t = 0; t < TRIS_PER_BODY; t++) {
      const b = fi * 8;
      const ox = (t % 8) * 4;
      const oy = ((t / 8) | 0) * 4;
      views.vertexX[b] = ox;
      views.vertexY[b] = oy;
      views.vertexX[b + 1] = ox + 3;
      views.vertexY[b + 1] = oy;
      views.vertexX[b + 2] = ox;
      views.vertexY[b + 2] = oy + 3;
      views.vertCount[fi] = 3;
      views.fixtureActive[fi] = 1;
      views.fixtureNext[fi] = head;
      head = fi;
      fi++;
    }
    views.fixtureHead[i] = head;
    views.fixtureCount[i] = TRIS_PER_BODY;
  }
  return views;
}

function packWorldA(out, views) {
  const { entityCount, meshActive, meshVisible, meshLayerMask, fixtureCount } = views;
  const { fixtureHead, fixtureNext, fixtureActive, vertCount, vertexX, vertexY } = views;
  const { x, y, rotC, rotS, maxFixtures } = views;
  const bit = 1;
  let w = 0;
  for (let i = 0; i < entityCount; i++) {
    if (!meshActive[i] || !meshVisible[i]) continue;
    if (!(meshLayerMask[i] & bit)) continue;
    if ((fixtureCount[i] | 0) < 1) continue;
    const c = rotC[i];
    const s = rotS[i];
    const wx = x[i];
    const wy = y[i];
    let cur = fixtureHead[i];
    let guard = 0;
    while (cur !== INV && guard++ < maxFixtures) {
      if (fixtureActive[cur]) {
        const n = vertCount[cur] | 0;
        if (n >= 3 && n <= 8) {
          const vb = cur * 8;
          const x0 = vertexX[vb];
          const y0 = vertexY[vb];
          const fans = n - 2;
          for (let t = 0; t < fans; t++) {
            const x1 = vertexX[vb + t + 1];
            const y1 = vertexY[vb + t + 1];
            const x2 = vertexX[vb + t + 2];
            const y2 = vertexY[vb + t + 2];
            const o = w * 6;
            out[o] = wx + c * x0 - s * y0;
            out[o + 1] = wy + s * x0 + c * y0;
            out[o + 2] = wx + c * x1 - s * y1;
            out[o + 3] = wy + s * x1 + c * y1;
            out[o + 4] = wx + c * x2 - s * y2;
            out[o + 5] = wy + s * x2 + c * y2;
            w++;
          }
        }
      }
      cur = fixtureNext[cur];
    }
  }
  return w;
}

function packPoseC(out, views) {
  const n = views.entityCount;
  let o = 0;
  for (let i = 0; i < n; i++) {
    out[o] = views.x[i];
    out[o + 1] = views.y[i];
    out[o + 2] = views.rotC[i];
    out[o + 3] = views.rotS[i];
    o += 4;
  }
  return n;
}

function checksumAB(world, inst, count) {
  for (let i = 0; i < count; i++) {
    const ib = i * COLLIDER_FILL_FLOATS;
    const wb = i * 6;
    const c = inst[ib + 8];
    const s = inst[ib + 9];
    const wx = inst[ib + 6];
    const wy = inst[ib + 7];
    for (let v = 0; v < 3; v++) {
      const lx = inst[ib + v * 2];
      const ly = inst[ib + v * 2 + 1];
      const px = wx + c * lx - s * ly;
      const py = wy + s * lx + c * ly;
      if (Math.abs(px - world[wb + v * 2]) > EPS || Math.abs(py - world[wb + v * 2 + 1]) > EPS) {
        return false;
      }
    }
  }
  return true;
}

function verdict(opsA, opsB, opsC) {
  const h1 = (opsB - opsA) / opsA;
  const h2 = (opsC - opsB) / opsB;
  const h1Status = h1 >= 0.03 ? 'KEEP' : h1 <= -0.03 ? 'WORSE' : 'TIE';
  const h2Status = h2 >= 0.03 ? 'KEEP' : h2 <= -0.03 ? 'WORSE' : 'TIE';
  return { h1, h2, h1Status, h2Status };
}

resetColliderFillMeshLayerWarn();
const views = makeViews(mulberry32(7));
const world = new Float32Array(INSTANCES * 6);
const inst = new Float32Array(INSTANCES * COLLIDER_FILL_FLOATS);
const pose = new Float32Array(BODIES * 4);
views.outU32 = new Uint32Array(inst.buffer);

const nA = packWorldA(world, views);
const nB = packColliderFill(inst, INSTANCES, 0, views);
const nC = packPoseC(pose, views);
if (nA !== INSTANCES || nB !== INSTANCES || nC !== BODIES) {
  throw new Error(`checksum setup count A=${nA} B=${nB} C=${nC} expected ${INSTANCES}/${BODIES}`);
}
const checksumOk = checksumAB(world, inst, INSTANCES);
if (!checksumOk) {
  throw new Error('collider-fill-pack checksum failed; times do not count');
}

const a = timeIt('A world-space', (iterations) => {
  for (let i = 0; i < iterations; i++) packWorldA(world, views);
}, { iterations: 40, warmup: 4, reps: 5 });

const b = timeIt('B packColliderFill', (iterations) => {
  for (let i = 0; i < iterations; i++) packColliderFill(inst, INSTANCES, 0, views);
}, { iterations: 40, warmup: 4, reps: 5 });

const c = timeIt('C pose-per-body', (iterations) => {
  for (let i = 0; i < iterations; i++) packPoseC(pose, views);
}, { iterations: 400, warmup: 40, reps: 5 });

const v = verdict(a.opsPerSec, b.opsPerSec, c.opsPerSec);

const payload = {
  name: 'collider-fill-pack',
  bodies: BODIES,
  trisPerBody: TRIS_PER_BODY,
  instances: INSTANCES,
  checksumOk,
  A: a,
  B: b,
  C: c,
  H1: { claim: 'B >= 3% more ops/s than A', delta: v.h1, status: v.h1Status },
  H2: { claim: 'C >= 3% more ops/s than B', delta: v.h2, status: v.h2Status },
};

writeReport(path.join(reportDir, 'kernel.json'), payload);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const report = `# Pack instanced (B) es más barato que transformar vértices a world en CPU (A)

## What changed
Tres kernels en el mismo proceso Node, misma semilla, destinos prealocados. A escribe un VBO world-space (\`x,y\` × 3 × triángulo), el camino que Graphics usaba. B es \`packColliderFill\` (v1 que se mergea): locales + pose + tint. C solo escribe 256 poses (\`xy, rotCS\`) asumiendo verts ya residentes — no entra a \`src/\` en este plan.

## Setup
Kernel Node, sin workers. \`timeIt\` con piso de 3 ms. Carga fija: **${BODIES}** bodies, **${TRIS_PER_BODY}** tris locales cada uno (**${INSTANCES}** instancias). \`rotC/rotS\` prellenados. Checksum: aplicar pose de B a los locales y comparar con A (epsilon ${EPS}).

## Numbers
- A world-space: mediana ${a.ms.toFixed(3)} ms / ${a.iterations} ops → **${Math.round(a.opsPerSec).toLocaleString()} ops/s**
- B packColliderFill: mediana ${b.ms.toFixed(3)} ms / ${b.iterations} ops → **${Math.round(b.opsPerSec).toLocaleString()} ops/s**
- C pose-por-body: mediana ${c.ms.toFixed(3)} ms / ${c.iterations} ops → **${Math.round(c.opsPerSec).toLocaleString()} ops/s**
- Checksum: ${checksumOk ? 'OK' : 'FAIL'}
- H1 B vs A: ${pct(v.h1)} → **${v.h1Status}**
- H2 C vs B: ${pct(v.h2)} → **${v.h2Status}**

## Verdict
H1 ${v.h1Status}: B ${v.h1Status === 'KEEP' ? 'justifica' : v.h1Status === 'TIE' ? 'no cruza el 3% contra' : 'no gana contra'} matar el world-space en CPU. Este PR siempre mergea B.
H2 ${v.h2Status}: ${v.h2Status === 'KEEP' ? 'C queda como follow-up (split de buffers / vertex pulling), no se mergea ahora.' : 'C se queda fuera de src/.'}

## What we learned
Separar forma local de pose evita reescribir 3 vértices world por triángulo. Instancing sirve porque earcut/fan deja primitivos iguales. Upload GPU no se midió en Node.
`;

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'report.md'), report);
console.log(`H1 ${v.h1Status} (${pct(v.h1)})  H2 ${v.h2Status} (${pct(v.h2)})`);
console.log(`wrote ${path.join(reportDir, 'report.md')}`);
