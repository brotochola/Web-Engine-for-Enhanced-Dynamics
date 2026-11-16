#!/usr/bin/env node
/**
 * E-419: what a MESH layer's fill costs the GPU by how its triangles reach the vertex shader, outside the engine. The
 * page builds volumeStressScene's town as packMeshUvFill writes it (one 24-float row a triangle, entity by entity, houses
 * spawned until renderer.maxMeshIndices is spent, as the scene's are) and draws it into a 1920 x 1080 RGBA8 target the
 * way the layer's RT pass does (premultiplied blending, no depth), each draw between two timer queries
 * (EXT_disjoint_timer_query_webgl2). With --scissor each draw is also timed under a 1 px scissor: what is left is the
 * vertex and setup work, the rest is fill.
 *
 * Ways (--ways, comma separated; all by default):
 *   inst      the batch as shipped: an instance a row, 3 vertices, its 14 attributes (MeshUvFillBatch), meshUvFill.*.glsl
 *   instVs    the batch as the --vs tree ships it
 *   instMin   the same instances, a shader that only places the corner (what the pipeline costs without the shader)
 *   instVec4  the same instances, the row read as 6 vec4 attributes
 *   instVec4Id  instVec4 with the corner from gl_VertexID (no per-vertex attribute)
 *   instVec4Lean  instVec4 with a fragment that declares only the inputs it reads
 *   inst2     two rows an instance (12 vec4 attributes, 6 vertices)
 *   flat      no instances: the row's 3 corners as 3 vertices of 16 floats (drawArrays)
 *   indexed   no instances: each mesh's vertices once (16 floats) and its indices (drawElements)
 *   pull      no instances, no attributes: the rows in an RGBA32F texture, read by gl_VertexID (drawArrays)
 *   col       E-452: ColliderFillBatch as shipped, the same triangles as its 18-float rows (no UVs, so no sun shift),
 *             colliderFill.*.glsl
 *   colVs     the collider batch as the --vs tree ships it
 * Every way but instMin runs meshUvFill.vert.glsl's body on the same row values, so the picture is the same; the page
 * checks it (a read back of each way's target against inst's; colVs's against col's, which has no sun shift).
 *
 *   node tests/bench/meshFillGpuBench.mjs [--n 20000] [--zoom 0.5] [--ways inst,flat] [--scissor] [--draws 40]
 *     [--rounds 3] [--root <tree>] [--vs <tree>] [--output path]
 * --root: meshUvFill.*.glsl and colliderFill.*.glsl from that tree's src/shaders (default this one), to time another
 *   revision's shaders.
 * --vs: the ways instVs and colVs, the batches as that tree ships them, timed in the same page as inst and col (the GPU's
 *   clock the same): `--ways inst,instVs --vs <base>` reads a shader change against its base.
 * Headed Chrome on the real GPU (a headless one draws on a software path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { isCli, parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readShader = (root, name) => fs.readFileSync(path.join(root, 'src/shaders', name), 'utf8').replace(/\r\n?/g, '\n');

/** Runs in the page. */
async function benchInPage({ vert, frag, vertVs, fragVs, colVert, colFrag, colVertVs, colFragVs, n, zoom, ways, scissor, draws, rounds, width, height }) {
  // ---- volumeStressScene's town (houseLevels, meshOf, the spawn order and its index budget) ----
  const SEED = 0x701;
  const WORLD_W = 6000;
  const WORLD_H = 4000;
  const CARS = 200;
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const box = (hw, hd, cx = 0, cy = 0) => [cx - hw, cy - hd, cx + hw, cy - hd, cx + hw, cy + hd, cx - hw, cy + hd];
  const ring = (k, rx, ry, cx, cy) => {
    const out = [];
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    return out;
  };
  const houseLevels = (hw, hd, h) => [[box(hw, hd), 0, h, box(hw, hd)], [ring(6, hw * 0.3, hd * 0.3, -hw * 0.4, 0), h, h * 1.3, ring(6, hw * 0.3, hd * 0.3, -hw * 0.4, 0)]];
  function meshOf(levels) {
    const xy = [];
    const heights = [];
    const indices = [];
    for (const [outline, bottom, h, top] of levels) {
      const k = outline.length / 2;
      const first = heights.length;
      for (let p = 0; p < k * 2; p++) heights.push(p < k ? bottom : h);
      xy.push(...outline, ...top);
      for (let i = 1; i < k - 1; i++) indices.push(first + k, first + k + i, first + k + i + 1);
      for (let i = 0; i < k; i++) {
        const j = (i + 1) % k;
        indices.push(first + i, first + j, first + k + j, first + i, first + k + j, first + k + i);
      }
    }
    return { xy, heights, indices };
  }
  const rng = mulberry32(SEED);
  let indexBudget = n * 72 + CARS * 96 + 64;
  const meshes = [];
  for (let i = 0; i < n; i++) {
    const x = rng() * WORLD_W;
    const y = rng() * WORLD_H;
    const hw = 14 + rng() * 40;
    const hd = 10 + rng() * 26;
    const h = 20 + rng() * 80;
    const m = meshOf(houseLevels(hw, hd, h));
    if (m.indices.length > indexBudget) continue; // MeshGeometry: the pool is full, the house has no mesh
    indexBudget -= m.indices.length;
    meshes.push({ entity: i, x, y, ...m });
  }

  // ---- the rows, as packMeshUvFill writes them (24 floats: v0 v1 v2 pos rot tint depth texId tileInv tileOff body uv0 uv1 uv2) ----
  let triCount = 0;
  let vertCount = 0;
  for (const m of meshes) {
    triCount += m.indices.length / 3;
    vertCount += m.heights.length;
  }
  const ROW = 24;
  const rows = new Float32Array((triCount + 1) * ROW);
  const rowsU32 = new Uint32Array(rows.buffer);
  const denom = triCount + 1;
  {
    let k = 0;
    for (const m of meshes) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const o = k * ROW;
        for (let c = 0; c < 3; c++) {
          const v = m.indices[t + c];
          rows[o + c * 2] = m.xy[v * 2];
          rows[o + c * 2 + 1] = m.xy[v * 2 + 1];
          rows[o + 18 + c * 2] = m.heights[v];
          rows[o + 18 + c * 2 + 1] = 0;
        }
        rows[o + 6] = m.x;
        rows[o + 7] = m.y;
        rows[o + 8] = 1;
        rows[o + 9] = 0;
        rowsU32[o + 10] = (255 << 24) >>> 0; // alpha 1, tint 0x000000
        rows[o + 11] = 1 - (k + 1) / denom;
        rows[o + 12] = -1; // no texture
        rows[o + 13] = 0;
        rows[o + 14] = 0;
        rows[o + 15] = 0;
        rows[o + 16] = 0;
        rows[o + 17] = m.entity;
        k++;
      }
    }
  }

  // ---- WebGL ----
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) return { error: 'no WebGL 2' };
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer) return { error: 'no EXT_disjoint_timer_query_webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

  function floatTexture(w, h, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  // The pose table: every entity's (x, y, cos, sin), 256 a row, as writeMeshPoseTable leaves it.
  const poseH = Math.max(1, Math.ceil((n + CARS) / 256));
  const pose = new Float32Array(256 * poseH * 4);
  for (const m of meshes) {
    pose[m.entity * 4] = m.x;
    pose[m.entity * 4 + 1] = m.y;
    pose[m.entity * 4 + 2] = 1;
    pose[m.entity * 4 + 3] = 0;
  }
  const poseTex = floatTexture(256, poseH, pose);
  const lutTex = floatTexture(3, 1, new Float32Array(12));
  const whiteTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, whiteTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  // The rows as a texture (pull): 6 texels a row, 682 rows a texture row.
  const PULL_W = 6 * 682;
  const pullH = Math.ceil(triCount / 682);
  const pullData = new Float32Array(PULL_W * pullH * 4);
  pullData.set(rows.subarray(0, triCount * ROW));
  const rowsTex = floatTexture(PULL_W, pullH, pullData);

  // Camera: centred, `zoom`; the RT pass's transform (world - camera) * zoom, Pixi's projection of a width x height target.
  const camX = WORLD_W * 0.5 - width / (2 * zoom);
  const camY = WORLD_H * 0.5 - height / (2 * zoom);
  const uProjection = new Float32Array([2 / width, 0, 0, 0, 2 / height, 0, -1, -1, 1]);
  const uWorld = new Float32Array([zoom, 0, 0, 0, zoom, 0, -camX * zoom, -camY * zoom, 1]);
  const uIdentity = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // The sun at 9 h: 0.6 px a px of height, towards 200 degrees.
  const sun = new Float32Array([0.6 * Math.cos((200 * Math.PI) / 180), 0.6 * Math.sin((200 * Math.PI) / 180), 0, 0]);

  function compile(type, source, what) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${what}: ${gl.getShaderInfoLog(s)}\n${source}`);
    return s;
  }
  // As Pixi's GlProgram hands them over: the version first, its default precisions (the files' own override them).
  const pixiPrep = (src, isFrag) => `#version 300 es\nprecision ${isFrag ? 'mediump' : 'highp'} float;\n${src.replace('#version 300 es', '')}`;
  function program(vs, fs, what) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, pixiPrep(vs, false), `${what} vertex`));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, pixiPrep(fs, true), `${what} fragment`));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${what} link: ${gl.getProgramInfoLog(p)}`);
    return p;
  }

  // ---- the vertex shader's forms: the shipped body with its attributes read another way ----
  const ATTRS = ['aTri', 'aV0', 'aV1', 'aV2', 'aInstXY', 'aInstRotCS', 'aInstTintBits', 'aInstDepth', 'aInstTexId', 'aInstTileInv', 'aInstTileOff', 'aInstBody', 'aUV0', 'aUV1', 'aUV2'];
  const TYPES = { aInstTintBits: 'float', aInstDepth: 'float', aInstTexId: 'float', aInstBody: 'float' };
  function withoutAttributes(src) {
    let out = src;
    for (const a of ATTRS) {
      const decl = `in ${TYPES[a] || 'vec2'} ${a};\n`;
      if (out.split(decl).length !== 2) throw new Error(`meshUvFill.vert.glsl: no ${decl.trim()}`);
      out = out.replace(decl, '');
    }
    return out;
  }
  // Locals with the attributes' names from a row r0..r5 (6 vec4) and a corner (0, 1, 2).
  const ROW_LOCALS = `
  vec2 aV0 = r0.xy; vec2 aV1 = r0.zw; vec2 aV2 = r1.xy; vec2 aInstXY = r1.zw; vec2 aInstRotCS = r2.xy;
  float aInstTintBits = r2.z; float aInstDepth = r2.w; float aInstTexId = r3.x; vec2 aInstTileInv = r3.yz;
  vec2 aInstTileOff = vec2(r3.w, r4.x); float aInstBody = r4.y; vec2 aUV0 = r4.zw; vec2 aUV1 = r5.xy; vec2 aUV2 = r5.zw;
