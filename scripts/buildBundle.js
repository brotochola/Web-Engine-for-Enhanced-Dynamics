/**
 * Build script for single-file bundle with inline workers
 *
 * Emits 3 artifacts (N-172): the production build as ESM and UMD, the debug build as ESM:
 *   weed.prod.bundle.esm.min.js / weed.prod.bundle.min.js
 *   weed.bundle.esm.min.js
 * Each one gzips its workers, Box2D, the shaders and the debug CSS inside, base64-embedded, inflated once at the first
 * scene (DecompressionStream): the file itself small, as the owner asked (2026-11-24, 11-28). The debug UMD is gone.
 *
 * Workers share one worker_common chunk (AbstractWorker graph). Box2D WASM is
 * gzip'd then base64-embedded in every artifact.
 *
 * --files adds the file mode (SST-8) in dist/files/: the three bundles again, each starting its
 * workers, Box2D and engine.wasm from files in a folder beside it (debug-<hash>/, prod-<hash>/).
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { BUILD_INPUTS_FILE, bundleInputsHash } from './distVersion.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const workersDir = path.join(distDir, 'workers');
const webpackCli = path.join(rootDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js');

if (process.argv.includes('--obfuscate')) process.env.OBFUSCATE = 'true';
const shouldObfuscate = process.env.OBFUSCATE === 'true';

/** The scene's workers (sceneWorkerBootstrap.js), which share workers/worker_common.min.js. */
export const SCENE_WORKER_NAMES = [
    'spatialWorker',
    'logicWorker',
    'pixiWorker',
    'particleWorker',
    'preRenderWorker',
];
/**
 * The short-lived workers a scene's load starts for its assets (src/core/assetWorkerClient.js: the atlas pack, the
 * tilemap parse; SST-5, SST-11). Each is one self-contained file (webpack.config.js keeps them out of the shared
 * chunk): their graphs are small, and they should not parse the scene workers' common code to start.
 */
export const ASSET_WORKER_NAMES = ['atlasWorker', 'tilemapWorker'];
export const WORKER_NAMES = [...SCENE_WORKER_NAMES, ...ASSET_WORKER_NAMES];

/**
 * Marker written next to the bundles recording which engine they were built
 * from. scripts/distVersion.js reads it; a missing or mismatched stamp blocks a
 * bench run that would otherwise measure the wrong engine.
 */
export const BUILD_STAMP_FILE = '.build-version';

export const BUNDLE_ARTIFACTS = [

    'weed.bundle.esm.min.js',
    'weed.prod.bundle.min.js',
    'weed.prod.bundle.esm.min.js',
];

/**
 * The isolation service worker (DX-SW), published next to the bundles as its own file: browsers
 * register a service worker only from a same-origin URL, never from a bundle's blob. A plain copy
 * of src/workers/isolationServiceWorker.js: its bytes carry no version, since any change makes
 * every visitor's browser reinstall it.
 */
export const ISOLATION_SERVICE_WORKER_FILE = 'weed-sw.js';

/**
 * The file mode (SST-8, `--files`): the engine with its workers, Box2D and engine.wasm as files beside the page's
 * bundle, which starts them by URL. A blob worker gets no V8 code cache and a data URL no wasm code cache, so the
 * single-file bundle parses and compiles all of them again on every visit; files served over HTTP can be cached
 * with their compiled code, and the wasm compiles while it downloads. The single-file bundles stay, for embeds and
 * CDNs: a browser starts a worker only from the page's origin.
 */
export const FILE_MODE_DIR = 'files';
/** The file mode's page bundles, in dist/files/. */
export const FILE_MODE_ARTIFACTS = BUNDLE_ARTIFACTS;

const KEEP_DIST_FILES = new Set([...BUNDLE_ARTIFACTS, 'index.html', ISOLATION_SERVICE_WORKER_FILE]);

const BOX2D_ALWAYS_SIBLINGS = ['weedjsPost.js', 'physicsHostImpl.js'];

