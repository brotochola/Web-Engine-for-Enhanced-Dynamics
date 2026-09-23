/**
 * Moving Y-sort painter. Not the catalog row.
 * 10% of sprites cross a neighbor every swing. Physics off (Box2D cap).
 * skipCull so Pixi sees N. ySorting uses reinsert.
 */
import WEED from '/src/index.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

const N = 300000;
const COLS = 400;
const MOVE_EVERY = 10;
const ROW = 22;
const DRIFT = ROW + 2;

export class PainterMoveEntity extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = 1;

  onSpawned({ x = 0, y = 0, scale = 0.8, tint = 0xffffff, drift = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._baseY = y;
    this._drift = drift;
    this._phase = (this.index % 17) * 0.4;
    this.rotation = 0;
    this.setSprite('ball');
    this.setScale(scale);
    this.setAnchor(0.5, 0.5);
    this.setTint(tint);
    this.setAlpha(0.9);
  }

  tick(dtRatio) {
    if (this._drift === 0) return;
    this._phase += 0.35 * (dtRatio || 1);
    this.y = this._baseY + Math.sin(this._phase) * this._drift;
  }
}

function painterMoveConfig() {
  return {
    worldWidth: 12000,
    worldHeight: 20000,
    entityIdWidth: 32,
    seed: 616161,
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
      ySortingInCPU: true,
      maxVisibleRenderables: N,
    },
    preRender: {
      noLimitFPS: false,
      skipCull: true,
      numberOfPreRenderWorkers: 1,
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
    scene.spawnEntity(PainterMoveEntity, {
      x: 40 + col * 24,
      y: 40 + row * ROW,
      scale: 0.75 + (i % 5) * 0.06,
      tint: palette[i % palette.length],
      drift: i % MOVE_EVERY === 0 ? DRIFT : 0,
    });
  }
  Camera.setZoom(0.5);
  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
}

class PainterMoveBase extends Scene {
  static assets = {
    textures: { ball: '/demos/img/bola.png' },
  };
  static entities = [[PainterMoveEntity, N]];
  create() {
    spawn(this);
  }
}

export class PainterMoveReinsertScene extends PainterMoveBase {
  static config = painterMoveConfig();
}
