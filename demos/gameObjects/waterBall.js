import WEED from '/src/index.js';

const { GameObject, Mouse, RigidBody, Collider, SpriteRenderer, rng } = WEED;

class WaterBall extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() { }

  onSpawned(spawnConfig = {}) {
    this.rigidBody.maxVel = 80;
    this.rigidBody.maxAcc = 8;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.001;

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    this.setSprite('_lightGradient');
    this.setLayer('water');
    this.setTint(0xffffff);
    this.setAlpha(1.0);

    const ballRadius = 15
    this.collider.radius = ballRadius;
    this.collider.visualRange = ballRadius * 4;

    // const GRADIENT_TEX_SIZE = 200;
    // const scale = (ballRadius * 2) / GRADIENT_TEX_SIZE;
    this.spriteRenderer.scaleX = 10;
    this.spriteRenderer.scaleY = 10
  }

  tick(dtRatio) {
    if (Mouse.isButton1Down) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 20000) return;
      this.addAcceleration(dx * 0.2, dy * 0.2);
    }
  }
}

export { WaterBall };
