import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findWgslUseBeforeDeclare } from '../../src/render/webgpu/wgslPrelude.js';

const demos = join(dirname(fileURLToPath(import.meta.url)), '..');

test('demo WGSL: no let/var/const used before declaration in the same fn', () => {
  const files = readdirSync(demos, { recursive: true })
    .filter((name) => typeof name === 'string' && name.endsWith('.wgsl'))
    .map((name) => join(demos, name));
  assert.ok(files.length > 0, 'no .wgsl files found');
  const failures = [];
  for (const file of files) {
    const issues = findWgslUseBeforeDeclare(readFileSync(file, 'utf8'));
    if (issues.length) failures.push(`${file}: ${issues.map((e) => `${e.name}@${e.line}`).join(', ')}`);
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});
