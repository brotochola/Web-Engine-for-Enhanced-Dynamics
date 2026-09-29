import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

/**
 * Full-world white sprite so multiply lighting has an albedo.
 * Lights/occluders in this stress scene have no sprites; without this the
 * canvas stays pitch black (lighting RT × black clear = black).
 */
export class VisPolyAlbedo extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, width = 100, height = 100 } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite('_white');
    const ow = this.spriteRenderer.originalWidth || 8;
    const oh = this.spriteRenderer.originalHeight || 8;
    this.setScale(width / ow, height / oh);
    this.setAnchor(0.5, 0.5);
    this.setTint(0xffffff);
  }
}
