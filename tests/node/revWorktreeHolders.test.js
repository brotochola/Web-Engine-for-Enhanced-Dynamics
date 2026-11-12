import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { worktreeHolders } from '../bench/revWorktree.mjs';

// Sitting worktrees (../weed-ab, about 260 MB each) piled up: 98 by 2026-11-12. Each process that uses one now leaves
// its pid in it, and a worktree goes once no live process holds it (at the holder's exit, or as stale at the next
// runner's first use). worktreeHolders is the test both read: the live pids among the ones left there.

function fakeRoot(pids) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-ab-holders-'));
  if (pids) {
    fs.mkdirSync(path.join(root, '.weed-ab-users'));
    for (const pid of pids) fs.writeFileSync(path.join(root, '.weed-ab-users', String(pid)), '');
  }
  return root;
}

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

test('a live holder holds a worktree, a dead one does not', () => {
  const dead = deadPid();
  const live = fakeRoot([process.pid, dead]);
  assert.deepEqual(worktreeHolders(live), [process.pid]);
  const orphan = fakeRoot([dead]);
  assert.deepEqual(worktreeHolders(orphan), [], 'every holder dead: stale');
  for (const r of [live, orphan]) fs.rmSync(r, { recursive: true, force: true });
});

test('no holders folder (a runner from before the holders) reads no holders', () => {
  const root = fakeRoot(null);
  assert.deepEqual(worktreeHolders(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a name that is no pid is no holder', () => {
  const root = fakeRoot(['notes', '0', '-5']);
  assert.deepEqual(worktreeHolders(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});
