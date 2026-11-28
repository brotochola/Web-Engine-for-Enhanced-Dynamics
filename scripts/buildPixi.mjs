import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const stubDir = path.join(root, 'scripts', 'pixi-stubs');

function stubPixiBackends() {
  return {
    name: 'stub-pixi-backends',
    setup(build) {
      build.onResolve({ filter: /\/CanvasRenderer\.mjs$/ }, () => {
        return { path: path.join(stubDir, 'canvasRenderer.mjs') };
      });
    },
  };
}

/** Replace `from` in `src` once; the build fails when Pixi no longer has it (an upgrade moved the code). */
function replaceOnce(src, from, to, file) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + from.length) >= 0) {
    throw new Error(`buildPixi: the patch anchor is not in ${file} exactly once: ${JSON.stringify(from)}`);
  }
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** An onLoad that applies `patch(src, file)` to the Pixi module matching `filter`. */
function patchModule(build, filter, patch) {
  build.onLoad({ filter }, async (args) => {
    const src = patch(await fs.readFile(args.path, 'utf8'), args.path);
    return { contents: src, loader: 'js', resolveDir: path.dirname(args.path) };
  });
}

/**
 * Pixi's per-pass paths without garbage: renderer.render, which the engine calls once per RT pass. A top-level bind of
 * the global uniforms made a Matrix, a Point and two objects, the bind stack an object per entry, startRenderPass a
 * closure, Color.toArray and the GC tick's loop an array iterator. The objects stay, one per stack depth. A Matrix's
 * fields are tagged, so each double written to one is a heap number: the uniforms' matrix and the projection are written
 * field by field, only where they change.
 */
