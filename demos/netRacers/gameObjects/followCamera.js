// followCamera - the car scene's camera (zoom out with speed), for whichever car this browser drives.

import WEED from '/src/index.js';

const { Camera } = WEED;

const ZOOM_AT_MIN_SPEED = 1.0;
const ZOOM_AT_MAX_SPEED = 0.55;
const SPEED_FOR_MAX_ZOOM = 1200; // px/s
const FOLLOW_SMOOTH = 0.1;

/** @param {number} entityIndex @param {number} speed px/s @param {number} dtRatio */
export function followCar(entityIndex, speed, dtRatio) {
  const t = Math.min(1, Math.max(0, speed / SPEED_FOR_MAX_ZOOM));
  Camera.targetZoom = ZOOM_AT_MIN_SPEED + t * (ZOOM_AT_MAX_SPEED - ZOOM_AT_MIN_SPEED);
  Camera.followEntity(entityIndex, 0, FOLLOW_SMOOTH, dtRatio);
}
