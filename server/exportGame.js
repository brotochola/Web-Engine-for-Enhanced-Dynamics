// exportGame.js — the editor's Export (VISUAL_EDITOR_PLAN.md ED-32): the running game as a static site, built on the
// dev server with esbuild.
//
//   index.html      the page: the engine, then the game, then loadScene of the level the editor ran
//   vendor/weed.js  the engine's production bundle, unchanged
//   game.min.js     the scene classes, their entity classes and the scene files, bundled and minified
//   assets/         the files the scenes declare (static assets, audios, layer shaders) and the baked atlas
//   _headers        COOP and COEP, for static hosts that read it (Netlify, Cloudflare Pages)
//   weed-sw.js      the engine's isolation service worker, for hosts that send no headers (when the engine has one)
//
// How game.min.js runs:
// - Every engine import in the game's code (`import WEED from '/src/index.js'`, '@weed.js/engine') is the global WEED.
//   The page has it from vendor/weed.js. The engine's workers load the scene module themselves: a bundled engine's
//   workers are blob workers, which fetch the module and run it as a function body with WEED as a parameter
//   (src/util/utils.js, evaluateBlobModule). That loader rewrites import and export statements with regular
//   expressions; game.min.js has none but its last line, `export { … }` (written so the loader reads it), and
//   checkWorkerLoadable refuses an output with anything else the loader would rewrite.
// - Class names are kept (esbuild keepNames): the engine knows scene, entity and component classes by name (scene
//   files, saves, registration, a worker finding the scene class by its name; scripts/minifyReservedNames.js).
// - The scene files are carried in game.min.js (WEED.registerSceneFile), at their paths below the scene module's
//   folder, now beside game.min.js; each one's "script" names game.min.js. Asset URLs are pointed at assets/ on the
//   page, before the first load (exportRuntime.js).
// Engine modules other than its index cannot be bundled (they would be a second copy of the engine): an import of one
// is refused, naming it. Imports of npm packages are bundled.
//
// No dependency on the engine's sources: this file is published with the dev server (ED-30). esbuild is loaded when
// an export runs, from the project's node_modules.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInside } from './devRoutes.js';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The engine package this server belongs to (the repo, or node_modules/@weed.js/engine). */
const ENGINE_ROOT = path.resolve(SERVER_DIR, '..');
const RUNTIME = path.join(SERVER_DIR, 'exportRuntime.js');
const RUNTIME_SPECIFIER = 'weed-export-runtime';
/** The production bundle a page loads as a classic script: it sets window.WEED. */
export const ENGINE_BUNDLE_FILE = 'weed.prod.bundle.min.js';
/** An export request's body: the baked atlas travels in it (base64). */
export const MAX_EXPORT_BODY_BYTES = 128 * 1024 * 1024;

/** A request the export cannot do, and the HTTP status that says so. */
export class ExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The engine's production bundle to ship: the one given, else the project's @weed.js/engine, else the one beside this
 * server (the engine repo's dist/).
 * @param {string} root - the served folder
 * @param {string} [given]
 * @returns {string}
 */
export function findEngineBundle(root, given) {
  const candidates = given
    ? [path.resolve(given)]
    : [path.join(root, 'node_modules', '@weed.js', 'engine', 'dist', ENGINE_BUNDLE_FILE), path.join(ENGINE_ROOT, 'dist', ENGINE_BUNDLE_FILE)];
  for (const file of candidates) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    // The game registers its scene files through the engine: an engine from before that cannot run an export.
    if (!fs.readFileSync(file, 'utf8').includes('registerSceneFile')) {
      throw new ExportError(`the engine bundle ${file} is older than exports (it has no registerSceneFile): rebuild it (npm run make_bundle) or ship a newer one`, 500);
    }
    return file;
  }
  throw new ExportError(`no engine bundle to ship (${candidates.join(', ')}): build it (npm run make_bundle) or install @weed.js/engine`, 500);
}

const isSitePath = (p) => typeof p === 'string' && p.startsWith('/');

