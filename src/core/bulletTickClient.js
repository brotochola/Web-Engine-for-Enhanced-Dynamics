// The bullet tick in WASM (E-76 W19): loads bulletTick.wasm onto the memory where the scene keeps the bullets,
// Transform, Collider and the spatial grid (Phase 4: Box2D's block), and points its column table at them each
// frame. bullet_tick walks the pool as BulletPool.tick does; a bullet whose cast meets a compound polygon or a
// chain is handed back for the JS tick.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { ShapeType } from '../box2d/box2dConstants.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./bulletTick.wasm', import.meta.url);

/** The kernel's variants (one walk, the same bytes): the shipped tick takes BULLET_TICK_VARIANT. */
export const BULLET_TICK_VARIANTS = ['bullet_tick', 'bullet_tick_hoist', 'bullet_tick_nostamp', 'bullet_tick_lean'];
export const BULLET_TICK_VARIANT = 'bullet_tick_lean';

/** wasm/bulletTick.c's column table, slot for slot. */
export const BULLET_TICK_SLOTS = [
  'bActive', 'bX', 'bY', 'bPrevX', 'bPrevY', 'bVx', 'bVy', 'bSpeed', 'bRotC', 'bRotS', 'bDamage', 'bOwner', 'bShooter',
  'oActive', 'oImpacts', 'oReturned', 'results',
  'tActive', 'tX', 'tY', 'tRotC', 'tRotS',
  'cActive', 'cShape', 'cLayer', 'cOffX', 'cOffY', 'cRadius', 'cWidth', 'cHeight',
  'cPolyCount', 'cFixtureCount', 'cPvx', 'cPvy', 'cPnx', 'cPny',
  'gGrid', 'gStamp', 'gGen',
];
const SLOT = Object.fromEntries(BULLET_TICK_SLOTS.map((name, k) => [name, k]));

// The kernel's shape numbers.
if (ShapeType.Box !== 0 || ShapeType.Circle !== 1 || ShapeType.Polygon !== 2 || ShapeType.Chain !== 3) {
  throw new Error('bulletTick: ShapeType changed; update wasm/bulletTick.c');
}

/**
 * @param {WebAssembly.Memory} memory
 * @param {{ tableByte: number, resultsByte: number, returnedByte: number, stampByte: number, bullets: number,
 *   entities: number }} layout the kernel's regions in that memory
 * @param {string} [variant] one of BULLET_TICK_VARIANTS (benches and tests pick; the engine takes the default)
 */
export async function bindBulletTick(memory, layout, variant = BULLET_TICK_VARIANT) {
  if (!BULLET_TICK_VARIANTS.includes(variant)) throw new Error(`bulletTick: no variant ${variant}`);
  const k = await loadWasmKernel('bulletTick', wasmUrl, memory, BULLET_TICK_VARIANTS);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, layout.tableByte, BULLET_TICK_SLOTS.length);
  table[SLOT.results] = layout.resultsByte;
  table[SLOT.oReturned] = layout.returnedByte;
  table[SLOT.gStamp] = layout.stampByte;
  table[SLOT.gGen] = 0;
  return {
    buffer,
    tick: k[variant],
    table,
    tableByte: layout.tableByte,
    results: new Int32Array(buffer, layout.resultsByte, 4),
    returned: new Uint32Array(buffer, layout.returnedByte, layout.bullets),
    stamp: new Uint32Array(buffer, layout.stampByte, layout.entities),
  };
}

/**
 * The column table for this frame. False when a column the tick reads or writes is not in the memory (or the
 * grid's ids are not 16-bit), and the JS tick runs instead.
 */
export function writeBulletColumns(b, BulletComponent, Transform, Collider, activeData, impactData, Grid) {
  const t = b.table;
  const buffer = b.buffer;
  let ok = true;
  const put = (slot, a, required) => {
    if (!a) {
      t[SLOT[slot]] = 0;
      if (required) ok = false;
    } else if (a.buffer === buffer) {
      t[SLOT[slot]] = a.byteOffset;
    } else {
      ok = false;
    }
  };
  const bc = BulletComponent;
  put('bActive', bc.active, true);
  put('bX', bc.x, true);
  put('bY', bc.y, true);
  put('bPrevX', bc.prevX, true);
  put('bPrevY', bc.prevY, true);
  put('bVx', bc.vx, true);
  put('bVy', bc.vy, true);
  put('bSpeed', bc.speed, true);
  put('bRotC', bc.bulletRotC, true);
  put('bRotS', bc.bulletRotS, true);
  put('bDamage', bc.damage, true);
  put('bOwner', bc.ownerId, true);
  put('bShooter', bc.shooterEntityType, true);
  if (!(bc.ownerId instanceof Uint16Array) || !(activeData instanceof Uint16Array)) ok = false;
  put('oActive', activeData, true);
  put('oImpacts', impactData, false);
  put('tActive', Transform.active, true);
  put('tX', Transform.x, true);
  put('tY', Transform.y, true);
  put('tRotC', Transform.rotC, false);
  put('tRotS', Transform.rotS, false);
  put('cActive', Collider.active, true);
  put('cShape', Collider.shapeType, true);
  put('cLayer', Collider.collisionLayer, true);
  put('cOffX', Collider.offsetX, true);
  put('cOffY', Collider.offsetY, true);
  put('cRadius', Collider.radius, true);
  put('cWidth', Collider.width, true);
  put('cHeight', Collider.height, true);
  put('cPolyCount', Collider.polyCount, true);
  put('cFixtureCount', Collider.fixtureCount, false);
  put('cPvx', Collider.polyVertexX, true);
  put('cPvy', Collider.polyVertexY, true);
  put('cPnx', Collider.polyNormalX, true);
  put('cPny', Collider.polyNormalY, true);
  const counts = Grid._gridCounts;
  if (!counts || counts.buffer !== buffer || !(Grid._gridEntities instanceof Uint16Array)) ok = false;
  else t[SLOT.gGrid] = counts.byteOffset;
  return ok;
}

/** Ray numbers left before the stamps wrap; past it they are cleared, as Ray._beginRayGen clears its own. */
export function readyBulletStamps(b, rays) {
  const gen = b.table[SLOT.gGen] >>> 0;
  if (gen + rays >= 0xFFFFFFFF) {
    b.stamp.fill(0);
    b.table[SLOT.gGen] = 0;
  }
}
