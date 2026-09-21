// Entity Template - engine-level starter (no demo dependencies)
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, SoundManager, Mouse, Gamepad } = WEED;

class MyEntity extends GameObject {
  // Required: fixed component set for this entity type
  static components = [RigidBody, Collider, SpriteRenderer];

  // Optional: reduce logic frequency when staggered updates are enabled
  // static tickInterval = 2;
  // static tickInterval = 0; // never visit (or just omit tick() entirely)
  // Do not write an empty tick(){} — that still counts as an override.
  // static tickAll(list, count, dtRatio) { /* SoA batch; do not also override tick() */ }

  setup() {
    // Runs once per pooled instance
    this.rigidBody.linearDamping = 0.02;
    this.collider.radius = 12;
    this.collider.visualRange = 140;

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.95;
  }

  onSpawned(spawnConfig = {}) {
    // Runs every spawn
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;

    // Optional animated setup:
    // this.setSpritesheet('my_sheet');
    // this.setAnimation('idle_down');
  }

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    const i = this.index;

    // Keyboard — true every frame while held
    if (WEED.Keyboard.isDown('arrowup')) {
      RigidBody.ay[i] -= 0.5; // px/s²; physics integrates dt — do not multiply by dtRatio
    }

    // Mouse — held state (true every frame while button is down)
    if (Mouse.isButton0Down) {
      // drag, continuous fire, etc.
    }

    // Mouse — edge detection (true only on the frame the event fired)
    // Reliable across all logic workers (uses SAB event counters).
    if (Mouse.isButton0Pressed) {
      // click: fires once on mousedown, even on fast clicks
    }
    if (Mouse.isButton0Released) {
      // release: fires once on mouseup
    }

    // Gamepad — pad 0 ergonomics (also Gamepad.isButtonDown(pad, Gamepad.A), getAxis, …)
    if (Gamepad.isConnected()) {
      RigidBody.ax[i] += Gamepad.leftX * 0.5; // px/s²
      RigidBody.ay[i] += Gamepad.leftY * 0.5;
      if (Gamepad.isAPressed) {
        // jump / once-per-press action
      }
    }

    // Example neighbor iteration
    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      // ...
    }

    // Sound playback — works identically on main thread and workers.
    // play(nameOrId, volume, rateMin, rateMax, loop, mute, worldX, worldY)
    // Spatial args (worldX/Y) enable distance attenuation + stereo pan.
    SoundManager.play('step', 0.4, 0.9, 1.1, 0, 0, this.x, this.y);
  }

  onCollisionEnter(otherIndex) {
    // Optional callback
  }

  onDespawned() {
    // Optional cleanup
  }
}

export { MyEntity };
