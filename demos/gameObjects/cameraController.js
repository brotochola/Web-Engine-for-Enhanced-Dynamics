import { MySoldier } from './mySoldier.js';

import WEED from '/src/index.js';
const { Camera, Mouse } = WEED;
export class CameraController extends WEED.GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  frameCount = 0;

  setup() {}
  onSpawned(spawnConfig = {}) {}
  onDespawned() {}

  tick(dtRatio) {
    const mySoldierIndices = MySoldier.getAllActiveIndices();

    if (mySoldierIndices.length === 0) return;

    let minX = 9999;
    let minY = 9999;
    let maxX = 0;
    let maxY = 0;

    // Find bounding box of all soldiers
    for (let i = 1; i < mySoldierIndices.length; i++) {
      const idx = mySoldierIndices[i];
      const x = Transform.x[idx];
      const y = Transform.y[idx];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    // Calculate center of all soldiers
    const centerX = minX + (maxX - minX) / 2;
    const centerY = minY + (maxY - minY) / 2;

    // Calculate zoom to fit all soldiers with padding (percentage of screen)
    const paddingWidthPercent = 0.25; // 20% on each side
    const paddingHeightPercent = 0.25; // 15% on each side
    const paddingX = Camera.canvasWidth * paddingWidthPercent;
    const paddingY = Camera.canvasHeight * paddingHeightPercent;
    const spreadX = maxX - minX + paddingX * 2;
    const spreadY = maxY - minY + paddingY * 2;

    // Calculate zoom so the spread fits in the viewport
    // Lower zoom = more world visible, higher zoom = zoomed in
    const zoomX = Camera.canvasWidth / spreadX;
    const zoomY = Camera.canvasHeight / spreadY;
    const zoom = Math.min(zoomX, zoomY, 1); // Cap at 2x zoom (don't zoom in too much)

    // Set target zoom (will be lerped smoothly)
    Camera.setZoom(zoom);

    // Follow the center of all soldiers
    Camera.follow(centerX, centerY);
  }
}
