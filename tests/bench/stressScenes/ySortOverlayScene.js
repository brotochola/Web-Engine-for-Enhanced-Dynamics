/**
 * Cutout body + blend quads that cross behind and in front.
 * `_white` is 8×8; scales below are world pixels.
 */
import WEED from '/src/index.js';
import { OVERLAY } from './ySortOverlayLayout.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

export { OVERLAY };

function queryParam(name) {
  const search = globalThis.location && globalThis.location.search;
  if (typeof search !== 'string') return null;
  return new URLSearchParams(search).get(name);
}

function overlayYSort() {
  const q = queryParam('ySort');
  if (q === 'cpu' || q === 'true') return 'cpu';
  if (q === '0' || q === 'false') return false;
  return 'cpu';
}

function overlayBackend() {
  const q = queryParam('backend');
  if (q === 'webgl' || q === 'webgpu') return q;
  return 'webgpu';
}

export class OverlayCutout extends GameObject {
  static components = [SpriteRenderer];
  onSpawned() {
    this.x = OVERLAY.body.x;
    this.y = OVERLAY.body.y;
    this.setSprite('_white');
    this.setScale(OVERLAY.body.sx, OVERLAY.body.sy);
    this.setAnchor(0.5, 1);
    this.setTint(OVERLAY.body.tint);
    this.setAlpha(1);
  }
}

export class OverlayBlend extends GameObject {
  static components = [SpriteRenderer];
  onSpawned({ x = 400, y = 280, sx = 10, sy = 10, tint = 0xff4466 } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    this.setScale(sx, sy);
    this.setAnchor(0.5, 0.5);
    this.setTint(tint);
    this.setAlpha(0.55);
  }
}

export class YSortOverlayScene extends Scene {
  static entities = [
    [OverlayCutout, 1],
    [OverlayBlend, 2],
  ];
  static config = {
    worldWidth: OVERLAY.canvasW,
    worldHeight: OVERLAY.canvasH,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 0, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: 1 },
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: overlayBackend(),
      ySort: overlayYSort(),
    },
    preRender: { skipCull: true },
    lighting: { enabled: false },
  };

  create() {
    this.spawnEntity(OverlayBlend, OVERLAY.front);
    this.spawnEntity(OverlayCutout, {});
    this.spawnEntity(OverlayBlend, OVERLAY.back);
    Camera.setZoom(1);
    Camera.centerOn(OVERLAY.camX, OVERLAY.camY);
  }
}
