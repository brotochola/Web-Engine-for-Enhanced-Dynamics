#!/usr/bin/env node
/** The checkout is one commit deep: fetch the revisions a job's arguments name (a, b, vs, rev), by full sha. */
import { execFileSync } from 'node:child_process';

const args = JSON.parse(process.env.JOB_ARGS || '{}');
for (const key of ['a', 'b', 'vs', 'rev']) {
  const rev = args[key];
  if (typeof rev !== 'string' || !/^[0-9a-f]{40}$/.test(rev)) continue;
  try {
    execFileSync('git', ['cat-file', '-e', `${rev}^{commit}`], { stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', '--depth=1', 'origin', rev], { stdio: 'inherit' });
  }
}
