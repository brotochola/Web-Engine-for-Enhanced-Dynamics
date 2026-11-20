import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,
  Transform,
  Collider,
  SpriteRenderer,
  ShadowCaster,
  RigidBody,
  ParticleEmitter,
  Flash,
  SoundManager,
  rng,
  enums,
} = WEED;
const { ShapeType } = enums;

// Written ECS-style (E-530): every hook is static, takes the barrel's index and writes its components' columns, so the
// logic workers make no instance for a barrel.
export class Barrel extends GameObject {
  static components = [Collider, SpriteRenderer, RigidBody, ShadowCaster];

  /** Barrel i spawned: one of the three barrel sprites on a small round body that slides a little when shot, never turns. */
  static onSpawned(i, spawnConfig) {
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, 10);
    // Heavy damping: a shot shoves it a few px and it stops at once.
    RigidBody.setLinearDamping(i, 10);
    // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
    Collider.visualRange[i] = 0;
    RigidBody.setFixedRotation(i, 1);
    SpriteRenderer.setSprite(i, 'barrel' + Math.floor(rng() * 3 + 1));
    SpriteRenderer.setScale(i, 1);
  }

  /** A bullet hit barrel i: a metal clang, sparks, a kick from the hit, and a flash. */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = rng() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.25, 0.85, 1.15, 0, 0, hitX, hitY, 'bullet_hits');

    const radius = Collider.radius[i];
    ParticleEmitter.emit({
      count: Math.floor(rng() * radius) + radius * 0.5,
      x: hitX,
      y: hitY,
      z: - rng() * SpriteRenderer.getOriginalHeight(i),
      angleXY: { min: 0, max: 360 },
      speed: { min: radius * 0.2, max: radius * 0.4 },
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

    // The kick: along the line from the barrel's centre to the hit point, 60 px/s per px of it.
    RigidBody.addVelocity(i, (hitX - Transform.x[i]) * 60, (hitY - Transform.y[i]) * 60);

    // A spark of strength s: reach 10·√s, glow s / 50000.
    const strength = rng() * 1000 + 1000;
    Flash.spawnIndex({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      radius: 10 * Math.sqrt(strength),
      glow: strength / 50000,
    });
  }
}
