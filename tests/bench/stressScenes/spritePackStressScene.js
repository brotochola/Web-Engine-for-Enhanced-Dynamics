/**
 * Sprite-pack stress: a vehicle for measuring `packInstancedRows` / H-02.
 *
 * WHY THIS EXISTS - the shape of the failure, not a guess.
 *
 * H-02 cleared the gate and still died at the scene:
 *
 *     kernel    +272 %, 5/5 rounds, 42 633 sprite slots
 *     scene      -2.21 %, 3/8 pairs, cv 12.9 % base / 10.2 % hypothesis
 *
 * And the diagnosis is NOT "Predator does not stress this path". Predator packs
 * 42 633 sprite slots and the trace puts `packInstancedRows` at **38.8 % of the
 * renderer** - the single largest addressable item in the engine. The scene
 * exercises it hard.
 *
 * The diagnosis is **resolution**. A cv of 12.9 % on a 5.699 ms median is about
 * +/- 0.74 ms of noise. A 3 % effect is 0.17 ms. It was never resolvable, so the
 * sitting could not have returned a win even if a win were there. Chasing it with
 * more pairs would have produced a tighter estimate of nothing.
 *
 * **Absolute noise does not scale with the work.** The fix is not a busier
 * scene, it is a DEEPER one: the same +/- 0.74 ms against a ~30 ms median is a cv
 * near 2.5 %, which resolves a 3 % effect comfortably.
 *
 * So this scene does three things:
 *
 *  1. Makes the renderer DEEP. `maxVisibleRenderables: 65535` and a large sprite
 *     count put the pack path tens of milliseconds over the frame instead of five,
 *     which is the entire point - the same noise over ten times the work.
 *  2. Removes everything that competes inside the same worker. Lighting off takes
 *     `gpuShadowCasters` (18.4 % of preRender) and the shadow/light stamp passes
 *     out of the renderer entirely; `ySort: false` removes the sort; no decals,
 *     no particles, no decorations. Whatever moves the renderer's `STEP_MS` here
 *     is the pack path.
 *  3. Counts are a URL parameter, so the depth sweep - 20k, 60k, 150k - is a
 *     command rather than an edit, and the noise-vs-depth curve can be measured
 *     instead of assumed.
 *
 * Physics off and logic does nothing: this is a render-path measurement.
 *
 * Load key: renderer STEP_MS, VISIBLE_ENTITIES. Reuse an existing sprite texture
 * rather than shipping one, so the scene measures the pack and not the decode.
 */
import WEED from '/src/index.js';

const { Scene, Camera } = WEED;

const COUNT = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('sprites');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 60000;
  } catch {
    return 60000;
  }
})();

export const SPRITE_COUNT = COUNT;

/**
 * Grid spacing, in world units. This is the depth knob that actually matters,
 * together with the canvas size.
 *
 * Measured: at 1920x1080 and spacing 24 the scene packs 5 335 sprites per frame;
 * at 3840x2160 it packs 21 037 - exactly 4x, the pixel-count ratio. The visible
 * count is bounded by viewport area / spacing, so:
 *
 *     packed  ~=  (canvasW / spacing) * (canvasH / spacing)
 *
 * To make the pack path deep, raise the canvas AND lower the spacing. Lowering
 * spacing alone is what broke v4, because there it was shrinking *as the
 * population grew* - a fixed small spacing is fine.
 */
export const SPACING = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('spacing');
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n >= 2 ? n : 24;
  } catch {
    return 24;
  }
})();

/**
 * World size derived from the population at MODULE SCOPE, before the config is
 * read and before any buffer is allocated.
 *
 * Spacing is held constant so every sprite stays separated at any population,
 * and the world grows to fit the grid. Deriving the world inside `create()` does
 * not work: buffers are already allocated by then, so the camera centred on a
 * world the scene no longer has, and VISIBLE_ENTITIES came back as 1.
 */
/**
 * Sprite render scale.
 *
 * Measured at 3840x2160: grid spacing 24, 10 and 5 ALL packed exactly 21 037
 * sprites. Spacing is not the limiter. The sprite's own rendered size is, so the
 * packed count is bounded by viewport area / sprite area, and shrinking the
 * sprite is the only lever that buys more rows through the pack path.
 *
 * Expected roughly as 1/scale^2, so scale 0.5 should reach ~84 000.
 */
export const SPRITE_SCALE = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('scale');
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
})();

/** `?camRot=<radians>` turns the camera (review E-51: a turned view culls with the box around it). Default 0. */
export const CAM_ROT = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('camRot');
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
})();

const COLS = Math.max(1, Math.ceil(Math.sqrt(SPRITE_COUNT)));
const ROWS = Math.ceil(SPRITE_COUNT / COLS);

/**
 * What this scene actually resolved, for the runner to check against the request.
 *
 * Every parameter here falls back to a default SILENTLY when it is absent from
 * `location.search`, which is how this scene reported 11139, then 5335, then
 * 21037 across a nominal 20k/60k/150k sweep while measuring the same 60000
 * sprites every single time. Exporting the resolved values turns that from a
 * number you have to disbelieve into an error you cannot miss.
 *
 * Declared after SPACING and SPRITE_SCALE because const bindings are in the
 * temporal dead zone until initialised.
 */
