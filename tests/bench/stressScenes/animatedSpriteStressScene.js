import WEED from '/src/index.js';
import { AnimatedWalker } from './animatedSprite/animatedWalker.js';

const { Scene, Camera } = WEED;

/** `?sprites=N`: animated sprites (default 100 000). */
export const SPRITES = (() => {
  try {
    const n = Number(new URLSearchParams(globalThis.location?.search || '').get('sprites'));
    return n > 0 ? Math.min(n | 0, 500000) : 100000;
  } catch {
    return 100000;
  }
})();

export const stressSceneConfig = {
  requested: { sprites: SPRITES },
};

/**
 * Bench scene (E-98g): sprites that play walk animations at different speeds and never move, every
 * one in view, so pre-render's queue keeps the same rows from frame to frame (its persist path)
 * while some sprite changes frame every frame.
 */
export class AnimatedSpriteStressScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,
    seed: 0xa11e,
    entityIdWidth: 32,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 1024, maxNeighbors: 0, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: 'webgl', noLimitFPS: false, ySort: false, maxVisibleRenderables: SPRITES },
    preRender: { skipCull: true, noLimitFPS: false },
    lighting: { enabled: false },
  };

  static assets = {
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png' },
    },
  };

  static entities = [[AnimatedWalker, SPRITES]];

  create() {
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    Camera.setZoom(1);
    Camera.centerOn(w / 2, h / 2);
    const rng = globalThis.rng;
    for (let i = 0; i < SPRITES; i++) {
      AnimatedWalker.spawn({ x: w * rng(), y: h * rng(), walk: (rng() * 4) | 0, animSpeed: 0.1 + rng() * 0.25 });
    }
  }
}
