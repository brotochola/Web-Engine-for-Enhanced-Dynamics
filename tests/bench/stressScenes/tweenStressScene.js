/**
 * 65535 entities, one alpha tween each.
 * `?workers=1` or `?workers=2` sets the logic worker count.
 * The tweens are created in entity order, so slot i belongs to entity i.
 */
import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, Tween } = WEED;

const ENTITY_COUNT = 65535;

function queryWorkers() {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('workers');
    const n = raw ? parseInt(raw, 10) : NaN;
    return n === 2 ? 2 : 1;
  } catch {
    return 1;
  }
}

const LOGIC_WORKERS = queryWorkers();

export const stressSceneConfig = {
  requested: { entities: ENTITY_COUNT, tweens: ENTITY_COUNT, logicWorkers: LOGIC_WORKERS },
};

class TweenEntity extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.spriteRenderer.alpha = 1;
  }
}

export class TweenStressScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    seed: 0x7ee4,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 256 },
    logic: { numberOfLogicWorkers: LOGIC_WORKERS },
    physics: { enabled: false },
    particle: { maxParticles: 0 },
    decoration: { maxDecorations: 0 },
    tween: { maxTweens: ENTITY_COUNT },
    renderer: { backend: 'webgl', maxVisibleRenderables: 32 },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[TweenEntity, ENTITY_COUNT]];

  create() {
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const spawned = this.spawnEntity(TweenEntity, { x: 100, y: 100 });
      if (!spawned) throw new Error(`tween stress: spawn failed at ${i}`);
      const slot = Tween.to(spawned.index, { alpha: 0 }, 1e9, 0);
      if (slot < 0) throw new Error(`tween stress: tween failed at ${i}`);
    }
  }
}
