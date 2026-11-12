/**
 * Baseline trees for A/B without touching the working tree.
 *
 * A baseline is a git worktree in a sibling folder (../weed-ab/<rev>-<sha>).
 * By default only `src/` comes from the baseline rev: everything else (demos,
 * stress scenes, the runner) is HEAD plus the working tree's uncommitted
 * changes outside `src/`, so both sides run the same scene files.
 *
 * Run a script from the baseline by launching it from `root`: every runner
 * derives repoRoot from its own path, so it serves that tree.
 *
 * A worktree is gone once used: each process that makes or reuses one leaves its pid in it (.weed-ab-users), and at
 * exit the worktrees no other live process holds are removed (about 260 MB each; 98 had piled up by 2026-11-12). The
 * first use in a process also removes the stale ones: every holder dead (a run cut short), or made by a runner from
 * before this (no holders) more than 12 hours ago. `--keep-worktrees` (runPredatorAbab) or WEED_KEEP_WORKTREES=1 keeps
 * them; tests/bench/cleanRevWorktrees.mjs removes the unused ones by hand.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyWorkloadCounts } from './workloadCountsPatch.mjs';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const worktreeParent = path.join(path.dirname(repoRoot), 'weed-ab');

const STAMP = '.weed-ab.json';
/** The pids of the processes that use a worktree, one empty file each. */
const USERS = '.weed-ab-users';
/** A worktree from a runner without holders, unused this long, is stale. */
const LEGACY_STALE_MS = 12 * 3600 * 1000;

function git(args, cwd = repoRoot) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function lines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function resolveRev(rev) {
  return git(['rev-parse', '--verify', `${rev}^{commit}`]);
}

function safeName(rev) {
  return String(rev).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function isSrc(rel) {
  return rel === 'src' || rel.startsWith('src/');
}

/** Working-tree paths that differ from HEAD (modified, deleted, untracked), optionally outside src/ only. */
function workingTreeChanges({ includeSrc = false } = {}) {
  const keep = (p) => includeSrc || !isSrc(p);
  const changed = lines(git(['diff', '--name-only', 'HEAD'])).filter(keep);
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard'])).filter(keep);
  return [...new Set([...changed, ...untracked])];
}

function linkNodeModules(root) {
  const link = path.join(root, 'node_modules');
  if (fs.existsSync(link)) return;
  const target = path.join(repoRoot, 'node_modules');
  if (!fs.existsSync(target)) return;
  fs.symlinkSync(target, link, 'junction');
}

/**
 * Drop the node_modules junction without following it. `git worktree remove`
 * and recursive deletes walk into a junction on Windows and delete the main
 * repo's node_modules, so this runs before any removal.
 */
function unlinkNodeModules(root) {
  const link = path.join(root, 'node_modules');
  let st;
  try {
    st = fs.lstatSync(link);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    fs.unlinkSync(link);
    return;
  }
  throw new Error(`${link} is a real directory, not the junction; refusing to delete the worktree`);
}

function checkoutSrcFromRev(root, sha) {
  git(['checkout', sha, '--', 'src'], root);
  const want = new Set(lines(git(['ls-tree', '-r', '--name-only', sha, '--', 'src'], root)));
  for (const abs of walkFiles(path.join(root, 'src'))) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!want.has(rel)) fs.unlinkSync(abs);
  }
}

function overlayWorkingTree(root, includeSrc = false) {
  const copied = [];
  for (const rel of workingTreeChanges({ includeSrc })) {
    const from = path.join(repoRoot, rel);
    const to = path.join(root, rel);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } else if (fs.existsSync(to)) {
      fs.unlinkSync(to);
    }
    copied.push(rel);
  }
  return copied;
}

/**
 * Create (or refresh) the baseline worktree for `rev`.
 * @param {string} rev
 * @param {{ srcOnly?: boolean, workloadCounts?: boolean, tag?: string }} [opts] `tag` names a second worktree of
 *   the same revision (runPredatorAbab's --hyp-rev side), so the two sides of an A/A are two directories
 * @returns {{ root: string, rev: string, sha: string, headSha: string, overlay: string[], countsPatched: boolean }}
 */
export function ensureRevWorktree(rev, opts = {}) {
  const srcOnly = opts.srcOnly !== false;
  pruneOnce();
  const sha = resolveRev(rev);
  const headSha = resolveRev('HEAD');
  const root = path.join(worktreeParent, `${safeName(rev)}-${sha.slice(0, 8)}${opts.tag ? `-${safeName(opts.tag)}` : ''}`);
  const base = srcOnly ? headSha : sha;

  fs.mkdirSync(worktreeParent, { recursive: true });
  const known = lines(git(['worktree', 'list', '--porcelain']))
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice('worktree '.length)).toLowerCase());
  if (known.includes(root.toLowerCase()) && fs.existsSync(root)) {
    unlinkNodeModules(root);
    git(['checkout', '-f', '--detach', base], root);
    git(['clean', '-fdq', '-e', STAMP, '-e', USERS], root);
  } else {
    if (fs.existsSync(root)) {
      unlinkNodeModules(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
    git(['worktree', 'prune']);
    git(['worktree', 'add', '--detach', root, base]);
  }

  if (srcOnly && sha !== headSha) checkoutSrcFromRev(root, sha);
  const overlay = srcOnly ? overlayWorkingTree(root, false) : [];
  linkNodeModules(root);
  const countsPatched = opts.workloadCounts === false ? false : applyWorkloadCounts(root);

  const info = { root, rev, sha, headSha, srcOnly, overlay, countsPatched, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, STAMP), JSON.stringify(info, null, 2) + '\n');
  holdRevWorktree(root);
  return info;
}

