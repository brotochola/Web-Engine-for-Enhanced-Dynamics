// N-450: with pixel depth (renderer.pixelDepth, src/render/pixelDepth.js) a sprite that is no face is depth-tested at
// its foot. That foot was its drawn y, while the painter sorts a decoration at its y plus its sortOffsetY (world-owned)
// or at its parent's sort line plus its sortOffsetY (attached): a water tank hung at roof height with a sortOffsetY to its
// house's front was tested 136 px behind it, and the roof's plane hid it. Now the collect keeps the painter's foot, less
// where the decoration is drawn (DecorationComponent.depthFootDy), the emit writes it as a depth foot code in the row's V
// tile offset (preRenderEmitWasm.test.js holds the kernel to depthFootCode), and the depth programs add it to the
// instance's y (depthFootY is their JS twin). Here: the two orders, the painter's and the depth's, agree.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { decorationNoParent } from '../../src/core/decorationPool.js';
import {
  DEPTH_FOOT_BIAS, DEPTH_FOOT_MAX, DEPTH_FOOT_UNITS, depthFootCode, depthFootY, gbufDepthVertex, gbufDepthWgsl,
  pixelDepthVertex, pixelDepthWgsl,
} from '../../src/render/pixelDepth.js';
import { faceMapVertex, faceMapWgsl, gbufAttributeWgsl } from '../../src/render/faceMap.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { setupDecorationCollect } from '../bench/decorationCollectMicrobench.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

const D = DecorationComponent;

/** Decoration i attached to parent p at local (localX, localY), turned with it. */
function attach(i, p, { localX = 0, localY = 0, sortOffsetY = 0, innerZ = 0 } = {}) {
  D.parentEntityIndex[i] = p;
  D.localX[i] = localX;
  D.localY[i] = localY;
  D.inheritParentRotation[i] = 1;
  D.sortOffsetY[i] = sortOffsetY;
  D.innerZ[i] = innerZ;
  D.offsetX[i] = 0;
  D.offsetY[i] = 0;
}

/** Decoration i in the world at y (drawn at y + offsetY). */
function place(i, y, { sortOffsetY = 0, offsetY = 0, innerZ = 0 } = {}) {
  D.parentEntityIndex[i] = decorationNoParent();
  D.x[i] = 100 + 10 * i;
  D.y[i] = y;
  D.sortOffsetY[i] = sortOffsetY;
  D.offsetX[i] = 0;
  D.offsetY[i] = offsetY;
  D.innerZ[i] = innerZ;
}

/** Collector row k's decoration, painter key, drawn y and depth foot (as the depth programs read the emitted row). */
function rows(pre) {
  const out = [];
  for (let k = 0; k < pre._renderableCount; k++) {
    const i = pre._renderableIndex[k];
    const drawn = pre._collectPy[k];
    // A decoration that is no face: U 0, no tile multiplier, V its code.
    const foot = depthFootY(drawn, 0, 0, 0, depthFootCode(D.depthFootDy[i]));
    out.push({ i, key: pre._renderableY[k], drawn, foot });
  }
  return out;
}

const orderBy = (list, field) => list.slice().sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0)).map((r) => r.i);

