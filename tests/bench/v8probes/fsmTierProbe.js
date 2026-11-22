// Run: D:/perf-tools/v8/debug/v8-debug.exe --trace-opt --trace-opt-verbose tests/bench/v8probes/fsmTierProbe.js -- 300
// E-292: does a Predator-shaped FSM state's onUpdate (FleeingCivilianBehaviorState's body) tier up to TurboFan when
// a dispatcher calls the state classes' static onUpdate per entity? d8 --trace-opt says why or why not.
const N = 20000;
const MAXN = 32;
const neighborData = new Int32Array(N * (MAXN + 1));
const entityType = new Uint8Array(N);
const x = new Float32Array(N);
const y = new Float32Array(N);
const ax = new Float32Array(N);
const ay = new Float32Array(N);
const soldierState = new Uint8Array(N);
const panicX = new Float32Array(N);
const panicY = new Float32Array(N);
const civState = new Uint8Array(N);
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
for (let i = 0; i < N; i++) {
  entityType[i] = rnd() < 0.1 ? 2 : 1;
  x[i] = rnd() * 4000;
  y[i] = rnd() * 4000;
  soldierState[i] = (rnd() * 4) | 0;
  const row = i * (MAXN + 1);
  const n = (rnd() * MAXN) | 0;
  neighborData[row] = n;
  for (let k = 1; k <= n; k++) neighborData[row + k] = (rnd() * N) | 0;
}
const SOLDIER = 2;
const RANGED = 1;
const CLOSE = 2;

class CivilianClass { static accelDistFloorSq = 400; }
const classByType = [null, CivilianClass, CivilianClass];

const fsm = {
  states: null,
  changeState(i, s) { civState[i] = s.stateIndex; },
  isInState(i, s) { return civState[i] === s.stateIndex; },
};

function tryPanic(i, nb, soldierType) {
  if (entityType[nb] !== soldierType) return false;
  const st = soldierState[nb];
  if (st !== RANGED && st !== CLOSE) return false;
  panicX[i] = x[nb];
  panicY[i] = y[nb];
  const PANIC = fsm.states.PANIC;
  if (!fsm.isInState(i, PANIC)) fsm.changeState(i, PANIC);
  return true;
}

class FSMState {}
class Idle extends FSMState {
  static onUpdate(i, dt) {
    const row = i * (MAXN + 1);
    const n = neighborData[row];
    for (let k = 1; k <= n; k++) {
      const nb = neighborData[row + k];
      if (tryPanic(i, nb, SOLDIER)) return;
      if (entityType[nb] === SOLDIER) { this.fsm.changeState(i, this.fsm.states.FLEEING); return; }
    }
  }
}
class Fleeing extends FSMState {
  static onUpdate(i, dt) {
    const rows = neighborData;
    const row = i * (MAXN + 1);
    const neighborCount = rows[row];
    const floorSq = classByType[entityType[i]].accelDistFloorSq;
    let fleeX = 0;
    let fleeY = 0;
    let predatorCount = 0;
    const myX = x[i];
    const myY = y[i];
    for (let n = 1; n <= neighborCount; n++) {
      const nb = rows[row + n];
      if (tryPanic(i, nb, SOLDIER)) return;
      if (entityType[nb] === SOLDIER) {
        const dx = myX - x[nb];
        const dy = myY - y[nb];
        const d2raw = dx * dx + dy * dy;
        if (d2raw > 1) {
          const d2 = d2raw < floorSq ? floorSq : d2raw;
          fleeX += dx / d2;
          fleeY += dy / d2;
          predatorCount++;
        }
      }
    }
    if (predatorCount === 0) { this.fsm.changeState(i, this.fsm.states.IDLE); return; }
    const f = 40500 / predatorCount;
    ax[i] += fleeX * f;
    ay[i] += fleeY * f;
  }
}
class Panic extends FSMState {
  static onUpdate(i, dt) { if (dt > 1e9) this.fsm.changeState(i, this.fsm.states.IDLE); }
}
Idle.stateIndex = 0; Fleeing.stateIndex = 1; Panic.stateIndex = 2;
for (const S of [Idle, Fleeing, Panic]) S.fsm = fsm;
fsm.states = { IDLE: Idle, FLEEING: Fleeing, PANIC: Panic };
const byIndex = [Idle, Fleeing, Panic];

function tickAll(dt) {
  for (let i = 0; i < N; i++) {
    if (entityType[i] !== 1) continue;
    // Keep a mix of states each frame, as Predator's crowd has.
    if ((i & 7) === 0) civState[i] = 1;
    const S = byIndex[civState[i]];
    S.onUpdate(i, dt);
  }
}
const frames = Number(globalThis.arguments?.[0] ?? 600);
const t0 = Date.now();
for (let f = 0; f < frames; f++) tickAll(16.67);
let s = 0;
for (let i = 0; i < N; i++) s += ax[i] + ay[i];
print(`frames ${frames} in ${Date.now() - t0} ms, checksum ${s.toFixed(3)}`);
