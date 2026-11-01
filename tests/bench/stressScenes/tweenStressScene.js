/**
 * 65535 entities, one alpha tween each.
 * `?workers=1` or `?workers=2` sets the logic worker count.
 * `?entities=<n>` sets the entity (and tween) count: past 65535 the ids are 32-bit, and one worker's logic passes 3 ms.
 * `?tick=1` gives the entities an empty tick, so with two workers their tweens follow the worker that ticks each one
 * (N-6) instead of Tween.tick's blocks of slots.
 * The tweens are created in entity order, so slot i belongs to entity i.
 */
import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, Tween } = WEED;

function queryEntities() {
  try {
    const n = parseInt(new URLSearchParams(globalThis.location?.search || '').get('entities'), 10);
    return n > 0 ? n : 65535;
  } catch {
    return 65535;
  }
}

const ENTITY_COUNT = queryEntities();

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

function queryTick() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('tick') === '1';
  } catch {
    return false;
  }
}

const TICK = queryTick();

export const stressSceneConfig = {
  requested: { entities: ENTITY_COUNT, tweens: ENTITY_COUNT, logicWorkers: LOGIC_WORKERS, tick: TICK },
};

// Exported: a worker finds entity classes among the module's exports, and its own copy of this module does not
// see the page's query.
export class TweenEntity extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.spriteRenderer.alpha = 1;
  }
}

export class TickingTweenEntity extends TweenEntity {
  tick() {}
}

const Entity = TICK ? TickingTweenEntity : TweenEntity;

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

  static entities = [[Entity, ENTITY_COUNT]];

  create() {
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const spawned = Entity.spawn({ x: 100, y: 100 });
      if (!spawned) throw new Error(`tween stress: spawn failed at ${i}`);
      const slot = Tween.to(spawned.index, { alpha: 0 }, 1e9, 0);
      if (slot < 0) throw new Error(`tween stress: tween failed at ${i}`);
    }
  }
}