test('N-450: the depth foot code holds a foot to 1/256 px; none, a NaN and -0 are 0, and past its reach it clamps', () => {
  for (const dy of [136, -136, 0.5, -0.25, 1 / 256, 12.4, -3000.75, 32767]) {
    const code = depthFootCode(dy);
    assert.ok(code > 0 && code <= DEPTH_FOOT_MAX, `${dy}: a code`);
    assert.ok(Math.abs(depthFootY(100, 0, 0, 0, code) - Math.fround(100 + Math.fround(dy))) <= 1 / 512, `${dy}: back`);
  }
  for (const dy of [0, -0, NaN, 1 / 1024, -1 / 1024]) assert.equal(depthFootCode(dy), 0, `${dy}: none`);
  assert.equal(depthFootCode(1e9), DEPTH_FOOT_MAX);
  assert.equal(depthFootCode(-1e9), 1);
  assert.equal(depthFootCode(Infinity), DEPTH_FOOT_MAX);
  assert.equal(depthFootCode(-Infinity), 1);
  // A row with no code, a face's normal (U), or a tiled one stands at its y.
  const code = depthFootCode(50);
  assert.equal(depthFootY(10, 0, 0, 0, 0), 10);
  assert.equal(depthFootY(10, 0, 0, 0x0101, code), 10, 'a face');
  assert.equal(depthFootY(10, 0.5, 0, 0, code), 10, 'tiled');
  assert.equal(depthFootY(10, 0, 0, 0, code), 60);
  // Within 24 bits: the GPU reads the offset as code / 65536, exact in a float32.
  assert.equal(DEPTH_FOOT_BIAS, 2 ** 23);
  assert.equal(DEPTH_FOOT_MAX, 2 ** 24 - 1);
  assert.equal(Math.fround(DEPTH_FOOT_MAX / 65536) * 65536, DEPTH_FOOT_MAX);
  assert.equal(DEPTH_FOOT_UNITS, 256);
});

test('N-450: a world-owned decoration with sortOffsetY and an attached one stand, for the depth, where the painter sorts them', async () => {
  const s = await setupDecorationCollect({ n: 16, parents: 8, ySort: true });
  const { pre } = s;
  const saved = { x: Transform.x.slice(), y: Transform.y.slice(), rotC: Transform.rotC.slice(), rotS: Transform.rotS.slice() };
  try {
    // Parent 1: feet-anchored, still, its sort line its y. Parent 4: anchored at its centre on a 96-high frame
    // (bindParentSprites), its line 48 px below its y. Parent 5: feet-anchored, turned a quarter.
    Transform.x[1] = 300;
    Transform.y[1] = 500.3;
    Transform.x[4] = 400;
    Transform.y[4] = 430;
    Transform.x[5] = 500;
    Transform.y[5] = 450;
    Transform.rotC[5] = 0;
    Transform.rotS[5] = 1;
    const expected = new Map();
    // The house's front line, and what stands at roof height above it with sortOffsetY bringing it in front (the tank).
    place(0, 505);
    expected.set(0, 505);
    place(1, 300, { sortOffsetY: 210 });
    expected.set(1, 510);
    // Drawn 100 px above the point it sorts at (offsetY), as a tall piece.
    place(2, 480, { offsetY: -100 });
    expected.set(2, 480);
    place(3, 200);
    expected.set(3, 200);
    // A flag high on parent 1: drawn at 350, sorted at the parent's line (500.3, rounded to 500 in the key).
    attach(4, 1, { localY: -150, innerZ: 1 });
    expected.set(4, 500.3);
    // Lower on it, sorted 30 px behind its line.
    attach(5, 1, { localY: -60, sortOffsetY: -30 });
    expected.set(5, 470.3);
    // On the centred parent: its line is 478.
    attach(6, 4, { localY: -100 });
    expected.set(6, 478);
    // On the turned parent, 40 px along it and 80 up: drawn at 450 + 40, sorted at 450.
    attach(7, 5, { localX: 40, localY: -80, sortOffsetY: 2 });
    expected.set(7, 452);
    const list = [...expected.keys()];
    s.visible[0] = list.length;
    s.visible.set(list, 1);
    assert.equal(s.frame(), list.length);

    const got = rows(pre);
    for (const r of got) {
      assert.ok(Math.abs(r.foot - expected.get(r.i)) <= 1 / 256, `decoration ${r.i}: foot ${r.foot}, the painter's ${expected.get(r.i)}`);
    }
    // Drawn elsewhere than they sort: the depth's old foot.
    assert.equal(got.find((r) => r.i === 1).drawn, 300);
    assert.equal(got.find((r) => r.i === 4).drawn, Math.fround(350.3));
    assert.equal(got.find((r) => r.i === 7).drawn, 490);
    // The painter's order and the depth's agree; the drawn ys' did not (the tank went behind the house's front).
    const painter = orderBy(got, 'key');
    assert.deepEqual(orderBy(got, 'foot'), painter);
    assert.deepEqual(painter, [3, 7, 5, 6, 2, 4, 0, 1]);
    assert.notDeepEqual(orderBy(got, 'drawn'), painter);
    assert.ok(painter.indexOf(1) > painter.indexOf(0), 'the tank sorts in front of the house front');
    assert.ok(got.find((r) => r.i === 1).foot > got.find((r) => r.i === 0).foot, 'and stands in front of it for the depth');
  } finally {
    Transform.x.set(saved.x);
    Transform.y.set(saved.y);
    Transform.rotC.set(saved.rotC);
    Transform.rotS.set(saved.rotS);
  }
});

