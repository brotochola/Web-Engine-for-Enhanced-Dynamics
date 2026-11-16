import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, ShadowCaster, LightEmitter, Transform } = WEED;

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
const WALKS = DIRS.map((d) => `walk_${d}`);

/**
 * Each walker's loop by entity index, worked out on its first tick (the same on any logic worker): centre x and y,
 * radius, speed, phase; NaN until then. In typed arrays so a tick carries no doubles into a call.
 */
const LOOP_CAP = 1 << 17;
const LOOP_CX = new Float64Array(LOOP_CAP).fill(NaN);
const LOOP_CY = new Float64Array(LOOP_CAP);
const LOOP_R = new Float64Array(LOOP_CAP);
const LOOP_W = new Float64Array(LOOP_CAP);
const LOOP_PHASE = new Float64Array(LOOP_CAP);

function loopOf(i) {
  const h1 = hash01(i, 0x9e3779b9);
  const h2 = hash01(i, 0x85ebca6b);
  const h3 = hash01(i, 0xc2b2ae35);
  LOOP_CX[i] = 120 + h1 * (CompareWalker.worldW - 240);
  LOOP_CY[i] = 120 + h2 * (CompareWalker.worldH - 240);
  LOOP_R[i] = 30 + h3 * 70;
  LOOP_W[i] = 0.4 + h2 * 0.6;
  LOOP_PHASE[i] = h1 * 6.283;
}

/**
 * A person who walks a loop around its own centre (a function of the clock: any logic worker can tick it), its walk
 * facing the way it goes: walk_<dir> by hand on SpriteRenderer, or DirectionalSprite's 'walk' facing where it moves.
 */
export class CompareWalker extends GameObject {
  static components = DS ? [DirectionalSprite, ShadowCaster] : [SpriteRenderer, ShadowCaster];

  onSpawned(spec = {}) {
    this.setSpritesheet(SHEETS[(spec.sheet ?? 0) % SHEETS.length]);
    if (DS) {
      this.directionalSprite.facingFrom = 'velocity';
      this.directionalSprite.turnMargin = 0;
      this.setAnimation('walk');
    } else {
      this._dir = 1;
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

  /** Its loop from its index (loopOf): where it is now; by hand on SpriteRenderer, its walk from the loop's tangent. */
  _place() {
    const i = this.index;
    if (LOOP_CX[i] !== LOOP_CX[i]) loopOf(i);
    const t = (performance.now() / 1000) * LOOP_W[i] + LOOP_PHASE[i];
    const c = Math.cos(t);
    const s = Math.sin(t);
    const r = LOOP_R[i];
    // Its column written here: a walker has no body and is no static scenery, so the x and y setters would do just
    // this, and passed a double they boxed it (2.1 MB/s at 3 000 walkers: the tick's inlining budget left them out).
    Transform.x[i] = LOOP_CX[i] + c * r;
    Transform.y[i] = LOOP_CY[i] + s * r * 0.6;
    if (!DS) {
      // The tangent of the loop, its heading.
      const a = Math.atan2(c * 0.6, -s);
      const d = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
      if (d !== this._dir) {
        this._dir = d;
        this.setAnimation(WALKS[d]);
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
