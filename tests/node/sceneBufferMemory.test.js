import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMemoryUsageSummary,
  formatBytes,
  getSharedBufferSize,
} from '../../src/core/sceneBufferMemory.js';

test('buildMemoryUsageSummary summarizes nested SharedArrayBuffer trees', () => {
  const buffers = {
    inputData: new SharedArrayBuffer(64),
    workerData: {
      frameRate: new SharedArrayBuffer(128),
      nested: [null, new SharedArrayBuffer(32)],
    },
    ignored: {
      value: 123,
      child: null,
    },
  };

  const summary = buildMemoryUsageSummary(buffers);

  assert.equal(summary.totalBytes, 224);
  assert.equal(summary.totalFormatted, '224.00 B');
  assert.equal(summary.bufferCount, 3);
  assert.deepEqual(summary.flatBreakdown, {
    inputData: 64,
    'workerData.frameRate': 128,
    'workerData.nested.1': 32,
  });
  assert.equal(summary.categories.inputData.totalBytes, 64);
  assert.equal(summary.categories.workerData.totalBytes, 160);
  assert.equal(summary.categories.workerData.children.frameRate.totalBytes, 128);
  assert.equal(summary.categories.workerData.children.nested.children['1'].totalBytes, 32);
  assert.equal(summary.categories.inputData.children, null);
});

test('buildMemoryUsageSummary returns the empty summary for missing buffers', () => {
  assert.deepEqual(buildMemoryUsageSummary(null), {
    totalBytes: 0,
    totalFormatted: '0 B',
    bufferCount: 0,
    categories: {},
    flatBreakdown: {},
  });
});

test('getSharedBufferSize returns either total bytes or full breakdown', () => {
  const buffers = {
    a: new SharedArrayBuffer(16),
    group: {
      b: new SharedArrayBuffer(48),
    },
  };

  assert.equal(getSharedBufferSize(buffers), 64);
  assert.deepEqual(getSharedBufferSize(buffers, true), {
    total: 64,
    totalFormatted: '64.00 B',
    breakdown: {
      a: 16,
      'group.b': 48,
    },
    categories: {
      a: {
        totalBytes: 16,
        totalFormatted: '16.00 B',
        bufferCount: 1,
        children: null,
      },
      group: {
        totalBytes: 48,
        totalFormatted: '48.00 B',
        bufferCount: 1,
        children: {
          b: {
            totalBytes: 48,
            totalFormatted: '48.00 B',
            bufferCount: 1,
            children: null,
          },
        },
      },
    },
    bufferCount: 2,
  });
});

test('formatBytes preserves the existing scene formatting', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
});
