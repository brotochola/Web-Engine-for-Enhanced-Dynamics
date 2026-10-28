/**
 * Kernel (E-157): GPU particles on WebGL fell behind WebGPU past a few hundred thousand (GPU Galaxy, GTX 1650,
 * ANGLE D3D11: 1 048 576 particles at 15–44 fps with the renderer's CPU step at 0.9 ms). This draws N instanced
 * quads from one buffer of 112-byte records (seven vec4 attributes, the engine's layout) and changes only how
 * the frame's new records reach that buffer:
 *
 *   static     no upload: the draw alone
 *   ranged     bufferSubData of the frame's `fresh` records at a moving offset into the drawn buffer (the engine)
 *   staging    the same records into a small buffer, then copyBufferSubData into the drawn one
 *   twoRanges  ranged, drawn as two calls with the attributes re-pointed (a live window across the ring end,
 *              without base-instance)
 *   whole      the whole buffer every frame (a ceiling for "ANGLE copies all of it")
 *
 * Browser module: run it headed (a real GPU, a visible window), modes alternating in rounds:
 *   node tests/bench/chromeKernel.mjs --headed --module /tests/bench/webglParticleUploadKernel.mjs \
 *     --args '{"n":1048576,"fresh":3500,"seconds":4,"rounds":3}'
 * Knobs that change the draw itself (for every mode): `attrs` (1-7, the vec4 attributes the shader reads; the
 * record stays 112 bytes), `strip` (drawArraysInstanced, a 4-vertex strip, instead of 6 indices), `size`
 * (a multiplier on the quads' size, for the fill), `blend` (false: no blending) and `layout`: 'attributes' (the
 * engine's: seven instanced vec4 attributes into one 112-byte-stride buffer) or 'texture' (the records in an
 * RGBA32F texture, seven texels each, read with texelFetch by gl_InstanceID; static and ranged modes only).
 * Reports per mode the frames presented per second (requestAnimationFrame, vsync caps it at the display rate)
 * and the median of frames timed through a 1-pixel readPixels (CPU and GPU, synchronous).
 */

const RECORD_FLOATS = 28;
const RECORD_BYTES = RECORD_FLOATS * 4;
const ATTRS = ['aMove', 'aHeight', 'aTime', 'aScale', 'aColor', 'aSpin', 'aFrames'];

// What an attribute the shader does not read holds: values that draw a small live quad.
const FIXED = [
  'vec4(640.0, 360.0, 0.0, 0.0)', 'vec4(0.0)', 'vec4(0.0, 5000.0, 0.0, 0.0)', 'vec4(1.0, 2.0, 1.0, 2.0)',
  'vec4(1.0, 0.0, 0.0, 0.0)', 'vec4(0.0)', 'vec4(0.0)',
];
/** Particles per texture row in the texture layout: 7 × 585 = 4095 texels. */
const PER_ROW = 585;

const declarations = (attrs, layout) =>
  layout === 'texture'
    ? 'uniform highp sampler2D uRecords;'
    : ATTRS.map((a, k) => (k < attrs ? `in vec4 ${a};` : `const vec4 ${a} = ${FIXED[k]};`)).join('\n');
const fetches = (layout) =>
  layout === 'texture'
    ? `  ivec2 base = ivec2((gl_InstanceID % ${PER_ROW}) * 7, gl_InstanceID / ${PER_ROW});\n` +
      ATTRS.map((a, k) => `  vec4 ${a} = texelFetch(uRecords, base + ivec2(${k}, 0), 0);`).join('\n')
    : '';

const vertexShader = (attrs, layout) => `#version 300 es
in vec2 aQuad;
${declarations(attrs, layout)}
uniform float uNow;
uniform vec2 uView;
uniform float uSize;
out vec4 vColor;
void main() {
${fetches(layout)}
  float age = uNow - aTime.x;
  float t = clamp(age / max(aTime.y, 1.0), 0.0, 1.0);
  vec2 p = aMove.xy + aMove.zw * age * 0.06 + vec2(0.0, aHeight.z * age * age * 1e-5);
  float s = (mix(aScale.x, aScale.y, t) + aSpin.x * 0.0 + aFrames.x * 0.0) * uSize;
  float a = mix(aColor.x, aColor.y, t) * step(age, aTime.y) * step(0.0, age) + 0.05;
  gl_Position = vec4((p + aQuad * s) / uView * 2.0 - 1.0, 0.0, 1.0);
  vColor = vec4(1.0, 0.8, 0.5, a);
}`;
const FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor.rgb * vColor.a, vColor.a); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

