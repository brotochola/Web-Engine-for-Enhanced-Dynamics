import WEED from '/src/index.js';

const { GameObject, AdobeAnimComponent, RigidBody, Collider } = WEED;

export class AdobeAnimateCharacter extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [AdobeAnimComponent, RigidBody, Collider];

  onSpawned(spawnConfig = {}) {
    const clipName = spawnConfig.clipName ?? 'running';
    const scaleX = spawnConfig.scaleX ?? spawnConfig.scale ?? 1;
    const scaleY = spawnConfig.scaleY ?? spawnConfig.scale ?? 1;

    this.setAdobeAnim('blue_character', clipName, {
      loop: spawnConfig.loop ?? true,
      playbackRate: spawnConfig.playbackRate ?? 1,
      scaleX,
      scaleY,
      anchorX: spawnConfig.anchorX ?? 0.5,
      anchorY: spawnConfig.anchorY ?? 0.5,
      alpha: spawnConfig.alpha ?? 1,
      tint: spawnConfig.tint ?? 0xffffff,
    });

    this.rigidBody.maxVel = 10;
    this.collider.radius = 16;

    this.collider.visualRange = 50;
    this.adobeAnim.rotation = spawnConfig.localRotation ?? 0;
  }
  tick(dtRatio) {
    if (Mouse.isButton0Down) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 30000) return;
      this.playAdobeClip("jumping", false)

      setTimeout(() => {
        this.playAdobeClip("idle", true)
      }, 1600)
      this.addAcceleration(dx * 0.1, dy * 0.1);
    }

  }

}
