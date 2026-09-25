import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GpuFrameTimer, sumTimestampPairs } from '../../src/render/gpuFrameTimer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const defaults = readFileSync(join(root, 'src/util/configDefaults.js'), 'utf8');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
const timerSrc = readFileSync(join(root, 'src/render/gpuFrameTimer.js'), 'utf8');
const bitonic = readFileSync(join(root, 'src/render/webgpu/bitonicSort.js'), 'utf8');

test('collectGpuStats defaults off and pixi attaches only when on', () => {
  assert.match(defaults, /collectGpuStats: false/);
  assert.match(pixi, /_attachGpuTimer\(\)/);
  assert.match(pixi, /if \(!this\.collectGpuStats\) return/);
});

test('WebGPU finishFrame resolves; computeStamp ignores pending reads', () => {
  assert.match(timerSrc, /_resolveGpuFrame\(\)/);
  assert.match(timerSrc, /_submitGpuResolve/);
  assert.match(timerSrc, /_hookDevice/);
  assert.match(timerSrc, /if \(this\._mode === 'webgpu'\) \{\s+this\._resolveGpuFrame/);
  assert.doesNotMatch(timerSrc, /if \(this\._reads\[r\] && this\._reads\[r\]\.pending\) return null/);
  const t = new GpuFrameTimer();
  t._mode = 'webgpu';
  t._computeQueries = [{}, {}];
  t._writeQs = 0;
  t._reads = [{ pending: true }, { pending: true }, { pending: true }];
  const a = t.computeStamp();
  const b = t.computeStamp();
  assert.ok(a);
  assert.ok(b);
  assert.equal(t._computePasses, 2);
  assert.equal(a.beginningOfPassWriteIndex, 0);
  assert.equal(b.beginningOfPassWriteIndex, 2);
});

test('pending MAP_READ keeps the parked GPU frame', () => {
  const t = new GpuFrameTimer();
  t._mode = 'webgpu';
  t._device = {
    createCommandEncoder() {
      throw new Error('should not resolve while dest is pending');
    },
  };
  t._queryCount = 8;
  t._writeQs = 1;
  t._readI = 0;
  t._reads = [{ pending: true, buf: {} }];
  t._renderQueries = [{}, {}];
  t._computeQueries = [{}, {}];
  t._pendingFrame = { qi: 0, renderPasses: 1, computePasses: 3, ranges: {} };
  t._renderPasses = 2;
  t._computePasses = 4;
  t._resolveGpuFrame();
  assert.equal(t._pendingFrame.computePasses, 3);
  assert.equal(t._computePasses, 4);
  assert.equal(t._writeQs, 1);
});

test('sumTimestampPairs adds end-start of each pass', () => {
  const view = new BigUint64Array([10n, 20n, 5n, 8n, 0n, 0n]);
  assert.ok(Math.abs(sumTimestampPairs(view, 0, 2) - 13e-6) < 1e-12);
});

test('bitonic stamps every compute pass when the timer is on', () => {
  assert.match(bitonic, /function beginTimedCompute/);
  const fills = bitonic.split('beginTimedCompute(').length - 1;
  assert.ok(fills >= 4);
});
