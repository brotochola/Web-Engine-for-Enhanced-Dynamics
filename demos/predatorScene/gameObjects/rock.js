import WEED from '/src/index.js';
import { LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  rng,
  ShadowCaster,
  ParticleEmitter,
  SoundManager,
  enums,
} = WEED;
const { ShapeType } = enums;

// Written ECS-style (E-530): every hook is static, takes the rock's index and writes its components' columns, so the
// logic workers make no instance for a rock. Predator, carScene and bichosScene all use it.
export class Rock extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

  /** A bullet hit rock i: a stony clang and yellow sparks, from anywhere up the rock's height. */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = rng() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.25, 0.85, 1.12, 0, 0, hitX, hitY, 'bullet_hits');

    ParticleEmitter.emit({
      count: 10 + rng() * 10,
      x: hitX,
      y: hitY,
      z: - rng() * SpriteRenderer.getOriginalHeight(i),
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 4 },
      rotation: { min: 0, max: 360 },
      vz: -rng() * 4 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.15, max: 0.5 },
      texture: '_whiteCircle',
      tint: { min: 0xffff00, max: 0xffbb00 },
      alpha: { min: 0.8, max: 1 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

  }

  /** Rock i spawned: one of the four rock sprites, a random size and facing, a static round body 0.4 of its width. */
  static onSpawned(i, spawnConfig) {
    RigidBody.setStatic(i, 1);
    SpriteRenderer.setSprite(i, 'rock' + Math.floor(rng() * 4 + 1));
    const scale = rng() * 0.5 + 1;
    SpriteRenderer.setScale(i, rng() > 0.5 ? scale : -scale, scale);
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, SpriteRenderer.getOriginalWidth(i) * 0.4 * scale);
    // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
    Collider.visualRange[i] = 0;
    // The silhouette twice as long, its foot 0.17 of the sprite below the anchor. With ?light3d=1 the camera gives its
    // height and the engine measures its base: the ShadowCaster's default.
    if (!LIGHT3D) ShadowCaster.setSprite(i, { heightScale: 2, anchorY: 0.17 });
    SpriteRenderer.setAnchor(i, 0.5, 0.66);
  }
}
