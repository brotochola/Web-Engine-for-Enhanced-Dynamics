/**
 * DX-DIRSPRITE kernel: DirectionalSprite.resolve over N moving entities (the logic worker's pass after the ticks), against
 * the selector Predator's people wrote by hand (an octant from the velocity, a new animation when it changes).
 *
 *   node tests/bench/directionalSpriteMicrobench.mjs [--n 5000] [--turn 0.02] [--output path]
 *
 * Cases:
 *   hand4      Predator's selector: 4 directions from the velocity by comparisons, a write when the octant changes
 *   ds4        DirectionalSprite, 4 directions, facingFrom 'velocity' (an atan2 per moving entity, the margin)
 *   ds32       DirectionalSprite, 32 directions (a render), facingFrom 'rotation'
 *   ds32odd    the same 32 with one moved half a degree: the slow nearest-of-all path
 *
 * Every entity turns its heading by --turn radians a frame, so directions change as often as a crowd's do. The checksum is
 * the animations drawn after the run, which the hand and ds4 cases must agree on with a margin of 0 (they pick the same
 * octant).
 */
import { DirectionalSprite, FACING_FROM } from '../../src/components/directionalSprite.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { buildDirectionTable } from '../../src/core/spriteDirections.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const LPC = ['walk_up', 'walk_left', 'walk_down', 'walk_right', 'idle_up', 'idle_left', 'idle_down', 'idle_right'];
/** Frames each case runs from the same start before its checksum. */
const CHECK_FRAMES = 120;
const RENDER = Array.from({ length: 32 }, (_, i) => `drive_${i}`);

function sheet(name, animations, spec) {
  const indexToName = {};
  const anims = {};
  animations.forEach((n, k) => {
    indexToName[k] = n;
    anims[n] = { originalName: n, index: k };
  });
  const directions = buildDirectionTable(name, spec, animations);
  SpriteSheetRegistry.registerProxy(name, { isProxy: true, targetSheet: 'bigAtlas', prefix: `${name}_`, animations: anims, indexToName, directions });
  SpriteSheetRegistry.frameDimensions.set(name, new Map(animations.map((n) => [`${name}_${n}`, { w: 64, h: 64 }])));
  return SpriteSheetRegistry.getSpritesheetId(name);
}

function bind(n) {
  SpriteSheetRegistry.clearForSceneUnload();
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(n)), n);
  DirectionalSprite.initializeArrays(new SharedArrayBuffer(DirectionalSprite.getBufferSize(n)), n);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  for (const k of ['x', 'y', 'rotC', 'rotS']) Transform[k] = new Float32Array(n);
  for (const k of ['vx', 'vy']) RigidBody[k] = new Float32Array(n);
  LightEmitter.clearArrays();
  DirectionalSprite._tables = [];
}

/** Predator's personAnimationFsm: the octant of the velocity, as a DIRECTION_* index (up, left, down, right). */
function facingIndexFromVelocity(vx, vy) {
  const ax = vx < 0 ? -vx : vx;
  const ay = vy < 0 ? -vy : vy;
  if (ay >= ax) return vy >= 0 ? 2 : 0;
  return vx >= 0 ? 3 : 1;
}

/** The hand-written pass: what Predator's walking state did per entity, with the write setAnimation made on a change. */
function handPass(n, facingDir, walkAnim) {
  const vx = RigidBody.vx;
  const vy = RigidBody.vy;
  const speed = RigidBody.speed;
  const state = SpriteRenderer.animationState;
  for (let i = 0; i < n; i++) {
    if (speed[i] > 4) {
      const d = facingIndexFromVelocity(vx[i], vy[i]);
      if (d !== facingDir[i]) {
        facingDir[i] = d;
        const anim = walkAnim[d];
        if (state[i] !== anim) {
          state[i] = anim;
          SpriteRenderer.updateBounds(i);
          SpriteRenderer.renderDirty[i] = 1;
          SpriteRenderer.keyedDirty[i] = 1;
        }
      }
    }
  }
}

function dsPass(n) {
  for (let i = 0; i < n; i++) DirectionalSprite.resolve(i);
}

/** Each entity's heading turns by `turn` a frame: velocity 60 px/s along it, and its rotation. */
function step(n, heading, turn) {
  const vx = RigidBody.vx;
  const vy = RigidBody.vy;
  const sp = RigidBody.speed;
  const rc = Transform.rotC;
  const rs = Transform.rotS;
  for (let i = 0; i < n; i++) {
    const h = heading[i] + turn * (i & 1 ? 1 : -1);
    heading[i] = h;
    const c = Math.cos(h);
    const s = Math.sin(h);
    vx[i] = c * 60;
    vy[i] = s * 60;
    sp[i] = 60;
    rc[i] = c;
    rs[i] = s;
  }
}

