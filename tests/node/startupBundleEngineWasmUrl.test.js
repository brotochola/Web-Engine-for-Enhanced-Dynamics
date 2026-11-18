/**
 * SST-2's page compiles engine.wasm once and posts the module to the workers; in the single-file bundle it reads
 * the module from WEED.EngineWasmUrl: the gzipped data URL the build inlined into the workers' common code, read
 * from there (no second copy in the bundle). The generated page entry runs here in a vm, raw and compressed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';

import { WORKER_NAMES, engineWasmDataUrlSpan, writeBundleEntry } from '../../scripts/buildBundle.js';

const engineBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 2, 3]);
const otherBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 9]);
const dataUrl = (bytes) => `data:application/gzip;base64,${zlib.gzipSync(bytes).toString('base64')}`;
// Two modules named in the shared chunk as the build writes them (inlineWorkerWasmAssets): the engine's is found by its bytes.
const workerCommon =
  `var a=new URL(${JSON.stringify(dataUrl(otherBytes))},i.b);` + `var e=new URL(${JSON.stringify(dataUrl(engineBytes))},i.b);`;

test("engine.wasm's data URL is found in the shared chunk by its bytes", () => {
  const span = engineWasmDataUrlSpan(workerCommon, engineBytes);
  assert.equal(workerCommon.slice(span.at, span.at + span.length), dataUrl(engineBytes));
  assert.throws(() => engineWasmDataUrlSpan('var x=1;', engineBytes), /not in the workers' common code/);
});

function runEntry({ compressed }) {
  const entry = writeBundleEntry({
    workers: Object.fromEntries(WORKER_NAMES.map((n) => [n, `/*${n}*/`])),
    workerCommon,
    engineWasmSpan: engineWasmDataUrlSpan(workerCommon, engineBytes),
    box2dWorkerSource: '/* box2d */',
    audioWorkletSource: '/* worklet */',
    debugUICSS: '',
    engineShaders: {},
    compressed,
    prod: true,
  });
  const lines = entry.split('\n');
  const swap = (from, to) => {
    const i = lines.indexOf(from);
    assert.ok(i >= 0, `the entry has no line ${from}`);
    lines[i] = to;
  };
  swap("import WEED_BASE from './index.js';", 'const WEED_BASE = {};');
  swap("export * from './index.js';", '');
  swap('export default WEED;', 'globalThis.exported = WEED;');
  const context = vm.createContext({ atob, Blob, Response, DecompressionStream, TextDecoder, Uint8Array });
  vm.runInContext(lines.join('\n'), context);
  return context.exported;
}

test('the single-file bundle names engine.wasm by the data URL its workers carry', () => {
  const WEED = runEntry({ compressed: false });
  assert.equal(WEED.EngineWasmUrl, dataUrl(engineBytes));
  assert.ok(WEED.WorkerCommonSource.includes(WEED.EngineWasmUrl));
});

test('the compressed bundle names it once its sources are inflated', async () => {
  const WEED = runEntry({ compressed: true });
  assert.equal(WEED.EngineWasmUrl, null);
  await WEED.ensureEmbeddedSources();
  assert.equal(WEED.EngineWasmUrl, dataUrl(engineBytes));
  assert.ok(zlib.gunzipSync(Buffer.from(WEED.EngineWasmUrl.split(',')[1], 'base64')).equals(engineBytes));
});
