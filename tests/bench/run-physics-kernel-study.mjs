import { performance } from 'node:perf_hooks';

const DEFAULT_ENTITY_COUNT = 100_000;
const DEFAULT_ITERATIONS = 240;

function parseArgs(argv) {
  const out = {
    entities: DEFAULT_ENTITY_COUNT,
    iterations: DEFAULT_ITERATIONS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--entities' && argv[i + 1]) out.entities = Number(argv[++i]) || out.entities;
    else if (arg === '--iterations' && argv[i + 1]) out.iterations = Number(argv[++i]) || out.iterations;
  }
  out.entities = Math.max(1, out.entities | 0);
  out.iterations = Math.max(1, out.iterations | 0);
  return out;
}

function createState(count) {
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  const ax = new Float32Array(count);
  const ay = new Float32Array(count);
  const friction = new Float32Array(count);
  const maxVel = new Float32Array(count);
  const sleeping = new Uint8Array(count);
  const isStatic = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const col = i % 512;
    const row = (i / 512) | 0;
    x[i] = col * 3.25;
    y[i] = row * 3.25;
    px[i] = x[i] - ((i % 7) - 3) * 0.01;
    py[i] = y[i] - ((i % 11) - 5) * 0.01;
    ax[i] = ((i % 5) - 2) * 0.001;
    ay[i] = ((i % 3) - 1) * 0.001;
    friction[i] = (i % 4) * 0.0001;
    maxVel[i] = 100;
    sleeping[i] = i % 97 === 0 ? 1 : 0;
    isStatic[i] = i % 211 === 0 ? 1 : 0;
  }

  return { x, y, px, py, vx, vy, ax, ay, friction, maxVel, sleeping, isStatic };
}

function cloneState(state) {
  return {
    x: new Float32Array(state.x),
    y: new Float32Array(state.y),
    px: new Float32Array(state.px),
    py: new Float32Array(state.py),
    vx: new Float32Array(state.vx),
    vy: new Float32Array(state.vy),
    ax: new Float32Array(state.ax),
    ay: new Float32Array(state.ay),
    friction: new Float32Array(state.friction),
    maxVel: new Float32Array(state.maxVel),
    sleeping: new Uint8Array(state.sleeping),
    isStatic: new Uint8Array(state.isStatic),
  };
}

function stepOne(i, state, constants) {
  const { x, y, px, py, vx, vy, ax, ay, friction, maxVel, sleeping, isStatic } = state;
  if (isStatic[i] || sleeping[i]) {
    if (sleeping[i]) {
      px[i] = x[i];
      py[i] = y[i];
      ax[i] = 0;
      ay[i] = 0;
    }
    return;
  }

  const oldX = x[i];
  const oldY = y[i];
  let dx = (oldX - px[i]) * constants.damping;
  let dy = (oldY - py[i]) * constants.damping;
  const f = friction[i];
  if (f > 0) {
    const frictionFactor = 1 - f * constants.dtRatio;
    dx *= frictionFactor;
    dy *= frictionFactor;
  }

  dx += constants.gravityScale * constants.gx + ax[i] * constants.dtRatio;
  dy += constants.gravityScale * constants.gy + ay[i] * constants.dtRatio;

  const speedSq = dx * dx + dy * dy;
  const maxSpeed = maxVel[i] * constants.dtRatio;
  const maxSpeedSq = maxSpeed * maxSpeed;
  if (speedSq > maxSpeedSq) {
    const scale = maxSpeed / Math.sqrt(speedSq);
    dx *= scale;
    dy *= scale;
  }

  x[i] = oldX + dx;
  y[i] = oldY + dy;
  px[i] = oldX;
  py[i] = oldY;
  vx[i] = dx * constants.invDtRatio;
  vy[i] = dy * constants.invDtRatio;
  ax[i] = 0;
  ay[i] = 0;
}

function scalarKernel(state, constants, iterations) {
  const count = state.x.length;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < count; i++) stepOne(i, state, constants);
  }
}

function unrolled4Kernel(state, constants, iterations) {
  const count = state.x.length;
  for (let it = 0; it < iterations; it++) {
    let i = 0;
    for (; i + 3 < count; i += 4) {
      stepOne(i, state, constants);
      stepOne(i + 1, state, constants);
      stepOne(i + 2, state, constants);
      stepOne(i + 3, state, constants);
    }
    for (; i < count; i++) stepOne(i, state, constants);
  }
}

function checksum(state) {
  let sum = 0;
  const stride = Math.max(1, (state.x.length / 1024) | 0);
  for (let i = 0; i < state.x.length; i += stride) {
    sum += state.x[i] * 0.001 + state.y[i] * 0.002 + state.vx[i] * 0.003 + state.vy[i] * 0.004;
  }
  return sum;
}

function runKernel(name, kernel, baseState, constants, iterations) {
  const state = cloneState(baseState);
  kernel(state, constants, 8); // warm JIT
  const start = performance.now();
  kernel(state, constants, iterations);
  const elapsedMs = performance.now() - start;
  return {
    name,
    elapsedMs,
    entitiesPerSecond: (state.x.length * iterations) / (elapsedMs / 1000),
    checksum: checksum(state),
  };
}

const options = parseArgs(process.argv.slice(2));
const baseState = createState(options.entities);
const constants = {
  damping: 0.995,
  dtRatio: 1,
  invDtRatio: 1,
  gravityScale: 1,
  gx: 0,
  gy: 0.5,
};

const results = [
  runKernel('scalar', scalarKernel, baseState, constants, options.iterations),
  runKernel('unrolled4-wrapper', unrolled4Kernel, baseState, constants, options.iterations),
];

console.log(JSON.stringify({
  benchmark: 'physics-kernel-study',
  entities: options.entities,
  iterations: options.iterations,
  results,
}, null, 2));