/** A site path resolved in the served folder, as a file that exists; else an ExportError naming what it was for. */
function siteFile(root, sitePath, what) {
  const file = isSitePath(sitePath) ? resolveInside(root, sitePath) : null;
  if (file === null) throw new ExportError(`${what} is not a path in the served folder: ${sitePath}`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ExportError(`${what} not found: ${sitePath}`, 404);
  return file;
}

/** A scene file read and checked as far as the export needs it (format 1, its script). */
function readSceneFile(root, sitePath) {
  if (!sitePath.endsWith('.scene.json')) throw new ExportError(`not a scene file (*.scene.json): ${sitePath}`);
  const file = siteFile(root, sitePath, 'a scene file');
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ExportError(`${sitePath} is not JSON: ${error.message}`);
  }
  if (doc === null || typeof doc !== 'object' || doc.format !== 1 || typeof doc.script !== 'string' || doc.script === '') {
    throw new ExportError(`${sitePath} is not a scene file of format 1 with a "script"`);
  }
  return doc;
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * The folder all the given site paths share (ends with /).
 * @param {string[]} sitePaths
 */
function commonFolder(sitePaths) {
  if (sitePaths.length === 0) return '/';
  let parts = sitePaths[0].split('/').slice(0, -1);
  for (const p of sitePaths.slice(1)) {
    const other = p.split('/').slice(0, -1);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return `${parts.join('/')}/`;
}

/**
 * Check what an export was asked for, and read what it carries: the scene modules, the scene files with their new
 * "script", the asset files and where they go.
 * @param {object} request - see exportGame
 * @param {string} root
 */
export function planExport(request, root) {
  if (request === null || typeof request !== 'object') throw new ExportError('the request must be a JSON object');
  const { scene, start = null, sceneFiles = [], assets = [], atlas = null } = request;
  const sceneExport = request.export;
  if (typeof sceneExport !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(sceneExport)) {
    throw new ExportError(`"export" must name the scene class: ${JSON.stringify(sceneExport)}`);
  }
  siteFile(root, scene, 'the scene module');
  if (!Array.isArray(sceneFiles) || !Array.isArray(assets)) throw new ExportError('"sceneFiles" and "assets" must be arrays');
  const sceneDir = path.posix.dirname(scene);

  // The scene files, below the scene module's folder, each naming its module: game.min.js from where it lands.
  const files = {};
  const modules = [scene];
  const exportsNeeded = new Set([sceneExport]);
  const filePaths = start !== null && !sceneFiles.includes(start) ? [start, ...sceneFiles] : sceneFiles;
  for (const sitePath of filePaths) {
    if (!isSitePath(sitePath)) throw new ExportError(`not a scene file path: ${JSON.stringify(sitePath)}`);
    const doc = readSceneFile(root, sitePath);
    const rel = path.posix.relative(sceneDir, sitePath);
    if (rel.startsWith('../')) {
      throw new ExportError(`${sitePath} is outside the scene module's folder (${sceneDir}/): an export carries the scene files from there down`);
    }
    const module = new URL(doc.script, `http://site${sitePath}`).pathname;
    siteFile(root, decodeURIComponent(module), `the scene module of ${sitePath}`);
    if (!modules.includes(module)) modules.push(module);
    if (typeof doc.export === 'string') exportsNeeded.add(doc.export);
    const depth = rel.split('/').length - 1;
    files[rel] = { ...doc, script: `${'../'.repeat(depth)}game.min.js` };
  }
  if (start !== null && !Object.hasOwn(files, path.posix.relative(sceneDir, start))) {
    throw new ExportError(`the start is not one of the scene files: ${start}`);
  }

  // The asset files, under assets/ by their path below the folder they share.
  const assetFiles = [];
  const seen = new Map();
  const missing = [];
  for (const entry of assets) {
    if (entry === null || typeof entry !== 'object' || typeof entry.url !== 'string' || !isSitePath(entry.path)) {
      throw new ExportError(`an asset must be { url, path } with a site path: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry.url)) continue;
    let file;
    try {
      file = siteFile(root, entry.path, 'an asset');
    } catch (error) {
      if (!(error instanceof ExportError)) throw error;
      missing.push(entry.path);
      continue;
    }
    seen.set(entry.url, entry.path);
    assetFiles.push({ url: entry.url, sitePath: entry.path, file });
  }
  const shared = commonFolder(assetFiles.map((a) => a.sitePath));
  for (const a of assetFiles) a.target = `assets/${a.sitePath.slice(shared.length)}`;

  let atlasFiles = null;
  if (atlas !== null) {
    if (typeof atlas !== 'object' || typeof atlas.json !== 'string' || typeof atlas.png !== 'string') {
      throw new ExportError('"atlas" must be { json, png } (the JSON text, the PNG as base64)');
    }
    try {
      JSON.parse(atlas.json);
    } catch (error) {
      throw new ExportError(`the atlas JSON does not parse: ${error.message}`);
    }
    const png = Buffer.from(atlas.png, 'base64');
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new ExportError('the atlas PNG is not a PNG');
    const base = `assets/${sceneExport}.atlas`;
    atlasFiles = { json: atlas.json, png, jsonTarget: `${base}.json`, pngTarget: `${base}.png` };
  }

  const startUrl = start === null ? null : path.posix.relative(sceneDir, start);
  return { scene, sceneExport, modules, exportsNeeded: [...exportsNeeded], files, assetFiles, atlasFiles, startUrl, missing };
}

/**
 * The esbuild plugin of an export: the engine's index (as a site path, a relative path or '@weed.js/engine') is the
 * global WEED; site paths are files of the served folder; other engine modules are refused.
 */
function weedPlugin(root) {
  const engineIndex = path.join(ENGINE_ROOT, 'src', 'index.js');
  const engineSrc = path.join(ENGINE_ROOT, 'src') + path.sep;
  const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const insideSrc = (abs) => (process.platform === 'win32' ? abs.toLowerCase().startsWith(engineSrc.toLowerCase()) : abs.startsWith(engineSrc));
  const engine = (abs, args) => {
    if (sameFile(abs, engineIndex)) return { path: 'WEED', namespace: 'weed-global' };
    if (insideSrc(abs)) {
      return {
        errors: [{ text: `${args.importer || 'the game'} imports ${args.path}, an engine module: a game reaches the engine through its index (WEED), which the export ships as vendor/weed.js` }],
      };
    }
    return null;
  };
  return {
    name: 'weed-export',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${RUNTIME_SPECIFIER}$`) }, () => ({ path: RUNTIME }));
      build.onResolve({ filter: /^@weed\.js\/engine(\/.*)?$/ }, () => ({ path: 'WEED', namespace: 'weed-global' }));
      build.onResolve({ filter: /^\// }, (args) => {
        const abs = resolveInside(root, args.path.split('?')[0]);
        if (abs === null) return { errors: [{ text: `${args.path} is outside the served folder` }] };
        return engine(abs, args) ?? { path: abs };
      });
      build.onResolve({ filter: /^\.\.?\// }, (args) => engine(path.resolve(args.resolveDir, args.path), args) ?? undefined);
      build.onLoad({ filter: /.*/, namespace: 'weed-global' }, () => ({ contents: 'module.exports = WEED;', loader: 'js' }));
    },
  };
}

/**
 * The entry esbuild bundles: the export's runtime, then every scene module (all their exports, as the modules have
 * them), then the runtime's install with the manifest.
 */
function entrySource(plan) {
  const lines = [`import { installExport } from '${RUNTIME_SPECIFIER}';`];
  plan.modules.forEach((m, i) => lines.push(`import * as m${i} from ${JSON.stringify(m)};`));
  for (const m of plan.modules) lines.push(`export * from ${JSON.stringify(m)};`);
  const manifest = {
    sceneFiles: plan.files,
    assets: Object.fromEntries(plan.assetFiles.map((a) => [a.url, a.target])),
    atlas: plan.atlasFiles === null ? null : { scene: plan.sceneExport, json: plan.atlasFiles.jsonTarget, png: plan.atlasFiles.pngTarget },
  };
  lines.push(`installExport(${JSON.stringify(manifest)}, import.meta.url, [${plan.modules.map((_, i) => `m${i}`).join(', ')}]);`);
  return `${lines.join('\n')}\n`;
}

/** What the engine's blob-worker loader rewrites (src/util/utils.js, rewriteBlobImports and transformBlobScript). */
const WORKER_LOADER_PATTERNS = [
  [/import\s+\{[^}]+\}\s+from\s+['"]/, 'an import statement'],
  [/import\s+\*\s+as\s+\w+\s+from\s+['"]/, 'an import statement'],
  [/import\s+\w+\s+from\s+['"]/, 'an import statement'],
  [/import\s+['"][^'"]+['"]/, 'an import statement'],
  [/(?:from|import)\s+['"](?:\.|\/demos\/|\/tests\/)/, 'a module path the loader would fetch'],
  [/export\s+(?:class|(?:async\s+)?function|const|let|var)\b/, 'an export declaration'],
  [/export\s*\{/, 'an export list'],
  [/export\s+default\b/, 'a default export'],
];

/**
 * Make esbuild's output loadable by the engine's blob workers, or say why it is not: its last line becomes
 * `export { a as B };` (the loader needs the space), and nothing else in it may look like what the loader rewrites (a
 * string that holds `import x from '…'` would be rewritten in the workers).
 * @param {string} code
 * @returns {string}
 */
export function checkWorkerLoadable(code) {
  const tail = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(code);
  if (tail === null) throw new ExportError('the bundle does not end with its export list', 500);
  const body = code.slice(0, tail.index);
  for (const [pattern, what] of WORKER_LOADER_PATTERNS) {
    const found = pattern.exec(body);
    if (found !== null) {
      const at = body.slice(Math.max(0, found.index - 40), found.index + 60);
      throw new ExportError(`game.min.js holds ${what} the engine's workers would rewrite as code, near: ${at}`, 500);
    }
  }
  return `${body}export { ${tail[1].trim()} };\n`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The exported page: the engine (window.WEED), the game, and a load of the level the editor ran. */
export function indexHtml({ title, startUrl, sceneExport }) {
  const load =
    startUrl === null
      ? `game.loadScene(new URL('./game.min.js', import.meta.url).href, { export: ${JSON.stringify(sceneExport)}, onProgress })`
      : `game.loadScene(new URL(${JSON.stringify(`./${startUrl}`)}, import.meta.url).href, { onProgress })`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      #loading {
        position: fixed;
        left: 12px;
        top: 12px;
        z-index: 5;
        color: #fff;
        font: 14px/1.4 system-ui, sans-serif;
      }
    </style>
    <!-- The engine (window.WEED). Built by the WeedJS editor's Export. -->
    <script src="./vendor/weed.js"></script>
  </head>
  <body>
    <div id="loading">Loading…</div>
    <script type="module">
      import './game.min.js';

      const loading = document.getElementById('loading');
      const onProgress = (done, total) => {
        loading.textContent = \`Loading… \${Math.round((100 * done) / Math.max(1, total))} %\`;
      };
      const game = new WEED.GameEngine({ debug: false, hotReload: false });
      window.game = game;
      try {
        await ${load};
        loading.remove();
      } catch (error) {
        loading.textContent = String(error && error.message ? error.message : error);
      }
    </script>
  </body>
</html>
`;
}

export const HEADERS_FILE = '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n';

/** Whether a folder may be replaced by an export: missing, empty, or an earlier export. */
function isReplaceable(dir) {
  if (!fs.existsSync(dir)) return true;
  if (!fs.statSync(dir).isDirectory()) return false;
  const names = fs.readdirSync(dir);
  return names.length === 0 || (names.includes('game.min.js') && names.includes('vendor'));
}

/**
 * Export a game: see the top of this file.
 * @param {object} request
 *   scene: the scene module's site path (`/demos/x/scene.js`); export: the scene class's export name;
 *   start: the site path of the scene file to start with, or null to load the module (and its defaultSceneFile);
 *   sceneFiles: the site paths of the scene files to carry, below the module's folder;
 *   assets: `{ url, path }` per file the scene declares: the URL as the code has it, its site path;
 *   atlas: `{ json, png }` (text, base64) baked from the running scene, which its class loads instead of packing, or null;
 *   title: the page's title
 * @param {{ root: string, outDir: string, engineBundle?: string, esbuild?: object }} options
 *   root: the served folder; outDir: the folder to write (replaced if it holds an earlier export; refused if it holds
 *   anything else); engineBundle: the production bundle to ship (findEngineBundle); esbuild: the module, for tests
 * @returns {Promise<{ outDir: string, files: string[], bytes: number, gameBytes: number, warnings: string[] }>}
 */
export async function exportGame(request, options) {
  const { root, outDir } = options;
  const plan = planExport(request, root);
  const engineBundle = findEngineBundle(root, options.engineBundle);
  if (!isReplaceable(outDir)) {
    throw new ExportError(`${outDir} holds files that are not an export: remove them, or export to another folder`, 409);
  }
  let esbuild = options.esbuild;
  if (esbuild === undefined) {
    try {
      esbuild = await import('esbuild');
    } catch {
      throw new ExportError('Export needs esbuild: npm install --save-dev esbuild', 501);
    }
  }

  let result;
  try {
    result = await esbuild.build({
      stdin: { contents: entrySource(plan), resolveDir: root, sourcefile: 'weed-export-entry.js', loader: 'js' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      keepNames: true,
      legalComments: 'none',
      charset: 'utf8',
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: [weedPlugin(root)],
    });
  } catch (error) {
    const messages = (error.errors || []).map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text));
    throw new ExportError(`the game did not bundle: ${messages.join('; ') || error.message}`);
  }
  const output = Object.values(result.metafile.outputs)[0];
  const missingExports = plan.exportsNeeded.filter((name) => !output.exports.includes(name));
  if (missingExports.length > 0) {
    throw new ExportError(`game.min.js does not export ${missingExports.join(', ')} (named by the scene or its files; two modules exporting one name cancel it)`);
  }
  const game = checkWorkerLoadable(result.outputFiles[0].text);

  // Everything is ready: replace the folder.
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const written = [];
  const write = (rel, content) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written.push(rel);
  };
  const copy = (rel, from) => {
    const file = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(from, file);
    written.push(rel);
  };
  const title = typeof request.title === 'string' && request.title !== '' ? request.title : plan.sceneExport;
  write('index.html', indexHtml({ title, startUrl: plan.startUrl, sceneExport: plan.sceneExport }));
  write('game.min.js', game);
  copy('vendor/weed.js', engineBundle);
  const isolationWorker = path.join(path.dirname(engineBundle), 'weed-sw.js');
  if (fs.existsSync(isolationWorker)) copy('weed-sw.js', isolationWorker);
  write('_headers', HEADERS_FILE);
  for (const a of plan.assetFiles) copy(a.target, a.file);
  if (plan.atlasFiles !== null) {
    write(plan.atlasFiles.pngTarget, plan.atlasFiles.png);
    write(plan.atlasFiles.jsonTarget, plan.atlasFiles.json);
  }
  const bytes = written.reduce((sum, rel) => sum + fs.statSync(path.join(outDir, rel)).size, 0);
  const warnings = plan.missing.map((p) => `not found, not exported: ${p}`);
  return { outDir, files: written.map(toPosix).sort(), bytes, gameBytes: Buffer.byteLength(game), warnings };
}

/**
 * POST /__weed/export (server/devRoutes.js): read the request, export, answer where it went.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} root
 * @param {(status: number, body: object) => void} send
 * @param {{ dir?: string, outDir?: string, engineBundle?: string, esbuild?: object }} [config]
 *   outDir: the folder every export goes to; or dir: a folder with one export per scene class in it
 *   (`<dir>/<SceneClass>`). The request never names a folder.
 */
export function exportRoute(req, root, send, config = {}) {
  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (chunk) => {
    if (refused) return;
    size += chunk.length;
    if (size > MAX_EXPORT_BODY_BYTES) {
      refused = true;
      chunks.length = 0;
      send(413, { error: `an export request is at most ${MAX_EXPORT_BODY_BYTES} bytes` });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (refused) return;
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      send(400, { error: `not JSON: ${error.message}` });
      return;
    }
    const name = typeof request?.export === 'string' ? request.export.replace(/[^\w-]/g, '_') : 'game';
    const outDir = config.outDir ? path.resolve(config.outDir) : path.join(path.resolve(config.dir || path.join(root, 'scratch', 'export')), name);
    exportGame(request, { root, outDir, engineBundle: config.engineBundle, esbuild: config.esbuild }).then(
      (done) => {
        const rel = path.relative(fs.realpathSync(root), outDir);
        const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        send(200, { ...done, url: inside ? `/${toPosix(rel)}/` : null });
      },
      (error) => send(error instanceof ExportError ? error.status : 500, { error: error.message }),
    );
  });
}