test('N-450: without a layer that y-sorts there is no painter foot: the depth stands each where it is drawn', async () => {
  const s = await setupDecorationCollect({ n: 64, parents: 8 });
  D.sortOffsetY.fill(40);
  assert.equal(s.frame(), s.n);
  for (const r of rows(s.pre)) assert.equal(r.foot, r.drawn, `decoration ${r.i}`);
});

test('N-450: every depth program stands its instance on the decoded foot (WebGL and WebGPU, colour and G-buffer)', () => {
  const glsl = readEngineShader('instancedSprite.vert.glsl');
  const wgsl = readEngineShader('instancedSprite.wgsl');
  const decodeGlsl = `depthFootY += (float(dfFoot) - ${DEPTH_FOOT_BIAS}.0) / ${DEPTH_FOOT_UNITS}.0;`;
  const decodeWgsl = `depthFootY += (f32(dfFoot) - ${DEPTH_FOOT_BIAS}.0) / ${DEPTH_FOOT_UNITS}.0;`;
  for (const faces of [false, true]) {
    for (const source of [glsl, spriteIndexedVertex(glsl)]) {
      const v = pixelDepthVertex(source, { gbuf: true, faces, cull: faces ? 'heights' : 'none' });
      assert.ok(v.includes(decodeGlsl) && v.includes('vFootFloor = depthFootY * uDepth.x;'), `GLSL, faces ${faces}`);
      if (faces) assert.ok(v.includes('float depthFloor = depthFootY * uDepth.x;'));
      assert.doesNotMatch(v, /aInstXY\.y \* uDepth\.x/, `GLSL, faces ${faces}: no foot at the drawn y`);
    }
    for (const source of [wgsl, spriteIndexedWgsl(wgsl)]) {
      const w = pixelDepthWgsl(gbufAttributeWgsl(source), { gbuf: true, faces, cull: faces ? 'heights' : 'none' });
      assert.ok(w.includes(decodeWgsl) && w.includes('out.vDepthFoot = vec4<f32>(depthFootY * uniforms.uDepth.x,'), `WGSL, faces ${faces}`);
      if (faces) assert.ok(w.includes('var depthFloor = depthFootY * uniforms.uDepth.x;'));
      assert.doesNotMatch(w, /aInstXY\.y \* uniforms\.uDepth\.x/, `WGSL, faces ${faces}: no foot at the drawn y`);
    }
  }
  const g = gbufDepthVertex(faceMapVertex(glsl, { gbuf: true }));
  assert.ok(g.includes(decodeGlsl) && !/aInstXY\.y \* uDepth\.x/.test(g), 'the G-buffer (GLSL)');
  const gw = gbufDepthWgsl(faceMapWgsl(gbufAttributeWgsl(wgsl), { gbuf: true }));
  assert.ok(gw.includes(decodeWgsl) && !/aInstXY\.y \* weedDepth\.x/.test(gw), 'the G-buffer (WGSL)');
});
