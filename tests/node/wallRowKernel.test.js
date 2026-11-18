// OL-11: the sweep's kernel writes a lamp's row (wall_row in wasm/visibilitySweep.c) from the polygon it left, where
// pre-render built it in JS (lampWallRow.js writeWallRow). The row must not change by a bit. Here the shipped kernel
// (engine.wasm) on a memory laid out as pre-render's: polygons written where the sweep leaves them (outX, outY, and
// what each vertex's ray hit), the occluders' codes beside them, and the kernel's row against the JS writer's on
// thousands of polygons: vertices that share rays, any start around the turn, three vertices, a full row, lamps and
// floor scales of every size.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WALL_BINS, WALL_ROW_ARGS, WALL_ROW_MAX_VERTS, WALL_VERT0, wallEdgeCode, wallRowTexels, writeWallRow,
} from '../../src/render/visibility/lampWallRow.js';
import { bindVisibilitySweep } from '../../src/render/visibility/visibilitySweepClient.js';
import { VISIBILITY_ROW_FLOATS, createVisibilityMemory, visibilityMemoryOpts } from '../../src/util/visibilityMemory.js';
import { mulberry32 } from '../bench/benchMath.js';

const OCCLUDERS = 96;

async function boot() {
  const vm = createVisibilityMemory(visibilityMemoryOpts({ maxVerts: WALL_ROW_MAX_VERTS, entities: 64, fixtures: 0 }));
  assert.ok(vm, 'the visibility memory');
  const sweep = await bindVisibilitySweep(vm, { maxVerts: WALL_ROW_MAX_VERTS });
  return { vm, sweep };
}

/**
 * A polygon of n vertices in rising angle around a lamp, written where the sweep leaves one: its vertices, and for each
 * what its ray hit (an occluder of the list, or -1). `stack` of the vertices keep the ray of the one before.
 */
function writePolygon(rng, views, n, { start = -Math.PI, stack = 0.15, floor = 0.7 } = {}) {
  const lx = (rng() - 0.5) * 6000;
  const ly = (rng() - 0.5) * 6000;
  const radius = 40 + rng() * 500;
  let angle = start;
  for (let v = 0; v < n; v++) {
    if (v > 0 && rng() >= stack) angle += ((start + 2 * Math.PI - angle) / (n - v + 1)) * (0.2 + rng() * 1.6);
    const free = rng() < 0.3;
    const r = free ? radius * 1.414 : radius * (0.05 + rng() * 0.9);
    views.outX[v] = lx + Math.cos(angle) * r;
    views.outY[v] = ly + Math.sin(angle) * r * floor;
    views.outOcc[v] = free ? -1 : (rng() * OCCLUDERS) | 0;
  }
  return { lx, ly, floorInv: 1 / floor, n };
}

/** The JS writer's row for the polygon in the memory, as bits. */
function jsRow(views, p) {
  const codes = new Float32Array(p.n);
  for (let v = 0; v < p.n; v++) codes[v] = views.outOcc[v] >= 0 ? views.occCode[views.outOcc[v]] : 0;
  const row = new Float32Array(4 * wallRowTexels(WALL_ROW_MAX_VERTS));
  WALL_ROW_ARGS[0] = p.lx;
  WALL_ROW_ARGS[1] = p.ly;
  WALL_ROW_ARGS[2] = p.floorInv;
  const wrote = writeWallRow(row, 0, views.outX, views.outY, codes, p.n);
  return { wrote, bits: new Uint32Array(row.buffer) };
}

