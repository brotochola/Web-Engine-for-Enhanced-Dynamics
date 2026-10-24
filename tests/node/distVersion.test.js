import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUILD_INPUTS_FILE, bundleInputsHash, checkDistFresh } from '../../scripts/distVersion.js';

// dist/ is fresh when it was built from the sources the working tree has now: a hash of the bundle
// inputs, not the version, which used to move on every commit (a docs commit made dist/ "stale")
// and stayed put through uncommitted src/ edits (which passed as fresh).

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-dist-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('src/a.js', 'export const a = 1;\n');
  write('src/version.js', "export const VERSION = '1.0.0';\n");
  write('docs/guide.md', 'docs\n');
  write('.gitignore', 'src/index.bundle.js\n');
  return { dir, write, hash: () => bundleInputsHash(dir) };
}

test('the input hash follows source edits and new files, not docs, line endings or ignored files', () => {
  const { dir, write, hash } = repo();
  try {
    const first = hash();
    assert.match(first, /^[0-9a-f]{16}$/);
    write('docs/guide.md', 'other docs\n');
    assert.equal(hash(), first, 'docs are not a bundle input');
    write('src/a.js', 'export const a = 1;\r\n');
    assert.equal(hash(), first, 'CRLF and LF checkouts hash the same');
    write('src/index.bundle.js', 'generated\n');
    assert.equal(hash(), first, 'a gitignored generated file is not an input');
    write('src/a.js', 'export const a = 2;\n');
    const edited = hash();
    assert.notEqual(edited, first, 'an uncommitted src/ edit changes it');
    write('src/b.js', 'export const b = 1;\n');
    assert.notEqual(hash(), edited, 'a new, untracked src/ file changes it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDistFresh compares dist/.build-inputs with the working tree', () => {
  const { dir, write, hash } = repo();
  try {
    write('dist/weed.bundle.esm.min.js', '/* bundle */\n');
    assert.equal(checkDistFresh(dir).reason, 'unstamped');
    write(`dist/${BUILD_INPUTS_FILE}`, `${hash()}\n`);
    write('docs/guide.md', 'a docs commit\n');
    assert.equal(checkDistFresh(dir).reason, 'fresh');
    write('src/a.js', 'export const a = 3;\n');
    const stale = checkDistFresh(dir);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale');
    assert.match(stale.message, /npm run make_bundle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
