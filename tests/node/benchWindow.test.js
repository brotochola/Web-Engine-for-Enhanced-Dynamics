import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The bench's headed windows open where the owner last left one: the saved position becomes a launch argument.
test('a saved window position becomes Chrome\'s --window-position, and the scale factor is always 1', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weed-bench-window-')), 'w.json');
  process.env.WEED_BENCH_WINDOW_FILE = file;
  const { benchWindowArgs, savedBenchWindow } = await import('../bench/benchWindow.mjs');
  assert.deepEqual(benchWindowArgs(), ['--force-device-scale-factor=1']);
  fs.writeFileSync(file, JSON.stringify({ left: 1930.4, top: -8 }));
  assert.deepEqual(savedBenchWindow(), { left: 1930, top: -8 });
  assert.deepEqual(benchWindowArgs(), ['--window-position=1930,-8', '--force-device-scale-factor=1']);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(benchWindowArgs(), ['--force-device-scale-factor=1']);
  delete process.env.WEED_BENCH_WINDOW_FILE;
});
