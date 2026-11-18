import WEED from '/src/index.js';

const { GameObject, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyLight extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ x = 0, y = 0, elevation = 0, move = 0, phase = 0 } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.lightEmitter.shadowRange = 900; // the occluders it gathers (the light reaches 200): the scene's load
    this.lightEmitter.color = 0xffffff;
    this.lightEmitter.radius = 200;
    this.lightEmitter.active = 1;
    // OL-3's maps arm: a lamp above the floor casts into the lamps' shadow map.
    this.lightEmitter.elevation = elevation;
    this.x = x;
    this.y = y;
    // `?move=`: the light circles its place at this radius (px), each from its own phase.
    this._homeX = x;
    this._homeY = y;
    this._move = move;
    this._turn = phase;
  }

  tick(dt, deltaTime) {
    if (!(this._move > 0)) return;
    this._turn += deltaTime / 1000;
    this.x = this._homeX + Math.cos(this._turn) * this._move;
    this.y = this._homeY + Math.sin(this._turn) * this._move;
  }
}
