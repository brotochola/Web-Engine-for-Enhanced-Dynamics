import { MySoldier } from './mySoldier.js';

import WEED from '/src/index.js';

const { Camera, Transform } = WEED;

const PAD = 0.25;
const SMOOTH = 0.12;
const SHRINK = 0.08;

let holdMinX = 0;
let holdMinY = 0;
let holdMaxX = 0;
let holdMaxY = 0;
let holdReady = false;

export function resetSquadCameraHold() {
  holdReady = false;
}

export function updateSquadCamera(dtRatio) {
  const indices = MySoldier.getAllActive();
  const n = indices ? indices.length : 0;
  if (n === 0) {
    holdReady = false;
    Camera.targetZoom = 1;
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const idx = indices[i];
    const x = Transform.x[idx];
    const y = Transform.y[idx];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const shrink = Math.min(1, SHRINK * (dtRatio > 0 ? dtRatio : 1));
  if (!holdReady) {
    holdMinX = minX;
    holdMinY = minY;
    holdMaxX = maxX;
    holdMaxY = maxY;
    holdReady = true;
  } else {
    holdMinX = minX < holdMinX ? minX : holdMinX + (minX - holdMinX) * shrink;
    holdMinY = minY < holdMinY ? minY : holdMinY + (minY - holdMinY) * shrink;
    holdMaxX = maxX > holdMaxX ? maxX : holdMaxX + (maxX - holdMaxX) * shrink;
    holdMaxY = maxY > holdMaxY ? maxY : holdMaxY + (maxY - holdMaxY) * shrink;
  }

  const spanX = Math.max(holdMaxX - holdMinX, 1);
  const spanY = Math.max(holdMaxY - holdMinY, 1);
  const zoomX = (Camera.canvasWidth * (1 - 2 * PAD)) / spanX;
  const zoomY = (Camera.canvasHeight * (1 - 2 * PAD)) / spanY;
  let zoom = Math.min(zoomX, zoomY, 1);
  if (zoom < Camera.minZoom) zoom = Camera.minZoom;

  Camera.targetZoom = zoom;
  Camera.follow((holdMinX + holdMaxX) * 0.5, (holdMinY + holdMaxY) * 0.5, SMOOTH, dtRatio);
}
