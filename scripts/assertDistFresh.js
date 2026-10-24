// assertDistFresh.js - fail when dist/ was not built from the working tree's sources
// (a hash of the bundle inputs, distVersion.js).
//
// Wired into prepublishOnly so a stale bundle cannot be published, and callable
// on its own for a pre-flight check.
//
//   node scripts/assertDistFresh.js          # check
//   node scripts/assertDistFresh.js --quiet  # exit code only

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDistFresh } from './distVersion.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');

const result = checkDistFresh(repoRoot);

if (result.ok) {
  if (!quiet) {
    console.log(`[distVersion] ${result.message}`);
  }
} else {
  console.error(`[distVersion] Stale dist bundle (${result.reason}).\n\n${result.message}`);
  process.exit(1);
}
