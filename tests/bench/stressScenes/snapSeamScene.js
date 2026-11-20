/**
 * N-302's capture: a floor of 16 px pieces laid edge to edge (4 rows of 120, from (1000, 1000)), drawn with pixel snap
 * (renderer.atlasScaleMode 'nearest') at a fractional zoom. Snap rounds each piece's origin to the screen's pixel grid
 * on its own while its corners keep their offsets (16 x zoom px), so two neighbours may leave a column of background
 * between them. The floor is white on a black page: a dark pixel inside it is a seam.
 *   ?zoom=1.3 (default)  ?camX=0.37 the camera's centre x past the floor's middle, in world px (fractions move the grid)
 *   ?snap=0 draws linear (no snap), the control.
 */
import WEED from '/src/index.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

const params = new URLSearchParams(globalThis.location?.search || '');
const num = (key, fallback) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};
export const ZOOM = num('zoom', 1.3);
export const CAM_X = num('camX', 0.37);
export const SNAP = params.get('snap') !== '0';
const COLS = 120;
const ROWS = 4;
const PIECE = 16;
const X0 = 1000;
const Y0 = 1000;

export const stressSceneConfig = { requested: { zoom: ZOOM, camX: CAM_X } };

export class SeamPiece extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.setSprite('_white');
    this.setAnchor(0, 0);
    this.setScale(PIECE / 8);
    this.x = x;
    this.y = y;
  }
}

export class SnapSeamScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 2000,
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
    renderer: { backend: 'webgl', atlasScaleMode: SNAP ? 'nearest' : 'linear' },
  };

  static assets = { textures: {} };

  static entities = [[SeamPiece, COLS * ROWS]];

  create() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) SeamPiece.spawn({ x: X0 + c * PIECE, y: Y0 + r * PIECE });
    }
    Camera.setZoom(ZOOM);
    Camera.centerOn(X0 + (COLS * PIECE) / 2 + CAM_X, Y0 + (ROWS * PIECE) / 2);
  }
}
