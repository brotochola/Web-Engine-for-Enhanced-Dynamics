// DX-SHADOW3D (the sun's map) on real code: the sun's terms, where a caster's picture point lands, the map's vertex
// shader made from the sprite shadows' one, and the light pass's blocks for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SUN_MAP_ZMAX, sunMapLanding, sunMapTerms, sunMapVertex } from '../../src/render/sunShadowMap.js';
import { shaderWithFlag } from '../../src/render/faceMap.js';
import { LIGHTING_DEFAULTS } from '../../src/util/configDefaults.js';
import { unknownConfigKeys } from '../../src/util/configKeys.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('the sun\'s terms: a px of height shifts its landing away from the sun, and cards run across it', () => {
  // The sun to the south-east at 45°: (cos45·(1, 1)/√2, sin45).
  const s = Math.SQRT1_2;
  const t = sunMapTerms([s * s, s * s, s], new Float32Array(4));
  close(t[0], s, 1e-6);
  close(t[1], s, 1e-6);
  close(t[2] * t[0] + t[3] * t[1], 0, 1e-6);
  const noon = sunMapTerms([0, 0, 1], new Float32Array(4));
  assert.deepEqual(Array.from(noon), [0, 0, 1, 0], 'straight above: no shift');
  const low = sunMapTerms([1, 0, 0], new Float32Array(4));
  assert.ok(Number.isFinite(low[0]) && low[0] > 10, 'a sun on the horizon is clamped, not infinite');
});

test('a card\'s columns run to the right of someone at the sun, as the light bench\'s', () => {
  // From the south (behind the camera): the sun sees what the camera sees, the picture's right is the screen's.
  const south = sunMapTerms([0, 1, 1], new Float32Array(4));
  close(south[2], 1);
  close(south[3], 0);
  // From the north: the sun sees the back, so the picture's right lands on the screen's left.
  const north = sunMapTerms([0, -1, 1], new Float32Array(4));
  close(north[2], -1);
  close(north[3], 0);
  // From the east: the right of someone looking west is the north (y down).
  const east = sunMapTerms([1, 0, 1], new Float32Array(4));
  close(east[2], 0);
  close(east[3], -1);
});

test('the sun\'s shift stops at the longest shadow it is given (Sun.shadowMaxLengthRatio)', () => {
  const low = sunMapTerms([1, 0, 0.1], new Float32Array(4), 3);
  close(low[0], 3, 1e-6);
  close(low[1], 0, 1e-6);
  const high = sunMapTerms([1, 0, 1], new Float32Array(4), 3);
  close(high[0], 1, 1e-6, 'a shadow shorter than the cap keeps its length');
});

test('the sprite shadows\' sun card stands on the frame\'s lowest opaque row, not on the anchor', () => {
  const src = shader('instancedSpriteShadow.vert.glsl');
  // The trim's bottom (the lowest opaque row): heights count up from it, and the foot is where it is drawn.
  assert.match(src, /float bottom = aInstTrim\.y \+ aInstTrim\.w;/);
  assert.match(src, /float sunZ = max\(bottom - content\.y, 0\.0\) \* abs\(aInstScale\.y\) \/ uSunK\.w \* height;/);
  assert.match(src, /vec2 foot = vec2\(aInstXY\.x, \(aInstXY\.y \+ \(bottom - aInstAnchor\.y \* aInstSize\.y\) \* aInstScale\.y\) \* uGroundInvScaleY\);/);
  // Its columns run along sunPerp: the sun's perpendicular, or a fixed card's axis (DX-CASTER).
  assert.match(src, /vec2 sunPerp = uSunPerp\.xy;/);
  assert.match(src, /vec2 land = foot \+ \(content\.x - footCol\) \* aInstScale\.x \* sunPerp - sunZ \* uSunK\.xy;/);
  // A base in the texture table's spare floats moves the foot: an ellipse's edge, or a render's lowest contact.
  assert.match(src, /aInstBase = t2\.zw;/);
  assert.match(src, /foot \+= toSun \* sqrt\(rx \* rx \* toSun\.x \* toSun\.x \+ ry \* ry \* toSun\.y \* toSun\.y\);/);
  assert.match(src, /foot = vec2\(aInstXY\.x, aInstXY\.y \* uGroundInvScaleY\) \+ toSun \* reach;/);
  // The old skewed sprite (stretched by shadowLengthRatio, turned on the screen) is gone from the sun's branch.
  assert.doesNotMatch(src, /uSun\.z/);
  const wgsl = shader('instancedSpriteShadow.wgsl');
  assert.match(wgsl, /let sunZ = max\(bottom - content\.y, 0\.0\) \* abs\(aInstScale\.y\) \/ uniforms\.uSunK\.w \* height;/);
  assert.match(wgsl, /uSunK: vec4<f32>,\n  uSunPerp: vec4<f32>,\n\}/);
  assert.doesNotMatch(wgsl, /uSun\.z/);
});

