import WEED from '/src/index.js';
import { anchorOn, benchAnimation, castAs } from '../light3d/benchSheets.js';

const { GameObject, Component, DirectionalSprite, ShadowCaster, Transform } = WEED;

/** How far past the world's edge a car drives before it comes back on the other side (px): out of view first. */
const WRAP_MARGIN = 160;

/**
 * A still render (a table, a bed, a shelf, a tank, a coop, a cow) that casts the sun's shadow as `kind` says
 * (light3d/benchSheets.js castAs). It never moves and never turns: what a cache of the map's still part keeps. Static
 * scenery (E-127), as a game's furniture would be: the engine knows it stays put.
 */
export class MapProp extends GameObject {
  static isStatic = true;
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ x = 0, y = 0, sheet = 'mesa', facing = Math.PI / 2, scale = 1, kind = 'auto' } = {}) {
    this.setSpritesheet(sheet);
    this.setScale(scale);
    anchorOn(this, sheet);
    this.x = x;
    this.y = y;
    // The view it faces, and its rotation the same: a box (kind 'box') turns with the entity, the view with facing.
    this.rotation = facing;
    this.directionalSprite.facing = facing;
    this.setAnimation(benchAnimation(sheet));
    castAs(this, kind, sheet, scale);
  }
}

/** A car's lane: its speed along x (px/s, negative going west) and the width of the world it wraps in. */
export class LaneState extends Component {
  static ARRAY_SCHEMA = {
    vx: Float32Array,
    wrapW: Float32Array,
  };
}

/**
 * A car on a road, east or west at its own speed, back on the other side once past the world's edge: the part of the map
 * that changes every frame. Its rotation picks the view it shows (DirectionalSprite facingFrom 'rotation') and turns its
 * box.
 */
export class MapCar extends GameObject {
  static components = [DirectionalSprite, ShadowCaster, LaneState];

  onSpawned({ x = 0, y = 0, sheet = 'hatch', vx = 80, wrapW = 1920, scale = 1, kind = 'auto' } = {}) {
    this.setSpritesheet(sheet);
    this.setScale(scale);
    anchorOn(this, sheet);
    this.x = x;
    this.y = y;
    this.laneState.vx = vx;
    this.laneState.wrapW = wrapW;
    this.rotation = vx >= 0 ? 0 : Math.PI;
    this.directionalSprite.facingFrom = 'rotation';
    this.setAnimation('drive');
    castAs(this, kind, sheet, scale);
  }

  tick(dtRatio, deltaTime) {
    const i = this.index;
    const dt = (deltaTime > 0 ? deltaTime : 16.7) * 0.001;
    const w = LaneState.wrapW[i];
    let x = Transform.x[i] + LaneState.vx[i] * dt;
    if (x < -WRAP_MARGIN) x += w + 2 * WRAP_MARGIN;
    else if (x > w + WRAP_MARGIN) x -= w + 2 * WRAP_MARGIN;
    Transform.x[i] = x;
  }
}
