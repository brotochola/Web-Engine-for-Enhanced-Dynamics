import WEED from '/src/index.js';
import { PlanetGrid, CELL, GRID, PLANET_RADIUS } from '../planetGrid.js';
import { WaterDrop } from './waterDrop.js';

const { GameObject, Keyboard, Mouse, Layer } = WEED;

const BRUSH_MAX = 26;

function stamp(cx, cy, r, v) {
  const lim = r * r + r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= lim) PlanetGrid.set(cx + dx, cy + dy, v);
    }
  }
}

function stroke(x0, y0, x1, y1, r, v) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(x0, y0, r, v);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export class PlanetManager extends GameObject {
  static components = [];
  static forceProcessOnLogicWorker = 0;

  onSpawned() {
    PlanetGrid.configure(GRID, PLANET_RADIUS);
    this.tool = 1;
    this.brush = 5;
    this._has = false;
    this._lx = 0;
    this._ly = 0;
  }

  tick() {
    if (Keyboard.isPressed('z')) this.tool = 1;
    if (Keyboard.isPressed('x')) this.tool = 0;
    if (Keyboard.isPressed('[')) this.brush = Math.max(1, this.brush - 1);
    if (Keyboard.isPressed(']')) this.brush = Math.min(BRUSH_MAX, this.brush + 1);
    if (Keyboard.isPressed('q')) this._pour();

    if (Mouse.isDebugToolActive || !Mouse.isButton0Down) {
      this._has = false;
      this._flush();
      return;
    }
    const cx = Math.floor(Mouse.x / CELL);
    const cy = Math.floor(Mouse.y / CELL);
    const v = this.tool ? 1 : 0;
    if (this._has) stroke(this._lx, this._ly, cx, cy, this.brush, v);
    else stamp(cx, cy, this.brush, v);
    this._lx = cx;
    this._ly = cy;
    this._has = true;
    this._flush();
  }

  _flush() {
    const rect = PlanetGrid.takeDirtyRect();
    if (!rect) return;
    const layer = Layer.get('planet');
    if (layer) layer.updateTexture('cells', PlanetGrid.cells, rect.tx, rect.ty, rect.tw, rect.th);
  }

  _pour() {
    const x = Mouse.x;
    const y = Mouse.y;
    for (let i = 0; i < 8; i++) {
      WaterDrop.spawn({
        x: x + (i - 3.5) * 8,
        y: y,
        vy: 60,
      });
    }
  }
}