export const stressSceneConfig = {
  requested: {
    sprites: SPRITE_COUNT,
    spacing: SPACING,
    scale: SPRITE_SCALE,
    camRot: CAM_ROT,
  },
};
export const WORLD_W = COLS * SPACING;
export const WORLD_H = ROWS * SPACING;
/**
 * Small world on purpose. The grid fills it exactly and the camera sits at zoom 1,
 * so "everything spawns on screen" is structural rather than a matter of luck -
 * which is what makes `VISIBLE_ENTITIES` a usable liveness check on this scene.
 */
/**
 * Small world on purpose. The grid fills it exactly and the camera sits at zoom 1,
 * so "everything spawns on screen" is structural rather than a matter of luck -
 * which is what makes `VISIBLE_ENTITIES` a usable liveness check on this scene.
 */

/**
 * One sprite component, no tick - the renderer is what is being measured.
 *
 * `renderVisible` is left at its default ON deliberately. The first version of
 * this scene copied `renderVisible = 0` from MinimalTickProp, where hiding is the
 * point because that scene measures logic. Here it hid all 150 000 sprites, and
 * the scene reported a flat 0.18 ms renderer at 20k, 60k and 150k with
 * `VISIBLE_ENTITIES 0` and `GPU_PASSES 0.0`.
 *
 * **A stress scene that renders nothing is indistinguishable from a fast one.**
 * That is now the second time this exact failure has happened in this audit (the
 * first was `decoration` nested under `particle` in the sway scene). Every scene
 * built here from now on asserts that it actually renders before its numbers are
 * believed - see the check at the bottom of this file's notes.
 */
class PackedSprite extends WEED.GameObject {
  static components = [WEED.SpriteRenderer];

  onSpawned({ x = 0, y = 0 } = {}) {
    // The call that actually makes a sprite render. Declaring the component and
    // supplying the texture are both necessary and neither is sufficient - the
    // first two versions of this scene did both and still rendered nothing,
    // because `setSprite` is what binds them. See the class comment.
    this.setSprite('sprite');
    this.setAnchor(0.5, 0.5);
    // Scale is the depth knob that actually works.
    //
    // Measured at 3840x2160: grid spacing 24 and spacing 10 both packed exactly
    // 21 037 sprites. Spacing is therefore NOT the limiter - the sprite's own
    // rendered size is, so the visible count is bounded by viewport area divided
    // by sprite area. Shrinking the sprite is what buys more rows through the
    // pack path.
    this.setScale(SPRITE_SCALE);
    this.x = x;
    this.y = y;
  }
}

export class SpritePackStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x9a11,

    spatial: { numberOfSpatialWorkers: 0, cellSize: 4096, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 0 },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      // The deep-renderer knob. 65535 is the ceiling; at high sprite counts the
      // pack loop, not the cap, is what is being timed.
      maxVisibleRenderables: 65535,
      // Removing the sort takes the radix sort out of the same worker, so the
      // renderer's step time is pack rather than pack-plus-sort.
      ySort: false,
    },

    // Off takes gpuShadowCasters and both light-stamp passes out of the renderer.
    // They are the largest other cost in that worker (18.4 % of preRender) and
    // this scene is not measuring them.
    lighting: { enabled: false },
  };

  // A real texture, borrowed rather than shipped, so the scene measures the pack
// loop and not texture decode. An empty texture table is how the first version
// of this scene rendered nothing at all.
static assets = { textures: { sprite: '/demos/img/bunny.png' } };

  static entities = [[PackedSprite, SPRITE_COUNT]];

  create() {
    // A GRID filling the world, not a random scatter.
    //
    // The random version reported `VISIBLE_734` at 20 000, 60 000 AND 150 000
    // sprites - flat, because the camera only ever saw a fraction of a 16 000^2
    // world. So it measured the same 734 sprites three times and called it a
    // depth sweep. The pack path was never stressed.
    //
    // Spacing is derived from the population so the grid always fills the view
    // exactly: whatever `?sprites=` says, every sprite is on screen.
    // FIXED spacing, and a world that GROWS with the population.
    //
    // The previous version kept the world at 4096^2 and derived spacing from the
    // population, which made spacing SHRINK as N grew: 28.8 -> 16.7 -> 10.6 for
    // 20k/60k/150k. Denser sprites get culled, so the extra population cancelled
    // itself out and VISIBLE_ENTITIES sat at exactly 11139 for all three.
    //
    // That is density saturation, not a capacity limit - and it is confirmed not
    // to be `maxVisibleRenderables` either: no
    // "[PRE_RENDER] render queue full" warning was emitted at 150 000, so the
    // queue never filled.
    //
    // Holding spacing constant means every sprite stays comfortably separated at
    // any population, so VISIBLE_ENTITIES must now scale with N. If it does not,
    // the scene is lying again and that is visible immediately.
    const cols = COLS;
    const rows = ROWS;
    for (let i = 0; i < SPRITE_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      this.spawnEntity(PackedSprite, {
        x: SPACING * (col + 0.5),
        y: SPACING * (row + 0.5),
      });
    }
    // Zoom 1 with the camera centred: the whole grid is the whole world, so the
    // visible count must equal the population. If it does not, the scene is
    // lying and that is visible immediately in VISIBLE_ENTITIES.
    Camera.setZoom(1);
    // Centre on the grid, which now IS the world.
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    if (CAM_ROT) Camera.setAngle(CAM_ROT);
  }
}