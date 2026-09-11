// ponytail: coupling math self-check. node fire/coupling-check.js
function crust(d, h, pad) {
  return d <= h + pad;
}

const h = 0.05;
const pad = 0;
if (!crust(0, h, pad)) throw new Error("surface should burn");
if (!crust(-0.2, h, pad)) throw new Error("interior should be source");
if (crust(h + 0.01, h, pad)) throw new Error("outside band");

function rigid(lin, omega, px, py, wx, wy) {
  return {
    vx: lin.x - omega * (wy - py),
    vy: lin.y + omega * (wx - px),
  };
}

const v = rigid({ x: 2, y: 0 }, 1, 0, 0, 0, 1);
if (Math.abs(v.vx - 1) > 1e-6) throw new Error("omega cross x");
if (Math.abs(v.vy - 0) > 1e-6) throw new Error("omega cross y");

function swirlSlotP(chance, bound, hCell, nBurn, maxSwirls) {
  const p = Math.min(1, chance * bound * hCell * 8);
  return (p * nBurn) / Math.max(maxSwirls, 1);
}
const nBurn = 5;
const maxSwirls = 155;
const pSlot = swirlSlotP(0.8, 0.5, 0.05, nBurn, maxSwirls);
const jsExpect = nBurn * Math.min(1, 0.8 * 0.5 * 0.05 * 8);
const gpuExpect = maxSwirls * pSlot;
if (Math.abs(jsExpect - gpuExpect) > 1e-9) throw new Error("swirl spawn rate");

function snapOrigin(pad, h) {
  return Math.floor(pad / h) * h;
}

function cellDelta(oldO, newO, h) {
  return Math.round((newO - oldO) / h);
}

const cellH = 0.25;
if (snapOrigin(1.1, cellH) !== 1.0) throw new Error("snap floor to h");
if (snapOrigin(-0.3, cellH) !== -0.5) throw new Error("snap negative origin");
if (cellDelta(1.0, 1.25, cellH) !== 1) throw new Error("one cell origin jump");
if (cellDelta(1.0, 1.0, cellH) !== 0) throw new Error("no jump when origin holds");
if (cellDelta(0, -1, cellH) !== -4) throw new Error("leftward origin jump");

function shiftSample(id, di, num) {
  const src = id + di;
  if (src < 0 || src >= num) return 0;
  return src;
}
if (shiftSample(0, 1, 8) !== 1) throw new Error("shift reads right neighbor");
if (shiftSample(0, -1, 8) !== 0) throw new Error("shift off-grid is vacuum");
if (shiftSample(7, 1, 8) !== 0) throw new Error("shift past end is vacuum");

function packVel(vel, scale = 0.12) {
  return 0.5 + 0.5 * Math.tanh(vel * scale);
}
if (Math.abs(packVel(0) - 0.5) > 1e-9) throw new Error("zero vel packs mid");
if (packVel(20) <= packVel(5)) throw new Error("faster vel brighter pack");

function fireBand(f, fireN, nAmt) {
  return Math.min(1, Math.max(0, f + nAmt * (fireN - 0.5) * 0.85));
}
if (Math.abs(fireBand(0.5, 0.5, 1) - 0.5) > 1e-9) throw new Error("mid noise no band shift");
if (fireBand(0.5, 1, 1) <= 0.5) throw new Error("hot grain should lift band");
if (0.5 + 0.25 + 0.125 !== 0.875) throw new Error("octave amps");

function latticeOriginAxis(cam, view, extent, h, padCells) {
  const minO = cam + view - extent;
  const kMin = Math.ceil(minO / h);
  const kMax = Math.floor(cam / h);
  if (kMin > kMax) return kMin * h;
  const want = cam - Math.max(padCells, 0) * h;
  return Math.min(kMax, Math.max(kMin, Math.floor(want / h))) * h;
}
function uvOutside(u, v) {
  return u < 0 || v < 0 || u > 1 || v > 1;
}
const cell = 4;
const view = 800;
const extentTight = 800;
const oOnGrid = latticeOriginAxis(100, view, extentTight, cell, 32);
if (oOnGrid !== 100) throw new Error("on-grid origin covers view; pad cannot steal BR");
const oOff = latticeOriginAxis(101, view, extentTight, cell, 32);
const brUv = (101 + view - oOff) / extentTight;
if (brUv > 1) throw new Error("off-grid origin must keep BR uv <= 1");
const slack = 256;
const padded = latticeOriginAxis(0, view, view + slack, cell, 32);
if (padded !== -32 * cell) throw new Error("pad only when extent has slack");
if (uvOutside(0, 0) || uvOutside(1, 1)) throw new Error("edge UV stays");
if (!uvOutside(1.001, 0.5) || !uvOutside(0.5, -0.01)) throw new Error("outside UV discards");

console.log("coupling-check ok");
