/**
 * Y-sort painter with SHARDED pre-render (numberOfPreRenderWorkers: 2). Not the
 * catalog row. Neither painterSortStressScene.js nor painterMoveStressScene.js
 * pins more than one pre-render worker, so the reinsert A/B that shipped
 * `renderer.painterSort` never ran against a sharded queue — this scene closes
 * that gap. skipCull is OFF (unlike the other painter stress scenes) so entities
 * drifting across the camera edge make each pre-render worker's queue slice
 * grow/shrink independently; the total published count can land on the same
 * number while the shard split underneath moved. That's the shape a `_painterSameSet`
 * regression would need to show up in — see docs/HYPOTHESIS_LOG.md.
 */
import WEED from '/src/index.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

const N = 20000;
const COLS = 100;
const ROW = 22;
const DRIFT = ROW * 6;

export class PainterShardEntity extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = 1;

  onSpawned({ x = 0, y = 0, scale = 0.8, tint = 0xffffff, phase = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._baseY = y;
    this._phase = phase;
    this.rotation = 0;
    this.setSprite('ball');
    this.setScale(scale);
    this.setAnchor(0.5, 0.5);
    this.setTint(tint);
    this.setAlpha(0.9);
  }

  tick(dtRatio) {
    this._phase += 0.05 * (dtRatio || 1);
    this.y = this._baseY + Math.sin(this._phase) * DRIFT;
  }
}

function painterShardedConfig(painterSort, numberOfPreRenderWorkers) {
  return {
    worldWidth: 3000,
    worldHeight: 5000,
    entityIdWidth: 32,
    seed: 727272,
    spatial: {
      numberOfSpatialWorkers: 0,
      cellSize: 256,
      maxNeighbors: 0,
      noLimitFPS: false,
    },
    logic: {
      numberOfLogicWorkers: 1,
      noLimitFPS: false,
      staggeredUpdates: true,
    },
    physics: {
      enabled: false,
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
    },
    particle: {
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySorting: true,
      maxVisibleRenderables: N,
      painterSort,
    },
    preRender: {
      noLimitFPS: false,
      skipCull: false,
      numberOfPreRenderWorkers,
      entityBlockSize: 256,
    },
    lighting: {
      enabled: false,
    },
  };
}

function spawn(scene) {
  const palette = [0xffffff, 0xffd166, 0x06d6a0, 0x118ab2, 0xef476f];
  for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    scene.spawnEntity(PainterShardEntity, {
      x: 40 + col * 24,
      y: 40 + row * ROW,
      scale: 0.75 + (i % 5) * 0.06,
      tint: palette[i % palette.length],
      phase: (i % 23) * 0.31,
    });
  }
  // Zoomed in: only a band of rows is on screen at once, so drift constantly
  // moves entities across the cull boundary — each pre-render worker's slice
  // of the published queue grows and shrinks independently of the others.
  Camera.setZoom(1.1);
  Camera.centerOn(1200, 2200);
}

class PainterShardedBase extends Scene {
  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };
  static entities = [[PainterShardEntity, N]];
  create() {
    spawn(this);
  }
}

export class PainterSharded1WOffScene extends PainterShardedBase {
  static config = painterShardedConfig('off', 1);
}
export class PainterSharded2WOffScene extends PainterShardedBase {
  static config = painterShardedConfig('off', 2);
}
export class PainterSharded1WReinsertScene extends PainterShardedBase {
  static config = painterShardedConfig('reinsert', 1);
}
export class PainterSharded2WReinsertScene extends PainterShardedBase {
  static config = painterShardedConfig('reinsert', 2);
}
