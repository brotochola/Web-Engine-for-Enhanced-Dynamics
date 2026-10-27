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

/**
 * The shader sync without garbage (scripts/pixi-stubs/shaderSyncPolyfill.mjs). BindGroup counts the resource slots
 * it gains in `_weedKeys`, which tells the sync's per-shader plan to rebuild.
 */
function patchPixiShaderSync() {
  return {
    name: 'patch-pixi-shader-sync',
    setup(build) {
      build.onResolve({ filter: /\/generateShaderSyncPolyfill\.mjs$/ }, () => {
        return { path: path.join(stubDir, 'shaderSyncPolyfill.mjs') };
      });
      build.onLoad({ filter: /[\\/]rendering[\\/]renderers[\\/]gpu[\\/]shader[\\/]BindGroup\.mjs$/ }, async (args) => {
        let src = await fs.readFile(args.path, 'utf8');
        src = replaceOnce(
          src,
          '    this.resources = /* @__PURE__ */ Object.create(null);\n    this._dirty = true;\n',
          '    this.resources = /* @__PURE__ */ Object.create(null);\n    this._dirty = true;\n    this._weedKeys = 0;\n',
          args.path,
        );
        src = replaceOnce(
          src,
          '    this.resources[index] = resource;\n',
          '    if (!(index in this.resources)) this._weedKeys++;\n    this.resources[index] = resource;\n',
          args.path,
        );
        return { contents: src, loader: 'js', resolveDir: path.dirname(args.path) };
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
  plugins: [stubPixiBackends(), patchPixiShaderSync()],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
