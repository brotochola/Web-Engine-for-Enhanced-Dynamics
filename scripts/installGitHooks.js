import { execSync } from 'node:child_process';

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  execSync('git config core.hooksPath scripts/git-hooks', { stdio: 'ignore' });
} catch {
  // Not a git checkout (npm pack / CI artifact) — skip.
}
