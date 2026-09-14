import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const stubDir = path.join(root, 'scripts', 'pixi-stubs');

function stubPixiBackends() {
  return {
    name: 'stub-pixi-backends',
    setup(build) {
      build.onResolve({ filter: /\/CanvasRenderer\.mjs$/ }, () => {
        return { path: path.join(stubDir, 'CanvasRenderer.mjs') };
      });
    },
  };
}

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'scripts', 'build-pixi-worker.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: path.join(root, 'src', 'lib', 'pixi_8.16_.min.js'),
  plugins: [stubPixiBackends()],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