function assertKernelRow(boot, p, label) {
  const { vm, sweep } = boot;
  const used = sweep.row(sweep.tableByte, p.lx, p.ly, p.floorInv, p.n);
  const ref = jsRow(vm.views, p);
  const expected = p.n >= 3 ? 4 * (WALL_VERT0 + p.n + 1) : 4;
  assert.equal(used, expected, `${label}: the floats written`);
  assert.equal(ref.wrote, p.n >= 3 ? p.n : 0);
  const out = vm.views.rowOut;
  const bits = new Uint32Array(out.buffer, out.byteOffset, used);
  for (let i = 0; i < used; i++) {
    if (bits[i] !== ref.bits[i]) {
      const where = i < 4 ? 'header' : i < 4 + WALL_BINS ? `bin ${i - 4}` : `vertex ${((i - 4 * WALL_VERT0) / 4) | 0} float ${i % 4}`;
      assert.fail(`${label}: float ${i} (${where}) differs: the kernel ${out[i]}, the JS ${new Float32Array(ref.bits.buffer)[i]}`);
    }
  }
}

test('OL-11: the memory holds a row as wide as a row can be, and the occluders\' codes', async () => {
  const { vm } = await boot();
  assert.equal(VISIBILITY_ROW_FLOATS, 4 * wallRowTexels(WALL_ROW_MAX_VERTS));
  assert.equal(vm.views.rowOut.length, VISIBILITY_ROW_FLOATS);
  assert.ok(vm.views.occCode.length >= OCCLUDERS);
});

test('OL-11: the kernel\'s row is the JS writer\'s, bit for bit, on 4000 polygons of every size', async () => {
  const b = await boot();
  const rng = mulberry32(0x0c0de);
  for (let o = 0; o < OCCLUDERS; o++) b.vm.views.occCode[o] = wallEdgeCode(1 + ((rng() * 60000) | 0), 0.05 + rng() * 0.95);
  for (let k = 0; k < 4000; k++) {
    const n = 3 + ((rng() * rng() * (WALL_ROW_MAX_VERTS - 2)) | 0);
    const p = writePolygon(rng, b.vm.views, n, { start: -Math.PI + (k % 7 === 0 ? rng() * 6 : 0), floor: k % 3 === 0 ? 1 : 0.7 });
    assertKernelRow(b, p, `polygon ${k} (n ${n})`);
  }
});

test('OL-11: vertices that share rays, a full row, three vertices, every ray free, and fewer than three', async () => {
  const b = await boot();
  const { views } = b.vm;
  const rng = mulberry32(0x0beef);
  for (let o = 0; o < OCCLUDERS; o++) views.occCode[o] = wallEdgeCode(1 + o, o % 3 === 0 ? 0.5 : 1);
  for (let k = 0; k < 300; k++) assertKernelRow(b, writePolygon(rng, views, 4 + (k % 60), { stack: 0.7 }), `stacked ${k}`);
  for (let k = 0; k < 20; k++) assertKernelRow(b, writePolygon(rng, views, WALL_ROW_MAX_VERTS), `full ${k}`);
  for (let k = 0; k < 50; k++) assertKernelRow(b, writePolygon(rng, views, 3), `triangle ${k}`);
  assertKernelRow(b, writePolygon(rng, views, 12, { stack: 1 }), 'one ray');
  const free = writePolygon(rng, views, 40);
  views.outOcc.fill(-1, 0, 40);
  assertKernelRow(b, free, 'every ray free');
  for (const n of [0, 1, 2]) assertKernelRow(b, { ...writePolygon(rng, views, 3), n }, `n ${n}`);
});

// On a real pre-render worker (tests/helpers/visibilityWired.mjs), both gathers: the same moving frames with the kernel
// writing the rows (the default) and with wasm.wallRow off (every row written in JS), the cache off so every lamp is
// swept every frame. The same lamps, the same rows, bit for bit; and the kernel is what wrote them where it may.
const SCENE = { lights: 24, boxes: 150, circles: 50, polygons: 30, rings: 5, blockHalf: 0.25 };

