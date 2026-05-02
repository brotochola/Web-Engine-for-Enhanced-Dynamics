/**
 * Build script for single-file bundle with inline workers
 *
 * This script:
 * 1. Builds workers as separate minified files
 * 2. Reads them as strings
 * 3. Generates index.bundle.js that includes workers in WEED.WorkerSources
 * 4. Builds the final single-file bundle
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Support both env (cross-env) and --obfuscate flag so it works on Windows
if (process.argv.includes('--obfuscate')) process.env.OBFUSCATE = 'true';
const shouldObfuscate = process.env.OBFUSCATE === 'true';
const isProd = process.env.WEED_PROD === 'true';

const buildLabel = isProd ? 'production (no debug)' : 'development';
console.log(`🌿 Building WeedJS single-file bundle [${buildLabel}]...\n`);

// Webpack + terser-webpack-plugin spawns N worker threads (default = cpus-1).
// On machines with many cores, each terser worker gets V8's default ~2GB heap
// and one of them OOMs while minifying the worker bundles (which inline
// pixi_8.16_.min.js + the whole src/ tree per worker entry).
// Bumping NODE_OPTIONS gives the parent process headroom; the parallel cap
// in webpack.config.js bounds peak memory across worker threads.
const buildEnv = {
    ...process.env,
    OBFUSCATE: shouldObfuscate ? 'true' : 'false',
    WEED_PROD: isProd ? 'true' : 'false',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=8192']
        .filter(Boolean)
        .join(' '),
};

// Invoke webpack-cli directly via Node, bypassing `npx`. Going through npx
// (which is `npm exec`) re-enters npm and surfaces noisy "Unknown env config"
// warnings for any pnpm-only or scope-registry env vars propagated by the
// caller. Calling cli.js directly skips the npm subshell entirely.
const webpackCli = path.join(rootDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
function runWebpack(configFile) {
    execSync(`node "${webpackCli}" --config ${configFile}`, {
        cwd: rootDir,
        stdio: 'inherit',
        env: buildEnv,
    });
}

// Step 1: Build workers first
console.log('📦 Step 1: Building workers...');
runWebpack('webpack.config.js');

// Step 2: Read compiled workers as strings
console.log('\n📝 Step 2: Reading compiled workers...');
const workersDir = path.join(rootDir, 'dist', 'workers');
const workers = {
    spatial_worker: fs.readFileSync(path.join(workersDir, 'spatial_worker.min.js'), 'utf8'),
    logic_worker: fs.readFileSync(path.join(workersDir, 'logic_worker.min.js'), 'utf8'),
    physics_worker: fs.readFileSync(path.join(workersDir, 'physics_worker.min.js'), 'utf8'),
    pixi_worker: fs.readFileSync(path.join(workersDir, 'pixi_worker.min.js'), 'utf8'),
    particle_worker: fs.readFileSync(path.join(workersDir, 'particle_worker.min.js'), 'utf8'),
    pre_render_worker: fs.readFileSync(path.join(workersDir, 'pre_render_worker.min.js'), 'utf8'),
};

// Read AudioWorklet processor source (embedded so SoundManager can create one at runtime)
const audioWorkletSource = fs.readFileSync(
    path.join(rootDir, 'src', 'workers', 'AudioMixerProcessor.js'), 'utf8'
);

// Read DebugUI CSS (embedded so _injectStyles works without fetching a separate file)
// In prod mode the debug overlay is stubbed out, so we skip the CSS entirely.
const debugUICSS = isProd
    ? ''
    : fs.readFileSync(path.join(rootDir, 'src', 'core', 'debug', 'DebugUI.css'), 'utf8');

// Step 3: Generate bundle entry with workers embedded in WEED
console.log('🔧 Step 3: Generating bundle entry with embedded workers...');

const bundleEntryCode = `
/**
 * WeedJS Single-File Bundle Entry Point
 * Workers are embedded as strings in WEED.WorkerSources
 * AUTO-GENERATED - DO NOT EDIT
 */

import WEED_BASE from './index.js';
export * from './index.js';