export function runDirectionalSpriteMicrobench({ n = 5000, turn = 0.02, output = null } = {}) {
  const results = {};
  const sums = {};
  for (const kase of ['hand4', 'ds4', 'ds32', 'ds32odd']) {
    bind(n);
    const lpc = sheet('civil', LPC);
    const spec32 = { drive: { count: 32, anims: 'drive_{i}' } };
    const odd = { drive: Object.fromEntries(RENDER.map((name, i) => [String(i === 5 ? 56.75 : i * 11.25), name])) };
    const render = kase === 'ds32' ? sheet('hatch', RENDER, spec32) : kase === 'ds32odd' ? sheet('hatch', RENDER, odd) : 0;
    const rand = mulberry32(7);
    const heading = new Float64Array(n);
    for (let i = 0; i < n; i++) heading[i] = rand() * Math.PI * 2;
    const facingDir = new Uint8Array(n).fill(255);
    const walkAnim = Int32Array.from(['walk_up', 'walk_left', 'walk_down', 'walk_right'].map((a) => LPC.indexOf(a)));
    for (let i = 0; i < n; i++) {
      SpriteRenderer.active[i] = 1;
      SpriteRenderer.scaleX[i] = 1;
      SpriteRenderer.scaleY[i] = 1;
      SpriteRenderer.spritesheetId[i] = kase.startsWith('ds32') ? render : lpc;
      SpriteRenderer.animationState[i] = 255;
      RigidBody.active[i] = 1;
      DirectionalSprite.resetRow(i);
      DirectionalSprite.turnMargin[i] = kase === 'ds4' ? 0 : Number.NaN;
      DirectionalSprite.facingFrom[i] = kase.startsWith('ds32') ? FACING_FROM.ROTATION : FACING_FROM.VELOCITY;
      if (kase !== 'hand4') DirectionalSprite.setGroup(i, kase.startsWith('ds32') ? 'drive' : 'walk');
    }
    const pass = kase === 'hand4' ? () => handPass(n, facingDir, walkAnim) : () => dsPass(n);
    const small = kase === 'hand4' ? () => handPass(64, facingDir, walkAnim) : () => dsPass(64);
    warmNormalCompile(() => {
      step(64, heading, turn);
      small();
    });
    // The checksum: the same start and the same CHECK_FRAMES for every case (the warm-up turned the first 64).
    for (let i = 0; i < n; i++) heading[i] = (i * 2.399963) % (Math.PI * 2);
    for (let f = 0; f < CHECK_FRAMES; f++) {
      step(n, heading, turn);
      pass();
    }
    sums[kase] = checksumInts(SpriteRenderer.animationState, n);
    results[kase] = timeIt(`${kase} n=${n}`, (frames) => {
      for (let f = 0; f < frames; f++) {
        step(n, heading, turn);
        pass();
      }
    }, { iterations: 20, warmup: 5, reps: 5 });
    results[kase].nsPerEntity = (results[kase].ms * 1e6) / (results[kase].iterations * n);
  }
  // The step alone, to take out of each case.
  bind(n);
  const heading = new Float64Array(n);
  const stepOnly = timeIt(`step n=${n}`, (frames) => {
    for (let f = 0; f < frames; f++) step(n, heading, turn);
  }, { iterations: 20, warmup: 5, reps: 5 });
  const report = {
    name: 'directional-sprite',
    n,
    turn,
    checksums: sums,
    handAndDs4Agree: sums.hand4 === sums.ds4,
    stepMs: stepOnly.ms / stepOnly.iterations,
    cases: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, {
      msPerFrame: r.ms / r.iterations,
      passMsPerFrame: r.ms / r.iterations - stepOnly.ms / stepOnly.iterations,
      nsPerEntity: r.nsPerEntity,
      opsPerSec: r.opsPerSec,
    }])),
  };
  if (!report.handAndDs4Agree) throw new Error(`checksum: hand4 ${sums.hand4} and ds4 ${sums.ds4} drew different animations`);
  for (const [k, c] of Object.entries(report.cases)) {
    console.log(`${k.padEnd(8)} pass ${c.passMsPerFrame.toFixed(3)} ms/frame for ${n} (${((c.passMsPerFrame * 1e6) / n).toFixed(1)} ns each)`);
  }
  if (output) writeReport(output, report);
  return report;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  runDirectionalSpriteMicrobench({ n: args.n ?? 5000, turn: args.turn ?? 0.02, output: args.output ? String(args.output) : null });
}
