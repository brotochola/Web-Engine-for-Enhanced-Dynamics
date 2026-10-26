/**
 * Offline smoke: all 8 dist artifacts, wasm gzip, Box2D sibling remap, worker embed mode.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { BUNDLE_ARTIFACTS, extractImportScriptNames, rewriteWorkerCommonImportScripts } from './buildBundle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const weedPost = fs.readFileSync(path.join(root, 'src', 'box2d', 'weedjsPost.js'), 'utf8');
const siblingNames = extractImportScriptNames(weedPost);
// Engine WASM kernels (E-76 T5; test modules are not shipped): each must be embedded in every artifact as a gzipped data URL
// of its committed bytes (data:application/gzip;base64,…, which the worker inflates), in the artifact or inside a gzipped
// worker payload.
const kernelModules = JSON.parse(fs.readFileSync(path.join(root, 'wasm', 'modules.json'), 'utf8')).modules.filter((m) => !m.test).map((m) => ({
  name: m.name,
  output: m.output,
  bytes: fs.readFileSync(path.join(root, m.output)),
}));
const box2dWasmBytes = fs.readFileSync(path.join(root, 'src', 'box2d', 'box2dWasm.wasm'));

/** The inflated bytes of every gzipped data URL in `text`. */
function gzipDataUrls(text) {
  const out = [];
  for (const m of text.matchAll(/data:application\/gzip;base64,([A-Za-z0-9+/=]+)/g)) {
    try {
      out.push(zlib.gunzipSync(Buffer.from(m[1], 'base64')));
    } catch {
      // not a gzip payload
    }
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Box2D's wasm among the gunzipped payloads (the kernels are gzipped wasm too: matched by its committed bytes). */
function findWasm(payloads) {
  for (const buf of payloads) {
    if (buf.equals(box2dWasmBytes)) return buf;
  }
  // Compressed artifacts gzip the whole Box2dWorkerSource; wasm b64 lives inside that UTF-8.
  for (const buf of payloads) {
    if (buf[0] === 0x00) continue;
    const inner = buf.toString('utf8').match(/H4sI[A-Za-z0-9+/=]+/g) || [];
    for (const b64 of inner) {
      try {
        const g = zlib.gunzipSync(Buffer.from(b64, 'base64'));
        if (g.equals(box2dWasmBytes)) return g;
      } catch {
        // not wasm
      }
    }
  }
  return null;
}

function gunzipPayloads(s) {
  const matches = s.match(/H4sI[A-Za-z0-9+/=]+/g) || [];
  const out = [];
  for (const b64 of matches) {
    try {
      out.push(zlib.gunzipSync(Buffer.from(b64, 'base64')));
    } catch {
      // truncated / false-positive base64
    }
  }
  return out;
}

function checkRewriteSample() {
  const commonUrl = 'blob:http://localhost/fake-common';
  const samples = [
    '__webpack_require__.u=chunkId=>"workers/worker_common.min.js";' +
      '__webpack_require__.p=scriptUrl+"../";' +
      'importScripts(__webpack_require__.p+__webpack_require__.u(chunkId));',
    'i.u=t=>"workers/worker_common.min.js";' +
      'i.p=t+"../";' +
      'importScripts(i.p+i.u(e));',
  ];
  for (const sample of samples) {
    const code = rewriteWorkerCommonImportScripts(sample, commonUrl);
    assert(code.includes(JSON.stringify(commonUrl)), 'u() not rewritten to blob URL');
    assert(code.includes('.p=""'), 'publicPath not cleared');
    assert(!code.includes('workers/worker_common.min.js'), 'old common path still present');
  }
}

checkRewriteSample();

const missing = BUNDLE_ARTIFACTS.filter((name) => !fs.existsSync(path.join(dist, name)));
if (missing.length) {
  throw new Error(
    `Missing dist artifacts: ${missing.join(', ')}. Run pnpm make_bundle (or test:bundle:build).`,
  );
}

assert(siblingNames.includes('box2dRayCastImpl.js'), 'weedjs_post missing box2dRayCast.impl.js');
assert(siblingNames.includes('liquidFunQueryImpl.js'), 'weedjs_post missing liquidFunQuery.impl.js');

for (const name of BUNDLE_ARTIFACTS) {
  const filePath = path.join(dist, name);
  const s = fs.readFileSync(filePath, 'utf8');
  const compressed = name.includes('.compressed.');

  assert(s.includes('BUNDLE_MODE'), `${name}: missing BUNDLE_MODE`);
  assert(s.includes('DecompressionStream'), `${name}: missing DecompressionStream`);
  assert(/H4sI/.test(s), `${name}: expected gzip magic in base64 (H4sI...)`);

  const payloads = gunzipPayloads(s);
  const wasm = findWasm(payloads);
  assert(wasm, `${name}: no gunzipped wasm (\\0asm) payload`);

  const utf8Payloads = payloads
    .filter((buf) => buf[0] !== 0x00)
    .map((buf) => buf.toString('utf8'));

  const kernelBytes = [s, ...utf8Payloads].flatMap(gzipDataUrls);
  for (const mod of kernelModules) {
    const embedded = kernelBytes.some((bytes) => bytes.equals(mod.bytes));
    assert(embedded, `${name}: kernel ${mod.name} (${mod.output}) is not embedded gzipped, or not its committed bytes`);
  }

  if (compressed) {
    assert(s.includes('EMBED_COMPRESSED'), `${name}: compressed bundle missing EMBED_COMPRESSED`);
    const box2dJs = utf8Payloads.find((text) => siblingNames.every((sib) => text.includes(sib)));
    assert(
      box2dJs,
      `${name}: gunzipped worker/glue payloads missing Box2D siblings (${siblingNames.join(', ')})`,
    );
    const workerJs = utf8Payloads.find(
      (text) =>
        text.includes('worker_common') ||
        text.includes('__webpack_require__') ||
        text.includes('AbstractWorker'),
    );
    assert(workerJs, `${name}: no gunzipped JS worker payload`);
  } else {
    for (const sib of siblingNames) {
      assert(s.includes(sib), `${name}: uncompressed missing sibling ${sib}`);
    }
  }

  const rawBytes = Buffer.byteLength(s);
  const gzipBytes = zlib.gzipSync(s, { level: 9 }).length;
  console.log(
    `  ${name}: raw ${rawBytes} gzip ${gzipBytes} wasm ${wasm.length} bytes${compressed ? ' + gzip workers' : ' + raw workers'}`,
  );
}

console.log('smoke-bundle-embed OK');
console.log(`  artifacts: ${BUNDLE_ARTIFACTS.length}`);
console.log(`  siblings: ${siblingNames.join(', ')}`);
console.log(`  kernels: ${kernelModules.map((m) => m.name).join(', ')}`);
