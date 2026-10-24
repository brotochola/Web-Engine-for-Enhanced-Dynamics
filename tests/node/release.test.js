import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { nextVersion } from '../../scripts/release.mjs';

// The version changes only in `npm run release`; commits leave it alone (no pre-commit bump).

test('release computes patch, minor, major or an explicit version', () => {
  assert.equal(nextVersion('0.12.209', 'patch'), '0.12.210');
  assert.equal(nextVersion('0.12.209', 'minor'), '0.13.0');
  assert.equal(nextVersion('0.12.209', 'major'), '1.0.0');
  assert.equal(nextVersion('0.12.209', '0.14.2'), '0.14.2');
  assert.equal(nextVersion('0.12.209', 'later'), null);
  assert.equal(nextVersion('0.12.209', undefined), null);
});

test('no git hook changes the version', () => {
  assert.equal(fs.existsSync(new URL('../../scripts/git-hooks/pre-commit', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('../../scripts/bumpPatchVersion.js', import.meta.url)), false);
});
