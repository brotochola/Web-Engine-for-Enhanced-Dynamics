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
 * Pixi's per-draw paths without garbage. Each draw walked integer-keyed objects with for…in (V8 builds a key array
 * for every such loop), built a string key, or made an options object.
 * - WebGL: the shader sync walks a per-shader plan (scripts/pixi-stubs/shaderSyncPolyfill.mjs). BindGroup counts the
 *   resource slots it gains in `_weedKeys`, which tells the plan to rebuild.
 * - WebGPU: BindGroup keeps its keys in for…in order (`_weedKeyList`) for the loops that walked its resources (the
 *   encoder's sync, `_touch`, `_key`); the encoder walks its bind groups and vertex buffers by index; a BindGroup keeps
 *   its GPU bind groups per layout, for its key; the mesh adapter draws with one options object; a Geometry keeps its
 *   last pipeline, for its cache and key.
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
          '/** WeedJS: a new resource key into `list`, in for…in order (integer keys ascending, then the others as added). */\n' +
            'function weedInsertKey(list, key) {\n' +
            '  const n = typeof key === "number" ? key : /^(0|[1-9]\\d*)$/.test(key) ? +key : -1;\n' +
            '  let at = list.length;\n' +
            '  if (n >= 0) {\n' +
            '    at = 0;\n' +
            '    for (; at < list.length; at++) {\n' +
            '      const k = list[at];\n' +
            '      const m = typeof k === "number" ? k : /^(0|[1-9]\\d*)$/.test(k) ? +k : -1;\n' +
            '      if (m < 0 || m > n) break;\n' +
            '    }\n' +
            '  }\n' +
            '  list.splice(at, 0, key);\n' +
            '}\n' +
            'class BindGroup {\n',
          file,
        );
        src = replaceOnce(
          src,
          '    this.resources = /* @__PURE__ */ Object.create(null);\n    this._dirty = true;\n',
          '    this.resources = /* @__PURE__ */ Object.create(null);\n    this._dirty = true;\n' +
            '    this._weedKeys = 0;\n    this._weedKeyList = [];\n' +
            '    this._weedGpuOwner = null;\n    this._weedGpuKey = "";\n    this._weedGpuByLayout = null;\n',
          file,
        );
        src = replaceOnce(
          src,
          '    this.resources[index] = resource;\n',
          '    if (!(index in this.resources)) {\n      this._weedKeys++;\n      weedInsertKey(this._weedKeyList, index);\n    }\n' +
            '    this.resources[index] = resource;\n',
          file,
        );
        src = replaceOnce(
          src,
          '      for (const i in this.resources) {\n        keyParts[index++] = this.resources[i] ? this.resources[i]._resourceId : -1;\n      }\n',
          '      const keys = this._weedKeyList;\n      for (let k = 0; k < keys.length; k++) {\n' +
            '        const resource = this.resources[keys[k]];\n        keyParts[index++] = resource ? resource._resourceId : -1;\n      }\n',
          file,
        );
        return replaceOnce(
          src,
          '    const resources = this.resources;\n    for (const i in resources) {\n      const resource = resources[i];\n' +
            '      if (!resource) continue;\n      resource._gcLastUsed = now;\n',
          '    const resources = this.resources;\n    const keys = this._weedKeyList;\n    for (let k = 0; k < keys.length; k++) {\n' +
            '      const resource = resources[keys[k]];\n      if (!resource) continue;\n      resource._gcLastUsed = now;\n',
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]GpuEncoderSystem\.mjs$/, (src, file) => {
        // The cached name map's keys run from 0 to at most the geometry's buffer count - 1 (one layout per buffer).
        src = replaceOnce(
          src,
          '    for (const i in buffersToBind) {\n      this._setVertexBuffer(parseInt(i, 10), geometry.attributes[buffersToBind[i]].buffer);\n    }\n',
          '    for (let i = 0, n = geometry.buffers.length; i < n; i++) {\n      const name = buffersToBind[i];\n' +
            '      if (name !== void 0) this._setVertexBuffer(i, geometry.attributes[name].buffer);\n    }\n',
          file,
        );
        // Bind group indices, as the encoder's 16 slots (_boundBindGroup).
        src = replaceOnce(
          src,
          '    for (const i in shader.groups) {\n      if (!program.layout[i]) continue;\n      const bindGroup = shader.groups[i];\n',
          '    const groups = shader.groups;\n    for (let i = 0; i < 16; i++) {\n      const bindGroup = groups[i];\n' +
            '      if (bindGroup === void 0 || !program.layout[i]) continue;\n',
          file,
        );
        return replaceOnce(
          src,
          '    for (const j in bindGroup.resources) {\n      const resource = bindGroup.resources[j];\n',
          '    const keys = bindGroup._weedKeyList;\n    for (let k = 0; k < keys.length; k++) {\n' +
            '      const resource = bindGroup.resources[keys[k]];\n',
          file,
        );
      });
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]BindGroupSystem\.mjs$/, (src, file) =>
        replaceOnce(
          src,
          '    const key = `${bindGroup._key}:${program._layoutKey << 4 | groupIndex}`;\n' +
            '    const gpuBindGroup = this._hash[key] || this._createBindGroup(key, bindGroup, program, groupIndex);\n' +
            '    return gpuBindGroup;\n',
          '    const groupKey = bindGroup._key;\n    const layoutKey = program._layoutKey << 4 | groupIndex;\n' +
            '    let byLayout = bindGroup._weedGpuByLayout;\n' +
            '    if (byLayout === null || bindGroup._weedGpuOwner !== this || bindGroup._weedGpuKey !== groupKey) {\n' +
            '      if (byLayout === null) byLayout = bindGroup._weedGpuByLayout = /* @__PURE__ */ new Map();\n' +
            '      else byLayout.clear();\n' +
            '      bindGroup._weedGpuOwner = this;\n      bindGroup._weedGpuKey = groupKey;\n' +
            '    } else {\n      const known = byLayout.get(layoutKey);\n      if (known !== void 0) return known;\n    }\n' +
            '    const key = `${groupKey}:${layoutKey}`;\n' +
            '    const gpuBindGroup = this._hash[key] || this._createBindGroup(key, bindGroup, program, groupIndex);\n' +
            '    byLayout.set(layoutKey, gpuBindGroup);\n    return gpuBindGroup;\n',
          file,
        ),
      );
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
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]pipeline[\\/]PipelineSystem\.mjs$/, (src, file) =>
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
      );
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
 * Pixi's WebGL format map gives the integer formats RED, RG or RGBA; WebGL 2 wants RED_INTEGER, RG_INTEGER or
 * RGBA_INTEGER with an integer internal format. Pixi allocated each texture of such a source (the GPU particle record
 * textures, rgba32uint) with an invalid texImage2D, a GL_INVALID_OPERATION in the console, before the engine's own
 * upload reallocated it.
 */
