/**
 * What the ASan harness's kernel cases share (tests/asan/kernels/*.mjs): the product's region layout moved into
 * malloc'd arrays, byte snapshots and comparisons, a seeded random, and a revision's sources on disk (a branch's
 * clients and shipped engine.wasm, which its cases import instead of the working tree's).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { asanResults, repoRoot, revHash } from './asanBuild.mjs';

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bytes of a typed array (a view, not a copy). */
export function bytesOf(v) {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** A copy of a typed array's bytes. */
export function snapshot(v) {
  return Buffer.from(bytesOf(v));
}

/** The first byte where two byte buffers differ, or -1. */
export function firstDifference(a, b) {
  if (a.length === b.length && Buffer.compare(a, b) === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A product layout object (createRenderQueueMemory's layout.stamp and the like) with every `…Byte` field moved into the
 * session's heap: the region the field names gets its own malloc'd block, of the bytes the product's region map gives
 * it, named after the region. The field's region is the one named `prefix` + the field's name (tmpIdxByte:
 * stampTmpIdx), else the region the offset falls in. Other fields are copied; -1 (none) stays.
 * @param {import('./asanSession.mjs').AsanSession} session
 * @param {{ regions: Record<string, { byte: number, bytes: number }> }} map renderQueueMemoryRegions' result
 * @param {Record<string, any>} layout
 * @param {string} prefix
 * @param {Map<string, number>} [placed] regions already placed (shared between layouts of one memory)
 * @returns {{ layout: Record<string, any>, placed: Map<string, { ptr: number, bytes: number }> }}
 */
export function relocateLayout(session, map, layout, prefix, placed = new Map()) {
  const regions = Object.entries(map.regions);
  const out = {};
  for (const [key, value] of Object.entries(layout)) {
    if (!key.endsWith('Byte') || typeof value !== 'number' || value < 0) {
      out[key] = value;
      continue;
    }
    const base = key.slice(0, -4);
    let name = [`${prefix}${capitalize(base)}`, base].find((n) => map.regions[n] && map.regions[n].byte === value);
    if (!name) {
      const hit = regions.find(([, r]) => r.bytes > 0 && value >= r.byte && value < r.byte + r.bytes);
      if (!hit) throw new Error(`relocateLayout: ${key} = ${value} is in no region`);
      name = hit[0];
    }
    const region = map.regions[name];
    let at = placed.get(name);
    if (!at) {
      at = { ptr: session.malloc(region.bytes, name), bytes: region.bytes };
      // Zeroed, as a fresh memory's regions are (the cases fill the scratch with their own bytes before each run).
      new Uint8Array(session.buffer, at.ptr, at.bytes).fill(0);
      placed.set(name, at);
    }
    out[key] = at.ptr + (value - region.byte);
  }
  return { layout: out, placed };
}

/**
 * relocateLayout for a whole layout tree (createRenderQueueMemory's layout with its emit, collect, custom layers...):
 * every `…Byte` field at any depth moved into a block of its own, aligned to the product's cache line (64 bytes: a
 * placed memory checks it), named after its region: the region named one of `prefixes` + the field's name, else the
 * one whose bytes hold the offset. The tree is copied; -1 stays.
 * @returns {{ layout: any, placed: Map<string, { ptr: number, bytes: number }> }}
 */
export function relocateTree(session, map, layout, prefixes = [''], placed = new Map()) {
  const regions = Object.entries(map.regions);
  const place = (key, value) => {
    const base = key.slice(0, -4);
    let name = prefixes.map((p) => (p ? `${p}${capitalize(base)}` : base)).find((n) => map.regions[n] && map.regions[n].byte === value);
    if (!name) {
      const hit = regions.find(([, r]) => r.bytes > 0 && value >= r.byte && value < r.byte + r.bytes);
      if (!hit) throw new Error(`relocateTree: ${key} = ${value} is in no region`);
      name = hit[0];
    }
    const region = map.regions[name];
    let at = placed.get(name);
    if (!at) {
      at = { ptr: session.malloc(region.bytes, name, 0, 64), bytes: region.bytes };
      // Zeroed, as a fresh memory's regions are: a table slot no writer touched reads 0 (absent) in the product.
      new Uint8Array(session.buffer, at.ptr, at.bytes).fill(0);
      placed.set(name, at);
    }
    return at.ptr + (value - region.byte);
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
    const out = {};
    for (const [key, value] of Object.entries(v)) {
      out[key] = key.endsWith('Byte') && typeof value === 'number' && value >= 0 ? place(key, value) : walk(value);
    }
    return out;
  };
  return { layout: walk(layout), placed };
}

/** Byte views of placed regions (relocateLayout's), all but the `skip` names. */
export function placedViews(session, placed, skip = []) {
  const out = [];
  for (const [name, at] of placed) {
    if (skip.includes(name)) continue;
    out.push(new Uint8Array(session.buffer, at.ptr, at.bytes));
  }
  return out;
}

/** The paths of a revision the harness imports (clients, their imports, the shipped engine.wasm, the test helpers). */
const REV_PATHS = ['src', 'tests/helpers', 'tests/reference', 'tests/bench/workerHarness.mjs', 'tests/bench/benchMath.js',
  'tests/bench/microbenchHelpers.mjs'];

/**
 * The directory that holds a revision's sources as the harness imports them: tests/results/asan/rev-<hash>/, written
 * once from git's objects (git ls-tree and cat-file, no checkout: the working tree and its index stay as they are).
 */
export function revisionRoot(rev) {
  const sha = revHash(rev);
  const dir = path.join(asanResults, `rev-${sha}`);
  const done = path.join(dir, '.complete');
  if (fs.existsSync(done)) return dir;
  const list = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '-z', sha, '--', ...REV_PATHS], { maxBuffer: 64 << 20 })
    .toString('utf8').split('\0').filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, object] = line.slice(0, tab).split(' ');
      return { mode, type, object, file: line.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob');
  const data = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: list.map((e) => e.object).join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  let at = 0;
  for (const e of list) {
    const nl = data.indexOf(10, at);
    const header = data.toString('utf8', at, nl).split(' ');
    const size = Number(header[2]);
    const body = data.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const file = path.join(dir, e.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  fs.writeFileSync(done, `${sha}\n`);
  return dir;
}

/** An importer of repo-relative modules from `root` (the working tree, or a revision's directory). */
export function importerFor(root) {
  return (rel) => import(pathToFileURL(path.join(root, rel)).href);
}