test('a picture point lands its height times the terms away, on the floor drawn at groundScaleY', () => {
  const terms = sunMapTerms([0, 1, 1], new Float32Array(4)); // from the south, at 45°: ky = 1
  const foot = sunMapLanding({ footX: 100, footY: 50, localX: 0, localY: 0, heightScaleY: 0.5 }, terms, 0.5);
  assert.deepEqual(foot, { x: 100, y: 50, z: 0 });
  const top = sunMapLanding({ footX: 100, footY: 50, localX: 0, localY: -10, heightScaleY: 0.5 }, terms, 0.5);
  assert.equal(top.z, 20, '10 screen px up is 20 px of height when a px of height rises 0.5');
  close(top.y, 50 - 20 * 0.5, 1e-9);
  const side = sunMapLanding({ footX: 100, footY: 50, localX: 6, localY: 0, heightScaleY: 0.5 }, terms, 0.5);
  close(side.x, 106, 1e-9);
});

test('the map\'s vertex shader is the sprite shadows\' with the same sun card, its height passed on', () => {
  const src = sunMapVertex(shader('instancedSpriteShadow.vert.glsl'));
  assert.match(src, /uniform vec4 uSunK;/);
  assert.match(src, /out float vSunZ;/);
  // Its columns run along sunPerp: the sun's perpendicular, or a fixed card's axis (DX-CASTER).
  assert.match(src, /vec2 sunPerp = uSunPerp\.xy;/);
  assert.match(src, /vec2 land = foot \+ \(content\.x - footCol\) \* aInstScale\.x \* sunPerp - sunZ \* uSunK\.xy;/);
  assert.match(src, /vSunZ = sunZ;/);
  // DX-CASTER: the caster's opacity rides in vColor.g into the map's texel (its G); DX-GBUF: its entity (the row's tint
  // float), which the map keeps with its highest caster by the depth test.
  assert.match(src, /vColor = vec4\(1\.0, castOpacity, 1\.0, 1\.0\);/);
  assert.match(src, /vSunId = casterEntityId\(aInstTintBits\);/);
  assert.equal(src.match(/void main\(\)/g).length, 1);
  assert.equal(src.match(/uniform vec4 uSunK;/g).length, 1, 'declared once');
  assert.throws(() => sunMapVertex('void main() {}'), /sun shadow map/);
});

test('the map\'s height span is one number in the module, the map\'s shader and the light pass', () => {
  const span = `${SUN_MAP_ZMAX}.0`;
  assert.ok(shader('sunShadowMap.frag.glsl').includes(`/ ${span}`));
  const light = shaderWithFlag(shader('lightingBasic.frag.glsl'), 'SUNMAP', true);
  assert.ok(light.includes(`* ${span}`));
});

test('the light pass keeps its old sun term without the map and takes the map\'s with it', () => {
  const src = shader('lightingBasic.frag.glsl');
  const off = shaderWithFlag(shaderWithFlag(src, 'SUNMAP', false), '!SUNMAP', true);
  const on = shaderWithFlag(shaderWithFlag(src, 'SUNMAP', true), '!SUNMAP', false);
  assert.doesNotMatch(off, /sunVisibility|uSunMap/);
  assert.match(off, /totalLight \+= sunColor \* uSunIntensity;/);
  assert.match(on, /totalLight \+= sunColor \* uSunIntensity \* sunVisibility\(vec3\(fragWorld, 0\.0\), 0\.0\);/);
  assert.doesNotMatch(on, /totalLight \+= sunColor \* uSunIntensity;/);
});

