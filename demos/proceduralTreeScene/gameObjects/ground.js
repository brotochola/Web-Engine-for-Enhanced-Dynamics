import WEED from '/src/index.js';
import { LAYER_BRANCH, LAYER_DEAD, LAYER_GROUND, LAYER_LEAF } from '../components/treeComponent.js';

const { GameObject, RigidBody, Collider, MeshRenderer } = WEED;

export const GROUND_Y = 1500;

export function groundSurfaceY(x) {
  return GROUND_Y + Math.sin(x * 0.0035) * 36;
}

export class Ground extends GameObject {
  static components = [RigidBody, Collider, MeshRenderer];

  onSpawned() {
    this.x = 0;
    this.y = GROUND_Y;
    this.rigidBody.static = 1;
    this.collider.friction = 1;
    this.collider.restitution = 0;
    this.collider.collisionLayer = LAYER_GROUND;
    this.collider.collisionMask = (1 << LAYER_BRANCH) | (1 << LAYER_LEAF) | (1 << LAYER_DEAD);
    this.collider.collisionGroupIndex = 0;
    this.meshRenderer.tint = 0x88aa66;
    this.meshRenderer.setTexture('rocky');
    this.setTileWorld(128);
    this.meshRenderer.visualOutset = 2;
    this.setLayer('terrain');

    const width = 3600;
    const seg = 280;
    const xy = [];
    const counts = [];
    let maxX = 0;
    let maxY = 0;
    for (let x = 0; x < width; x += seg) {
      const x1 = Math.min(width, x + seg);
      const y0 = Math.sin(x * 0.0035) * 36;
      const y1 = Math.sin(x1 * 0.0035) * 36;
      const bot = 280;
      // CCW in this Y-down space: top-left, top-right, bottom-right, bottom-left.
      xy.push(x, y0, x1, y1, x1, bot, x, bot);
      counts.push(4);
      if (x1 > maxX) maxX = x1;
      if (bot > maxY) maxY = bot;
    }
    const ok = this.collider.replacePolygonsFlat(
      new Float32Array(xy),
      new Uint8Array(counts),
      counts.length,
    );
    if (!ok) return;
    this.collider.visualRange = Math.hypot(maxX, maxY) + 80;
  }
}