function patchPixiPassGarbage() {
  return {
    name: 'patch-pixi-pass-garbage',
    setup(build) {
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]shared[\\/]renderTarget[\\/]GlobalUniformSystem\.mjs$/, (src, file) => {
        src = replaceOnce(
          src,
          '    this._renderer = renderer;\n  }\n  reset() {\n',
          '    this._renderer = renderer;\n' +
            '    this._weedRoot = { worldTransformMatrix: new Matrix(), worldColor: 4294967295, offset: new Point() };\n' +
            '    this._weedData = [];\n' +
            '  }\n  reset() {\n',
          file,
        );
        src = replaceOnce(
          src,
          `    uniforms.uWorldTransformMatrix.copyFrom(globalUniformData.worldTransformMatrix);
    uniforms.uWorldTransformMatrix.tx -= globalUniformData.offset.x;
    uniforms.uWorldTransformMatrix.ty -= globalUniformData.offset.y;
`,
          `    const weedTo = uniforms.uWorldTransformMatrix;
    const weedFrom = globalUniformData.worldTransformMatrix;
    const weedTx = weedFrom.tx - globalUniformData.offset.x;
    const weedTy = weedFrom.ty - globalUniformData.offset.y;
    if (weedTo.a !== weedFrom.a) weedTo.a = weedFrom.a;
    if (weedTo.b !== weedFrom.b) weedTo.b = weedFrom.b;
    if (weedTo.c !== weedFrom.c) weedTo.c = weedFrom.c;
    if (weedTo.d !== weedFrom.d) weedTo.d = weedFrom.d;
    if (weedTo.tx !== weedTx) weedTo.tx = weedTx;
    if (weedTo.ty !== weedTy) weedTo.ty = weedTy;
`,
          file,
        );
        return replaceOnce(
          src,
          `    const currentGlobalUniformData = this._stackIndex ? this._globalUniformDataStack[this._stackIndex - 1] : {
      projectionData: renderTarget,
      worldTransformMatrix: new Matrix(),
      worldColor: 4294967295,
      offset: new Point()
    };
    const globalUniformData = {
      projectionMatrix: projectionMatrix || this._renderer.renderTarget.projectionMatrix,
      resolution: size || renderTarget.size,
      worldTransformMatrix: worldTransformMatrix || currentGlobalUniformData.worldTransformMatrix,
      worldColor: worldColor || currentGlobalUniformData.worldColor,
      offset: offset || currentGlobalUniformData.offset,
      bindGroup: null
    };
`,
          `    const currentGlobalUniformData = this._stackIndex ? this._globalUniformDataStack[this._stackIndex - 1] : this._weedRoot;
    const depth = this._stackIndex;
    const globalUniformData = this._weedData[depth] || (this._weedData[depth] = {
      projectionMatrix: null,
      resolution: null,
      worldTransformMatrix: null,
      worldColor: 0,
      offset: null,
      bindGroup: null
    });
    globalUniformData.projectionMatrix = projectionMatrix || this._renderer.renderTarget.projectionMatrix;
    globalUniformData.resolution = size || renderTarget.size;
    globalUniformData.worldTransformMatrix = worldTransformMatrix || currentGlobalUniformData.worldTransformMatrix;
    globalUniformData.worldColor = worldColor || currentGlobalUniformData.worldColor;
    globalUniformData.offset = offset || currentGlobalUniformData.offset;
`,
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]shared[\\/]renderTarget[\\/]RenderTargetSystem\.mjs$/, (src, file) => {
        src = replaceOnce(
          src,
          '    this._renderTargetStack = [];\n',
          '    this._renderTargetStack = [];\n    this._weedStackEntries = [];\n',
          file,
        );
        return replaceOnce(
          src,
          `    this._renderTargetStack.push({
      target: options.target,
      clear: false,
      clearColor: void 0,
      frame: options.frame ? options.frame.clone() : void 0,
      mipLevel: options.mipLevel,
      layer: options.layer,
      flipY: options.flipY
    });
`,
          `    const weedDepth = this._renderTargetStack.length;
    const weedEntry = this._weedStackEntries[weedDepth] || (this._weedStackEntries[weedDepth] = {
      target: null,
      clear: false,
      clearColor: void 0,
      frame: void 0,
      mipLevel: void 0,
      layer: void 0,
      flipY: void 0
    });
    weedEntry.target = options.target;
    weedEntry.frame = options.frame ? options.frame.clone() : void 0;
    weedEntry.mipLevel = options.mipLevel;
    weedEntry.layer = options.layer;
    weedEntry.flipY = options.flipY;
    this._renderTargetStack.push(weedEntry);
`,
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gl[\\/]renderTarget[\\/]GlRenderTargetAdaptor\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          `    renderTarget.colorAttachments.forEach((attachment) => {
      this._renderer.texture.unbind(attachment.texture);
    });
    const gl = this._renderer.gl;
    this.bindFramebuffer(gpuRenderTarget.framebuffer);
`,
          `    const weedAttachments = renderTarget.colorAttachments;
    for (let i = 0; i < weedAttachments.length; i++) this._renderer.texture.unbind(weedAttachments[i].texture);
    const gl = this._renderer.gl;
    this.bindFramebuffer(gpuRenderTarget.framebuffer);
`,
          file,
        ));
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]renderTarget[\\/]calculateProjection\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          `  pm.identity();
  pm.a = 1 / width * 2;
  pm.d = sign * (1 / height * 2);
  pm.tx = -1 - x * pm.a;
  pm.ty = -sign - y * pm.d;
`,
          `  const a = 1 / width * 2;
  const d = sign * (1 / height * 2);
  const tx = -1 - x * a;
  const ty = -sign - y * d;
  if (pm.a !== a) pm.a = a;
  if (pm.b !== 0) pm.b = 0;
  if (pm.c !== 0) pm.c = 0;
  if (pm.d !== d) pm.d = d;
  if (pm.tx !== tx) pm.tx = tx;
  if (pm.ty !== ty) pm.ty = ty;
`,
          file,
        ));
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]shared[\\/]GCSystem\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          `    for (const child of renderGroup.renderGroupChildren) {
      this._updateInstructionGCTick(child, gcTick);
    }
`,
          `    const weedChildren = renderGroup.renderGroupChildren;
    for (let i = 0; i < weedChildren.length; i++) this._updateInstructionGCTick(weedChildren[i], gcTick);
`,
          file,
        ));
      patchModule(build, /[\\/]color[\\/]Color\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          `    const [r, g, b, a] = this._components;
    out[0] = r;
    out[1] = g;
    out[2] = b;
    out[3] = a;
`,
          `    const c = this._components;
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    out[3] = c[3];
`,
          file,
        ));
    },
  };
}

