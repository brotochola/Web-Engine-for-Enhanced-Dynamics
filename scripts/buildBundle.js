/**
 * Build script for single-file bundle with inline workers
 *
 * Emits 8 artifacts (UMD/ESM × debug/prod × raw/gzip-embed workers):
 *   weed.bundle.min.js / weed.bundle.esm.min.js
 *   weed.prod.bundle.min.js / weed.prod.bundle.esm.min.js
 *   weed.bundle.compressed.min.js / weed.bundle.esm.compressed.min.js
 *   weed.prod.bundle.compressed.min.js / weed.prod.bundle.esm.compressed.min.js
 *
 * Workers share one worker_common chunk (AbstractWorker graph). Box2D WASM is
 * gzip'd then base64-embedded in every artifact. Compressed artifacts also
 * gzip worker/glue/css strings (inflate via DecompressionStream on first load).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const workersDir = path.join(distDir, 'workers');
const webpackCli = path.join(rootDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js');

if (process.argv.includes('--obfuscate')) process.env.OBFUSCATE = 'true';
const shouldObfuscate = process.env.OBFUSCATE === 'true';

export const WORKER_NAMES = [
    'spatial_worker',
    'logic_worker',
    'pixi_worker',
    'particle_worker',
    'pre_render_worker',
];

export const BUNDLE_ARTIFACTS = [
    'weed.bundle.min.js',
    'weed.bundle.esm.min.js',
    'weed.prod.bundle.min.js',
    'weed.prod.bundle.esm.min.js',
    'weed.bundle.compressed.min.js',
    'weed.bundle.esm.compressed.min.js',
    'weed.prod.bundle.compressed.min.js',
    'weed.prod.bundle.esm.compressed.min.js',
];

const KEEP_DIST_FILES = new Set([...BUNDLE_ARTIFACTS, 'index.html']);

const BOX2D_ALWAYS_SIBLINGS = ['weedjs_post.js', 'physics_host.impl.js'];

/** Quoted .js filenames in the first importScripts(...) of a classic script. */
export function extractImportScriptNames(source) {
    const match = source.match(/importScripts\s*\(([\s\S]*?)\)/);
    if (!match) return [];
    return [...match[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map((m) => m[1].split('/').pop());
}

/** Box2D blob-remap list: glue + every file weedjs_post importScripts. */
export function listBox2dSiblingNames(weedPostSource) {
    return [...new Set([...BOX2D_ALWAYS_SIBLINGS, ...extractImportScriptNames(weedPostSource)])];
}

export function bundleFileName({ prod, esm, compressed }) {
    const parts = ['weed'];
    if (prod) parts.push('prod');
    parts.push('bundle');
    if (esm) parts.push('esm');
    if (compressed) parts.push('compressed');
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

function makeBuildEnv(prod, compressed) {
    return {
        ...process.env,
        OBFUSCATE: shouldObfuscate ? 'true' : 'false',
        WEED_PROD: prod ? 'true' : 'false',
        WEED_COMPRESSED: compressed ? 'true' : 'false',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192']
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

function buildBox2dWorkerSource() {
    const box2dDir = path.join(rootDir, 'src', 'box2d');
    const weedPostPath = path.join(box2dDir, 'weedjs_post.js');
    const weedPostSource = fs.readFileSync(weedPostPath, 'utf8');
    const siblingNames = listBox2dSiblingNames(weedPostSource);

    const box2dSiblingScripts = {};
    for (const name of siblingNames) {
        const filePath = path.join(box2dDir, name);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Box2D sibling missing: ${filePath}`);
        }
        box2dSiblingScripts[name] =
            name === 'weedjs_post.js' ? weedPostSource : fs.readFileSync(filePath, 'utf8');
    }

    const box2dGlue = fs.readFileSync(path.join(box2dDir, 'box2d_wasm.js'), 'utf8');
    const wasmBytes = fs.readFileSync(path.join(box2dDir, 'box2d_wasm.wasm'));
    const gzipped = zlib.gzipSync(wasmBytes, { level: 9 });
    const box2dWasmGzipB64 = gzipped.toString('base64');

    console.log(
        `   Box2D wasm: ${kb(wasmBytes.length)} raw → ${kb(gzipped.length)} gzip → ` +
            `${kb(Buffer.byteLength(box2dWasmGzipB64, 'utf8'))} base64`,
    );
    console.log(`   Box2D siblings: ${siblingNames.join(', ')}`);

    const box2dGluePatched = box2dGlue.replace(
        /importScripts\(\s*["']weedjs_post\.js["']\s*\)\s*;?\s*importScripts\(\s*["']physics_host\.impl\.js["']\s*\)/,
        '/* weedjs_post + physics_host preloaded for bundle embed */',
    ).replace(
        /importScripts\(\s*["']weedjs_post\.js["']\s*\)/,
        '/* weedjs_post preloaded for bundle embed */',
    );

    // gzip-before-base64; inflate async via DecompressionStream, then instantiate.
    return (
        `(function(global){\n` +
        `  var Module = global.Module || {};\n` +
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
        `  Module["instantiateWasm"] = function(info, receiveInstance) {\n` +
        `    return __weedGunzip(__weedB64ToU8(__weedWasmGzipB64)).then(function(wasmBinary) {\n` +
        `      return WebAssembly.instantiate(wasmBinary, info).then(function(result) {\n` +
        `        receiveInstance(result.instance, result.module);\n` +
        `        return result.instance.exports;\n` +
        `      });\n` +
        `    });\n` +
        `  };\n` +
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
        `    global.importScripts("weedjs_post.js");\n` +
        `    global.importScripts("physics_host.impl.js");\n` +
        `    var __weedReady = Module["onRuntimeInitialized"];\n` +
        `    Module["onRuntimeInitialized"] = function () {\n` +
        `      if (typeof __weedReady === "function") __weedReady();\n` +
        `    };\n` +
        `  }\n` +
        `})(typeof self !== "undefined" ? self : this);\n` +
        box2dGluePatched
    );
}

function readWorkerArtifacts() {
    const workers = {};
    const sizes = {};
    for (const name of WORKER_NAMES) {
        const filePath = path.join(workersDir, `${name}.min.js`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing worker build: ${filePath}`);
        }
        workers[name] = fs.readFileSync(filePath, 'utf8');
        sizes[name] = Buffer.byteLength(workers[name], 'utf8');
    }

    const commonPath = path.join(workersDir, 'worker_common.min.js');
    let workerCommon = '';
    if (fs.existsSync(commonPath)) {
        workerCommon = fs.readFileSync(commonPath, 'utf8');
        sizes.worker_common = Buffer.byteLength(workerCommon, 'utf8');
    } else {
        console.warn('   WARN: workers/worker_common.min.js missing — workers not deduped');
        sizes.worker_common = 0;
    }

    return { workers, workerCommon, sizes };
}

function embedPayload(text, compressed) {
    return compressed ? gzipB64(text) : text;
}

function writeBundleEntry({
    workers,
    workerCommon,
    box2dWorkerSource,
    audioWorkletSource,
    debugUICSS,
    compressed,
}) {
    const embeddedWorkers = {};
    for (const name of WORKER_NAMES) {
        embeddedWorkers[name] = embedPayload(workers[name], compressed);
    }
    const embeddedCommon = embedPayload(workerCommon, compressed);
    const embeddedBox2d = embedPayload(box2dWorkerSource, compressed);
    const embeddedAudio = embedPayload(audioWorkletSource, compressed);
    const embeddedCss = embedPayload(debugUICSS, compressed);

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

const EMBED_COMPRESSED = ${compressed ? 'true' : 'false'};
let embedReady = !EMBED_COMPRESSED;
let embedPromise = null;
let box2dWorkerBlobUrl = null;
let workerCommonBlobUrl = null;

function rewriteWorkerCommonImportScripts(source, commonUrl) {
  if (!commonUrl || !source) return source;
  // Webpack emits: importScripts(__webpack_require__.p + __webpack_require__.u(id))
  // with u() => "workers/worker_common.min.js" and p = scriptUrl + "../".
  // Blob workers have no useful script directory, so point u() at the common
  // blob URL and clear publicPath.
  var code = source.replace(
    /__webpack_require__\\.u\\s*=\\s*chunkId\\s*=>\\s*"[^"]*worker_common[^"]*"/g,
    '__webpack_require__.u=chunkId=>' + JSON.stringify(commonUrl)
  );
  code = code.replace(
    /__webpack_require__\\.p\\s*=\\s*scriptUrl\\s*\\+\\s*"\\.\\.\\/"/g,
    '__webpack_require__.p=""'
  );
  return code;
}

function weedB64ToU8(b64) {
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
    var names = Object.keys(workerSources);
    var values = await Promise.all(names.map(function (name) {
      return weedGunzipUtf8(workerSources[name]);
    }));
    var inflated = {};
    for (var i = 0; i < names.length; i++) inflated[names[i]] = values[i];
    workerSources = Object.freeze(inflated);
    workerCommonSource = await weedGunzipUtf8(workerCommonSource);
    box2dWorkerSource = await weedGunzipUtf8(box2dWorkerSource);
    audioWorkletSource = await weedGunzipUtf8(audioWorkletSource);
    debugUICSS = await weedGunzipUtf8(debugUICSS);
    embedReady = true;
  })();
  return embedPromise;
}

const WEED = Object.freeze({
  ...WEED_BASE,
  get WorkerSources() { return workerSources; },
  get WorkerCommonSource() { return workerCommonSource; },
  get Box2dWorkerSource() { return box2dWorkerSource; },
  get AudioWorkletSource() { return audioWorkletSource; },
  get DebugUICSS() { return debugUICSS; },
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

export default WEED;
`;
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

function webpackBundle({ prod, compressed, workers, workerCommon, box2dWorkerSource, audioWorkletSource, debugUICSS }) {
    const env = makeBuildEnv(prod, compressed);
    const label = `${prod ? 'prod' : 'debug'} ${compressed ? 'compressed' : 'raw'}`;
    const bundleEntryPath = path.join(rootDir, 'src', 'index.bundle.js');

    console.log(`\n🔧 Generating bundle entry [${label}]...`);
    fs.writeFileSync(
        bundleEntryPath,
        writeBundleEntry({
            workers,
            workerCommon,
            box2dWorkerSource,
            audioWorkletSource,
            debugUICSS,
            compressed,
        }),
    );

    console.log(`🎁 Webpack UMD+ESM [${label}]...`);
    runWebpack('webpack.bundle.config.js', env);
    fs.unlinkSync(bundleEntryPath);

    return [
        bundleFileName({ prod, esm: false, compressed }),
        bundleFileName({ prod, esm: true, compressed }),
    ];
}

function buildProdAxis({ prod, box2dWorkerSource, audioWorkletSource }) {
    const label = prod ? 'production (no debug)' : 'debug';
    const env = makeBuildEnv(prod, false);
    console.log(`\n🌿 Building WeedJS workers [${label}]...\n`);

    console.log('📦 Step 1: Building workers...');
    runWebpack('webpack.config.js', env);

    console.log('\n📝 Step 2: Reading compiled workers...');
    const { workers, workerCommon, sizes } = readWorkerArtifacts();

    const debugUICSS = prod
        ? ''
        : fs.readFileSync(path.join(rootDir, 'src', 'core', 'debug', 'DebugUI.css'), 'utf8');

    printSizeBreakdown(label, sizes, Buffer.byteLength(box2dWorkerSource, 'utf8'));

    const names = [];
    for (const compressed of [false, true]) {
        names.push(
            ...webpackBundle({
                prod,
                compressed,
                workers,
                workerCommon,
                box2dWorkerSource,
                audioWorkletSource,
                debugUICSS,
            }),
        );
    }
    return names;
}

function cleanupDistTemps() {
    console.log('\n🧹 Cleaning up temporary build files...');

    if (fs.existsSync(workersDir)) {
        fs.rmSync(workersDir, { recursive: true });
        console.log('   Removed: dist/workers/');
    }

    const weedMinPath = path.join(distDir, 'weed.min.js');
    if (fs.existsSync(weedMinPath)) {
        fs.unlinkSync(weedMinPath);
        console.log('   Removed: dist/weed.min.js');
    }

    if (!fs.existsSync(distDir)) return;
    for (const file of fs.readdirSync(distDir)) {
        if (KEEP_DIST_FILES.has(file)) continue;
        if (file.endsWith('.css') || file.endsWith('.js')) {
            fs.unlinkSync(path.join(distDir, file));
            console.log('   Removed: dist/' + file);
        }
    }
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
    console.log('🌿 Building WeedJS single-file bundles (debug + prod, raw + compressed)...\n');

    console.log('📦 Preparing shared Box2D embed (gzip → base64)...');
    const box2dWorkerSource = buildBox2dWorkerSource();
    const audioWorkletSource = fs.readFileSync(
        path.join(rootDir, 'src', 'workers', 'AudioMixerProcessor.js'),
        'utf8',
    );

    const names = [
        ...buildProdAxis({
            prod: false,
            box2dWorkerSource,
            audioWorkletSource,
        }),
        ...buildProdAxis({
            prod: true,
            box2dWorkerSource,
            audioWorkletSource,
        }),
    ];

    cleanupDistTemps();
    copySmokeTest();

    console.log('\n✅ Single-file bundles created!');
    console.log('\n📊 Bundle sizes:');
    for (const name of names) {
        const stats = fs.statSync(path.join(distDir, name));
        const pad = ' '.repeat(Math.max(1, 42 - name.length));
        console.log(`   ${name}:${pad}${kb(stats.size)}`);
    }
    console.log('   (workers share worker_common; WASM gzip in all 8; .compressed gzip-embeds worker JS)');
    console.log('   index.html:             Bundle smoke test (?bundle= filename)');
}

const isDirectRun =
    Boolean(process.argv[1]) &&
    path.normalize(path.resolve(process.argv[1])) === path.normalize(__filename);

if (isDirectRun) {
    main();
}
