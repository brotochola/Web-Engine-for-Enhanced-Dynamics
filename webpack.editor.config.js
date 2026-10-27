/**
 * Webpack config for the editor (VISUAL_EDITOR_PLAN.md ED-29): src/core/debug/editor/ as the @weed.js/editor
 * package's weed.editor files, built by scripts/buildEditor.js into packages/editor/dist/.
 *
 * Every import the editor makes from outside its folder is the engine's own module, read from WEED_EDITOR_KIT
 * (src/core/debug/editorKit.js, published by a debug build of the engine), never a copy: the editor and the game
 * share one Time, one Camera, the same component arrays. An import the kit does not publish fails the build, naming it.
 *
 *   weed.editor.min.js      a script: sets globalThis.WEED_EDITOR (add it to the page after the engine)
 *   weed.editor.esm.min.js  an ES module, for an import map entry '@weed.js/editor'
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';
import { MINIFY_RESERVED_NAMES } from './scripts/minifyReservedNames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, 'src');
const editorDir = path.resolve(__dirname, 'src/core/debug/editor');
const outDir = process.env.WEED_EDITOR_OUT ? path.resolve(process.env.WEED_EDITOR_OUT) : path.resolve(__dirname, 'packages/editor/dist');

const inside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** The kit's keys, read from its source (`'core/camera.js': camera,`). */
export function editorKitKeys(source = fs.readFileSync(path.join(srcDir, 'core/debug/editorKit.js'), 'utf8')) {
  return new Set([...source.matchAll(/^\s*'([^']+\.js)':\s*\w+,?$/gm)].map((m) => m[1]));
}

/** An import from the editor's folder to an engine module: the kit's entry for it. */
export function kitExternal(keys) {
  return ({ context, request }, callback) => {
    if (!request || !request.startsWith('.') || !context || !(context === editorDir || inside(editorDir, context))) return callback();
    const target = path.resolve(context, request);
    if (target === editorDir || inside(editorDir, target) || !inside(srcDir, target)) return callback();
    const key = path.relative(srcDir, target).split(path.sep).join('/');
    if (!keys.has(key)) {
      return callback(new Error(`the editor imports src/${key}, which src/core/debug/editorKit.js does not publish: add it there`));
    }
    return callback(null, `globalThis.WEED_EDITOR_KIT[${JSON.stringify(key)}]`, 'var');
  };
}

const keys = editorKitKeys();

const common = {
  mode: 'production',
  devtool: false,
  entry: './src/core/debug/editor/editorMain.js',
  externals: [kitExternal(keys)],
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: [/node_modules/],
        use: {
          loader: 'babel-loader',
          options: {
            compact: true,
            presets: [['@babel/preset-env', { targets: { browsers: ['> 1%', 'last 2 versions', 'not dead'] }, modules: false }]],
          },
        },
      },
    ],
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          keep_classnames: true,
          compress: { drop_debugger: true, pure_funcs: ['console.debug'] },
          mangle: { reserved: MINIFY_RESERVED_NAMES },
          format: { comments: false },
        },
        extractComments: false,
      }),
    ],
  },
  resolve: { extensions: ['.js'] },
};

const scriptConfig = {
  ...common,
  output: { path: outDir, filename: 'weed.editor.min.js', library: { name: 'WEED_EDITOR', type: 'umd' }, globalObject: 'globalThis' },
};

const moduleConfig = {
  ...common,
  output: { path: outDir, filename: 'weed.editor.esm.min.js', library: { type: 'module' } },
  experiments: { outputModule: true },
};

export default [scriptConfig, moduleConfig];