/**
 * Pixi's per-draw paths without garbage. Each draw walked integer-keyed objects with for…in (V8 builds a key array
 * for every such loop), built a string key, or made an options object.
 * - WebGL: the shader sync walks a per-shader plan (scripts/pixi-stubs/shaderSyncPolyfill.mjs), checked by each
 *   BindGroup's `_resourceKeys`.
 * - WebGPU: the mesh adapter draws with one options object; a Geometry keeps its last pipeline, for its cache and key;
 *   BindGroup's `_touchKeys` (read at every bind group switch, by `_touch`) holds no arrow over `this`, which made V8
 *   allocate a context at each call, cached or not (pixijs issue #12391, PR #12460: drop this once it is released).
 *   Pixi 8.23 does the rest upstream, as this build patched it before (E-152): BindGroup lists its binding numbers in
 *   `_resourceKeys` for the loops that walked its resources and keys itself by two numbers (#12229, #12278), the
 *   encoder walks its bind groups and vertex buffers by index (#12229), a BindGroup keeps its cache entry, for its
 *   layout and system (#12278), and no sampler is stamped on rebind (#12288). E-464's uniform copy without a submit of
 *   its own is upstream's too (#12345).
 */
function patchPixiDrawGarbage() {
  return {
    name: 'patch-pixi-draw-garbage',
    setup(build) {
      build.onResolve({ filter: /\/generateShaderSyncPolyfill\.mjs$/ }, () => {
        return { path: path.join(stubDir, 'shaderSyncPolyfill.mjs') };
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]shader[\\/]BindGroup\.mjs$/, (src, file) => {
        src = replaceOnce(
          src,
          'class BindGroup {\n',
          '/** WeedJS (#12391): the binding numbers `_touch` stamps, every one but the samplers; no closure over the group. */\n' +
            'function weedTouchKeys(group) {\n' +
            '  const keys = group._resourceKeys;\n' +
            '  const out = [];\n' +
            '  for (let i = 0; i < keys.length; i++) {\n' +
            '    if (group.resources[keys[i]]?._resourceType !== "textureSampler") out.push(keys[i]);\n' +
            '  }\n' +
            '  return out;\n' +
            '}\n' +
            'class BindGroup {\n',
          file,
        );
        return replaceOnce(
          src,
          '    this._touchKeysValue ?? (this._touchKeysValue = this._resourceKeys.filter((index) => this.resources[index]?._resourceType !== "textureSampler"));\n',
          '    this._touchKeysValue ?? (this._touchKeysValue = weedTouchKeys(this));\n',
          file,
        );
      });
      patchModule(build, /[\\/]scene[\\/]mesh[\\/]gpu[\\/]GpuMeshAdapter\.mjs$/, (src, file) => {
        // firstInstance is there from the start: instanceRangeDraw.js sets it around a ranged draw and puts it back.
        src = replaceOnce(
          src,
          'class GpuMeshAdapter {\n',
          'const weedMeshDraw = { geometry: null, shader: null, state: null, firstInstance: void 0 };\nclass GpuMeshAdapter {\n',
          file,
        );
        return replaceOnce(
          src,
          '    renderer.encoder.draw({\n      geometry: mesh._geometry,\n      shader,\n      state: mesh.state\n    });\n',
          '    const options = weedMeshDraw;\n    options.geometry = mesh._geometry;\n    options.shader = shader;\n' +
            '    options.state = mesh.state;\n    renderer.encoder.draw(options);\n' +
            '    options.geometry = null;\n    options.shader = null;\n    options.state = null;\n',
          file,
        );
      });
      // SST-7: and the pipelines built ahead (pipelinesAhead), in this onLoad: esbuild takes the first one that answers.
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]pipeline[\\/]PipelineSystem\.mjs$/, (src, file) => pipelinesAhead(
        replaceOnce(
          src,
          '    let pipeline = this._pipeCache.get(key);\n    if (!pipeline) {\n' +
            '      pipeline = this._createPipeline(geometry, program, state, topology, overrides);\n' +
            '      this._pipeCache.set(key, pipeline);\n    }\n    return pipeline;\n',
          '    const cache = this._pipeCache;\n' +
            '    if (geometry._weedPipeCache === cache && geometry._weedPipeKey === key) return geometry._weedPipe;\n' +
            '    let pipeline = cache.get(key);\n    if (!pipeline) {\n' +
            '      pipeline = this._createPipeline(geometry, program, state, topology, overrides);\n' +
            '      cache.set(key, pipeline);\n    }\n' +
            '    geometry._weedPipeCache = cache;\n    geometry._weedPipeKey = key;\n    geometry._weedPipe = pipeline;\n' +
            '    return pipeline;\n',
          file,
        ),
        file,
      ));
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]shared[\\/]geometry[\\/]Geometry\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          '    this._layoutKey = 0;\n',
          '    this._layoutKey = 0;\n    this._weedPipeCache = null;\n    this._weedPipeKey = NaN;\n    this._weedPipe = null;\n',
          file,
        ),
      );
    },
  };
}

