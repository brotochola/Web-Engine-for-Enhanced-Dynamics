/**
 * Two-color overlaps for the CPU painter. Layout lives in gpuYSortProbeLayout.js.
 */
import WEED from '/src/index.js';
import { CASES } from './gpuYSortProbeLayout.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

export class ProbeSprite extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = 0;

  onSpawned(cfg) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.rotation = cfg.rot || 0;
    this.setSprite('_white');
    this.setScale(cfg.scale);
    this.setAnchor(cfg.ax, cfg.ay);
    this.setTint(cfg.tint);
    this.setAlpha(1);
    this.spriteRenderer.zIndex = cfg.zIndex | 0;
    if (cfg.layer) this.setLayer(cfg.layer);
    if (cfg.decoration) {
      const d = cfg.decoration;
      this.addDecoration('_white', 0, 0, d.scale, d.scale, d.innerZ, {
        tint: d.tint,
        anchorX: d.anchorX,
        anchorY: d.anchorY,
      });
    }
  }
}

function countSprites() {
  let n = 0;
  for (let i = 0; i < CASES.length; i++) n += CASES[i].sprites.length;
  return n;
}

const N = countSprites();

export class GpuYSortProbeScene extends Scene {
  static config = {
    worldWidth: 960,
    worldHeight: 5000,
    entityIdWidth: 32,
    seed: 1,
    spatial: { numberOfSpatialWorkers: 0, cellSize: 256, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { enabled: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, maxDecorations: 4, decals: false },
    renderer: {
      backend: 'webgl',
      ySort: true,
      maxVisibleRenderables: 32,
    },
    preRender: { skipCull: true, numberOfPreRenderWorkers: 1 },
    lighting: { enabled: false },
    layers: {
      pile: { zIndex: 2, ySorting: true, maxItems: 8 },
    },
  };

  static entities = [[ProbeSprite, N]];

  create() {
    for (let c = 0; c < CASES.length; c++) {
      const row = CASES[c];
      for (let s = 0; s < row.sprites.length; s++) {
        const src = row.sprites[s];
        this.spawnEntity(ProbeSprite, {
          x: row.x,
          y: src.y,
          tint: src.tint,
          scale: src.scale,
          ax: src.anchorX,
          ay: src.anchorY,
          zIndex: src.zIndex,
          rot: src.rot,
          layer: src.layer,
          decoration: src.decoration,
        });
      }
    }
    Camera.setZoom(1);
    Camera.setPosition(0, 0);
  }
}
