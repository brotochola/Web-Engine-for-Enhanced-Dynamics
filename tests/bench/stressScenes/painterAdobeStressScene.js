/**
 * Y-sort painter + Adobe piece expansion. Not a catalog row.
 * Type 6 expands one entity into a variable number of queue rows per frame.
 * Persist used to write at the collector index, which is not the emit index
 * once any expanded row is in the list. Two pre-render workers + skipCull so
 * persist and the shard prefix both see the expanded queue.
 */
import WEED from '/src/index.js';

const { Scene, Camera, GameObject, AdobeAnimComponent } = WEED;

const N = 400;
const COLS = 20;
const ROW = 80;

export class PainterAdobeEntity extends GameObject {
  static components = [AdobeAnimComponent];
  static assetName = 'willian';
  static clipName = 'Argen1_Piel2';

  onSpawned({ x = 0, y = 0, scale = 0.55, phase = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._baseY = y;
    this._phase = phase;
    this.adobeAnimComponent.setAsset(this.constructor.assetName, this.constructor.clipName, {
      loop: true,
      playbackRate: 1,
      scaleX: scale,
      scaleY: scale,
      anchorX: 0.5,
      anchorY: 1,
      alpha: 1,
      tint: 0xffffff,
    });
  }

  tick(dtRatio) {
    this._phase += 0.08 * (dtRatio || 1);
    this.y = this._baseY + Math.sin(this._phase) * 18;
  }
}

function painterAdobeConfig(painterSort, numberOfPreRenderWorkers) {
  return {
    worldWidth: 2400,
    worldHeight: 2400,
    entityIdWidth: 32,
    seed: 191919,
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
      maxVisibleRenderables: 25000,
      painterSort,
    },
    preRender: {
      noLimitFPS: false,
      skipCull: true,
      numberOfPreRenderWorkers,
      entityBlockSize: 64,
    },
    lighting: {
      enabled: false,
    },
  };
}

function spawn(scene) {
  for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = (i / COLS) | 0;
    scene.spawnEntity(PainterAdobeEntity, {
      x: 80 + col * 90,
      y: 80 + row * ROW,
      scale: 0.45 + (i % 4) * 0.04,
      phase: (i % 11) * 0.4,
    });
  }
  Camera.setZoom(0.7);
  Camera.centerOn(scene.config.worldWidth * 0.5, scene.config.worldHeight * 0.5);
}

class PainterAdobeBase extends Scene {
  static assets = {
    AdobeAnimateAnimations: {
      willian: {
        atlas: '/demos/fla/willian/willian2/spritemap1.json',
        animation: '/demos/fla/willian/willian2/Animation.json',
        png: '/demos/fla/willian/willian2/spritemap1.png',
      },
    },
  };
  static entities = [[PainterAdobeEntity, N]];
  create() {
    spawn(this);
  }
}

export class PainterAdobe1WReinsertScene extends PainterAdobeBase {
  static config = painterAdobeConfig('reinsert', 1);
}
export class PainterAdobe2WReinsertScene extends PainterAdobeBase {
  static config = painterAdobeConfig('reinsert', 2);
}
