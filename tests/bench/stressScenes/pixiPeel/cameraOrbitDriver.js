import WEED from '/src/index.js';

const { GameObject, Camera } = WEED;

/** Main-thread or worker: write SAB camera so skip-RT / scenery early-out cannot fire. */
export function stepCameraOrbit(t, cx, cy, radius, zoom0, zoomAmp) {
  Camera.setZoom(zoom0 + Math.sin(t * 0.7) * zoomAmp);
  Camera.setPosition(
    cx + Math.cos(t) * radius,
    cy + Math.sin(t * 1.37) * radius,
  );
}

/**
 * Pan + zoom every tick so scenery skip and MESH skip-RT cannot fire.
 */
export class CameraOrbitDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({
    cx = 2000,
    cy = 2000,
    radius = 480,
    step = 0.045,
    zoom0 = 0.55,
    zoomAmp = 0.12,
    seed = 0x0b17,
  } = {}) {
    this.x = cx;
    this.y = cy;
    this._cx = cx;
    this._cy = cy;
    this._radius = radius;
    this._step = step;
    this._zoom0 = zoom0;
    this._zoomAmp = zoomAmp;
    this._t = ((seed >>> 0) % 1024) * 0.01;
  }

  tick() {
    this._t += this._step;
    stepCameraOrbit(this._t, this._cx, this._cy, this._radius, this._zoom0, this._zoomAmp);
  }
}
