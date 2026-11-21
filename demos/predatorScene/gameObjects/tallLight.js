import WEED from '/src/index.js';
import { WALL_CHIPS, WALL_HIT_FLASH } from '../effectPresets.js';
import { LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  LightEmitter,
  ShadowCaster,
  ParticleEmitter,
  rng,
  randomColor,
  Flash,
  SoundManager,
  enums,
} = WEED;
const { ShapeType } = enums;

// Written ECS-style (E-530): every hook is static, takes the lamp's index and writes its components' columns, so the
// logic workers make no instance for a lamp post.
export class TallLight extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static serializable = true;
  // Tall lights are simple lit props with collision, a sprite, and an emitter. ?light3d=1: the post casts the sun's
  // shadow and the other lamps' (its silhouette: a lamp's own post does not shade its light).
  static components = LIGHT3D
    ? [Collider, SpriteRenderer, LightEmitter, ShadowCaster]
    : [Collider, SpriteRenderer, LightEmitter];

  /**
   * LIFECYCLE: lamp post i spawned (or respawned from the pool): its sprite, a light of a random warm-to-white colour
   * on its bulb, and a small round collider at its foot. Every value is set again on each spawn, so nothing a pooled
   * slot's last life changed is left over.
   * @param {number} i
   * @param {Object} spawnConfig - what spawn() was given
   */
  static onSpawned(i, spawnConfig) {
    SpriteRenderer.setSprite(i, 'tallLight');

    LightEmitter.color[i] = randomColor({
      min: 0xff0000,
      max: 0xffffff,
    });

    // The bulb is 110 px above the post's foot: the glow sits on it, and the pool is lit from up there
    // (centred on the foot, flatter than a light on the ground).
    LightEmitter.glowOffsetY[i] = -110;
    LightEmitter.elevation[i] = 110;
    LightEmitter.radius[i] = 1414;
    LightEmitter.active[i] = 1;
    LightEmitter.setGlow(i, 0.48); // TallLights show the glowing sprite

    // Circle collider
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, 17);
    LightEmitter.shadowRange[i] = 400; // its shadows stop at 400 px (the light reaches 1414): cheaper
    Collider.setOffsetY(i, -9);
  }

  /** A bullet hit lamp post i: a metal clang, sparks where it hit, and a short flash. */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = rng() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.25, 0.9, 1.15, 0, 0, hitX, hitY, 'bullet_hits');

    // As many chips as the damage, from 20 px up, and a short flash.
    const count = Math.floor(damage * 8) + 3;
    ParticleEmitter.emitPreset(WALL_CHIPS, hitX, hitY, -20, count);
    Flash.spawnPreset(WALL_HIT_FLASH, hitX, hitY);
  }
}
