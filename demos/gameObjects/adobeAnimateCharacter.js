import WEED from '/src/index.js';

const { GameObject, AdobeAnimComponent, AdobeAnimRegistry, RigidBody, Collider, Mouse } = WEED;

export class AdobeAnimateCharacter extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [AdobeAnimComponent, RigidBody, Collider];
  static assetName = 'willian';
  static clips = Object.freeze({
    idle: 'Willian_corriendo',
    jumping: 'Willian_corriendo',
    running: 'Willian_corriendo',
  });
  static assetId = 0;
  static clipIds = Object.create(null);
  static clipDurations = Object.create(null);
  static _clipCacheReady = false;

  static warmClipCache() {
    if (this._clipCacheReady) return true;

    const assetId = AdobeAnimRegistry.getAssetId(this.assetName);
    if (!assetId) return false;

    this.assetId = assetId;

    for (const clipName of Object.values(this.clips)) {
      const clipId = AdobeAnimRegistry.getClipId(assetId, clipName);
      const frameCount = AdobeAnimRegistry.getClipFrameCount(assetId, clipId);
      const frameRate = AdobeAnimRegistry.getClipFrameRate(assetId, clipId);

      this.clipIds[clipName] = clipId;
      this.clipDurations[clipName] = frameRate > 0 ? frameCount / frameRate : 0;
    }

    this._clipCacheReady = true;
    return true;
  }

  playCachedClip(clipName, loop = true) {
    const EntityClass = this.constructor;
    if (!EntityClass.warmClipCache()) return this;

    this.adobeAnimComponent.clipId = EntityClass.clipIds[clipName] ?? 0;
    this.adobeAnimComponent.time = 0;
    this.adobeAnimComponent.loop = loop ? 1 : 0;
    this.adobeAnimComponent.playing = 1;
    AdobeAnimComponent.applyClipBounds(this.index);
    return this;
  }

  onSpawned(spawnConfig = {}) {
    const EntityClass = this.constructor;
    EntityClass.warmClipCache();

    const clipName = spawnConfig.clipName ?? EntityClass.clips.running;
    const scaleX = spawnConfig.scaleX ?? spawnConfig.scale ?? 1;
    const scaleY = spawnConfig.scaleY ?? spawnConfig.scale ?? 1;

    this.adobeAnimComponent.setAsset(EntityClass.assetName, clipName, {
      loop: spawnConfig.loop ?? true,
      playbackRate: spawnConfig.playbackRate ?? 1,
      scaleX,
      scaleY,
      anchorX: spawnConfig.anchorX ?? 0.5,
      anchorY: spawnConfig.anchorY ?? 1,
      alpha: spawnConfig.alpha ?? 1,
      tint: 0xffffff// randomColor({ min: 0x000000, max: 0xffffff }) //spawnConfig.tint ?? 0xffffff,
    });

    this.rigidBody.maxVel = 10;
    this.collider.radius = 16;

    this.collider.visualRange = 50;
    this.adobeAnimComponent.rotation = spawnConfig.localRotation ?? 0;
  }

  tick(dtRatio) {
    const EntityClass = this.constructor;
    const jumpClipName = EntityClass.clips.jumping;
    const idleClipName = EntityClass.clips.idle;
    const jumpClipId = EntityClass.clipIds[jumpClipName];
    const jumpDuration = EntityClass.clipDurations[jumpClipName] ?? 0;

    if (
      this.adobeAnimComponent.clipId === jumpClipId &&
      (!this.adobeAnimComponent.playing || this.adobeAnimComponent.time >= jumpDuration)
    ) {
      this.playCachedClip(idleClipName, true);
    }

    if (Mouse.isButton0Down) {
      const dx = this.x - Mouse.x;
      const dy = this.y - Mouse.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > 30000) return;

      if (this.adobeAnimComponent.clipId !== jumpClipId || !this.adobeAnimComponent.playing) {
        this.playCachedClip(jumpClipName, false);
      }

      this.addAcceleration(dx * 0.1, dy * 0.1);
    }
  }
}