/**
 * E-475: Pixi links a WebGL program the first time it binds it and waits for the link (generateProgram reads
 * LINK_STATUS right after linkProgram): Predator by night waited 2.1 s in its first frames, 1.3 s of it for the light
 * pass. With KHR_parallel_shader_compile the driver links on threads of its own, and nothing waits until something is
 * read back from the program. So:
 * - generateProgram comes in two halves: weedStartProgram compiles, attaches and links, reading nothing back;
 *   weedFinishProgram reads the link (LINK_STATUS, attributes, uniforms) and makes the GlProgramData.
 * - GlShaderSystem.weedLinkAhead(program) starts a program's link; weedLinksRunning() asks COMPLETION_STATUS_KHR of the
 *   links started (never waiting: Chrome answers from a query); the program's first bind finishes the link started
 *   instead of starting another (_createProgramData).
 * - GlProgram.weedMade: when the engine sets it to an array, every program made from then on is pushed on it.
 */
function patchPixiParallelLinks() {
  return {
    name: 'patch-pixi-parallel-links',
    setup(build) {
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gl[\\/]shader[\\/]program[\\/]generateProgram\.mjs$/, (src, file) => {
        src = replaceOnce(src, 'function generateProgram(gl, program) {\n', 'function weedStartProgram(gl, program) {\n', file);
        src = replaceOnce(
          src,
          '  gl.linkProgram(webGLProgram);\n',
          '  gl.linkProgram(webGLProgram);\n' +
            '  return { webGLProgram, glVertShader, glFragShader, done: false };\n' +
            '}\n' +
            'function weedFinishProgram(gl, program, { webGLProgram, glVertShader, glFragShader }) {\n' +
            // Pixi 8.23 reads it after the link too: the uniform blocks' fixed slots start past a feedback buffer (#12307).
            '  const transformFeedbackVaryings = program.transformFeedbackVaryings;\n',
          file,
        );
        return replaceOnce(
          src,
          'export { generateProgram };',
          'function generateProgram(gl, program) {\n' +
            '  return weedFinishProgram(gl, program, weedStartProgram(gl, program));\n' +
            '}\n\n' +
            'export { generateProgram, weedStartProgram, weedFinishProgram };',
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gl[\\/]shader[\\/]GlShaderSystem\.mjs$/, (src, file) => {
        src = replaceOnce(
          src,
          "import { generateProgram } from './program/generateProgram.mjs';",
          "import { generateProgram, weedStartProgram, weedFinishProgram } from './program/generateProgram.mjs';",
          file,
        );
        src = replaceOnce(
          src,
          '    this._renderer = renderer;\n  }\n  contextChange(gl) {\n    this._gl = gl;\n',
          '    this._renderer = renderer;\n' +
            '    this._weedLinks = /* @__PURE__ */ Object.create(null);\n' +
            '    this._weedParallel = null;\n' +
            '  }\n' +
            '  contextChange(gl) {\n' +
            '    this._gl = gl;\n' +
            '    this._weedLinks = /* @__PURE__ */ Object.create(null);\n' +
            // Enabled before any link: Chrome begins a link's completion query only while the extension is on.
            '    this._weedParallel = gl.getExtension("KHR_parallel_shader_compile");\n',
          file,
        );
        return replaceOnce(
          src,
          `  _createProgramData(program) {
    const key = program._key;
    this._programDataHash[key] = generateProgram(this._gl, program);
    return this._programDataHash[key];
  }
`,
          `  _createProgramData(program) {
    const key = program._key;
    const weedStarted = this._weedLinks[key];
    if (weedStarted !== void 0) {
      delete this._weedLinks[key];
      this._programDataHash[key] = weedFinishProgram(this._gl, program, weedStarted);
    } else {
      this._programDataHash[key] = generateProgram(this._gl, program);
    }
    return this._programDataHash[key];
  }
  /** WeedJS (E-475): starts \`program\`'s link, reading nothing back; returns whether it started one. */
  weedLinkAhead(program) {
    const key = program._key;
    if (this._programDataHash[key] || this._weedLinks[key] !== void 0 || program.vertex === null) return false;
    this._weedLinks[key] = weedStartProgram(this._gl, program);
    return true;
  }
  /** WeedJS (E-475): how many links weedLinkAhead started are still running; 0 without the extension. Never waits. */
  weedLinksRunning() {
    const ext = this._weedParallel;
    if (ext === null) return 0;
    const gl = this._gl;
    let running = 0;
    for (const key in this._weedLinks) {
      const link = this._weedLinks[key];
      if (link.done) continue;
      // false while it links; true once done, null on a lost context (nothing to wait for then).
      if (gl.getProgramParameter(link.webGLProgram, ext.COMPLETION_STATUS_KHR) === false) running++;
      else link.done = true;
    }
    return running;
  }
`,
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gl[\\/]shader[\\/]GlProgram\.mjs$/, (src, file) => {
        src = replaceOnce(
          src,
          '    this._key = createIdFromString(`${this.vertex}:${this.fragment}`, "gl-program");\n  }\n',
          '    this._key = createIdFromString(`${this.vertex}:${this.fragment}`, "gl-program");\n' +
            '    if (_GlProgram.weedMade !== null) _GlProgram.weedMade.push(this);\n' +
            '  }\n',
          file,
        );
        return replaceOnce(
          src,
          '_GlProgram.defaultOptions = {\n',
          '_GlProgram.weedMade = null;\n_GlProgram.defaultOptions = {\n',
          file,
        );
      });
    },
  };
}

/**
 * SST-7 step 3 (E-495): Pixi makes a WebGPU render pipeline the first time it draws with it, with the synchronous
 * createRenderPipeline: Dawn compiles it on the GPU process's thread and the frames wait. So:
 * - _createPipeline comes in two halves: _weedPipelineDescriptor builds the descriptor, _createPipeline makes it as before.
 * - PipelineSystem.weedPipelineAhead(geometry, program, state, topology, renderTarget) builds, with
 *   createRenderPipelineAsync, the pipeline getPipeline would make for that draw into `renderTarget` (its formats, sample
 *   count, depth and flip; the colour mask whole and the stencil off, as a pass starts), and puts it in the cache
 *   getPipeline reads, under the same key, once built. The system's own target state is left as it was.
 */
const PIPELINE_AHEAD = `    return descriptor;
  }
  /** WeedJS (SST-7): getPipeline's pipeline for this draw into renderTarget, built ahead, asynchronously; null if it has one. */
  weedPipelineAhead(geometry, program, state, topology, renderTarget) {
    const saved = [this._multisampleCount, this._colorFormatId, this._depthStencilFormat, this._depthStencilFormatData,
      this._depthReadOnly, this._stencilReadOnly, this._invertFrontFace];
    // setRenderTarget writes the target's formats into the system's own list (_setColorFormats): kept to put back.
    const colorFormats = this._colorFormats.slice();
    const colorMask = this._colorMask;
    const stencilMode = this._stencilMode;
    this._colorMask = 15;
    this.setStencilMode(STENCIL_MODES.DISABLED);
    this.setRenderTarget(renderTarget);
    let built = null;
    try {
      if (!geometry._layoutKey) {
        ensureAttributes(geometry, program.attributeData);
        this._generateBufferKey(geometry);
      }
      topology || (topology = geometry.topology);
      const key = getGraphicsStateKey(
        geometry._layoutKey, program._layoutKey, state.data, state._blendModeId, topologyStringToId[topology], emptyOverrides.id
      );
      const cache = this._pipeCache;
      this._weedBuilding || (this._weedBuilding = /* @__PURE__ */ new WeakMap());
      let building = this._weedBuilding.get(cache);
      if (!building) this._weedBuilding.set(cache, building = /* @__PURE__ */ new Set());
      if (!cache.has(key) && !building.has(key)) {
        building.add(key);
        const descriptor = this._weedPipelineDescriptor(geometry, program, state, topology, emptyOverrides);
        built = this._gpu.device.createRenderPipelineAsync(descriptor).then((pipeline) => {
          building.delete(key);
          if (!cache.has(key)) cache.set(key, pipeline);
        }, (error) => {
          building.delete(key);
          throw error;
        });
      }
    } finally {
      [this._multisampleCount, this._colorFormatId, this._depthStencilFormat, this._depthStencilFormatData,
        this._depthReadOnly, this._stencilReadOnly, this._invertFrontFace] = saved;
      const formats = this._colorFormats;
      formats.length = colorFormats.length;
      for (let i = 0; i < colorFormats.length; i++) formats[i] = colorFormats[i];
      this._colorMask = colorMask;
      this.setStencilMode(stencilMode);
      this._updatePipeHash();
    }
    return built;
  }
`;

/** SST-7: PipelineSystem's source with the pipelines built ahead (applied in patchPixiDrawGarbage's onLoad of it). */
function pipelinesAhead(src, file) {
  src = replaceOnce(
    src,
    '  _createPipeline(geometry, program, state, topology, overrides) {\n    const device = this._gpu.device;\n',
    '  _createPipeline(geometry, program, state, topology, overrides) {\n' +
      '    return this._gpu.device.createRenderPipeline(this._weedPipelineDescriptor(geometry, program, state, topology, overrides));\n' +
      '  }\n' +
      '  _weedPipelineDescriptor(geometry, program, state, topology, overrides) {\n',
    file,
  );
  return replaceOnce(src, '    const pipeline = device.createRenderPipeline(descriptor);\n    return pipeline;\n  }\n', PIPELINE_AHEAD, file);
}

/**
 * N-458: Pixi's boot asks how many ifs a fragment shader takes by compiling ever smaller ones until one compiles. With the
 * WebGL context lost none does, the count reaches 0 and the loop never ends (a core at 100 %, the load waiting for ever):
 * it throws there instead, and the renderer's boot waits for the context (pixiWorker._startPixi).
 */
function patchPixiLostBoot() {
  return {
    name: 'patch-pixi-lost-boot',
    setup(build) {
      patchModule(build, /[\\/]rendering[\\/]batcher[\\/]gl[\\/]utils[\\/]checkMaxIfStatementsInShader\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          '        maxIfs = maxIfs / 2 | 0;\n',
          '        maxIfs = maxIfs / 2 | 0;\n' +
            '        if (maxIfs === 0) throw new Error("Pixi: no fragment shader compiles (the WebGL context may be lost)");\n',
          file,
        ));
    },
  };
}

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'scripts', 'buildPixiWorker.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: path.join(root, 'src', 'vendor', 'pixi.min.js'),
  plugins: [stubPixiBackends(), patchPixiDrawGarbage(), patchPixiPassGarbage(), patchPixiParallelLinks(), patchPixiLostBoot()],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
