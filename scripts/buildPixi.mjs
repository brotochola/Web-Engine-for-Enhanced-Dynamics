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
        return { path: path.join(stubDir, 'canvasRenderer.mjs') };
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
  plugins: [stubPixiBackends()],
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