test('lighting.sunShadows is a key, sprite by default', () => {
  assert.equal(LIGHTING_DEFAULTS.sunShadows, 'sprite');
  assert.deepEqual(unknownConfigKeys({ lighting: { sunShadows: 'map' } }), []);
});

test('lighting.selfShadow: the light pass steps towards the sun over the face map, only with faces', async () => {
  const { lightingSource } = await import('../../src/render/faceMap.js');
  const src = shader('lightingBasic.frag.glsl');
  const steps = lightingSource(src, { faces: true, sunMap: false, selfShadow: true });
  assert.match(steps, /selfShadow\(p, selfId\)/);
  assert.match(steps, /sunDirect \*= mix\(1\.0, selfSun, smoothstep\(0\.05, 0\.3, sunDirect\)\)/);
  assert.doesNotMatch(lightingSource(src, { faces: true, sunMap: false, selfShadow: false }), /selfShadow|uSelfShadow/);
  assert.doesNotMatch(lightingSource(src, { faces: false, sunMap: false, selfShadow: true }), /selfShadow|uSelfShadow|#if/);
  assert.equal(LIGHTING_DEFAULTS.selfShadow, false);
});

test('a caster with a height map casts columns: each cell where it is in 3D, the column under it to the floor', async () => {
  const { SUN_MAP_COLUMNS, sunMapColumnGrid, sunMapColumnIndex, sunMapColumnsVertex } = await import('../../src/render/sunShadowMap.js');
  const grid = sunMapColumnGrid(2);
  assert.equal(grid.length, 2 * 2 * 4 * 4);
  assert.deepEqual(Array.from(grid.subarray(0, 16)), [0.25, 0.25, 0, -1, 0.25, 0.25, 1, -1, 0.25, 0.25, 1, 1, 0.25, 0.25, 0, 1]);
  // E-376: four corners a cell, two triangles by index (the same two the six vertices drew: 0 1 2 and 0 2 3).
  assert.deepEqual(Array.from(sunMapColumnIndex(2).subarray(0, 12)), [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  assert.equal(sunMapColumnIndex(SUN_MAP_COLUMNS).length, SUN_MAP_COLUMNS * SUN_MAP_COLUMNS * 6);
  assert.equal(Math.max(...sunMapColumnIndex(SUN_MAP_COLUMNS)), SUN_MAP_COLUMNS * SUN_MAP_COLUMNS * 4 - 1);
  const src = sunMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl'));
  assert.match(src, /in vec4 aCell;/);
  // E-379: this instance's block of the frame (a large render draws as k x k instances of the grid).
  assert.match(src, /in vec4 aBlock;/);
  assert.match(src, /aQuad = \(aBlock\.xy \+ aCell\.xy\) \/ blocks;/);
  // The floor point under a cell is its screen place moved down by its height (the faces' formula), then the strip runs
  // from there (height 0) to where its ray lands (height z).
  assert.match(src, /vec2 base = vec2\(pix\.x, \(pix\.y \+ uSunK\.w \* z\) \* uGroundInvScaleY\);/);
  // A column's height runs from 0 at the floor to z at its top; a cell swept north to its footprint keeps z (zA).
  assert.match(src, /vSunZ = mix\(zA, z, aCell\.z\);/);
  assert.match(src, /float zA = 0\.0;/);
  // E-447: the instance's grid (aBlock.w), the finest when it has none.
  assert.ok(src.includes(`/ ((aBlock.w > 1.5 ? aBlock.w : ${SUN_MAP_COLUMNS}.0) * blocks);`));
  // With a footprint row (the base's second float, + 1): the cell swept north at its height to the footprint's edge.
  assert.match(src, /float footprintNorth\(int slot, float x\)/);
  assert.match(src, /if \(aInstBase\.y >= 1\.0\) \{/);
  // A render (its base has a contact) casts columns and no card, unless its sheet casts its card for the sun (a negative
  // second float); a picture of one view, maps or not, its card.
  // DX-CASTER: a caster's own kind first (2 its solid), else its sheet's (a render's contact, no card flag).
  assert.match(src, /bool solid = sunKind == 2 \|\| \(sunKind == 0 && aInstBase\.x < 0\.0 && aInstBase\.y >= 0\.0\);/);
  assert.match(src, /if \(!solid \|\| m\.b \+ m\.a <= 0\.0/);
  assert.ok(
    sunMapVertex(shader('instancedSpriteShadow.vert.glsl')).includes(
      'if (sunKind >= 3 || sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0)) {',
    ),
  );
  // Drawn on the sprite shadows' layer: the shadow's colour and opacity, no height.
  const flat = sunMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl'), SUN_MAP_COLUMNS, { heights: false });
  assert.match(flat, /vColor = vec4\(0\.0, 0\.0, 0\.0, uSun\.w \* castOpacity\);/);
  assert.doesNotMatch(flat, /vSunZ/);
});

test('WebGPU: the map\'s and the solids\' WGSL come from the sprite shadows\' WGSL as the GLSL ones do', async () => {
  const { SUN_MAP_COLUMNS, sunMapWgsl, sunMapColumnsWgsl } = await import('../../src/render/sunShadowMap.js');
  const { sunShadowGpuProgram } = await import('../../src/render/webgpu/instancedSpriteWgsl.js');
  const { lightingGpuProgram } = await import('../../src/render/webgpu/pixiMeshWgsl.js');
  const wgsl = shader('instancedSpriteShadow.wgsl');
  const map = sunMapWgsl(wgsl);
  assert.match(map, /@location\(6\) vSunZ: f32,/);
  assert.ok(map.includes('    out.vSunZ = sunZ;\n'), 'the card\'s height');
  assert.ok(map.includes('fn mainFragMap(in: VertexOut)'), 'the map\'s fragment');
  assert.ok(
    map.includes('    if (sunKind >= 3 || sunKind == 2 || (sunKind == 0 && aInstBase.x < 0.0 && aInstBase.y >= 0.0)) {'),
    'a render\'s frame skips its card unless it casts one',
  );
  const cards = sunMapWgsl(wgsl, { heights: false });
  assert.doesNotMatch(cards, /vSunZ|mainFragMap/, 'the solids\' cards keep the shadow program\'s colour and fragment');
  const columns = sunMapColumnsWgsl(wgsl);
  assert.match(columns, /@location\(0\) aCell: vec4<f32>,/);
  assert.match(columns, /@location\(12\) aBlock: vec4<f32>,/);
  assert.ok(columns.includes('  let aQuad = (aBlock.xy + aCell.xy) / blocks;\n'));
  assert.match(columns, /@group\(2\) @binding\(5\) var uMaps: texture_2d<f32>;/);
  assert.ok(columns.includes('  out.vSunZ = mix(zA, z, aCell.z);\n'));
  assert.match(columns, /@group\(2\) @binding\(7\) var uFoot: texture_2d<f32>;/);
  assert.ok(columns.includes('fn footprintNorth(slot: i32, x: f32) -> f32 {'));
  assert.equal(columns.match(/fn mainVert\(/g).length, 1);
  const flat = sunMapColumnsWgsl(wgsl, SUN_MAP_COLUMNS, { heights: false });
  assert.ok(flat.includes('out.vColor = vec4<f32>(0.0, 0.0, 0.0, uniforms.uSun.w * castOpacity);'));
  assert.doesNotMatch(flat, /vSunZ/);
  // The columns read the atlas and the twin page in the vertex stage: their layout says so.
  const GpuProgram = { from: (o) => o };
  const p = sunShadowGpuProgram(GpuProgram, columns, 'mainFragMap', 'c', { maps: true });
  assert.equal(p.layout[2].uMaps, 5);
  assert.equal(p.layout[2].uFoot, 7);
  assert.ok(p.gpuLayout[2].some((e) => e.binding === 7));
  assert.ok(p.gpuLayout[2].find((e) => e.binding === 0).visibility === p.gpuLayout[2].find((e) => e.binding === 5).visibility);
  const lit = lightingGpuProgram(GpuProgram, 'x', 'l', true, true);
  assert.deepEqual([lit.layout[2].uFaceMap, lit.layout[2].uSunMap], [4, 5]);
});

test('E-379: a columns pass draws the rows that cast columns for its light, a large render as blocks of the grid', async () => {
  const { COLUMN_CELL_PX, COLUMN_GRIDS, compactColumnRows } = await import('../../src/render/sunShadowMap.js');
  // E-447: a grid each; with no texel known every instance draws with the finest.
  const grids = (rowsEach) => COLUMN_GRIDS.map(() => ({ rows: new Float32Array(rowsEach * 22), blocks: new Float32Array(rowsEach * 4) }));
  const counts = new Int32Array(COLUMN_GRIDS.length);
  const F = 22;
  const L = 12;
  // The texture table: 0 a card (a standing base), 1 a small render (a contact, casts its solid), 2 a barn-sized render,
  // 3 a render that casts its card for the sun (its base's second float negative).
  const lut = new Float32Array(4 * L);
  const frame = (id, w, h, bx, by) => lut.set([w, h, 0, 0, 1, 1, 0, 0, w, h, bx, by], id * L);
  frame(0, 64, 64, 33, 6);
  frame(1, 100, 80, -11, 0);
  frame(2, 442, 442, -40, 0);
  frame(3, 90, 70, -9, -0.5);
  const rows = [];
  const row = (tex, sunKind, lampKind, scale = 1) => {
    const r = new Float32Array(F);
    r[0] = rows.length; // x, to know it back
    r[2] = scale;
    r[3] = scale;
    r[8] = sunKind || lampKind ? -((sunKind | (lampKind << 3)) + 1) : 0;
    r[10] = tex;
    rows.push(r);
  };
  row(0, 0, 0); // a person: no columns
  row(1, 0, 0); // a small render: its columns
  row(2, 0, 0); // the barn: 3 x 3 blocks (442 px over 24 cells of 8 px)
  row(1, 1, 0); // a render set to cast its card for the sun: none for the sun
  row(0, 2, 0); // a sprite set to cast its height map: its columns
  row(3, 0, 0); // a render whose sheet casts its card for the sun: none for the sun, its columns for the lamps
  const src = new Float32Array(rows.length * F);
  rows.forEach((r, i) => src.set(r, i * F));
  const outs = grids(64);
  const n = compactColumnRows(src, rows.length, F, lut, L, 0, outs, null, counts);
  assert.equal(n, 1 + 9 + 1);
  assert.deepEqual(Array.from(counts), [11, 0, 0, 0, 0, 0]);
  const out = outs[0].rows;
  const blocks = outs[0].blocks;
  assert.deepEqual([...Array(n).keys()].map((i) => out[i * F]), [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4]);
  assert.deepEqual(Array.from(blocks.subarray(0, 4)), [0, 0, 1, 24]);
  assert.deepEqual(Array.from(blocks.subarray(4, 4 * 10)), [0, 0, 3, 24, 1, 0, 3, 24, 2, 0, 3, 24, 0, 1, 3, 24, 1, 1, 3, 24, 2, 1, 3, 24, 0, 2, 3, 24, 1, 2, 3, 24, 2, 2, 3, 24]);
  assert.deepEqual(Array.from(out.subarray(F, 2 * F)), Array.from(rows[2]), 'a block is its row, copied whole');
  assert.ok(Math.ceil(442 / (24 * COLUMN_CELL_PX)) === 3);
  // The lamps: the render that casts its card for the sun casts columns towards a lamp (its kind there is the sheet's).
  const lamps = compactColumnRows(src, rows.length, F, lut, L, 1, outs, null, counts);
  assert.deepEqual([...Array(lamps).keys()].map((i) => out[i * F]), [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 5]);
  // Too little room: what fits is written, the count it needs comes back.
  const small = grids(4);
  assert.equal(compactColumnRows(src, rows.length, F, lut, L, 0, small, null, counts), 11);
  assert.equal(counts[0], 11);
  assert.deepEqual([0, 1, 2, 3].map((i) => small[0].rows[i * F]), [1, 2, 2, 2]);
});

test('E-447: each column instance draws with the grid its block needs on the map, no finer than the texel it lands on', async () => {
  const { COLUMN_GRIDS, columnGrid, compactColumnRows } = await import('../../src/render/sunShadowMap.js');
  const { GPU_CASTER_LIGHT_FLOAT } = await import('../../src/render/gpuQueueLayout.js');
  // The coarsest grid whose cells stay within a texel; the finest when the texel is unknown or the frame is large.
  assert.deepEqual(COLUMN_GRIDS, [24, 16, 12, 8, 6, 4]);
  assert.equal(columnGrid(64, 0), 0);
  assert.equal(columnGrid(64, 1), 0, '64 cells of 1 px wanted: the finest grid, 24');
  assert.equal(columnGrid(64, 4), 1, '16 cells wanted: 16');
  assert.equal(columnGrid(64, 5.3), 1, '12.1 cells wanted: 16 (12 would make cells wider than a texel)');
  assert.equal(COLUMN_GRIDS[columnGrid(64, 6)], 12, '10.7 wanted: 12');
  assert.equal(COLUMN_GRIDS[columnGrid(64, 64)], 4, 'a frame a texel: the coarsest, 4');
  for (const side of [8, 40, 64, 100, 192]) {
    for (const texel of [0.5, 1, 2, 3, 5, 9]) {
      const cells = COLUMN_GRIDS[columnGrid(side, texel)];
      assert.ok(cells === 24 || side / cells <= texel + 1e-9, `${side} px over ${cells} cells at ${texel} px a texel`);
    }
  }
  // Rows land on their map's texel: the sun's (texels[0]) or their lamp's tile's (texels[tile], the row's light z - 1).
  const F = 22;
  const L = 12;
  const lut = new Float32Array(L);
  lut.set([64, 64, 0, 0, 1, 1, 0, 0, 64, 64, -11, 0], 0); // a 64 px render: casts its solid
  const src = new Float32Array(3 * F);
  for (let r = 0; r < 3; r++) {
    src[r * F] = r;
    src[r * F + 2] = 1;
    src[r * F + 3] = 1;
    src[r * F + 10] = 0;
    src[r * F + GPU_CASTER_LIGHT_FLOAT + 2] = r + 1; // tile r
  }
  const outs = COLUMN_GRIDS.map(() => ({ rows: new Float32Array(8 * F), blocks: new Float32Array(8 * 4) }));
  const counts = new Int32Array(COLUMN_GRIDS.length);
  // The sun's map at 2 px a texel: 32 cells wanted, the finest grid for all three.
  assert.equal(compactColumnRows(src, 3, F, lut, L, 0, outs, new Float32Array([2]), counts), 3);
  assert.deepEqual(Array.from(counts), [3, 0, 0, 0, 0, 0]);
  // Three lamps' tiles at 1, 6 and 20 px a texel: grids 24, 12 and 4, each instance's cells in its block's fourth float.
  assert.equal(compactColumnRows(src, 3, F, lut, L, 1, outs, new Float32Array([1, 6, 20]), counts), 3);
  assert.deepEqual(Array.from(counts), [1, 0, 1, 0, 0, 1]);
  assert.deepEqual([outs[0].rows[0], outs[2].rows[0], outs[5].rows[0]], [0, 1, 2]);
  assert.deepEqual([outs[0].blocks[3], outs[2].blocks[3], outs[5].blocks[3]], [24, 12, 4]);
  // A tile past the texels known draws with the finest.
  assert.equal(compactColumnRows(src, 3, F, lut, L, 1, outs, new Float32Array([20]), counts), 3);
  assert.deepEqual(Array.from(counts), [2, 0, 0, 0, 0, 1]);
});
