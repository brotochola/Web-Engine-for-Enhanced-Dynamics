#!/usr/bin/env node
/**
 * Kernel (E-288): logic's accelerations into Box2D and the step that uses them, on the shipped src/box2d build in Node
 * (one thread: Box2D's tasks run inline, so this times the total work, not its spread over the pool). N dynamic boxes
 * on a grid with no contacts, no gravity, sleeping off; most have an acceleration, some an angular one, every frame.
 * One op = bodies_apply_accelerations over every body, then step_world (1/60 s, 4 substeps). The checksum covers every
 * body's velocity after the warm-up frames, so two builds that apply the same forces give the same checksum.
 *
 *   node tests/bench/bodyAccelerationsMicrobench.mjs [--n 25000] [--frames 60] [--output path]
 */
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const BODY_DYNAMIC = 1;
const CH_VX = 3;
const CH_VY = 4;
const CH_W = 5;

export function setupBodyAccelerations(n, seed = 0xe288) {
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations', 'malloc'], { pages: 4096 });
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(n + 64)) throw new Error('bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  const cols = 250;
  for (let i = 0; i < n; i++) {
    const slot = fn('create_body_box')(
      worldId, BODY_DYNAMIC, (i % cols) * 4, Math.floor(i / cols) * 4, 0, 0.5, 0.5, 0, 0, 2, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
    );
    if (slot !== i) throw new Error(`create_body_box gave slot ${slot} for ${i}`);
  }
  const malloc = fn('malloc');
  const listByte = malloc(n * 2);
  const f32 = () => malloc(n * 4);
  const b = { ax: f32(), ay: f32(), aa: f32(), mass: f32(), inertia: f32(), isStatic: malloc(n), fixed: malloc(n) };
  const list = new Uint16Array(memory.buffer, listByte, n);
  const col = (byte) => new Float32Array(memory.buffer, byte, n);
  const ax = col(b.ax);
  const ay = col(b.ay);
  const aa = col(b.aa);
  const rng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    list[i] = i;
    const r = rng();
    ax[i] = r < 0.9 ? (rng() - 0.5) * 0.2 : 0;
    ay[i] = r < 0.9 ? (rng() - 0.5) * 0.2 : 0;
    aa[i] = r < 0.3 ? (rng() - 0.5) * 0.1 : 0;
  }
  col(b.mass).fill(2);
  col(b.inertia).fill(0.4);
  new Uint8Array(memory.buffer, b.isStatic, n).fill(0);
  new Uint8Array(memory.buffer, b.fixed, n).fill(0);
  const apply = fn('bodies_apply_accelerations');
  const step = fn('step_world');
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  return {
    frame() {
      apply(listByte, n, b.ax, b.ay, b.aa, b.mass, b.inertia, b.isStatic, b.fixed);
      step(worldId, 1 / 60, 4);
    },
    checksum() {
      const f = new Float32Array(memory.buffer);
      const u = new Uint32Array(memory.buffer);
      let h = 2166136261;
      for (const c of [CH_VX, CH_VY, CH_W]) {
        const base = (stateByte >> 2) + c * cap;
        for (let i = 0; i < n; i++) {
          if (f[base + i] !== f[base + i]) throw new Error('NaN velocity');
          h = Math.imul(h ^ u[base + i], 16777619) >>> 0;
        }
      }
      return checksumInts([h], 1);
    },
  };
}

function main() {
  const args = parseArgs();
  const n = Number(args.n ?? 25000);
  const frames = Number(args.frames ?? 60);
  const k = setupBodyAccelerations(n);
  for (let f = 0; f < frames; f++) k.frame();
  const checksum = k.checksum();
  const cases = {
    frame: timeIt(`apply + step (n=${n})`, () => k.frame(), { iterations: 60, warmup: 10 }),
  };
  console.log(`checksum ${checksum}`);
  if (args.output) writeReport(String(args.output), { feature: 'body-accelerations', n, frames, checksum, cases });
}

if (isCli(import.meta.url)) main();
