/**
 * Run tests/node/*.test.js against dist bundle artifacts.
 * Missing public exports → skip the file. Never resolve src/ as fallback.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUNDLE_ARTIFACTS } from './buildBundle.js';
import { exportNameSet, loadBundleNamespace } from './bundleTestLoad.mjs';
import { classifyTestPath } from './bundleTestScan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const testsDir = path.join(root, 'tests', 'node');
const registerPath = path.join(root, 'scripts', 'bundleTestRegister.mjs');

function parseArgs(argv) {
  const names = [];
  const flags = {
    esm: false,
    umd: false,
    prod: false,
    debug: false,
    compressed: false,
    raw: false,
    list: false,
  };
  for (const a of argv) {
    if (a === '--esm') flags.esm = true;
    else if (a === '--umd') flags.umd = true;
    else if (a === '--prod') flags.prod = true;
    else if (a === '--debug') flags.debug = true;
    else if (a === '--compressed') flags.compressed = true;
    else if (a === '--raw') flags.raw = true;
    else if (a === '--list') flags.list = true;
    else if (a === '--') continue;
    else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      names.push(path.basename(a));
    }
  }
  return { names, flags };
}

function filterArtifacts(names, flags) {
  const known = new Set(BUNDLE_ARTIFACTS);
  if (names.length) {
    for (const n of names) {
      if (!known.has(n)) {
        throw new Error(`Unknown artifact: ${n}. Valid: ${BUNDLE_ARTIFACTS.join(', ')}`);
      }
    }
  }
  let list = names.length ? names : [...BUNDLE_ARTIFACTS];
  if (flags.esm) list = list.filter((n) => n.includes('.esm.'));
  if (flags.umd) list = list.filter((n) => !n.includes('.esm.'));
  if (flags.prod) list = list.filter((n) => n.includes('.prod.'));
  if (flags.debug) list = list.filter((n) => !n.includes('.prod.'));
  if (flags.compressed) list = list.filter((n) => n.includes('.compressed.'));
  if (flags.raw) list = list.filter((n) => !n.includes('.compressed.'));
  return list;
}

function listTestFiles() {
  return fs
    .readdirSync(testsDir)
    .filter((n) => n.endsWith('.test.js'))
    .map((n) => path.join(testsDir, n))
    .sort();
}

function isEsmArtifact(name) {
  return name.includes('.esm.');
}

async function loadExportNames(artifactPath, esm) {
  const ns = await loadBundleNamespace(artifactPath, esm);
  return exportNameSet(ns);
}

function classifyFiles(testFiles, exportNames) {
  const run = [];
  const skip = [];
  for (const file of testFiles) {
    const result = classifyTestPath(file, { repoRoot: root, exportNames });
    const base = path.basename(file);
    if (result.ok) run.push(file);
    else skip.push({ file: base, reason: result.reason });
  }
  return { run, skip };
}

function printClassified(name, run, skip) {
  console.log(`\n== ${name} ==`);
  for (const s of skip) {
    console.log(`SKIP ${s.file} — ${s.reason}`);
  }
  if (run.length) {
    console.log(`RUN  ${run.map((f) => path.basename(f)).join(' ')}`);
  }
  console.log(`${path.basename(name)}: ${run.length} run / ${skip.length} skip`);
}

function runNodeTests(artifactPath, esm, files) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(registerPath).href,
      '--test',
      '--test-concurrency=4',
      ...files,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        WEED_TEST_BUNDLE: artifactPath,
        WEED_TEST_BUNDLE_FORMAT: esm ? 'esm' : 'umd',
      },
    },
  );
  return result.status ?? 1;
}

const { names, flags } = parseArgs(process.argv.slice(2));
const artifacts = filterArtifacts(names, flags);
if (!artifacts.length) {
  console.error('No bundle artifacts matched the given filters.');
  process.exit(1);
}

const missing = artifacts.filter((name) => !fs.existsSync(path.join(dist, name)));
if (missing.length) {
  console.error(
    `Missing dist artifacts: ${missing.join(', ')}. Run pnpm make_bundle (or test:bundle:build).`,
  );
  process.exit(1);
}

const testFiles = listTestFiles();
let failed = 0;

for (const name of artifacts) {
  const artifactPath = path.join(dist, name);
  const esm = isEsmArtifact(name);
  const exportNames = await loadExportNames(artifactPath, esm);
  const { run, skip } = classifyFiles(testFiles, exportNames);
  printClassified(name, run, skip);

  if (!run.length) {
    console.error(`${name}: 0 eligible test files (loader/bundle broken).`);
    failed = 1;
    continue;
  }
  if (flags.list) continue;

  const status = runNodeTests(artifactPath, esm, run);
  if (status !== 0) {
    console.error(`${name}: node tests failed (exit ${status}).`);
    failed = status;
  }
}

process.exit(failed);