`;
  function rowForm(src, head, prelude) {
    const body = withoutAttributes(src);
    const main = 'void main() {\n';
    if (body.split(main).length !== 2) throw new Error('meshUvFill.vert.glsl: one main');
    return body.replace('#version 300 es\n', `#version 300 es\n${head}`).replace(main, `${main}${prelude}`);
  }
  const vInstVec4 = () => rowForm(vert, 'in vec2 aTri;\nin vec4 aR0;\nin vec4 aR1;\nin vec4 aR2;\nin vec4 aR3;\nin vec4 aR4;\nin vec4 aR5;\n',
    `  vec4 r0 = aR0; vec4 r1 = aR1; vec4 r2 = aR2; vec4 r3 = aR3; vec4 r4 = aR4; vec4 r5 = aR5;\n${ROW_LOCALS}`);
  // instVec4 with the corner from gl_VertexID: no per-vertex attribute.
  const vInstVec4Id = () => rowForm(vert, 'in vec4 aR0;\nin vec4 aR1;\nin vec4 aR2;\nin vec4 aR3;\nin vec4 aR4;\nin vec4 aR5;\n',
    `  vec4 r0 = aR0; vec4 r1 = aR1; vec4 r2 = aR2; vec4 r3 = aR3; vec4 r4 = aR4; vec4 r5 = aR5;
  vec2 aTri = vec2(gl_VertexID == 1 ? 1.0 : 0.0, gl_VertexID == 2 ? 1.0 : 0.0);\n${ROW_LOCALS}`);
  // The fragment without the inputs it does not read (vLocal, vWorld, vTileInv, vTileOff).
  const fLean = () => {
    let out = frag;
    for (const decl of ['in vec2 vLocal;\n', 'in vec2 vWorld;\n', 'in vec2 vTileInv;\n', 'in vec2 vTileOff;\n']) {
      if (out.split(decl).length !== 2) throw new Error(`meshUvFill.frag.glsl: no ${decl.trim()}`);
      out = out.replace(decl, '');
    }
    return out;
  };
  const vInst2 = () => rowForm(vert,
    'in vec3 aTri3;\nin vec4 aA0;\nin vec4 aA1;\nin vec4 aA2;\nin vec4 aA3;\nin vec4 aA4;\nin vec4 aA5;\nin vec4 aB0;\nin vec4 aB1;\nin vec4 aB2;\nin vec4 aB3;\nin vec4 aB4;\nin vec4 aB5;\n',
    `  bool second = aTri3.z > 0.5;
  vec4 r0 = second ? aB0 : aA0; vec4 r1 = second ? aB1 : aA1; vec4 r2 = second ? aB2 : aA2;
  vec4 r3 = second ? aB3 : aA3; vec4 r4 = second ? aB4 : aA4; vec4 r5 = second ? aB5 : aA5;
  vec2 aTri = aTri3.xy;\n${ROW_LOCALS}`);
  // flat and indexed: a vertex carries its own corner and its U, V: (corner, uv), (pos, rot), (tint, depth, texId, body), (tileInv, tileOff).
  const vVert = () => rowForm(vert, 'in vec4 aP0;\nin vec4 aP1;\nin vec4 aP2;\nin vec4 aP3;\n', `
  vec2 aTri = vec2(0.0); vec2 aV0 = aP0.xy; vec2 aV1 = aV0; vec2 aV2 = aV0; vec2 aUV0 = aP0.zw; vec2 aUV1 = aUV0; vec2 aUV2 = aUV0;
  vec2 aInstXY = aP1.xy; vec2 aInstRotCS = aP1.zw; float aInstTintBits = aP2.x; float aInstDepth = aP2.y; float aInstTexId = aP2.z;
  float aInstBody = aP2.w; vec2 aInstTileInv = aP3.xy; vec2 aInstTileOff = aP3.zw;
`);
  const vPull = () => rowForm(vert, 'uniform highp sampler2D uRows;\n', `
  int weedTri = gl_VertexID / 3;
  int weedCorner = gl_VertexID - weedTri * 3;
  ivec2 weedAt = ivec2((weedTri % 682) * 6, weedTri / 682);
  vec4 r0 = texelFetch(uRows, weedAt, 0); vec4 r1 = texelFetch(uRows, weedAt + ivec2(1, 0), 0);
  vec4 r2 = texelFetch(uRows, weedAt + ivec2(2, 0), 0); vec4 r3 = texelFetch(uRows, weedAt + ivec2(3, 0), 0);
  vec4 r4 = texelFetch(uRows, weedAt + ivec2(4, 0), 0); vec4 r5 = texelFetch(uRows, weedAt + ivec2(5, 0), 0);
  vec2 aTri = vec2(weedCorner == 1 ? 1.0 : 0.0, weedCorner == 2 ? 1.0 : 0.0);\n${ROW_LOCALS}`);
  const vMin = `#version 300 es
in vec2 aTri;
in vec2 aV0;
in vec2 aV1;
in vec2 aV2;
in vec2 aInstXY;
in vec2 aUV0;
in vec2 aUV1;
in vec2 aUV2;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uSunShadow;
void main() {
  vec2 local = aV0 + aTri.x * (aV1 - aV0) + aTri.y * (aV2 - aV0);
  float h = aUV0.x + aTri.x * (aUV1.x - aUV0.x) + aTri.y * (aUV2.x - aUV0.x);
  vec3 clip = uProjectionMatrix * uWorldTransformMatrix * vec3(local + aInstXY + h * uSunShadow.xy, 1.0);
  gl_Position = vec4(clip.xy, 0.5, 1.0);
}
`;
  const fMin = `#version 300 es
precision highp float;
out vec4 finalColor;
void main() { finalColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

  // ---- geometry per way ----
  const STRIDE = ROW * 4;
  function buffer(target, data) {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }
  const triBuf = buffer(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1]));
  const tri3Buf = buffer(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1]));
  const rowBuf = buffer(gl.ARRAY_BUFFER, rows);
  // col: the same rows as ColliderFillBatch's 18 floats (packColliderFill writes the first 18 of a UV row's 24 the same).
  const COL_ROW = 18;
  const colRows = new Float32Array(triCount * COL_ROW);
  for (let k = 0; k < triCount; k++) colRows.set(rows.subarray(k * ROW, k * ROW + COL_ROW), k * COL_ROW);
  const colBuf = buffer(gl.ARRAY_BUFFER, colRows);
  // flat: 3 vertices a row; indexed: each mesh's vertices once.
  const VERT = 16;
  function vertexRecord(out, o, x, y, u, row) {
    out[o] = x; out[o + 1] = y; out[o + 2] = u; out[o + 3] = 0;
    out[o + 4] = rows[row + 6]; out[o + 5] = rows[row + 7]; out[o + 6] = rows[row + 8]; out[o + 7] = rows[row + 9];
    out[o + 8] = rows[row + 10]; out[o + 9] = rows[row + 11]; out[o + 10] = rows[row + 12]; out[o + 11] = rows[row + 17];
    out[o + 12] = rows[row + 13]; out[o + 13] = rows[row + 14]; out[o + 14] = rows[row + 15]; out[o + 15] = rows[row + 16];
  }
  const flat = new Float32Array(triCount * 3 * VERT);
  for (let k = 0; k < triCount; k++) {
    const r = k * ROW;
    for (let c = 0; c < 3; c++) vertexRecord(flat, (k * 3 + c) * VERT, rows[r + c * 2], rows[r + c * 2 + 1], rows[r + 18 + c * 2], r);
  }
  const flatBuf = buffer(gl.ARRAY_BUFFER, flat);
  const iv = new Float32Array(vertCount * VERT);
  const ix = new Uint32Array(triCount * 3);
  {
    let v0 = 0;
    let i0 = 0;
    let k = 0;
    for (const m of meshes) {
      const nv = m.heights.length;
      for (let v = 0; v < nv; v++) vertexRecord(iv, (v0 + v) * VERT, m.xy[v * 2], m.xy[v * 2 + 1], m.heights[v], k * ROW);
      for (let t = 0; t < m.indices.length; t++) ix[i0 + t] = v0 + m.indices[t];
      v0 += nv;
      i0 += m.indices.length;
      k += m.indices.length / 3;
    }
  }
  const ivBuf = buffer(gl.ARRAY_BUFFER, iv);

  function attrib(p, name, buf, size, stride, offset, divisor) {
    const at = gl.getAttribLocation(p, name);
    if (at < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(at, divisor);
  }
  const OFFSETS = { aV0: 0, aV1: 2, aV2: 4, aInstXY: 6, aInstRotCS: 8, aInstTintBits: 10, aInstDepth: 11, aInstTexId: 12, aInstTileInv: 13, aInstTileOff: 15, aInstBody: 17, aUV0: 18, aUV1: 20, aUV2: 22 };
  // The batch's attributes in either form it has shipped in: the row's 14 fields, or the row as 6 vec4 (aRow0..aRow5).
  // A name the program does not have is left unbound.
  const shippedAttribs = (p) => {
    attrib(p, 'aTri', triBuf, 2, 0, 0, 0);
    for (const [name, off] of Object.entries(OFFSETS)) attrib(p, name, rowBuf, TYPES[name] ? 1 : 2, STRIDE, off * 4, 1);
    for (let r = 0; r < 6; r++) attrib(p, `aRow${r}`, rowBuf, 4, STRIDE, r * 16, 1);
  };
  // The collider batch's attributes in either form: its 11 fields, or its 18 floats as 4 vec4 and a vec2 (E-452).
  const colAttribs = (p) => {
    attrib(p, 'aTri', triBuf, 2, 0, 0, 0);
    for (const [name, off] of Object.entries(OFFSETS)) {
      if (off < COL_ROW) attrib(p, name, colBuf, TYPES[name] ? 1 : 2, COL_ROW * 4, off * 4, 1);
    }
    for (let r = 0; r < 5; r++) attrib(p, `aRow${r}`, colBuf, r < 4 ? 4 : 2, COL_ROW * 4, r * 16, 1);
  };
  const WAYS = {
    inst: { vs: () => vert, fs: () => frag, bind: shippedAttribs, draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount) },
    // The batch as another tree (--vs) ships it, timed in the same page as inst.
    instVs: {
      vs: () => {
        if (!vertVs) throw new Error('instVs needs --vs <tree>');
        return vertVs;
      },
      fs: () => fragVs,
      bind: shippedAttribs,
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount),
    },
    instMin: { vs: () => vMin, fs: () => fMin, bind: shippedAttribs, draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount) },
    instVec4: {
      vs: vInstVec4, fs: () => frag,
      bind: (p) => {
        attrib(p, 'aTri', triBuf, 2, 0, 0, 0);
        for (let r = 0; r < 6; r++) attrib(p, `aR${r}`, rowBuf, 4, STRIDE, r * 16, 1);
      },
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount),
    },
    instVec4Id: {
      vs: vInstVec4Id, fs: () => frag,
      bind: (p) => { for (let r = 0; r < 6; r++) attrib(p, `aR${r}`, rowBuf, 4, STRIDE, r * 16, 1); },
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount),
    },
    instVec4Lean: {
      vs: vInstVec4, fs: fLean,
      bind: (p) => {
        attrib(p, 'aTri', triBuf, 2, 0, 0, 0);
        for (let r = 0; r < 6; r++) attrib(p, `aR${r}`, rowBuf, 4, STRIDE, r * 16, 1);
      },
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount),
    },
    inst2: {
      vs: vInst2, fs: () => frag,
      bind: (p) => {
        attrib(p, 'aTri3', tri3Buf, 3, 0, 0, 0);
        for (let r = 0; r < 6; r++) {
          attrib(p, `aA${r}`, rowBuf, 4, STRIDE * 2, r * 16, 1);
          attrib(p, `aB${r}`, rowBuf, 4, STRIDE * 2, STRIDE + r * 16, 1);
        }
      },
      // The odd row's partner is the zero row after the last: a triangle of no area.
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, (triCount + 1) >> 1),
    },
    flat: {
      vs: vVert, fs: () => frag,
      bind: (p) => { for (let r = 0; r < 4; r++) attrib(p, `aP${r}`, flatBuf, 4, VERT * 4, r * 16, 0); },
      draw: () => gl.drawArrays(gl.TRIANGLES, 0, triCount * 3),
    },
    indexed: {
      vs: vVert, fs: () => frag,
      bind: (p) => {
        for (let r = 0; r < 4; r++) attrib(p, `aP${r}`, ivBuf, 4, VERT * 4, r * 16, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer(gl.ELEMENT_ARRAY_BUFFER, ix));
      },
      draw: () => gl.drawElements(gl.TRIANGLES, triCount * 3, gl.UNSIGNED_INT, 0),
    },
    pull: { vs: vPull, fs: () => frag, bind: () => {}, draw: () => gl.drawArrays(gl.TRIANGLES, 0, triCount * 3) },
    col: { vs: () => colVert, fs: () => colFrag, bind: colAttribs, draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount) },
    colVs: {
      vs: () => {
        if (!colVertVs) throw new Error('colVs needs --vs <tree>');
        return colVertVs;
      },
      fs: () => colFragVs,
      bind: colAttribs,
      draw: () => gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, triCount),
    },
  };
  // The picture each way is checked against: the collider batch draws no sun shift.
  const referenceOf = (name) => (name === 'col' || name === 'colVs' ? 'col' : 'inst');

  const built = {};
  const skipped = {};
  for (const name of ways) {
    const way = WAYS[name];
    if (!way) return { error: `unknown way ${name}` };
    let vs;
    let fs;
    try {
      vs = way.vs();
      fs = way.fs();
    } catch (err) {
      // A way written against the 14-attribute shader, on a tree that ships another form.
      skipped[name] = String(err.message || err);
      continue;
    }
    const p = program(vs, fs, name);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    way.bind(p);
    gl.bindVertexArray(null);
    gl.useProgram(p);
    const u = (k) => gl.getUniformLocation(p, k);
    gl.uniformMatrix3fv(u('uProjectionMatrix'), false, uProjection);
    gl.uniformMatrix3fv(u('uWorldTransformMatrix'), false, uWorld);
    gl.uniformMatrix3fv(u('uTransformMatrix'), false, uIdentity);
    gl.uniform4f(u('uColor'), 1, 1, 1, 1);
    gl.uniform4fv(u('uSunShadow'), sun);
    gl.uniform1i(u('uTexture'), 0);
    gl.uniform1i(u('uTexLut'), 1);
    gl.uniform1i(u('uPoseTable'), 2);
    gl.uniform1i(u('uRows'), 3);
    built[name] = { p, vao, draw: way.draw };
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, whiteTex);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, poseTex);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, rowsTex);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.viewport(0, 0, width, height);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  const pending = [];
  const free = [];
  const results = new Map();
  function collect() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i];
      if (!gl.getQueryParameter(q.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(q.q, gl.QUERY_RESULT);
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT) && q.key) {
        const list = results.get(q.key) || [];
        list.push(ns / 1e6);
        results.set(q.key, list);
      }
      pending.splice(i, 1);
      free.push(q.q);
    }
  }
  async function settle() {
    for (let t = 0; t < 400 && pending.length; t++) {
      await new Promise((r) => setTimeout(r, 5));
      collect();
    }
  }
  function drawWay(name, key, small) {
    const b = built[name];
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (small) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 1, 1);
    }
    gl.useProgram(b.p);
    gl.bindVertexArray(b.vao);
    const q = free.pop() || gl.createQuery();
    gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    b.draw();
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    pending.push({ q, key });
    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  // The picture each way leaves, against its reference's (referenceOf): the target read back after one full draw.
  const pixels = new Uint8Array(width * height * 4);
  function picture(name) {
    drawWay(name, null, false);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels.slice();
  }
  const live = ways.filter((name) => built[name]);
  const references = {};
  for (const name of ['inst', 'col']) if (built[name]) references[name] = picture(name);
  const parity = {};
  for (const name of live) {
    const reference = references[referenceOf(name)];
    if (name === 'inst' || name === 'instMin' || name === 'col' || !reference) continue;
    const got = picture(name);
    let differ = 0;
    let maxDelta = 0;
    for (let i = 0; i < got.length; i++) {
      const d = Math.abs(got[i] - reference[i]);
      if (d) {
        differ++;
        if (d > maxDelta) maxDelta = d;
      }
    }
    parity[name] = { bytesDiffering: differ, maxDelta };
  }
  let covered = 0;
  const shown = references.inst || references.col || null;
  if (shown) for (let i = 3; i < shown.length; i += 4) if (shown[i]) covered++;

  // Warm the GPU's clocks with a second of drawing, then rounds of each way, interleaved.
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    for (const name of live) drawWay(name, null, false);
    gl.flush();
    await new Promise((r) => setTimeout(r, 0));
    collect();
  }
  await settle();
  results.clear();
  for (let r = 0; r < rounds; r++) {
    for (const name of live) {
      for (const small of scissor ? [false, true] : [false]) {
        const key = `${name}${small ? ' scissor' : ''}`;
        for (let d = 0; d < draws; d++) drawWay(name, key, small);
        gl.flush();
        await new Promise((res) => setTimeout(res, 0));
        collect();
      }
    }
    await settle();
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const out = [];
  for (const [key, list] of results) {
    out.push({ key, draws: list.length, medianMs: median(list), minMs: Math.min(...list) });
  }
  return { renderer, houses: meshes.length, triangles: triCount, vertices: vertCount, covered, width, height, zoom, parity, skipped, results: out };
}

export async function runMeshFillGpuBench(opts) {
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    return await page.evaluate(benchInPage, {
      vert: readShader(opts.root, 'meshUvFill.vert.glsl'),
      frag: readShader(opts.root, 'meshUvFill.frag.glsl'),
      vertVs: opts.vs ? readShader(opts.vs, 'meshUvFill.vert.glsl') : null,
      fragVs: opts.vs ? readShader(opts.vs, 'meshUvFill.frag.glsl') : null,
      colVert: readShader(opts.root, 'colliderFill.vert.glsl'),
      colFrag: readShader(opts.root, 'colliderFill.frag.glsl'),
      colVertVs: opts.vs ? readShader(opts.vs, 'colliderFill.vert.glsl') : null,
      colFragVs: opts.vs ? readShader(opts.vs, 'colliderFill.frag.glsl') : null,
      n: opts.n,
      zoom: opts.zoom,
      ways: opts.ways,
      scissor: opts.scissor,
      draws: opts.draws,
      rounds: opts.rounds,
      width: opts.width,
      height: opts.height,
    });
  } finally {
    await browser.close();
  }
}

/** The GPU's clock while `fn` runs (nvidia-smi, where there is one): the readings in MHz. */
async function withGpuClock(fn) {
  const clocks = [];
  let smi = null;
  try {
    smi = spawn('nvidia-smi', ['--query-gpu=clocks.gr,utilization.gpu', '--format=csv,noheader,nounits', '-lms', '200'], { stdio: ['ignore', 'pipe', 'ignore'] });
    smi.on('error', () => {});
    smi.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const [mhz, busy] = line.split(',').map((s) => Number(s.trim()));
        if (Number.isFinite(mhz)) clocks.push({ mhz, busy });
      }
    });
  } catch {
    smi = null;
  }
  try {
    return { result: await fn(), clocks };
  } finally {
    if (smi) smi.kill();
  }
}

async function main() {
  const args = parseArgs();
  const opts = {
    n: Number(args.n ?? 20000),
    zoom: Number(args.zoom ?? 0.5),
    ways: String(args.ways ?? 'inst,instMin,instVec4,instVec4Id,instVec4Lean,inst2,flat,indexed,pull,col').split(',').filter(Boolean),
    scissor: !!args.scissor,
    draws: Number(args.draws ?? 40),
    rounds: Number(args.rounds ?? 3),
    width: Number(args.width ?? 1920),
    height: Number(args.height ?? 1080),
    root: typeof args.root === 'string' ? path.resolve(args.root) : repoRoot,
    vs: typeof args.vs === 'string' ? path.resolve(args.vs) : null,
  };
  const { result: r, clocks } = await withGpuClock(() => runMeshFillGpuBench(opts));
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  const busy = clocks.filter((c) => c.busy > 50);
  const mhz = busy.length ? Math.round(busy.reduce((s, c) => s + c.mhz, 0) / busy.length) : null;
  console.log(`${r.renderer}; ${r.houses} houses, ${r.triangles} triangles (${r.vertices} mesh vertices), ${r.width} x ${r.height} at zoom ${r.zoom}, ` +
    `${r.covered} px covered; GPU clock while busy: ${mhz ?? '?'} MHz`);
  for (const row of r.results) {
    console.log(`  ${row.medianMs.toFixed(3).padStart(7)} ms (min ${row.minMs.toFixed(3)}, ${row.draws} draws)  ${row.key}`);
  }
  for (const [name, why] of Object.entries(r.skipped || {})) console.log(`  skipped ${name}: ${why.split('\n')[0]}`);
  for (const [name, p] of Object.entries(r.parity)) {
    const ref = name === 'colVs' ? 'col' : 'inst';
    console.log(`  parity ${name}: ${p.bytesDiffering} bytes differ from ${ref} (max ${p.maxDelta})`);
  }
  if (args.output) fs.writeFileSync(String(args.output), JSON.stringify({ opts, ...r, clocks }, null, 1));
}

if (isCli(import.meta.url)) await main();
