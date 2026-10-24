/**
 * The bullet tick kernel (E-76 W19, wasm/bulletTick.c), shared by its test and its bench.
 *
 * `bulletWorld` lays every column BulletPool.tick and its Ray.linecastDir read and write in one shared
 * WebAssembly.Memory, as Phase 4's block holds them: the bullets, Transform, Collider, the spatial grid (16-bit
 * ids), and the kernel's own regions (the active list and impacts it writes, the returned list, its stamps,
 * results and table). It binds them where the shipped code reads them, so BulletPool.tick runs the JS on the
 * same bytes the kernel reads; `bind` points them back at this world.
 */
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { Grid } from '../../src/core/grid.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { BULLET_TICK_SLOTS, bindBulletTick } from '../../src/core/bulletTickClient.js';

const MAX_POLYGON_VERTICES = 8;

/**
 * @param {{ bullets: number, entities: number, cols: number, rows: number, cellSize: number, perCell: number,
 *   impacts: number }} size
 */
export function bulletWorld({ bullets, entities, cols, rows, cellSize, perCell, impacts }) {
  const cellByteSize = 4 + perCell * 2;
  const parts = [
    ['bActive', Uint8Array, bullets], ['bX', Float32Array, bullets], ['bY', Float32Array, bullets],
    ['bPrevX', Float32Array, bullets], ['bPrevY', Float32Array, bullets], ['bVx', Float32Array, bullets],
    ['bVy', Float32Array, bullets], ['bSpeed', Float32Array, bullets], ['bRotC', Float32Array, bullets],
    ['bRotS', Float32Array, bullets], ['bDamage', Float32Array, bullets], ['bOwner', Uint16Array, bullets],
    ['bShooter', Uint8Array, bullets],
    ['tActive', Uint8Array, entities], ['tX', Float32Array, entities], ['tY', Float32Array, entities],
    ['tRotC', Float32Array, entities], ['tRotS', Float32Array, entities],
    ['cActive', Uint8Array, entities], ['cShape', Uint8Array, entities], ['cLayer', Uint8Array, entities],
    ['cOffX', Float32Array, entities], ['cOffY', Float32Array, entities], ['cRadius', Float32Array, entities],
    ['cWidth', Float32Array, entities], ['cHeight', Float32Array, entities], ['cPolyCount', Uint8Array, entities],
    ['cFixtureCount', Uint16Array, entities],
    ['cPvx', Float32Array, entities * MAX_POLYGON_VERTICES], ['cPvy', Float32Array, entities * MAX_POLYGON_VERTICES],
    ['cPnx', Float32Array, entities * MAX_POLYGON_VERTICES], ['cPny', Float32Array, entities * MAX_POLYGON_VERTICES],
    ['grid', Uint8Array, cols * rows * cellByteSize],
    ['activeOut', Uint16Array, bullets + 1], ['impacts', Float32Array, impacts * 6],
    ['returned', Uint32Array, bullets], ['stamp', Uint32Array, entities],
    ['results', Int32Array, 4], ['table', Uint32Array, BULLET_TICK_SLOTS.length],
  ];
  let top = 64;
  const offsets = {};
  for (const [name, Ctor, len] of parts) {
    top = (top + 63) & ~63;
    offsets[name] = top;
    top += len * Ctor.BYTES_PER_ELEMENT;
  }
  const pages = Math.ceil(top / 65536) + 1;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const v = {};
  for (const [name, Ctor, len] of parts) v[name] = new Ctor(memory.buffer, offsets[name], len);

  /** Point the components, the grid and the pool at this world (several worlds can share a page). */
  const bind = () => {
    const bc = BulletComponent;
    bc.active = v.bActive;
    bc.x = v.bX;
    bc.y = v.bY;
    bc.prevX = v.bPrevX;
    bc.prevY = v.bPrevY;
    bc.vx = v.bVx;
    bc.vy = v.bVy;
    bc.speed = v.bSpeed;
    bc.bulletRotC = v.bRotC;
    bc.bulletRotS = v.bRotS;
    bc.damage = v.bDamage;
    bc.ownerId = v.bOwner;
    bc.shooterEntityType = v.bShooter;
    Transform.active = v.tActive;
    Transform.x = v.tX;
    Transform.y = v.tY;
    Transform.rotC = v.tRotC;
    Transform.rotS = v.tRotS;
    Collider.active = v.cActive;
    Collider.shapeType = v.cShape;
    Collider.collisionLayer = v.cLayer;
    Collider.offsetX = v.cOffX;
    Collider.offsetY = v.cOffY;
    Collider.radius = v.cRadius;
    Collider.width = v.cWidth;
    Collider.height = v.cHeight;
    Collider.polyCount = v.cPolyCount;
    Collider.fixtureCount = v.cFixtureCount;
    Collider.polyVertexX = v.cPvx;
    Collider.polyVertexY = v.cPvy;
    Collider.polyNormalX = v.cPnx;
    Collider.polyNormalY = v.cPny;
    Grid.cellSize = cellSize;
    Grid.invCellSize = 1 / cellSize;
    Grid.gridWidth = cols;
    Grid.gridHeight = rows;
    Grid.totalCells = cols * rows;
    Grid.maxEntitiesPerCell = perCell;
    Grid.cellByteSize = cellByteSize;
    Grid._cellIdStride = cellByteSize / 2;
    Grid._headerIds = 2;
    Grid._gridCounts = v.grid;
    Grid._gridEntities = new Uint16Array(memory.buffer, offsets.grid, (cols * rows * cellByteSize) / 2);
    BulletPool.maxCount = bullets;
  };
  bind();

  /** Insert entity e into every cell its box (centre, half extents) overlaps, as the spatial workers do. */
  const insert = (e, cx, cy, half, halfY = half) => {
    const c0 = Math.max(0, Math.floor((cx - half) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((cx + half) / cellSize));
    const r0 = Math.max(0, Math.floor((cy - halfY) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((cy + halfY) / cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * cols + c;
        const n = v.grid[cell * cellByteSize];
        if (n >= perCell) continue;
        Grid._gridEntities[cell * (cellByteSize / 2) + 2 + n] = e;
        v.grid[cell * cellByteSize] = n + 1;
      }
    }
  };
  return {
    memory, views: v, offsets, insert, bind,
    layout: {
      tableByte: offsets.table, resultsByte: offsets.results, returnedByte: offsets.returned,
      stampByte: offsets.stamp, activeByte: offsets.activeOut, impactsByte: offsets.impacts,
      bullets, entities, impacts,
    },
  };
}

/** The kernel on that world, as the particle worker binds it (a variant of BULLET_TICK_VARIANTS, or the default). */
export function bindBullets(w, variant) {
  return bindBulletTick(w.memory, w.layout, variant);
}
