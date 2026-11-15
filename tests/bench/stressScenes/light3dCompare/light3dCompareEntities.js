import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, ShadowCaster, LightEmitter } = WEED;

/**
 * light3dCompareScene's people, lamps and props: only the API main has too (SpriteRenderer, ShadowCaster, LightEmitter),
 * so the scene runs on both sides of a sitting. `?ds=1` (the branch only) draws the people through DirectionalSprite.
 * The knobs come from WEED.params, the same on the page and in every worker.
 */
const DS = WEED.params?.get('ds') === '1' || WEED.params?.get('all') === '1';
const DirectionalSprite = DS ? WEED.DirectionalSprite : null;
if (DS && !DirectionalSprite) throw new Error('light3dCompareScene: ?ds=1 needs DirectionalSprite (dx/light3d)');

const SHEETS = ['civil1', 'civil2', 'civil3', 'civil4'];

/** A well-mixed number in [0, 1) from an index and a salt (murmur3's finalizer): no lines across the world. */
function hash01(i, salt) {
  let h = (i ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const DIRS = ['right', 'down', 'left', 'up'];

/**
 * A person who walks a loop around its own centre (a function of the clock: any logic worker can tick it), its walk
 * facing the way it goes: walk_<dir> by hand on SpriteRenderer, or DirectionalSprite's 'walk' turned to its heading.
 */
export class CompareWalker extends GameObject {
  static components = DS ? [DirectionalSprite, ShadowCaster] : [SpriteRenderer, ShadowCaster];

  onSpawned(spec = {}) {
    this.setSpritesheet(SHEETS[(spec.sheet ?? 0) % SHEETS.length]);
    if (DS) {
      this.directionalSprite.facingFrom = 'manual';
      this.directionalSprite.turnMargin = 0;
      this.setAnimation('walk');
    } else {
      this.setAnimation('walk_down');
    }
    this.setAnimationSpeed(0.15);
    this.setScale(spec.scale ?? 0.9);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.98;
    this._place();
  }

  tick() {
    this._place();
  }

  /** Its loop from its index: centre, radius, speed and phase; its heading from the loop's tangent. */
  _place() {
    const i = this.index;
    const h1 = hash01(i, 0x9e3779b9);
    const h2 = hash01(i, 0x85ebca6b);
    const h3 = hash01(i, 0xc2b2ae35);
    const cx = 120 + h1 * (CompareWalker.worldW - 240);
    const cy = 120 + h2 * (CompareWalker.worldH - 240);
    const r = 30 + h3 * 70;
    const w = 0.4 + h2 * 0.6;
    const t = (performance.now() / 1000) * w + h1 * 6.283;
    const c = Math.cos(t);
    const s = Math.sin(t);
    this.x = cx + c * r;
    this.y = cy + s * r * 0.6;
    // The tangent of the loop, its heading.
    const vx = -s;
    const vy = c * 0.6;
    if (DS) {
      this.directionalSprite.facing = Math.atan2(vy, vx);
    } else {
      const a = Math.atan2(vy, vx);
      const d = DIRS[((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4];
      if (d !== this._dir) {
        this._dir = d;
        this.setAnimation(`walk_${d}`);
      }
    }
  }
}
CompareWalker.worldW = 3200;
CompareWalker.worldH = 2000;

/** A still prop that casts: a house, a tree, a barrel or a rock. */
export class CompareProp extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned(spec = {}) {
    this.setSprite(spec.texture ?? 'barrel1');
    this.setScale(spec.scale ?? 1);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = spec.ay ?? 0.95;
    this.x = spec.x ?? 0;
    this.y = spec.y ?? 0;
  }
}

/** A lamp on a post: a raised warm light that casts shadows. */
export class CompareLamp extends GameObject {
  static components = [LightEmitter];

  onSpawned(spec = {}) {
    const light = this.lightEmitter;
    light.radius = spec.radius ?? 520;
    light.color = spec.color ?? 0xffd08a;
    light.brightness = spec.brightness ?? 1.5;
    light.elevation = spec.elevation ?? 90;
    light.castShadows = 1;
    light.active = 1;
    this.x = spec.x ?? 0;
    this.y = spec.y ?? 0;
  }
}
