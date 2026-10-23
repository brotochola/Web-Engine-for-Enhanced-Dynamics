import WEED from '/src/index.js';

const { GameObject, SpriteRenderer } = WEED;

const WALKS = ['walk_up', 'walk_left', 'walk_down', 'walk_right'];

/** A civilian walking on the spot: an animated sprite that never moves (animatedSpriteStressScene). */
export class AnimatedWalker extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, walk = 2, animSpeed = 0.2 } = {}) {
    this.setSpritesheet('civil1');
    this.setAnimation(WALKS[walk & 3]);
    this.setAnimationSpeed(animSpeed);
    this.setScale(0.5);
    this.x = x;
    this.y = y;
  }
}
