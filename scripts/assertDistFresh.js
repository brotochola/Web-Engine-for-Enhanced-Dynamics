// assertDistFresh.js - fail when dist/ does not match src/version.js.
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
    console.log(
      result.reason === 'src-version-unreadable'
        ? `[distVersion] ${result.message}`
        : `[distVersion] dist ${result.distVersion} matches src ${result.srcVersion}.`,
    );
  }
} else {
  console.error(`[distVersion] Stale dist bundle (${result.reason}).\n\n${result.message}`);
  process.exit(1);
}
