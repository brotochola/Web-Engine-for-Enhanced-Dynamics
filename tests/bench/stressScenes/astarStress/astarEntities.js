import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer, NavGrid, enums } = WEED;
const { ShapeType } = enums;

// `?speed=` px a tick (an agent asks for a new path each time it enters a cell, so this sets the path rate too).
const SPEED = Number(WEED.params?.get('speed') ?? 2);

/** A box of wall cells: its collider is what the nav grid marks unwalkable. */
export class AstarWall extends GameObject {
  static components = [Collider, SpriteRenderer];
  static isStatic = true;

  onSpawned({ width = 32, height = 32 } = {}) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.visualRange = Math.max(width, height);
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setScale(width / 8, height / 8);
    this.setTint(0x5a6070);
  }
}

/**
 * Walks to a random walkable cell by NavGrid.getNextAStarPosition, then picks another. The position it asks from
 * changes cell every few ticks, and each (from, to) pair is a path of its own: the particle worker runs A* for it.
 */
export class AstarAgent extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ seed = 1 } = {}) {
    this._rng = (seed * 2654435761) >>> 0 || 1;
    this._tx = 0.5;
    this._ty = 0.5;
    this._targetCell = -1;
    this._next = { x: 0.5, y: 0.5 };
    this._arrivals = 0;
    this.setSprite('_whiteCircle');
    this.setAnchor(0.5, 0.5);
    this.setScale(1.5, 1.5);
    this.setTint(0xffc040);
    this._pickTarget();
  }

  _random() {
    this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0;
    return this._rng / 4294967296;
  }

  _pickTarget() {
    const info = NavGrid.getGridInfo();
    if (!info || !(info.totalCells > 0)) return;
    for (let tries = 0; tries < 32; tries++) {
      const cell = Math.floor(this._random() * info.totalCells);
      if (!NavGrid.isCellWalkable(cell)) continue;
      const center = this._next;
      NavGrid.getCellCenter(cell, center);
      this._targetCell = cell;
      this._tx = center.x;
      this._ty = center.y;
      return;
    }
  }

  tick() {
    if (this._targetCell < 0 || NavGrid.getCellAt(this.x, this.y) === this._targetCell) {
      this._arrivals++;
      this._pickTarget();
      return;
    }
    const next = this._next;
    NavGrid.getNextAStarPosition(this.x, this.y, this._tx, this._ty, next);
    const dx = next.x - this.x;
    const dy = next.y - this.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= SPEED) {
      this.x = next.x;
      this.y = next.y;
    } else if (d > 0) {
      this.x += (dx / d) * SPEED;
      this.y += (dy / d) * SPEED;
    }
  }
}

/**
 * The scene's fixed load: each tick it asks for the path between two new random walkable cells, whether or not the
 * last one came back. Every pair is new, so each is one A* search, and how many it asks for does not depend on how fast
 * the particle worker answers (the walkers wait for their paths, so theirs does).
 */
export class AstarPlanner extends GameObject {
  static components = [];

  onSpawned({ seed = 1 } = {}) {
    this._rng = (seed * 2246822519) >>> 0 || 1;
    this._from = { x: 0.5, y: 0.5 };
    this._to = { x: 0.5, y: 0.5 };
    this._next = { x: 0.5, y: 0.5 };
  }

  _randomCell(out) {
    const info = NavGrid.getGridInfo();
    if (!info || !(info.totalCells > 0)) return false;
    for (let tries = 0; tries < 32; tries++) {
      this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0;
      const cell = Math.floor((this._rng / 4294967296) * info.totalCells);
      if (!NavGrid.isCellWalkable(cell)) continue;
      NavGrid.getCellCenter(cell, out);
      return true;
    }
    return false;
  }

  tick() {
    if (!this._randomCell(this._from) || !this._randomCell(this._to)) return;
    NavGrid.getNextAStarPosition(this._from.x, this._from.y, this._to.x, this._to.y, this._next);
  }
}

/** Hands the walls to the nav grid once a logic worker sees them all active (a page spawn is set up a frame later). */
export class AstarMazeBuilder extends GameObject {
  static components = [];

  onSpawned({ walls = 0 } = {}) {
    this._expected = walls;
    this._done = false;
    this._ticks = 0;
  }

  tick() {
    if (this._done) return;
    this._ticks++;
    const active = AstarWall.getAllActive();
    if (this._ticks < 3 || active.length < this._expected) return;
    NavGrid.updateNavGrid(Array.from(active));
    this._done = true;
  }
}