/** One record, as the engine writes it at spawn: a position, a velocity, a birth and a life. */
function writeRecord(f, i, now, rand, w, h) {
  const o = i * RECORD_FLOATS;
  f[o] = rand() * w;
  f[o + 1] = rand() * h;
  f[o + 2] = (rand() - 0.5) * 2;
  f[o + 3] = (rand() - 0.5) * 2;
  f[o + 6] = 0.5;
  f[o + 8] = now;
  f[o + 9] = 5000;
  f[o + 12] = 1;
  f[o + 13] = 2;
  f[o + 16] = 1;
  f[o + 17] = 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export async function run({
  n = 1048576, fresh = 3500, seconds = 4, rounds = 3, modes, width = 1280, height = 720,
  attrs = 7, strip = false, size = 1, blend = true, layout = 'attributes',
} = {}) {
  const list = modes || ['static', 'ranged', 'staging', 'twoRanges', 'whole'];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#000';
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('no WebGL2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertexShader(attrs, layout)));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const uNow = gl.getUniformLocation(prog, 'uNow');
  gl.uniform2f(gl.getUniformLocation(prog, 'uView'), width, height);
  gl.uniform1f(gl.getUniformLocation(prog, 'uSize'), size);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  // Indexed: the corners in order around the quad. Strip: the order a 4-vertex triangle strip needs.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(strip ? [-1, -1, 1, -1, -1, 1, 1, 1] : [-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  const qLoc = gl.getAttribLocation(prog, 'aQuad');
  gl.enableVertexAttribArray(qLoc);
  gl.vertexAttribPointer(qLoc, 2, gl.FLOAT, false, 8, 0);
  const index = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

  // The texture layout needs whole rows of PER_ROW particles: the array is padded to them.
  const texRows = Math.ceil(n / PER_ROW);
  const records = new Float32Array(layout === 'texture' ? texRows * PER_ROW * RECORD_FLOATS : n * RECORD_FLOATS);
  const rand = rng(0x157);
  for (let i = 0; i < n; i++) writeRecord(records, i, -rand() * 5000, rand, width, height);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, records, gl.DYNAMIC_DRAW);
  const locs = ATTRS.map((name) => gl.getAttribLocation(prog, name));
  const point = (firstInstance) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    locs.forEach((loc, k) => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, RECORD_BYTES, firstInstance * RECORD_BYTES + k * 16);
      gl.vertexAttribDivisor(loc, 1);
    });
  };
  if (layout === 'texture') {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, PER_ROW * 7, texRows);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PER_ROW * 7, texRows, gl.RGBA, gl.FLOAT, records);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(prog, 'uRecords'), 0);
  } else {
    point(0);
  }
  const staging = gl.createBuffer();
  gl.bindBuffer(gl.COPY_READ_BUFFER, staging);
  gl.bufferData(gl.COPY_READ_BUFFER, fresh * RECORD_BYTES, gl.STREAM_DRAW);

  if (blend) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }
  gl.viewport(0, 0, width, height);
  const pixel = new Uint8Array(4);
  let cursor = 0;
  const t0 = performance.now();

  const draw = (count) => {
    if (strip) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    else gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
  };

  const step = (mode) => {
    const now = performance.now() - t0;
    if (mode !== 'static') {
      const from = cursor;
      const head = Math.min(fresh, n - from);
      for (let i = 0; i < head; i++) writeRecord(records, from + i, now, rand, width, height);
      if (layout === 'texture') {
        // The rows the new records touch.
        const y0 = (from / PER_ROW) | 0;
        const y1 = ((from + head - 1) / PER_ROW) | 0;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, PER_ROW * 7, y1 - y0 + 1, gl.RGBA, gl.FLOAT, records, y0 * PER_ROW * RECORD_FLOATS);
      } else if (mode === 'staging') {
        gl.bindBuffer(gl.COPY_READ_BUFFER, staging);
        gl.bufferSubData(gl.COPY_READ_BUFFER, 0, records, from * RECORD_FLOATS, head * RECORD_FLOATS);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, buf);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, from * RECORD_BYTES, head * RECORD_BYTES);
      } else if (mode === 'whole') {
        // The same new records, sent as the whole buffer.
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, records);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, from * RECORD_BYTES, records, from * RECORD_FLOATS, head * RECORD_FLOATS);
      }
      cursor = (from + head) % n;
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uNow, now);
    if (mode === 'twoRanges') {
      // The live window starts at the cursor and wraps: two draws, the attributes re-pointed for each.
      point(cursor);
      draw(n - cursor);
      point(0);
      if (cursor > 0) draw(cursor);
    } else {
      draw(n);
    }
  };

  const results = {};
  for (const m of list) results[m] = { fps: [], syncMs: [] };
  for (let r = 0; r < rounds; r++) {
    for (const mode of list) {
      // Settle: a second of this mode before counting.
      const settle = performance.now() + 1000;
      while (performance.now() < settle) {
        step(mode);
        await frame();
      }
      let frames = 0;
      const start = performance.now();
      const end = start + seconds * 1000;
      while (performance.now() < end) {
        step(mode);
        await frame();
        frames++;
      }
      results[mode].fps.push((frames * 1000) / (performance.now() - start));
      const times = [];
      for (let k = 0; k < 30; k++) {
        const a = performance.now();
        step(mode);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        times.push(performance.now() - a);
        await frame();
      }
      times.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      results[mode].syncMs.push(times[times.length >> 1]);
    }
  }
  const median = (a) => {
    const s = a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return s[s.length >> 1];
  };
  const summary = {};
  for (const m of list) summary[m] = { fps: median(results[m].fps), syncMs: median(results[m].syncMs), rounds: results[m] };
  // That the draw drew: the GL error after one more frame, and how many of 64 pixels across the middle row are lit.
  step(list[0]);
  const error = gl.getError();
  const row = new Uint8Array(width * 4);
  gl.readPixels(0, height >> 1, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
  let lit = 0;
  for (let k = 0; k < 64; k++) if (row[((k * width) >> 6) * 4] > 0) lit++;
  return { renderer, n, fresh, seconds, rounds, attrs, strip, size, blend, layout, glError: error, litOf64: lit, summary };
}
