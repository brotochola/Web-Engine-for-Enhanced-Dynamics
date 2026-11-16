/**
 * The GPU pass bench's WebGL 2 side: a pass compiled as Pixi's GlProgram would compile it (pixiGlslPair), its attributes,
 * uniforms and samplers found by reflection and fed by name (anything the pass does not name gets zeros, an identity
 * matrix or a 1 x 1 black texture), drawn into its own targets. No Pixi: only the measured pass runs.
 *
 * Timing: a wait for the GPU around K draws (plan §9.3). The clock includes issuing the draws, so a pass far cheaper than
 * a draw call reads as the call's cost: the page reports the empty round trip next to it. The wait is a 1 x 1 read back
 * of the pass's target, not gl.finish(): Chrome's WebGL finish() is a flush and does not wait, so each sample timed how
 * fast the queue took draws, and a pass timed after another read as the one before it while that one's backlog drained
 * (2026-11-15: selfShadow after light3d 1.19 ms, alone 3.27; the empty round trip read 0.000 ms).
 */

/**
 * The sources Pixi's GlProgram hands to WebGL, from the ones the engine gives it: the vendored Pixi's preprocessors
 * (stripVersion, ensurePrecision, addProgramDefines, setProgramName, insertVersion), in its order, with its default
 * precisions (vertex highp, fragment mediump, which a shader's own `precision highp float;` overrides).
 */
export function pixiGlslPair(vertex, fragment, name = 'gpu-pass-bench') {
  const es300 = fragment.indexOf('#version 300 es') !== -1;
  const run = (source, isFragment) => {
    let s = source;
    if (es300) s = s.replace('#version 300 es', '');
    if (s.substring(0, 9) !== 'precision') s = `precision ${isFragment ? 'mediump' : 'highp'} float;\n${s}`;
    if (!es300) {
      if (isFragment) {
        s = s.replace('out vec4 finalColor;', '');
        s = `\n#ifdef GL_ES\n#define in varying\n#define finalColor gl_FragColor\n#define texture texture2D\n#endif\n${s}\n`;
      } else {
        s = `\n#ifdef GL_ES\n#define in attribute\n#define out varying\n#endif\n${s}\n`;
      }
    }
    if (s.indexOf('#define SHADER_NAME') === -1) s = `#define SHADER_NAME ${name.replace(/\s+/g, '-')}-${isFragment ? 'fragment' : 'vertex'}\n${s}`;
    if (es300) s = `#version 300 es\n${s}`;
    return s;
  };
  return { vertex: run(vertex, false), fragment: run(fragment, true) };
}

