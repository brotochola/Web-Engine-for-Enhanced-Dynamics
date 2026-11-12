#!/usr/bin/env node
/**
 * Remove the sitting worktrees under ../weed-ab that no live process holds (revWorktree.mjs). Runners remove their own
 * at exit and the stale ones at their first use; this is the same by hand, for leftovers or before freeing the disk.
 *
 *   node tests/bench/cleanRevWorktrees.mjs              every unused worktree (a run's held ones are left)
 *   node tests/bench/cleanRevWorktrees.mjs --stale      only the stale ones, as a runner prunes them
 *   node tests/bench/cleanRevWorktrees.mjs --dry-run    list them, remove nothing
 *
 * Each one goes through removeRevWorktree, which unlinks its node_modules junction first: never delete these folders
 * by hand or with `git worktree remove --force` alone, which can follow the junction into the main node_modules.
 */
import { pruneStaleRevWorktrees, staleRevWorktrees, worktreeParent } from './revWorktree.mjs';

const args = new Set(process.argv.slice(2));
const opts = args.has('--stale') ? {} : { legacyMs: 0 };
if (args.has('--dry-run')) {
  const list = staleRevWorktrees(opts);
  for (const r of list) console.log(r);
  console.log(`${list.length} unused worktree(s) under ${worktreeParent}`);
} else {
  const removed = pruneStaleRevWorktrees(opts);
  for (const r of removed) console.log(`removed ${r}`);
  console.log(`${removed.length} worktree(s) removed from ${worktreeParent}`);
}
