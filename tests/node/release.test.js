import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { nextVersion } from '../../scripts/release.mjs';

// Every commit bumps the patch version (pre-commit hook); the release commit skips the hook's bump.

test('release computes patch, minor, major or an explicit version', () => {
  assert.equal(nextVersion('0.12.209', 'patch'), '0.12.210');
  assert.equal(nextVersion('0.12.209', 'minor'), '0.13.0');
  assert.equal(nextVersion('0.12.209', 'major'), '1.0.0');
  assert.equal(nextVersion('0.12.209', '0.14.2'), '0.14.2');
  assert.equal(nextVersion('0.12.209', 'later'), null);
  assert.equal(nextVersion('0.12.209', undefined), null);
});

test('the pre-commit hook bumps the patch version and skips the release commit', () => {
  const hook = fs.readFileSync(new URL('../../scripts/git-hooks/pre-commit', import.meta.url), 'utf8');
  assert.ok(hook.includes('bumpPatchVersion.js'));
  assert.ok(hook.includes('WEED_RELEASE'));
  assert.ok(fs.existsSync(new URL('../../scripts/bumpPatchVersion.js', import.meta.url)));
});