const FORMATS = {
  rgba8: { internal: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE', float: false },
  r8: { internal: 'R8', format: 'RED', type: 'UNSIGNED_BYTE', float: false },
  r16f: { internal: 'R16F', format: 'RED', type: 'HALF_FLOAT', float: true },
  rgba16f: { internal: 'RGBA16F', format: 'RGBA', type: 'HALF_FLOAT', float: true },
  r32f: { internal: 'R32F', format: 'RED', type: 'FLOAT', float: true, wide: true },
  rgba32f: { internal: 'RGBA32F', format: 'RGBA', type: 'FLOAT', float: true, wide: true },
  // E-205: the light tiles' words (read with texelFetch, never filtered or drawn into).
  r32ui: { internal: 'R32UI', format: 'RED_INTEGER', type: 'UNSIGNED_INT', float: false, wide: true },
};

const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function compile(gl, type, source, what) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${what} does not compile: ${log}`);
  }
  return shader;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {object} the backend (see page.js for how it is driven)
 */
export function createGlBackend(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('no WebGL 2 context');
  const ext = {
    colorBufferFloat: gl.getExtension('EXT_color_buffer_float'),
    floatBlend: gl.getExtension('EXT_float_blend'),
    drawBuffersIndexed: gl.getExtension('OES_draw_buffers_indexed'),
    debugInfo: gl.getExtension('WEBGL_debug_renderer_info'),
  };
  const textures = new Map();
  const framebuffers = new Map();
  const handles = [];
  // The empty round trip's read back (timeEmpty): a pixel no pass draws.
  const syncTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, syncTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const syncFb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, syncFb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, syncTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const pixel8 = new Uint8Array(4);
  const pixelF = new Float32Array(4);

  const black = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, black);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const info = {
    backend: 'webgl',
    renderer: ext.debugInfo ? gl.getParameter(ext.debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: ext.debugInfo ? gl.getParameter(ext.debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION),
    extensions: Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, Boolean(v)])),
  };

  /** Whether a target of `format` can be drawn into, and blended (max needs blending). */
  function supports(format, blended) {
    const f = FORMATS[format];
    if (!f) return `unknown format ${format}`;
    if (f.float && !ext.colorBufferFloat) return `${format} targets need EXT_color_buffer_float`;
    if (f.wide && blended && !ext.floatBlend) return `${format} blending needs EXT_float_blend`;
    return null;
  }

  /**
   * A texture by key: { kind: 'bitmap' | 'data' | 'target' | 'depth', width, height, format, data, bitmap, filter,
   * premultiply }.
   */
  function createTexture(key, desc) {
    if (desc.kind === 'depth') {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, desc.bits === 16 ? gl.DEPTH_COMPONENT16 : gl.DEPTH_COMPONENT24, desc.width, desc.height);
      textures.set(key, { depth: rb, width: desc.width, height: desc.height, format: 'depth' });
      return;
    }
    const format = desc.format || 'rgba8';
    const f = FORMATS[format];
    if (!f) throw new Error(`unknown texture format ${format}`);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (desc.kind === 'bitmap') {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, Boolean(desc.premultiply));
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, desc.bitmap);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    } else {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl[f.internal], desc.width, desc.height, 0, gl[f.format], gl[f.type], desc.kind === 'data' ? desc.data : null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
    const filter = desc.filter === 'linear' && !f.wide ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const width = desc.kind === 'bitmap' ? desc.bitmap.width : desc.width;
    const height = desc.kind === 'bitmap' ? desc.bitmap.height : desc.height;
    textures.set(key, { tex, width, height, format });
  }

  function framebufferFor(targets, depthKey) {
    const key = `${targets.join('+')}#${depthKey || ''}`;
    let fb = framebuffers.get(key);
    if (fb) return fb;
    fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    targets.forEach((t, i) => {
      const entry = textures.get(t);
      if (!entry || !entry.tex) throw new Error(`no target ${t}`);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, entry.tex, 0);
    });
    if (depthKey) {
      const d = textures.get(depthKey);
      if (!d || !d.depth) throw new Error(`no depth target ${depthKey}`);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d.depth);
    }
    // Draw buffers are the framebuffer's own state: set once.
    gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`targets ${targets.join(', ')} are not complete (0x${status.toString(16)})`);
    framebuffers.set(key, fb);
    return fb;
  }

  function setBlend(mode, index = -1) {
    const ie = ext.drawBuffersIndexed;
    if (index >= 0 && ie) {
      if (mode === 'none') {
        ie.disableiOES(gl.BLEND, index);
        return;
      }
      ie.enableiOES(gl.BLEND, index);
      if (mode === 'max') {
        ie.blendEquationiOES(index, gl.MAX);
        ie.blendFunciOES(index, gl.ONE, gl.ONE);
      } else if (mode === 'add') {
        ie.blendEquationiOES(index, gl.FUNC_ADD);
        ie.blendFunciOES(index, gl.ONE, gl.ONE);
      } else if (mode === 'multiply') {
        ie.blendEquationiOES(index, gl.FUNC_ADD);
        ie.blendFuncSeparateiOES(index, gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        ie.blendEquationiOES(index, gl.FUNC_ADD);
        ie.blendFunciOES(index, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      return;
    }
    if (mode === 'none') {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    if (mode === 'max') {
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (mode === 'add') {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else if (mode === 'multiply') {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      // 'premultiplied': Pixi's normal blending on premultiplied colour.
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  const SAMPLERS = new Set([gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY, gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D]);
  const COMPONENTS = new Map([[gl.FLOAT, 1], [gl.FLOAT_VEC2, 2], [gl.FLOAT_VEC3, 3], [gl.FLOAT_VEC4, 4]]);

  function setUniform(loc, type, size, v) {
    const arr = (n) => {
      const out = new Float32Array(n * size);
      if (typeof v === 'number') out[0] = v;
      else if (v) for (let i = 0; i < out.length && i < v.length; i++) out[i] = v[i];
      return out;
    };
    switch (type) {
      case gl.FLOAT: gl.uniform1fv(loc, arr(1)); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, arr(2)); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr(3)); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, arr(4)); break;
      case gl.INT:
      case gl.BOOL: gl.uniform1iv(loc, Int32Array.from(arr(1), (x) => x | 0)); break;
      case gl.INT_VEC2: gl.uniform2iv(loc, Int32Array.from(arr(2), (x) => x | 0)); break;
      case gl.INT_VEC4: gl.uniform4iv(loc, Int32Array.from(arr(4), (x) => x | 0)); break;
      case gl.UNSIGNED_INT: gl.uniform1uiv(loc, Uint32Array.from(arr(1), (x) => x >>> 0)); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, v ? arr(9) : IDENTITY3); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, v ? arr(16) : IDENTITY4); break;
      default: break;
    }
  }

  /**
   * Compiles and sets up a pass (page.js's pass spec): its program, a vertex array with its per-vertex stream and one
   * interleaved instance stream holding every other attribute, its uniforms (set once: nothing changes between draws)
   * and samplers, its framebuffer.
   */
  function createPass(spec) {
    const { vertex, fragment } = pixiGlslPair(spec.glsl.vertex, spec.glsl.fragment, spec.name);
    const program = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vertex, `${spec.name}'s vertex shader`);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragment, `${spec.name}'s fragment shader`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${spec.name} does not link: ${gl.getProgramInfoLog(program)}`);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    const perVertex = spec.vertex;
    const instanceCount = spec.instances ? spec.instances.count : 1;
    const attributes = [];
    const n = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < n; i++) {
      const a = gl.getActiveAttrib(program, i);
      if (!a || a.name.startsWith('gl_')) continue;
      const comps = COMPONENTS.get(a.type);
      if (!comps) throw new Error(`${spec.name}: attribute ${a.name} has a type the bench does not feed`);
      attributes.push({ name: a.name, comps, loc: gl.getAttribLocation(program, a.name) });
    }
    const vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, perVertex.data, gl.STATIC_DRAW);
    buffers.push(vbuf);
    const others = [];
    for (const a of attributes) {
      if (a.name === perVertex.name) {
        gl.enableVertexAttribArray(a.loc);
        gl.vertexAttribPointer(a.loc, perVertex.size, gl.FLOAT, false, perVertex.size * 4, 0);
        gl.vertexAttribDivisor(a.loc, 0);
      } else {
        others.push(a);
      }
    }
    if (others.length > 0) {
      const stride = others.reduce((s, a) => s + a.comps, 0);
      const data = new Float32Array(stride * instanceCount);
      // Copied as bits: a float that carries a uint (aInstTintBits) is a NaN for most tints.
      const bits = new Uint32Array(data.buffer);
      let offset = 0;
      for (const a of others) {
        const src = spec.instances?.attributes?.[a.name];
        if (src) {
          const have = Math.max(1, Math.round(src.length / instanceCount));
          const from = new Uint32Array(src.buffer, src.byteOffset, src.length);
          for (let i = 0; i < instanceCount; i++) {
            for (let c = 0; c < a.comps && c < have; c++) bits[i * stride + offset + c] = from[i * have + c];
          }
        }
        a.offset = offset;
        offset += a.comps;
      }
      const ibuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      buffers.push(ibuf);
      for (const a of others) {
        gl.enableVertexAttribArray(a.loc);
        gl.vertexAttribPointer(a.loc, a.comps, gl.FLOAT, false, stride * 4, a.offset * 4);
        gl.vertexAttribDivisor(a.loc, 1);
      }
    }
    let indexCount = 0;
    if (perVertex.indices) {
      const ebuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, perVertex.indices, gl.STATIC_DRAW);
      buffers.push(ebuf);
      indexCount = perVertex.indices.length;
    }
    gl.bindVertexArray(null);

    gl.useProgram(program);
    const units = [];
    const unknown = [];
    const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nu; i++) {
      const u = gl.getActiveUniform(program, i);
      if (!u) continue;
      const name = u.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(program, u.name);
      if (SAMPLERS.has(u.type)) {
        const key = spec.textures?.[name];
        const entry = key ? textures.get(key) : null;
        if (key && !entry) throw new Error(`${spec.name}: no texture ${key} for ${name}`);
        if (!key) unknown.push(name);
        gl.uniform1i(loc, units.length);
        units.push(entry ? entry.tex : black);
      } else {
        const v = spec.uniforms?.[name];
        if (v === undefined) unknown.push(name);
        setUniform(loc, u.type, u.size, v);
      }
    }
    gl.useProgram(null);

    const targets = spec.targets;
    for (const t of targets) {
      const why = supports(textures.get(t)?.format || 'rgba8', (spec.blend || []).some((b) => b !== 'none'));
      if (why) throw new Error(`${spec.name}: ${why}`);
    }
    const fb = framebufferFor(targets, spec.depthTarget);
    const first = textures.get(targets[0]);
    const handle = {
      spec,
      program,
      vao,
      buffers,
      units,
      fb,
      width: first.width,
      height: first.height,
      indexCount,
      vertexCount: perVertex.count,
      instanceCount,
      blend: spec.blend || ['none'],
      clear: spec.clear || null,
      depth: Boolean(spec.depthTarget),
      unknown,
      sharedBlend: targets.length > 1 && !ext.drawBuffersIndexed,
    };
    handles.push(handle);
    return handle;
  }

  /** Issues one execution of the pass. */
  function draw(h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, h.fb);
    gl.viewport(0, 0, h.width, h.height);
    if (h.blend.length > 1 && ext.drawBuffersIndexed) h.blend.forEach((mode, i) => setBlend(mode, i));
    else setBlend(h.blend[0]);
    if (h.depth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
    } else {
      gl.disable(gl.DEPTH_TEST);
    }
    if (h.clear) {
      gl.clearColor(h.clear[0], h.clear[1], h.clear[2], h.clear[3]);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | (h.depth ? gl.DEPTH_BUFFER_BIT : 0));
    }
    gl.useProgram(h.program);
    for (let u = 0; u < h.units.length; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, h.units[u]);
    }
    gl.bindVertexArray(h.vao);
    if (h.indexCount > 0) gl.drawElementsInstanced(gl.TRIANGLES, h.indexCount, gl.UNSIGNED_SHORT, 0, h.instanceCount);
    else gl.drawArraysInstanced(gl.TRIANGLES, 0, h.vertexCount, h.instanceCount);
    gl.bindVertexArray(null);
  }

  /**
   * Waits until the GPU has run everything queued: one pixel of a target read back (of the pass's own first target, which
   * its draws wrote; the queue runs in order). Float targets are read as floats (EXT_color_buffer_float drew them).
   */
  function waitGpu(h) {
    const target = h ? textures.get(h.spec.targets[0]) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, h ? h.fb : syncFb);
    if (target && FORMATS[target.format]?.float) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixelF);
    else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** ms for K executions between two waits for the GPU. */
  async function timeK(h, k) {
    waitGpu(h);
    const t0 = performance.now();
    for (let i = 0; i < k; i++) draw(h);
    waitGpu(h);
    return performance.now() - t0;
  }

  /** ms for the clock's round trip alone (two waits). */
  async function timeEmpty() {
    waitGpu(null);
    const t0 = performance.now();
    waitGpu(null);
    return performance.now() - t0;
  }

  /** One presented frame with the pass drawn n times (the capacity search: no finish, the frame rate tells). */
  function frame(h, n) {
    for (let i = 0; i < n; i++) draw(h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.08, 0.08, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** A target's pixels (RGBA8 targets only), for a sanity look at what a pass drew. */
  function readTarget(key) {
    const t = textures.get(key);
    if (!t || t.format !== 'rgba8') return null;
    const fb = framebufferFor([key], null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const out = new Uint8Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: t.width, height: t.height, data: out };
  }

  function destroy() {
    for (const h of handles) {
      gl.deleteProgram(h.program);
      gl.deleteVertexArray(h.vao);
      for (const b of h.buffers) gl.deleteBuffer(b);
    }
    for (const fb of framebuffers.values()) gl.deleteFramebuffer(fb);
    gl.deleteFramebuffer(syncFb);
    gl.deleteTexture(syncTex);
    for (const t of textures.values()) {
      if (t.tex) gl.deleteTexture(t.tex);
      if (t.depth) gl.deleteRenderbuffer(t.depth);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { kind: 'webgl', info, supports, createTexture, createPass, draw, timeK, timeEmpty, frame, readTarget, destroy };
}
