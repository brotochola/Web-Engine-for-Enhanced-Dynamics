#!/usr/bin/env node
/**
 * Kernel: GameObject's per-frame setters (N-170, N-215) as a game's tick calls them, on real columns, the command ring
 * unbound (no Box2D body). One op is a frame over `--n` walkers (4096 by default), each walker:
 *   - moving: x and y to new values, setVelocity to new values, setAnimationSpeed and alpha to the same values as
 *     the frame before (values float32 cannot hold: 0.3 x 0.00277 and 0.3, so only N-170's compare lets them out
 *     early);
 *   - same: every one of those to the value it already has (all early-outs).
 * The checksum folds the columns and the dirty flags after a fixed number of frames.
 *
 *   node tests/bench/setterMicrobench.mjs [--n 4096] [--output path]
 *   node tests/bench/setterMicrobench.mjs --go src/core/gameObject.other.js
 * --go times the setters of another gameObject.js in this tree's src/core (a copy of another build, so its relative
 * imports are this tree's): two builds of the setters compare in alternating processes of one tree.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const CHECK_FRAMES = 64;

/** Columns for n walkers, and n entities of `GameObject` over them (the way the engine's tests make one). */
export function setupSetters(GameObject, n) {
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotation = new Float32Array(n);
  Transform.rotC = new Float32Array(n).fill(1);
  Transform.rotS = new Float32Array(n);
  Transform.entityType = new Uint8Array(n);
  RigidBody.vx = new Float32Array(n);
  RigidBody.vy = new Float32Array(n);
  RigidBody.angularVelocity = new Float32Array(n);
  SpriteRenderer.alpha = new Float32Array(n).fill(1);
  SpriteRenderer.scaleX = new Float32Array(n).fill(1);
  SpriteRenderer.scaleY = new Float32Array(n).fill(1);
  SpriteRenderer.animationSpeed = new Float32Array(n);
  SpriteRenderer.flip = new Uint8Array(n);
  SpriteRenderer.renderDirty = new Uint8Array(n);
  SpriteRenderer.keyedDirty = new Uint8Array(n);
  const has = { RigidBody: true, SpriteRenderer: true, MeshRenderer: false, adobeAnimComponent: false, Box2dBody: false };
  const entities = [];
  for (let i = 0; i < n; i++) {
    const go = Object.create(GameObject.prototype);
    go.index = i;
    go._hasComponents = has;
    entities.push(go);
  }
  return entities;
}

/** One frame of the `moving` case: frame f moves every walker; speed and alpha are set again to the same values. */
function frameMoving(entities, f) {
  const n = entities.length;
  const t = (f & 1023) * 0.37;
  for (let i = 0; i < n; i++) {
    const e = entities[i];
    e.x = i * 0.5 + t;
    e.y = i * 0.25 - t;
    e.setVelocity(t * 0.1, -t * 0.2);
    e.setAnimationSpeed(0.3 * 0.00277);
    e.alpha = 0.3;
  }
}

/** One frame of the `same` case: every setter given the value it already holds. */
function frameSame(entities) {
  const n = entities.length;
  for (let i = 0; i < n; i++) {
    const e = entities[i];
    e.x = i * 0.1;
    e.y = i * 0.3;
    e.setVelocity(0.7, -0.3);
    e.setAnimationSpeed(0.3 * 0.00277);
    e.alpha = 0.3;
  }
}

function checksum(n) {
  let h = checksumFloats(Transform.x, n);
  h = Math.imul(h ^ checksumFloats(Transform.y, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumFloats(RigidBody.vx, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumFloats(RigidBody.vy, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumFloats(SpriteRenderer.animationSpeed, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumFloats(SpriteRenderer.alpha, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumInts(SpriteRenderer.renderDirty, n), 16777619) >>> 0;
  h = Math.imul(h ^ checksumInts(SpriteRenderer.keyedDirty, n), 16777619) >>> 0;
  return h >>> 0;
}

async function main() {
  const args = parseArgs();
  const n = Number(args.n ?? 4096);
  const goFile = args.go ? path.resolve(String(args.go)) : path.resolve(import.meta.dirname, '../../src/core/gameObject.js');
  const { GameObject } = await import(pathToFileURL(goFile).href);
  const cases = {};
  const sums = {};
  for (const name of ['moving', 'same']) {
    const entities = setupSetters(GameObject, n);
    let f = 0;
    const one = name === 'moving' ? () => frameMoving(entities, f++) : () => frameSame(entities);
    // The flags the first frames set, cleared once: the checksum counts what CHECK_FRAMES frames mark after that.
    one();
    SpriteRenderer.renderDirty.fill(0);
    SpriteRenderer.keyedDirty.fill(0);
    for (let k = 1; k < CHECK_FRAMES; k++) one();
    sums[name] = checksum(n);
    warmNormalCompile(one, 300);
    cases[name] = timeIt(`${name} (${n} walkers)`, one, { iterations: 50, warmup: 10 });
    cases[name].checksum = sums[name];
  }
  const report = {
    feature: 'gameobject-setters',
    functions: ['GameObject set x', 'set y', 'setVelocity', 'setAnimationSpeed', 'set alpha'],
    n,
    go: path.relative(path.resolve(import.meta.dirname, '../..'), goFile),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify({ n, go: report.go, moving: cases.moving.opsPerSec, same: cases.same.opsPerSec, sums }));
}

if (isCli(import.meta.url)) await main();
