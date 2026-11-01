#!/usr/bin/env node
/**
 * Kernel (E-181, E-182): one Box2D step of awake bodies without contacts, the cost the state export and the moved
 * list put on it. Node, the repo's box2dWasm.wasm, single-threaded (tests/helpers/box2dWasmInstance.mjs), sleeping off,
 * no gravity: N dynamic circles on a grid far apart, either all moving (`--case moving`, vx 40, E-182's case: every
 * body finalized, exported and listed) or all still (`--case still`, E-181's: awake bodies that do not move).
 * Checksum, after the 30 warm-up steps: a sample of the bodies' exported x (the same on any build) and the moved
 * list's length (which E-181 changes in the still case).
 *
 *   node tests/bench/moveExportMicrobench.mjs [--case moving|still] [--bodies 20000] [--output path]
 */
import { parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const args = parseArgs();
const CASE = String(args.case ?? 'moving');
if (CASE !== 'moving' && CASE !== 'still') throw new Error(`--case moving or still, not ${CASE}`);
const N = Number(args.bodies ?? 20000);
const BODY_DYNAMIC = 1;

const { memory, fn } = instantiateBox2dWasm(['create_body_circle', 'get_body_move_count']);
const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
if (!worldId) throw new Error('create_world failed');
if (!fn('bind_game_buffers')(N + 64)) throw new Error('bind_game_buffers failed');
fn('world_enable_sleeping')(worldId, 0);
const create = fn('create_body_circle');
const cols = Math.ceil(Math.sqrt(N));
const vx = CASE === 'moving' ? 40 : 0;
for (let i = 0; i < N; i++) {
  const slot = create(
    worldId, BODY_DYNAMIC, (i % cols) * 40, ((i / cols) | 0) * 40, 0, 4, 0, 0, 1, 0, 0, 0, 0, 0,
    vx, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i,
  );
  if (slot !== i) throw new Error(`create_body_circle ${i} gave ${slot}`);
}
const step = fn('step_world');
const moveCount = fn('get_body_move_count');
const stateX = (fn('get_state_byte_offset')() >> 2);

function call() {
  step(worldId, 1 / 60, 4);
}

function checksum() {
  const f32 = new Float32Array(memory.buffer);
  let s = 0;
  for (let i = 0; i < N; i += 97) s = (s * 31 + Math.round(f32[stateX + i] * 16)) >>> 0;
  return (s ^ moveCount()) >>> 0;
}

warmNormalCompile(call, 30);
const moved = moveCount();
const sum = checksum();
const r = timeIt('step_world', call, { reps: 9 });
const report = {
  kernel: 'moveExport',
  case: CASE,
  bodies: N,
  movedPerStep: moved,
  checksum: sum,
  ms: r.ms,
  opsPerSec: r.opsPerSec,
  usPerStep: 1e6 / r.opsPerSec,
};
console.log(`${CASE}, ${N} bodies, moved ${moved} a step, checksum ${sum}: ${report.usPerStep.toFixed(1)} us a step (${r.opsPerSec.toFixed(1)} steps/s)`);
if (args.output) writeReport(String(args.output), report);
