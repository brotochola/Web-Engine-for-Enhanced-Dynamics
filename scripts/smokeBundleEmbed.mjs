/**
 * Offline smoke: all 8 dist artifacts, wasm gzip, Box2D sibling remap, worker embed mode.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { BUNDLE_ARTIFACTS, extractImportScriptNames } from './build-bundle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const weedPost = fs.readFileSync(path.join(root, 'src', 'box2d', 'weedjs_post.js'), 'utf8');
const siblingNames = extractImportScriptNames(weedPost);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function findWasm(payloads) {
  for (const buf of payloads) {
    if (buf.length > 10000 && buf[0] === 0x00 && buf[1] === 0x61) return buf;
  }
  // Compressed artifacts gzip the whole Box2dWorkerSource; wasm b64 lives inside that UTF-8.
  for (const buf of payloads) {
    if (buf[0] === 0x00) continue;
    const inner = buf.toString('utf8').match(/H4sI[A-Za-z0-9+/=]+/g) || [];
    for (const b64 of inner) {
      try {
        const g = zlib.gunzipSync(Buffer.from(b64, 'base64'));
        if (g.length > 10000 && g[0] === 0x00 && g[1] === 0x61) return g;
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
  const sample =
    '__webpack_require__.u=chunkId=>"workers/worker_common.min.js";' +
    '__webpack_require__.p=scriptUrl+"../";' +
    'importScripts(__webpack_require__.p+__webpack_require__.u(chunkId));';
  const commonUrl = 'blob:http://localhost/fake-common';
  let code = sample.replace(
    /__webpack_require__\.u\s*=\s*chunkId\s*=>\s*"[^"]*worker_common[^"]*"/g,
    '__webpack_require__.u=chunkId=>' + JSON.stringify(commonUrl),
  );
  code = code.replace(
    /__webpack_require__\.p\s*=\s*scriptUrl\s*\+\s*"\.\.\/"/g,
    '__webpack_require__.p=""',
  );
  assert(code.includes(JSON.stringify(commonUrl)), 'u() not rewritten to blob URL');
  assert(code.includes('__webpack_require__.p=""'), 'publicPath not cleared');
  assert(!code.includes('workers/worker_common.min.js'), 'old common path still present');
}

checkRewriteSample();

const missing = BUNDLE_ARTIFACTS.filter((name) => !fs.existsSync(path.join(dist, name)));
if (missing.length) {
  throw new Error(
    `Missing dist artifacts: ${missing.join(', ')}. Run pnpm make_bundle (or test:bundle:build).`,
  );
}

assert(siblingNames.includes('box2dRayCast.impl.js'), 'weedjs_post missing box2dRayCast.impl.js');
assert(siblingNames.includes('liquidFunQuery.impl.js'), 'weedjs_post missing liquidFunQuery.impl.js');

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

  console.log(`  ${name}: wasm ${wasm.length} bytes${compressed ? ' + gzip workers' : ' + raw workers'}`);
}

console.log('smoke-bundle-embed OK');
console.log(`  artifacts: ${BUNDLE_ARTIFACTS.length}`);
console.log(`  siblings: ${siblingNames.join(', ')}`);
