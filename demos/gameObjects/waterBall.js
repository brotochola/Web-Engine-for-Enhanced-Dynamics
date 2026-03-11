import WEED from '/src/index.js';

const { GameObject, Mouse, RigidBody, Collider, SpriteRenderer } = WEED;

const BASE_WATER_TINT = 0x7fb2ff;
const SPLASH_TINT = 0xffffff;

function mixTint(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;

  const r = Math.round(ar + (br - ar) * clamped);
  const g = Math.round(ag + (bg - ag) * clamped);
  const bCh = Math.round(ab + (bb - ab) * clamped);
  return (r << 16) | (g << 8) | bCh;
}

class WaterBall extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() { }

  onSpawned(spawnConfig = {}) {
    this.rigidBody.maxVel = 300;
    this.rigidBody.maxAcc = 8;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.01

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;

    this.setSprite('_lightGradient');
    this.setLayer('water');
    this.setTint(BASE_WATER_TINT);
    this.setAlpha(0.9);

    // Small collider + larger visual = dense packing with lots of gradient overlap.
    // Physics prevents co-location; the metaball shader merges overlapping gradients
    // into a smooth continuous surface.
    const colliderRadius = 10;
    this.collider.radius = colliderRadius;
    this.collider.visualRange = colliderRadius * 8;

    RigidBody.mass[this.index] *= 2;
    RigidBody.invMass[this.index] = 1 / (RigidBody.mass[this.index] || 1);

    this.setScale(5);
  }

  tick(dtRatio) {
    const speed = this.rigidBody.speed || 0;
    const splash = Math.max(0, Math.min(1, (speed - 55) / 150));
    this.setTint(mixTint(BASE_WATER_TINT, SPLASH_TINT, splash));
    this.setAlpha(0.82 + splash * 0.18);

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