async function playFrames(bootWorker, wallRow, frames) {
  const { bootPreRender, bootPreRenderGather, makeScene, runFrame, writeFrame } = await import('../helpers/visibilityWired.mjs');
  const boot = bootWorker === 'gather' ? bootPreRenderGather : bootPreRender;
  const b = await boot(makeScene(0x0a11, SCENE), { rows: true, wallCache: false, maxNeighbors: 512, wasm: { wallRow } });
  const kernel = b.pre._visSweep;
  const row = kernel.row;
  let calls = 0;
  kernel.row = (...args) => {
    calls++;
    return row(...args);
  };
  const out = [];
  for (let f = 0; f < frames; f++) {
    writeFrame(b, f * 0.05);
    b.pre._wallRowsWrite = b.pre._wallRowBuffers[f & 1];
    const rows = runFrame(b).rows;
    out.push(rows.lamps.map((lamp, r) => {
      const o = r * rows.rowFloats;
      const used = 4 * (WALL_VERT0 + rows.f32[o] + 1);
      return { lamp, bits: new Uint32Array(rows.f32.slice(o, o + used).buffer) };
    }));
  }
  return { out, calls };
}

for (const gather of ['js', 'gather']) {
  test(`OL-11: a worker's rows are the same with the kernel writing them and with wasm.wallRow off (${gather === 'js' ? 'the JS gather' : 'visibilityGather.wasm'})`, async () => {
    const js = await playFrames(gather, false, 12);
    const wasm = await playFrames(gather, true, 12);
    assert.equal(js.calls, 0, 'wasm.wallRow off: the kernel writes no row');
    const rows = wasm.out.reduce((a, frame) => a + frame.length, 0);
    assert.ok(wasm.calls > rows * 0.5 && wasm.calls <= rows, `the kernel wrote ${wasm.calls} of ${rows} rows (the rest have a compound solid in reach)`);
    for (let f = 0; f < js.out.length; f++) {
      assert.deepEqual(wasm.out[f].map((r) => r.lamp), js.out[f].map((r) => r.lamp), `frame ${f}: the lamps with a row`);
      for (let r = 0; r < js.out[f].length; r++) {
        const a = js.out[f][r].bits;
        const k = wasm.out[f][r].bits;
        assert.equal(k.length, a.length, `frame ${f} lamp ${js.out[f][r].lamp}: the row's length`);
        for (let i = 0; i < a.length; i++) if (a[i] !== k[i]) assert.fail(`frame ${f} lamp ${js.out[f][r].lamp}: float ${i} differs`);
      }
    }
  });
}

// OL-12: with the walls' rows the gather's kernel writes each packed occluder's code itself (its entity's G-buffer id
// and its opacity), where the JS gather names the entity and pre-render works the code out. The same frames on a worker
// that gathers in JS and on one that gathers in visibilityGather.wasm: every row names the same wall, of the same
// opacity, on every edge.
test('OL-12: the gather kernel\'s codes are the ones pre-render works out from the JS gather', async () => {
  const js = await playFrames('js', true, 8);
  const wasm = await playFrames('gather', true, 8);
  let edges = 0;
  let walls = 0;
  for (let f = 0; f < js.out.length; f++) {
    assert.deepEqual(wasm.out[f].map((r) => r.lamp), js.out[f].map((r) => r.lamp), `frame ${f}: the lamps with a row`);
    for (let r = 0; r < js.out[f].length; r++) {
      const a = new Float32Array(js.out[f][r].bits.buffer);
      const k = new Float32Array(wasm.out[f][r].bits.buffer);
      assert.equal(k[0], a[0], `frame ${f} lamp ${js.out[f][r].lamp}: the vertices`);
      for (let v = 0; v < a[0]; v++) {
        const at = 4 * (WALL_VERT0 + v) + 3;
        assert.equal(k[at], a[at], `frame ${f} lamp ${js.out[f][r].lamp} vertex ${v}: the edge's code`);
        edges++;
        if (a[at] !== 0) walls++;
      }
    }
  }
  assert.ok(walls > 500 && walls < edges, `${walls} of ${edges} edges name a wall`);
});