/**
 * Baseline for one hypothesis still in the working tree: HEAD plus every
 * working-tree change (src included), then `overrides` (repo-relative path →
 * file whose contents replace it, usually the pre-hypothesis copy saved before
 * editing src). Lives in ../weed-ab/<name>; the working tree is only read.
 * @param {string} name
 * @param {Record<string, string>} overrides
 */
export function ensureOverlayWorktree(name, overrides) {
  pruneOnce();
  const headSha = resolveRev('HEAD');
  const root = path.join(worktreeParent, `wt-${safeName(name)}`);
  fs.mkdirSync(worktreeParent, { recursive: true });
  const known = lines(git(['worktree', 'list', '--porcelain']))
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice('worktree '.length)).toLowerCase());
  if (known.includes(root.toLowerCase()) && fs.existsSync(root)) {
    unlinkNodeModules(root);
    git(['checkout', '-f', '--detach', headSha], root);
    git(['clean', '-fdq', '-e', STAMP, '-e', USERS], root);
  } else {
    if (fs.existsSync(root)) {
      unlinkNodeModules(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
    git(['worktree', 'prune']);
    git(['worktree', 'add', '--detach', root, headSha]);
  }
  const overlay = overlayWorkingTree(root, true);
  for (const [rel, from] of Object.entries(overrides || {})) {
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  linkNodeModules(root);
  const info = { root, name, headSha, overlay, overrides, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, STAMP), JSON.stringify(info, null, 2) + '\n');
  holdRevWorktree(root);
  return info;
}

export function removeRevWorktree(root) {
  if (!root || path.resolve(root).toLowerCase() === repoRoot.toLowerCase()) {
    throw new Error('refusing to remove the working tree');
  }
  unlinkNodeModules(root);
  git(['worktree', 'remove', '--force', root]);
}

const held = new Set();
let keepWorktrees = process.env.WEED_KEEP_WORKTREES === '1';
let exitHooked = false;
let pruned = false;

/** Whether a process is alive (signal 0 tests it; EPERM means it is, and someone else's). */
function pidAlive(pid) {
  if (!(pid > 0)) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** The live processes that hold `root` (this one included when it does). */
export function worktreeHolders(root) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, USERS));
  } catch {
    return [];
  }
  return names.map(Number).filter(pidAlive);
}

/** This process uses `root`: it is removed at this process's exit unless another live one still holds it. */
export function holdRevWorktree(root) {
  fs.mkdirSync(path.join(root, USERS), { recursive: true });
  fs.writeFileSync(path.join(root, USERS, String(process.pid)), '');
  held.add(path.resolve(root));
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', releaseRevWorktrees);
  }
}

/** Keep the worktrees this process used (runPredatorAbab --keep-worktrees; WEED_KEEP_WORKTREES=1 for any runner). */
export function keepRevWorktrees(keep = true) {
  keepWorktrees = Boolean(keep);
}

/** Drop this process's hold on each worktree it used, and remove each one no other live process holds. */
export function releaseRevWorktrees() {
  for (const root of held) {
    try {
      fs.rmSync(path.join(root, USERS, String(process.pid)), { force: true });
      if (keepWorktrees || worktreeHolders(root).length > 0) continue;
      removeRevWorktree(root);
    } catch (e) {
      console.warn(`[revWorktree] ${root} was left: ${String(e?.message || e).split('\n')[0]}`);
    }
  }
  held.clear();
}

/**
 * The worktrees under worktreeParent no live process holds: every holder dead (a run cut short), or no holders and
 * unused for `legacyMs` (a runner from before the holders; `legacyMs` 0 takes them all).
 * @returns {string[]}
 */
export function staleRevWorktrees({ legacyMs = LEGACY_STALE_MS } = {}) {
  const parent = path.resolve(worktreeParent).toLowerCase();
  const roots = lines(git(['worktree', 'list', '--porcelain']))
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice('worktree '.length)))
    .filter((r) => path.dirname(r).toLowerCase() === parent);
  const now = Date.now();
  return roots.filter((r) => {
    if (held.has(r) || !fs.existsSync(r)) return false;
    const users = path.join(r, USERS);
    if (fs.existsSync(users)) return worktreeHolders(r).length === 0;
    let used = 0;
    try {
      used = fs.statSync(path.join(r, STAMP)).mtimeMs;
    } catch {
      used = fs.statSync(r).mtimeMs;
    }
    return now - used >= legacyMs;
  });
}

/** Remove the stale worktrees (staleRevWorktrees); returns the ones removed. */
export function pruneStaleRevWorktrees(opts = {}) {
  const removed = [];
  for (const r of staleRevWorktrees(opts)) {
    try {
      removeRevWorktree(r);
      removed.push(r);
    } catch (e) {
      console.warn(`[revWorktree] ${r} was left: ${String(e?.message || e).split('\n')[0]}`);
    }
  }
  try {
    git(['worktree', 'prune']);
  } catch {
    // Nothing to prune.
  }
  return removed;
}

function pruneOnce() {
  if (pruned || keepWorktrees) return;
  pruned = true;
  const removed = pruneStaleRevWorktrees();
  if (removed.length) console.log(`[revWorktree] removed ${removed.length} stale worktree(s) under ${worktreeParent}`);
}
