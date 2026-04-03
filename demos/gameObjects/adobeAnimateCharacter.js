import WEED from '/src/index.js';

const { GameObject, AdobeAnimComponent } = WEED;

export class AdobeAnimateCharacter extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [AdobeAnimComponent];

  onSpawned(spawnConfig = {}) {
    const clipName = spawnConfig.clipName ?? 'running';
    const scaleX = spawnConfig.scaleX ?? spawnConfig.scale ?? 1;
    const scaleY = spawnConfig.scaleY ?? spawnConfig.scale ?? 1;

    this.setAdobeAnim('blue_character', clipName, {
      loop: spawnConfig.loop ?? true,
      playbackRate: spawnConfig.playbackRate ?? 1,
      scaleX,
      scaleY,
      alpha: spawnConfig.alpha ?? 1,
      tint: spawnConfig.tint ?? 0xffffff,
    });

    this.adobeAnim.rotation = spawnConfig.localRotation ?? 0;
  }

}