/** Quoted .js filenames in the first importScripts(...) of a classic script. */
export function extractImportScriptNames(source) {
    const match = source.match(/importScripts\s*\(([\s\S]*?)\)/);
    if (!match) return [];
    return [...match[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map((m) => m[1].split('/').pop());
}

/** Quoted .js filenames in every importScripts(...) call (wasm glue has one file per call). */
export function extractAllImportScriptNames(source) {
    const names = [];
    const re = /importScripts\s*\(([\s\S]*?)\)/g;
    let match;
    while ((match = re.exec(source))) {
        for (const m of match[1].matchAll(/['"]([^'"]+\.js)['"]/g)) {
            names.push(m[1].split('/').pop());
        }
    }
    return names;
}

/** Box2D blob-remap list: glue + every file weedjs_post importScripts. */
export function listBox2dSiblingNames(weedPostSource) {
    return [...new Set([...BOX2D_ALWAYS_SIBLINGS, ...extractImportScriptNames(weedPostSource)])];
}

/** A bundle's file name. Every bundle gzips its workers inside (N-172), so the name says nothing about compression. */
export function bundleFileName({ prod, esm }) {
    const parts = ['weed'];
    if (prod) parts.push('prod');
    parts.push('bundle');
    if (esm) parts.push('esm');
    parts.push('min.js');
    return parts.join('.');
}

function kb(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function gzipB64(text) {
    if (!text) return '';
    return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64');
}

export function makeBuildEnv(prod, compressed) {
    return {
        ...process.env,
        OBFUSCATE: shouldObfuscate ? 'true' : 'false',
        WEED_PROD: prod ? 'true' : 'false',
        WEED_COMPRESSED: compressed ? 'true' : 'false',
        // N-251: paths through node_modules as found, not resolved through its junction (the webpack configs' symlinks:
        // false is the same for webpack's resolver), so a worktree builds the main folder's bytes.
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192', '--preserve-symlinks', '--preserve-symlinks-main']
            .filter(Boolean)
            .join(' '),
    };
}

function runWebpack(configFile, env) {
    execSync(`node "${webpackCli}" --config ${configFile}`, {
        cwd: rootDir,
        stdio: 'inherit',
        env,
    });
}

/**
 * The Box2D physics worker as one classic script: the glue, with weedjsPost.js, physicsHostImpl.js and the files they
 * importScripts embedded as strings and handed to importScripts as blob URLs (one request, not 18 in a row).
 * `embedWasm`: the single-file bundle carries box2dWasm.wasm too (gzip, base64) and instantiates it from those bytes.
 * The file mode (SST-8) leaves it out: the glue streams box2dWasm.wasm from beside the script (instantiateStreaming),
 * so the browser can cache its compiled code between visits.
 */
export function buildBox2dWorkerSource({ embedWasm = true } = {}) {
    const box2dDir = path.join(rootDir, 'src', 'box2d');
    const weedPostPath = path.join(box2dDir, 'weedjsPost.js');
    const weedPostSource = fs.readFileSync(weedPostPath, 'utf8');
    const siblingNames = listBox2dSiblingNames(weedPostSource);

    const box2dSiblingScripts = {};
    for (const name of siblingNames) {
        const filePath = path.join(box2dDir, name);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Box2D sibling missing: ${filePath}`);
        }
        box2dSiblingScripts[name] =
            name === 'weedjsPost.js' ? weedPostSource : fs.readFileSync(filePath, 'utf8');
    }

    const box2dGlue = fs.readFileSync(path.join(box2dDir, 'box2dWasm.js'), 'utf8');
    let wasmEmbed = '';
    if (embedWasm) {
        const wasmBytes = fs.readFileSync(path.join(box2dDir, 'box2dWasm.wasm'));
        const gzipped = zlib.gzipSync(wasmBytes, { level: 9 });
        const box2dWasmGzipB64 = gzipped.toString('base64');
        console.log(
            `   Box2D wasm: ${kb(wasmBytes.length)} raw → ${kb(gzipped.length)} gzip → ` +
            `${kb(Buffer.byteLength(box2dWasmGzipB64, 'utf8'))} base64`,
        );
        // gzip-before-base64; inflate async via DecompressionStream, then instantiate.
        wasmEmbed =
            `  var __weedWasmGzipB64 = ${JSON.stringify(box2dWasmGzipB64)};\n` +
            `  function __weedB64ToU8(b64) {\n` +
            `    var binary = atob(b64);\n` +
            `    var bytes = new Uint8Array(binary.length);\n` +
            `    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n` +
            `    return bytes;\n` +
            `  }\n` +
            `  function __weedGunzip(bytes) {\n` +
            `    if (typeof DecompressionStream === "undefined") {\n` +
            `      return Promise.reject(new Error("DecompressionStream required for Weed Box2D embed"));\n` +
            `    }\n` +
            `    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));\n` +
            `    return new Response(stream).arrayBuffer().then(function(buf) { return new Uint8Array(buf); });\n` +
            `  }\n` +
            `  // Pthread helpers receive an already-compiled module and instantiate it\n` +
            `  // synchronously. The async gunzip hook would mark the worker ready before\n` +
            `  // exports exist, so the first pthread_create (pool size 0) crashes.\n` +
            `  if (global.name !== "em-pthread") {\n` +
            `    Module["instantiateWasm"] = function(info, receiveInstance) {\n` +
            `      return __weedGunzip(__weedB64ToU8(__weedWasmGzipB64)).then(function(wasmBinary) {\n` +
            `        return WebAssembly.instantiate(wasmBinary, info).then(function(result) {\n` +
            `          receiveInstance(result.instance, result.module);\n` +
            `          return result.instance.exports;\n` +
            `        });\n` +
            `      });\n` +
            `    };\n` +
            `  }\n`;
    }
    console.log(`   Box2D siblings: ${siblingNames.join(', ')}`);

    const box2dGluePatched = box2dGlue
        .replace(
            /importScripts\(\s*["']weedjsPost\.js["']\s*\)\s*;?\s*importScripts\(\s*["']physicsHostImpl\.js["']\s*\)/,
            '/* weedjsPost + physicsHostImpl preloaded for bundle embed */',
        )
        .replace(
            /importScripts\(\s*["']weedjs_post\.js["']\s*\)\s*;?\s*importScripts\(\s*["']physics_host\.impl\.js["']\s*\)/,
            '/* weedjs_post + physics_host preloaded for bundle embed */',
        )
        .replace(
            /importScripts\(\s*["']weedjsPost\.js["']\s*\)/,
            '/* weedjsPost preloaded for bundle embed */',
        )
        .replace(
            /importScripts\(\s*["']weedjs_post\.js["']\s*\)/,
            '/* weedjs_post preloaded for bundle embed */',
        );

    return (
        `(function(global){\n` +
        `  var Module = global.Module || {};\n` +
        wasmEmbed +
        `  global.Module = Module;\n` +
        `  var __weedBox2dScripts = ${JSON.stringify(box2dSiblingScripts)};\n` +
        `  var __weedBox2dBlobs = Object.create(null);\n` +
        `  var __importScripts = global.importScripts.bind(global);\n` +
        `  global.importScripts = function() {\n` +
        `    var args = Array.prototype.slice.call(arguments).map(function(u) {\n` +
        `      var name = String(u).split("/").pop().split("?")[0];\n` +
        `      if (__weedBox2dScripts[name]) {\n` +
        `        if (!__weedBox2dBlobs[name]) {\n` +
        `          __weedBox2dBlobs[name] = URL.createObjectURL(\n` +
        `            new Blob([__weedBox2dScripts[name]], { type: "application/javascript" })\n` +
        `          );\n` +
        `        }\n` +
        `        return __weedBox2dBlobs[name];\n` +
        `      }\n` +
        `      return u;\n` +
        `    });\n` +
        `    return __importScripts.apply(global, args);\n` +
        `  };\n` +
        `  if (global.name !== "em-pthread") {\n` +
        `    global.importScripts("weedjsPost.js");\n` +
        `    global.importScripts("physicsHostImpl.js");\n` +
        `    var __weedReady = Module["onRuntimeInitialized"];\n` +
        `    Module["onRuntimeInitialized"] = function () {\n` +
        `      if (typeof __weedReady === "function") __weedReady();\n` +
        `    };\n` +
        `  }\n` +
        `})(typeof self !== "undefined" ? self : this);\n` +
        box2dGluePatched
    );
}

/**
 * Webpack emits `new URL('./engine.wasm', import.meta.url)` (src/wasm/engine.js, every kernel in one module) as
 * `new URL(publicPath + "hash.wasm", scriptBase)`. Blob workers set scriptBase
 * to `blob:.../../../`, and `new URL` throws. Inline the bytes as a data URL
 * so the constructor gets an absolute URL and the worker never fetches. Gzipped,
 * as Box2D's wasm is: engine.wasm is 235 KB raw, 59 KB gzipped (loadWasmKernel
 * inflates a data:application/gzip URL with DecompressionStream). The module that
 * names it is shared by the workers, so it lands once, in their common chunk.
 */
const WASM_ASSET_PATTERN = /[A-Za-z_$][\w$]*\.p\s*\+\s*(["'])([^"']+\.wasm)\1/g;

/** The wasm assets a webpack output names through its public path (`x.p+"<hash>.wasm"`), relative to that path. */
export function wasmAssetNames(source) {
    return [...new Set([...source.matchAll(WASM_ASSET_PATTERN)].map((m) => m[2]))];
}

function resolveWasmAsset(rel, label, dir = distDir) {
    const filePath = path.join(dir, rel);
    const fallback = path.join(dir, path.basename(rel));
    const resolved = fs.existsSync(filePath) ? filePath : fallback;
    if (!fs.existsSync(resolved)) {
        throw new Error(`Wasm asset missing (${label}): ${rel}`);
    }
    return resolved;
}

let inlinedWasmAssets = 0;
function inlineWorkerWasmAssets(source, label) {
    let inlined = 0;
    const next = source.replace(WASM_ASSET_PATTERN, (_match, _quote, rel) => {
        inlined++;
        const b64 = zlib.gzipSync(fs.readFileSync(resolveWasmAsset(rel, label)), { level: 9 }).toString('base64');
        return JSON.stringify(`data:application/gzip;base64,${b64}`);
    });
    inlinedWasmAssets += inlined;
    if (inlined) console.log(`   inlined ${inlined} wasm asset(s) into ${label}`);
    return next;
}

/**
 * Where engine.wasm's data URL (the one inlineWorkerWasmAssets wrote) sits in the workers' common code, so the page
 * reads it from there (WEED.EngineWasmUrl, SST-2: the page compiles the module once) without a second copy in the
 * bundle. The engine's module among the data URLs is the one whose bytes are `engineWasmBytes`.
 * @returns {{ at: number, length: number }} the URL is source.slice(at, at + length)
 */
export function engineWasmDataUrlSpan(source, engineWasmBytes) {
    for (const m of source.matchAll(/(["'])(data:application\/gzip;base64,[A-Za-z0-9+/=]+)\1/g)) {
        const bytes = zlib.gunzipSync(Buffer.from(m[2].slice(m[2].indexOf(',') + 1), 'base64'));
        if (bytes.equals(engineWasmBytes)) return { at: m.index + 1, length: m[2].length };
    }
    throw new Error("engine.wasm's data URL is not in the workers' common code: the page could not compile it once");
}

/**
 * Engine shaders by the path pixiWorker fetches them from (/src/shaders/…).
 * npm installs ship dist/ only, so bundles carry them.
 */
export function readEngineShaders() {
    const dir = path.join(rootDir, 'src', 'shaders');
    const shaders = {};
    for (const name of fs.readdirSync(dir).sort()) {
        shaders['/src/shaders/' + name] = fs.readFileSync(path.join(dir, name), 'utf8');
    }
    return shaders;
}

function readWorkerArtifacts() {
    const workers = {};
    const sizes = {};
    for (const name of WORKER_NAMES) {
        const filePath = path.join(workersDir, `${name}.min.js`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing worker build: ${filePath}`);
        }
        workers[name] = inlineWorkerWasmAssets(fs.readFileSync(filePath, 'utf8'), name);
        sizes[name] = Buffer.byteLength(workers[name], 'utf8');
    }

    const commonPath = path.join(workersDir, 'worker_common.min.js');
    let workerCommon = '';
    if (fs.existsSync(commonPath)) {
        workerCommon = inlineWorkerWasmAssets(fs.readFileSync(commonPath, 'utf8'), 'worker_common');
        sizes.worker_common = Buffer.byteLength(workerCommon, 'utf8');
    } else {
        console.warn('   WARN: workers/worker_common.min.js missing — workers not deduped');
        sizes.worker_common = 0;
    }
    if (inlinedWasmAssets < 1) {
        throw new Error(
            'No worker artifact has a publicPath wasm asset to inline (engine.wasm). ' +
            'new URL(import.meta.url) would throw inside the blob workers.',
        );
    }
    const engineWasmSpan = engineWasmDataUrlSpan(
        workerCommon,
        fs.readFileSync(path.join(rootDir, 'src', 'wasm', 'engine.wasm')),
    );

    return { workers, workerCommon, engineWasmSpan, sizes };
}

function embedPayload(text, compressed) {
    return compressed ? gzipB64(text) : text;
}

export function rewriteWorkerCommonImportScripts(source, commonUrl) {
    if (!commonUrl || !source) return source;
    // Webpack emits importScripts(require.p + require.u(id)).
    // u() returns "workers/worker_common.min.js" and p is scriptUrl + "../".
    // Terser mangles the require binding and the parameter (i.u=t=>"..."), so
    // match the property names only. Blob workers have no script directory:
    // point u() at the common blob URL and clear publicPath.
    var code = source.replace(
        /\.u\s*=\s*[A-Za-z_$][\w$]*\s*=>\s*"[^"]*worker_common[^"]*"/g,
        '.u=chunkId=>' + JSON.stringify(commonUrl)
    );
    code = code.replace(
        /\.p\s*=\s*[A-Za-z_$][\w$]*\s*\+\s*"\.\.\/"/g,
        '.p=""'
    );
    return code;
}

/**
 * The global a file-mode worker reads its folder from (its public path: workers/, the shared chunk, the wasm).
 * The file mode starts each engine worker from a blob that sets it and importScripts the worker's file: the engine
 * tells the bundle's workers by their blob URL (game scripts are evaluated from their text, not import()ed, since
 * a worker has no import map), and webpack's runtime, which takes its public path from the worker's own URL, would
 * read the blob's.
 */
export const FILE_MODE_FOLDER_GLOBAL = '__weedWorkerFolder';

/**
 * A worker entry of webpack.config.js for the file mode: its public path (the script's folder + "../") becomes the
 * folder the starting blob names, or the script's folder + "../" when started from its own URL.
 * @returns {{ code: string, count: number }} count: the public paths rewritten (each entry has exactly one)
 */
export function rewriteWorkerPublicPathForFileMode(source) {
    let count = 0;
    const code = source.replace(/\.p\s*=\s*([A-Za-z_$][\w$]*)\s*\+\s*"\.\.\/"/g, (_match, scriptFolder) => {
        count++;
        return `.p=self.${FILE_MODE_FOLDER_GLOBAL}||${scriptFolder}+"../"`;
    });
    return { code, count };
}

export function writeBundleEntry({
    workers,
    workerCommon,
    engineWasmSpan,
    box2dWorkerSource,
    audioWorkletSource,
    debugUICSS,
    engineShaders,
    compressed,
    prod,
}) {
    // N-172: compressed, every payload goes into one gzip stream, sliced back by its lengths at run time: one base64
    // decode, one DecompressionStream and one TextDecoder instead of one each for every worker and shader (a page's
    // repeat visit started 25-30 ms later with them inflated one by one). Uncompressed, the strings sit in the entry.
    const css = prod ? '' : debugUICSS;
    const parts = [
        ...WORKER_NAMES.map((name) => [`w:${name}`, workers[name]]),
        ['common', workerCommon],
        ['box2d', box2dWorkerSource],
        ['audio', audioWorkletSource],
        ['css', css],
        ...Object.entries(engineShaders).map(([shaderPath, source]) => [`s:${shaderPath}`, source]),
    ];
    const packed = compressed ? embedPayload(parts.map(([, text]) => text).join(''), true) : '';
    const packedIndex = compressed ? parts.map(([key, text]) => [key, text.length]) : [];
    const inline = (text) => (compressed ? '' : text);
    const embeddedWorkers = {};
    for (const name of WORKER_NAMES) {
        embeddedWorkers[name] = inline(workers[name]);
    }
    const embeddedCommon = inline(workerCommon);
    const embeddedBox2d = inline(box2dWorkerSource);
    const embeddedAudio = inline(audioWorkletSource);
    const embeddedCss = inline(css);
    const embeddedShaders = {};
    for (const [shaderPath, source] of Object.entries(engineShaders)) {
        embeddedShaders[shaderPath] = inline(source);
    }

    const workerSourceLines = WORKER_NAMES.map(
        (name) => `  ${name}: ${JSON.stringify(embeddedWorkers[name])},`,
    ).join('\n');

    return `/**
 * WeedJS Single-File Bundle Entry Point
 * Workers + Box2D classic physics host are embedded as strings in WEED.*
 * AUTO-GENERATED - DO NOT EDIT
 */

import WEED_BASE from './index.js';
export * from './index.js';

let workerSources = Object.freeze({
${workerSourceLines}
});

let workerCommonSource = ${JSON.stringify(embeddedCommon)};
let box2dWorkerSource = ${JSON.stringify(embeddedBox2d)};
let audioWorkletSource = ${JSON.stringify(embeddedAudio)};
let debugUICSS = ${JSON.stringify(embeddedCss)};
let engineShaders = Object.freeze(${JSON.stringify(embeddedShaders)});
// engine.wasm's gzipped data URL inside workerCommonSource (once inflated): WEED.EngineWasmUrl.
const ENGINE_WASM_URL_AT = ${engineWasmSpan.at};
const ENGINE_WASM_URL_LENGTH = ${engineWasmSpan.length};

const EMBED_COMPRESSED = ${compressed ? 'true' : 'false'};
// Every payload in one gzip stream (base64), and each one's [key, length] in the order they were joined.
const EMBED_PACKED = ${JSON.stringify(packed)};
const EMBED_INDEX = ${JSON.stringify(packedIndex)};
let embedReady = !EMBED_COMPRESSED;
let embedPromise = null;
let box2dWorkerBlobUrl = null;
let workerCommonBlobUrl = null;

${rewriteWorkerCommonImportScripts.toString()}

function weedB64ToU8(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function weedGunzipUtf8(b64) {
  if (!b64) return Promise.resolve('');
  if (typeof DecompressionStream === 'undefined') {
    return Promise.reject(new Error('DecompressionStream required for Weed embed'));
  }
  var stream = new Blob([weedB64ToU8(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer().then(function (buf) {
    return new TextDecoder().decode(buf);
  });
}

function ensureEmbeddedSources() {
  if (embedReady) return Promise.resolve();
  if (embedPromise) return embedPromise;
  embedPromise = (async function () {
    var text = await weedGunzipUtf8(EMBED_PACKED);
    var workers = {};
    var shaders = {};
    var at = 0;
    for (var i = 0; i < EMBED_INDEX.length; i++) {
      var key = EMBED_INDEX[i][0];
      var value = text.slice(at, at + EMBED_INDEX[i][1]);
      at += EMBED_INDEX[i][1];
      if (key.slice(0, 2) === 'w:') workers[key.slice(2)] = value;
      else if (key.slice(0, 2) === 's:') shaders[key.slice(2)] = value;
      else if (key === 'common') workerCommonSource = value;
      else if (key === 'box2d') box2dWorkerSource = value;
      else if (key === 'audio') audioWorkletSource = value;
      else if (key === 'css') debugUICSS = value;
    }
    workerSources = Object.freeze(workers);
    engineShaders = Object.freeze(shaders);
    embedReady = true;
  })();
  return embedPromise;
}

const WEED = Object.freeze({
  ...WEED_BASE,
  // The spread would freeze the value of the moment: loadScene's { params } changes it.
  get params() { return WEED_BASE.params; },
  get WorkerSources() { return workerSources; },
  get WorkerCommonSource() { return workerCommonSource; },
  get Box2dWorkerSource() { return box2dWorkerSource; },
  get AudioWorkletSource() { return audioWorkletSource; },
  get DebugUICSS() { return debugUICSS; },
  /** Engine shader sources by /src/shaders/… path, for the renderer worker. */
  get EngineShaders() { return engineShaders; },
  /**
   * engine.wasm as the gzipped data URL the workers carry, for the page to compile it once (SST-2); null until
   * ensureEmbeddedSources() has inflated a compressed bundle.
   */
  get EngineWasmUrl() {
    return embedReady ? workerCommonSource.slice(ENGINE_WASM_URL_AT, ENGINE_WASM_URL_AT + ENGINE_WASM_URL_LENGTH) : null;
  },
  BUNDLE_MODE: true,
  EMBED_COMPRESSED,
  ensureEmbeddedSources,
  createWorker(workerName) {
    if (!embedReady) {
      throw new Error('WEED.ensureEmbeddedSources() must finish before createWorker');
    }
    const source = workerSources[workerName];
    if (!source) {
      throw new Error('Unknown worker: ' + workerName + '. Available: ' + Object.keys(workerSources).join(', '));
    }
    if (workerCommonSource && !workerCommonBlobUrl) {
      workerCommonBlobUrl = URL.createObjectURL(
        new Blob([workerCommonSource], { type: 'application/javascript' })
      );
    }
    const code = rewriteWorkerCommonImportScripts(source, workerCommonBlobUrl);
    const blob = new Blob([code], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  },
  /** Absolute blob: URL for classic Box2D physics host (pthreads re-fetch same URL). */
  getBox2dWorkerUrl() {
    if (!embedReady) {
      throw new Error('WEED.ensureEmbeddedSources() must finish before getBox2dWorkerUrl');
    }
    if (!box2dWorkerBlobUrl) {
      box2dWorkerBlobUrl = URL.createObjectURL(
        new Blob([box2dWorkerSource], { type: 'application/javascript' })
      );
    }
    return box2dWorkerBlobUrl;
  },
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

// N-172: the inflation starts as the bundle loads, so the first scene finds it done (or nearly): a failure is seen by
// whoever awaits ensureEmbeddedSources(), not left unhandled here.
if (EMBED_COMPRESSED) ensureEmbeddedSources().catch(function () {});

export default WEED;
`;
}

/**
 * File mode, at run time (written into the page's bundle): the URL of one of the bundle's files, `file` relative to
 * the folder the bundle was loaded from. With `pageOrigin`, a file the page could not start as a worker (a bundle
 * loaded from another origin, a CDN) stops with what to use instead, rather than with new Worker's SecurityError.
 */
export function weedFileModeUrl(file, bundleFolderUrl, pageOrigin) {
  const url = new URL(file, bundleFolderUrl);
  if (pageOrigin && url.origin !== pageOrigin) {
    throw new Error(
      'WeedJS: this bundle starts its workers from the files beside it (' + url.href + '), and a browser starts a ' +
      'worker only from the page\'s own origin (' + pageOrigin + '). Serve the bundle\'s folder with the page, or ' +
      'load the single-file bundle (dist/weed*.min.js) from another origin.'
    );
  }
  return url.href;
}

/**
 * The file mode's files for one build (debug or prod): webpack's worker build in its own layout (workers/<name>.min.js,
 * workers/worker_common.min.js, and the wasm assets they name at its root, which their public path reaches), each
 * entry's public path read from the starting blob (rewriteWorkerPublicPathForFileMode), and Box2D's worker as one
 * script with box2dWasm.wasm beside it (box2d/). The folder is
 * named by a hash of its files, so a host may cache them for good and a new build never mixes with an old one.
 * `workerBuildDir` is where webpack.config.js wrote the workers, `outDir` the file mode's folder, `engineWasmBytes`
 * the engine's module among the wasm assets (tests pass others).
 * @returns {{ dirName: string, workerFiles: Record<string, string>, box2dWorkerFile: string, engineWasmFile: string }}
 *   paths from outDir
 */
export function writeFileModeFolder({
    prod,
    box2dFileSource,
    workerBuildDir = distDir,
    outDir = path.join(distDir, FILE_MODE_DIR),
    engineWasmBytes = fs.readFileSync(path.join(rootDir, 'src', 'wasm', 'engine.wasm')),
}) {
    const files = new Map();
    for (const name of [...WORKER_NAMES, 'worker_common']) {
        const rel = `workers/${name}.min.js`;
        const abs = path.join(workerBuildDir, rel);
        if (!fs.existsSync(abs)) {
            if (name === 'worker_common') continue;
            throw new Error(`Missing worker build: ${abs}`);
        }
        if (name === 'worker_common') {
            files.set(rel, fs.readFileSync(abs));
            continue;
        }
        const { code, count } = rewriteWorkerPublicPathForFileMode(fs.readFileSync(abs, 'utf8'));
        // An entry that loads the shared chunk (or names an asset) has one public path; a self-contained one (an
        // asset worker) may have none.
        const needsPublicPath = code.includes('importScripts(') || wasmAssetNames(code).length > 0;
        if (count > 1 || (count === 0 && needsPublicPath)) {
            throw new Error(`${rel}: ${count} public paths (scriptUrl + "../") to point at the file mode's folder, expected 1`);
        }
        files.set(rel, Buffer.from(code, 'utf8'));
    }
    let engineWasmRel = null;
    for (const buf of [...files.values()]) {
        for (const rel of wasmAssetNames(buf.toString('utf8'))) {
            const bytes = fs.readFileSync(resolveWasmAsset(rel, 'file mode', workerBuildDir));
            files.set(rel, bytes);
            if (bytes.equals(engineWasmBytes)) engineWasmRel = rel;
        }
    }
    if (!engineWasmRel) throw new Error('file mode: no worker names engine.wasm, so the page could not compile it once');
    files.set('box2d/box2dWasm.js', Buffer.from(box2dFileSource, 'utf8'));
    files.set('box2d/box2dWasm.wasm', fs.readFileSync(path.join(rootDir, 'src', 'box2d', 'box2dWasm.wasm')));

    const hash = crypto.createHash('sha256');
    for (const rel of [...files.keys()].sort()) {
        hash.update(`${rel}\0`);
        hash.update(files.get(rel));
        hash.update('\0');
    }
    const dirName = `${prod ? 'prod' : 'debug'}-${hash.digest('hex').slice(0, 10)}`;
    const dir = path.join(outDir, dirName);
    console.log(`\n📂 File mode: ${dir}`);
    for (const [rel, buf] of files) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), buf);
        console.log(`   ${rel}:${' '.repeat(Math.max(1, 34 - rel.length))}${kb(buf.length)}`);
    }

    const workerFiles = {};
    for (const name of WORKER_NAMES) workerFiles[name] = `${dirName}/workers/${name}.min.js`;
    return {
        dirName,
        workerFiles,
        box2dWorkerFile: `${dirName}/box2d/box2dWasm.js`,
        engineWasmFile: `${dirName}/${engineWasmRel}`,
    };
}

export function writeFileModeBundleEntry({
    workerFiles,
    box2dWorkerFile,
    engineWasmFile,
    audioWorkletSource,
    debugUICSS,
    engineShaders,
    prod,
}) {
    return `/**
 * WeedJS bundle entry, file mode (SST-8, scripts/buildBundle.js --files): the workers, Box2D and engine.wasm are
 * files in a folder beside this bundle, loaded by URL, so the browser can keep them and their compiled code
 * between visits.
 * AUTO-GENERATED - DO NOT EDIT
 */

import WEED_BASE from './index.js';
export * from './index.js';

${weedFileModeUrl.toString()}

// The folder this bundle was loaded from: webpack's automatic public path, found while the bundle is evaluated
// (import.meta.url in the ESM bundle, the script element's src in the UMD one).
const bundleFolderUrl = __webpack_public_path__;
const pageOrigin = typeof location !== 'undefined' ? location.origin : '';
const workerFiles = Object.freeze(${JSON.stringify(workerFiles)});
const box2dWorkerFile = ${JSON.stringify(box2dWorkerFile)};
const workerUrls = {};
for (const name of Object.keys(workerFiles)) workerUrls[name] = weedFileModeUrl(workerFiles[name], bundleFolderUrl, '');
Object.freeze(workerUrls);
const starterUrls = {};
// The workers name the same file (their public path + its hash), so the module the page compiles is theirs.
const engineWasmUrl = weedFileModeUrl(${JSON.stringify(engineWasmFile)}, bundleFolderUrl, '');

const audioWorkletSource = ${JSON.stringify(audioWorkletSource)};
const debugUICSS = ${JSON.stringify(prod ? '' : debugUICSS)};
const engineShaders = Object.freeze(${JSON.stringify(engineShaders)});

const WEED = Object.freeze({
  ...WEED_BASE,
  // The spread would freeze the value of the moment: loadScene's { params } changes it.
  get params() { return WEED_BASE.params; },
  /** The worker files' URLs by worker name (the single-file bundle holds their code here). */
  get WorkerSources() { return workerUrls; },
  get AudioWorkletSource() { return audioWorkletSource; },
  get DebugUICSS() { return debugUICSS; },
  /** Engine shader sources by /src/shaders/… path, for the renderer worker. */
  get EngineShaders() { return engineShaders; },
  /** engine.wasm's file beside the bundle, for the page to compile it once (SST-2), streamed and cacheable. */
  get EngineWasmUrl() { return engineWasmUrl; },
  BUNDLE_MODE: true,
  /** The workers' code comes from files beside the bundle (the file mode), not from strings inside it. */
  BUNDLE_WORKER_FILES: true,
  EMBED_COMPRESSED: false,
  /** Nothing to inflate in the file mode; kept so callers need not tell the modes apart. */
  ensureEmbeddedSources() { return Promise.resolve(); },
  /**
   * The worker starts from a blob that names its folder and importScripts its file: the engine treats a blob worker
   * as the bundle's (game scripts evaluated from their text, as in the single-file bundle), while the code itself
   * comes from the file, which the browser caches.
   */
  createWorker(workerName) {
    const file = workerFiles[workerName];
    if (!file) {
      throw new Error('Unknown worker: ' + workerName + '. Available: ' + Object.keys(workerFiles).join(', '));
    }
    if (!starterUrls[workerName]) {
      const url = weedFileModeUrl(file, bundleFolderUrl, pageOrigin);
      const starter = 'self.${FILE_MODE_FOLDER_GLOBAL}=' + JSON.stringify(new URL('../', url).href) + ';' +
        'importScripts(' + JSON.stringify(url) + ');';
      starterUrls[workerName] = URL.createObjectURL(new Blob([starter], { type: 'application/javascript' }));
    }
    return new Worker(starterUrls[workerName]);
  },
  /** URL of the classic Box2D physics host, started from its file (its pthreads load the same file). */
  getBox2dWorkerUrl() {
    return weedFileModeUrl(box2dWorkerFile, bundleFolderUrl, pageOrigin);
  },
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

export default WEED;
`;
}

/** The file mode's page bundles (UMD and ESM) for one build, into dist/files/ beside their folder. */
function webpackFileModeBundle({ prod, box2dFileSource, audioWorkletSource, debugUICSS, engineShaders }) {
    const folder = writeFileModeFolder({ prod, box2dFileSource });
    const outDir = path.join(distDir, FILE_MODE_DIR);
    const env = { ...makeBuildEnv(prod, false), WEED_BUNDLE_OUT_DIR: outDir, WEED_BUNDLE_WORKER_FILES: 'true' };
    const label = `${prod ? 'prod' : 'debug'} file mode`;
    const bundleEntryPath = path.join(rootDir, 'src', 'index.bundle.js');

    console.log(`\n🔧 Generating bundle entry [${label}]...`);
    fs.writeFileSync(
        bundleEntryPath,
        writeFileModeBundleEntry({ ...folder, audioWorkletSource, debugUICSS, engineShaders, prod }),
    );
    console.log(`🎁 Webpack UMD+ESM [${label}]...`);
    try {
        runWebpack('webpack.bundle.config.js', env);
    } finally {
        fs.rmSync(bundleEntryPath, { force: true });
    }
    const esmOnly = [`${FILE_MODE_DIR}/${bundleFileName({ prod, esm: true, compressed: false })}`];
    return prod ? [`${FILE_MODE_DIR}/${bundleFileName({ prod, esm: false, compressed: false })}`, ...esmOnly] : esmOnly;
}

function printSizeBreakdown(label, sizes, box2dSourceLen) {
    console.log(`\n📐 Embedded payload [${label}]:`);
    if (sizes.worker_common) {
        console.log(`   worker_common:     ${kb(sizes.worker_common)}`);
    }
    for (const name of WORKER_NAMES) {
        const pad = ' '.repeat(Math.max(1, 18 - name.length));
        console.log(`   ${name}:${pad}${kb(sizes[name])}`);
    }
    console.log(`   Box2dWorkerSource: ${kb(box2dSourceLen)}`);
}

function webpackBundle({ prod, compressed, workers, workerCommon, engineWasmSpan, box2dWorkerSource, audioWorkletSource, debugUICSS, engineShaders }) {
    const env = makeBuildEnv(prod, compressed);
    const label = `${prod ? 'prod' : 'debug'} ${compressed ? 'compressed' : 'raw'}`;
    const bundleEntryPath = path.join(rootDir, 'src', 'index.bundle.js');

    console.log(`\n🔧 Generating bundle entry [${label}]...`);
    fs.writeFileSync(
        bundleEntryPath,
        writeBundleEntry({
            workers,
            workerCommon,
            engineWasmSpan,
            box2dWorkerSource,
            audioWorkletSource,
            debugUICSS,
            engineShaders,
            compressed,
            prod,
        }),
    );

    console.log(`🎁 Webpack UMD+ESM [${label}]...`);
    try {
        runWebpack('webpack.bundle.config.js', env);
    } finally {
        // A failed webpack must not leave the generated entry in src/.
        fs.rmSync(bundleEntryPath, { force: true });
    }

    // webpack.bundle.config.js: the production build as UMD and ESM, the debug build as ESM only.
    return prod
        ? [bundleFileName({ prod, esm: false, compressed }), bundleFileName({ prod, esm: true, compressed })]
        : [bundleFileName({ prod, esm: true, compressed })];
}

function buildProdAxis({ prod, box2dWorkerSource, box2dFileSource, audioWorkletSource }) {
    const label = prod ? 'production (no debug)' : 'debug';
    const env = makeBuildEnv(prod, false);
    console.log(`\n🌿 Building WeedJS workers [${label}]...\n`);

    console.log('📦 Step 1: Building workers...');
    runWebpack('webpack.config.js', env);

    console.log('\n📝 Step 2: Reading compiled workers...');
    const { workers, workerCommon, engineWasmSpan, sizes } = readWorkerArtifacts();

    const debugUICSS = prod
        ? ''
        : fs.readFileSync(path.join(rootDir, 'src', 'core', 'debug', 'debugUi.css'), 'utf8');

    const engineShaders = readEngineShaders();

    printSizeBreakdown(label, sizes, Buffer.byteLength(box2dWorkerSource, 'utf8'));

    // N-172 (owner, 2026-11-24 and 11-28): the bundle file itself small, so its workers, glue, CSS and shaders go in
    // gzipped and inflate once at the first scene (ensureEmbeddedSources), as engine.wasm and Box2D always did.
    const names = webpackBundle({
        prod,
        compressed: true,
        workers,
        workerCommon,
        engineWasmSpan,
        box2dWorkerSource,
        audioWorkletSource,
        debugUICSS,
        engineShaders,
    });
    // The file mode, while this build's workers are still in dist/workers/ (the next build writes over them).
    if (box2dFileSource) {
        names.push(...webpackFileModeBundle({ prod, box2dFileSource, audioWorkletSource, debugUICSS, engineShaders }));
    }
    return names;
}

/** Removes what the build left in dist/ but the artifacts; dist/files/ goes too unless this build wrote it. */
function cleanupDistTemps({ keepFileMode = false } = {}) {
    console.log('\n🧹 Cleaning up temporary build files...');

    if (!fs.existsSync(distDir)) return;
    const remove = (rel) => {
        // Windows: an indexer or antivirus can hold a file for a moment.
        fs.rmSync(path.join(distDir, rel), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        console.log('   Removed: dist/' + rel);
    };
    for (const file of fs.readdirSync(distDir)) {
        if (KEEP_DIST_FILES.has(file)) continue;
        if (keepFileMode && file === FILE_MODE_DIR) continue;
        remove(file);
    }
    if (!keepFileMode) return;
    // The page bundles' webpack also writes the assets source builds load by URL (the audio worklet, the debug CSS),
    // which a bundle takes from its own strings: only the bundles and their worker folders stay.
    const keep = new Set(FILE_MODE_ARTIFACTS);
    for (const file of fs.readdirSync(path.join(distDir, FILE_MODE_DIR))) {
        if (keep.has(file) || /^(debug|prod)-[0-9a-f]{10}$/.test(file)) continue;
        remove(`${FILE_MODE_DIR}/${file}`);
    }
}

/**
 * Writes dist/weed-sw.js (or into `dir`), byte for byte from its source.
 * @param {string} [dir]
 * @returns {string} the path written
 */
export function writeIsolationServiceWorker(dir = distDir) {
    const target = path.join(dir, ISOLATION_SERVICE_WORKER_FILE);
    fs.copyFileSync(path.join(rootDir, 'src', 'workers', 'isolationServiceWorker.js'), target);
    return target;
}

function copySmokeTest() {
    console.log('\n🧪 Generating bundle smoke test...');
    const testSrcDir = path.join(rootDir, 'scripts', 'bundle-test');
    if (!fs.existsSync(testSrcDir)) return;
    for (const file of fs.readdirSync(testSrcDir)) {
        fs.copyFileSync(path.join(testSrcDir, file), path.join(distDir, file));
    }
    console.log('   Copied: index.html');
}

function main() {
    const buildFileMode = process.argv.includes('--files');
    console.log(
        '🌿 Building WeedJS single-file bundles (prod ESM + UMD, debug ESM)' +
        (buildFileMode ? ' and the file mode (dist/files/)' : '') + '...\n',
    );

    // The stamps say what dist/ was built from. Drop them before writing
    // anything, so a build that fails halfway leaves no stamp, and distVersion
    // refuses the half-new dist/ instead of trusting the previous stamp.
    fs.rmSync(path.join(distDir, BUILD_STAMP_FILE), { force: true });
    fs.rmSync(path.join(distDir, BUILD_INPUTS_FILE), { force: true });
    // An older file mode never outlives the build that wrote it.
    fs.rmSync(path.join(distDir, FILE_MODE_DIR), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // Hashed before the build reads them: what distVersion.js compares the working tree against.
    const inputs = bundleInputsHash(rootDir);
    // The atlas cache keys a bundle's atlas by the build it came from (src/core/atlas/atlasCache.js); webpack's
    // DefinePlugin reads it from the environment every build below inherits (makeBuildEnv).
    process.env.WEED_BUILD_INPUTS = inputs || '';

    console.log('📦 Preparing shared Box2D embed (gzip → base64)...');
    const box2dWorkerSource = buildBox2dWorkerSource();
    const box2dFileSource = buildFileMode ? buildBox2dWorkerSource({ embedWasm: false }) : null;
    const audioWorkletSource = fs.readFileSync(
        path.join(rootDir, 'src', 'workers', 'audioMixerProcessor.js'),
        'utf8',
    );

    const names = [
        ...buildProdAxis({
            prod: false,
            box2dWorkerSource,
            box2dFileSource,
            audioWorkletSource,
        }),
        ...buildProdAxis({
            prod: true,
            box2dWorkerSource,
            box2dFileSource,
            audioWorkletSource,
        }),
    ];

    cleanupDistTemps({ keepFileMode: buildFileMode });
    copySmokeTest();
    writeIsolationServiceWorker();
    console.log('   Copied: ' + ISOLATION_SERVICE_WORKER_FILE);

    // Exact build stamp. distVersion.js refuses a bench run whose stamp does not
    // match src/version.js, because a stale dist/ measures a different engine
    // than the working tree and nothing in the output says so. Written from the
    // same source syncVersion.js uses, so it cannot drift from src/version.js.
    const stampedVersion = /VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
        fs.readFileSync(path.join(rootDir, 'src', 'version.js'), 'utf8'),
    )?.[1];
    if (!stampedVersion) {
        throw new Error(
            'buildBundle: could not read VERSION from src/version.js. Run: node scripts/syncVersion.js',
        );
    }
    fs.writeFileSync(
        path.join(distDir, BUILD_STAMP_FILE),
        `${stampedVersion}\n`,
    );
    if (inputs) {
        fs.writeFileSync(path.join(distDir, BUILD_INPUTS_FILE), `${inputs}\n`);
    } else {
        console.warn('   Not a git checkout: dist/' + BUILD_INPUTS_FILE + ' not written; freshness cannot be checked.');
    }

    console.log('\n✅ Single-file bundles created!');
    console.log('\n📊 Bundle sizes:');
    for (const name of names) {
        const stats = fs.statSync(path.join(distDir, name));
        const pad = ' '.repeat(Math.max(1, 42 - name.length));
        console.log(`   ${name}:${pad}${kb(stats.size)}`);
    }
    console.log('   (workers share worker_common; WASM gzip in all 3)');
    if (buildFileMode) {
        console.log(`   (${FILE_MODE_DIR}/: the file mode, its workers, Box2D and wasm in ${FILE_MODE_DIR}/debug-<hash>/ and ${FILE_MODE_DIR}/prod-<hash>/)`);
    }
    console.log('   index.html:             Bundle smoke test (?bundle= filename)');
}

// Windows paths compare case-insensitively: `node d:/...` against a `D:\...`
// module path read as "imported", and the build silently did nothing.
const normPath = (p) => {
    const abs = path.normalize(path.resolve(p));
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
};
const isDirectRun = Boolean(process.argv[1]) && normPath(process.argv[1]) === normPath(__filename);

if (isDirectRun) {
    main();
}
