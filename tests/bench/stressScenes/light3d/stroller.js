import WEED from '/src/index.js';
import { FLOOR_SCALE_Y, VIEW_H, VIEW_W, anchorOn } from './benchSheets.js';

const { GameObject, Component, DirectionalSprite, Transform } = WEED;

/** A stroller's walk: where it heads (radians), how fast that turns (radians a second), its speed (floor px a second). */
export class StrollState extends Component {
  static ARRAY_SCHEMA = {
    heading: Float32Array,
    turn: Float32Array,
    speed: Float32Array,
  };
}

/**
 * A person (the light bench's LPC, with its height and normal maps) strolling slow curves over a VIEW_W × VIEW_H world, in
 * the direction it walks (DirectionalSprite facingFrom 'velocity', from its pose: it has no body). It bounces off the
 * world's edges instead of coming back on the other side, so it never jumps (a jump would turn it round for a frame) and
 * the crowd in view stays the same.
 */
export class Stroller extends GameObject {
  static components = [DirectionalSprite, StrollState];

  onSpawned({ x = 0, y = 0, heading = 0, turn = 0.2, pace = 30, scale = 1, sheet = 'civil7' } = {}) {
    this.setSpritesheet(sheet);
    this.setScale(scale);
    anchorOn(this, sheet);
    this.x = x;
    this.y = y;
    const s = this.strollState;
    s.heading = heading;
    s.turn = turn;
    s.speed = pace;
    this.directionalSprite.facingFrom = 'velocity';
    this.setAnimation('walk');
    // The steps about as fast as the feet move.
    this.setAnimationSpeed(0.08 + pace * 0.003);
  }

  tick(dtRatio, deltaTime) {
    const i = this.index;
    const dt = (deltaTime > 0 ? deltaTime : 16.7) * 0.001;
    let h = StrollState.heading[i] + StrollState.turn[i] * dt;
    const step = StrollState.speed[i] * dt;
    let x = Transform.x[i] + Math.cos(h) * step;
    // Floor px across are FLOOR_SCALE_Y screen px up and down.
    let y = Transform.y[i] + Math.sin(h) * step * FLOOR_SCALE_Y;
    if (x < 0) {
      x = -x;
      h = Math.PI - h;
    } else if (x > VIEW_W) {
      x = 2 * VIEW_W - x;
      h = Math.PI - h;
    }
    if (y < 0) {
      y = -y;
      h = -h;
    } else if (y > VIEW_H) {
      y = 2 * VIEW_H - y;
      h = -h;
    }
    StrollState.heading[i] = h;
    Transform.x[i] = x;
    Transform.y[i] = y;
  }
}