const WorkerSources = Object.freeze({
  spatial_worker: ${JSON.stringify(workers.spatial_worker)},
  logic_worker: ${JSON.stringify(workers.logic_worker)},
  physics_worker: ${JSON.stringify(workers.physics_worker)},
  pixi_worker: ${JSON.stringify(workers.pixi_worker)},
  particle_worker: ${JSON.stringify(workers.particle_worker)},
  pre_render_worker: ${JSON.stringify(workers.pre_render_worker)},
});

const WEED = Object.freeze({
  ...WEED_BASE,
  WorkerSources,
  AudioWorkletSource: ${JSON.stringify(audioWorkletSource)},
  DebugUICSS: ${JSON.stringify(debugUICSS)},
  BUNDLE_MODE: true,
  createWorker(workerName) {
    const source = WorkerSources[workerName];
    if (!source) {
      throw new Error('Unknown worker: ' + workerName + '. Available: ' + Object.keys(WorkerSources).join(', '));
    }
    const blob = new Blob([source], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  },
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

export default WEED;
`;

const bundleEntryPath = path.join(rootDir, 'src', 'index.bundle.js');
fs.writeFileSync(bundleEntryPath, bundleEntryCode);
console.log('   Created: src/index.bundle.js');

// Step 4: Build final bundle
console.log('\n🎁 Step 4: Building final bundle...');
runWebpack('webpack.bundle.config.js');

// Cleanup temp files
fs.unlinkSync(bundleEntryPath);

// Remove temporary build artifacts (keep only the bundle)
console.log('\n🧹 Cleaning up temporary build files...');
const distDir = path.join(rootDir, 'dist');

// Remove workers folder
const workersFolder = path.join(distDir, 'workers');
if (fs.existsSync(workersFolder)) {
    fs.rmSync(workersFolder, { recursive: true });
    console.log('   Removed: dist/workers/');
}

// Remove weed.min.js (intermediate build)
const weedMinPath = path.join(distDir, 'weed.min.js');
if (fs.existsSync(weedMinPath)) {
    fs.unlinkSync(weedMinPath);
    console.log('   Removed: dist/weed.min.js');
}

// Remove stray asset files (.css, hashed .js) generated by webpack — everything
// is embedded in the bundle so these leftover files aren't needed
const umdName = isProd ? 'weed.prod.bundle.min.js' : 'weed.bundle.min.js';
const esmName = isProd ? 'weed.prod.bundle.esm.min.js' : 'weed.bundle.esm.min.js';
const distFiles = fs.readdirSync(distDir);
const keepFiles = new Set([
    'weed.bundle.min.js', 'weed.bundle.esm.min.js',
    'weed.prod.bundle.min.js', 'weed.prod.bundle.esm.min.js',
    'index.html',
]);
for (const file of distFiles) {
    if (keepFiles.has(file)) continue;
    if (file.endsWith('.css') || file.endsWith('.js')) {
        fs.unlinkSync(path.join(distDir, file));
        console.log('   Removed: dist/' + file);
    }
}

// Copy smoke test files into dist/ (webpack clean: true wipes them each build)
console.log('\n🧪 Generating bundle smoke test...');
const testSrcDir = path.join(rootDir, 'scripts', 'bundle-test');
if (fs.existsSync(testSrcDir)) {
    for (const file of fs.readdirSync(testSrcDir)) {
        fs.copyFileSync(path.join(testSrcDir, file), path.join(distDir, file));
    }
    console.log('   Copied: index.html ');
}

console.log('\n✅ Single-file bundles created!');
console.log('\n📊 Bundle sizes:');
const umdStats = fs.statSync(path.join(rootDir, 'dist', umdName));
const esmStats = fs.statSync(path.join(rootDir, 'dist', esmName));
console.log(`   ${umdName}: ${' '.repeat(Math.max(0, 30 - umdName.length))}${(umdStats.size / 1024).toFixed(1)} KB (UMD - for <script> tags)`);
console.log(`   ${esmName}: ${' '.repeat(Math.max(0, 30 - esmName.length))}${(esmStats.size / 1024).toFixed(1)} KB (ESM - for import statements)`);
console.log('   (both include all workers embedded as strings)');
if (isProd) console.log('   (production build — debug modules stripped)');
console.log('   index.html:             Bundle smoke test (open in browser)');
