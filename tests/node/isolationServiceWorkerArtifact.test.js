import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ISOLATION_SERVICE_WORKER_FILE, writeIsolationServiceWorker } from '../../scripts/buildBundle.js';

// DX-SW, SW-5. The bundle build publishes the isolation service worker as dist/weed-sw.js, a plain
// copy of its source (any change to its bytes makes every visitor's browser reinstall it).

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'src/workers/isolationServiceWorker.js'));

test('the build writes weed-sw.js byte for byte from its source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-sw-'));
  try {
    const written = writeIsolationServiceWorker(dir);
    assert.equal(path.basename(written), 'weed-sw.js');
    assert.equal(ISOLATION_SERVICE_WORKER_FILE, 'weed-sw.js');
    assert.ok(fs.readFileSync(written).equals(source));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed dist/weed-sw.js matches its source', () => {
  const dist = fs.readFileSync(path.join(root, 'dist', 'weed-sw.js'));
  assert.ok(dist.equals(source), 'dist/weed-sw.js is stale: run node scripts/buildBundle.js');
});