function patchPixiIntegerFormats() {
  const formats = [
    ['r8uint', 'RED'], ['r8sint', 'RED'], ['r16uint', 'RED'], ['r16sint', 'RED'],
    ['rg8uint', 'RG'], ['rg8sint', 'RG'], ['r32uint', 'RED'], ['r32sint', 'RED'],
    ['rg16uint', 'RG'], ['rg16sint', 'RG'], ['rgba8uint', 'RGBA'], ['rgba8sint', 'RGBA'],
    ['rg32uint', 'RG'], ['rg32sint', 'RG'], ['rgba16uint', 'RGBA'], ['rgba16sint', 'RGBA'],
    ['rgba32uint', 'RGBA'], ['rgba32sint', 'RGBA'],
  ];
  return {
    name: 'patch-pixi-integer-formats',
    setup(build) {
      patchModule(build, /[\\/]rendering[\\/]renderers[\\/]gl[\\/]texture[\\/]utils[\\/]mapFormatToGlFormat\.mjs$/, (src, file) => {
        for (const [name, base] of formats) {
          src = replaceOnce(src, `    ${name}: gl.${base},\n`, `    ${name}: gl.${base}_INTEGER,\n`, file);
        }
        return src;
      });
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
  plugins: [stubPixiBackends(), patchPixiDrawGarbage(), patchPixiIntegerFormats()],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
