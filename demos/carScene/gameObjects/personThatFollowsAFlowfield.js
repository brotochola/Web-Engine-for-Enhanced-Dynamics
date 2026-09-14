import WEED from '/src/index.js';
import { DIRECTION_DOWN, PersonComponent } from '/demos/predatorScene/components/personComponent.js';
import { PersonAnimationFSM } from '/demos/predatorScene/fsm/personAnimationFSM.js';
import { LootableComponent } from '/demos/predatorScene/components/lootableComponent.js';
import { CarComponent } from '../components/carComponent.js';
import { ParticleEmitter, SpriteSheetRegistry, SoundManager } from '/src/index.js';

const { rng, GameObject, RigidBody, Collider, CollisionListener, SpriteRenderer, NavGrid, Transform } = WEED;

// Reusable object for flowfield sampling (zero allocation)
const _navVec = { x: 0, y: 0 };

export class PersonThatFollowsAFlowfield extends GameObject {
  static scriptUrl = import.meta.url;
  static deriveSpeed = true;
  static tickInterval = 4; // match MySoldier

  static components = [
    RigidBody,
    Collider,
    CollisionListener,
    SpriteRenderer,
    PersonAnimationFSM,
    PersonComponent,
    LootableComponent,
  ];

  static defaultFriction = 2; // match MySoldier.linearDamping

  static punchRangeSq = 30 ** 2;
  static punchDamage = 0.3;
  static muzzleDistancePx = 30;
  static muzzleHeightPx = -30;

  static minSquaredDistanceToGroup = 140 ** 2;
  static groupingForce = 0;
  // Match MySoldier.separationForce (literal — avoid pulling MySoldier at class init)
  static separationForce = 60000;
  static separationRadius = 30;
  static separationRadiusSq = this.separationRadius * this.separationRadius;
  static resistance = 0.5;
  static flowfieldName = 'sidewalks';
  /** Match MySoldier.followDestinationStrength */
  static flowFollowStrength = 300;
  /** Match MySoldier.chaseStrength — used for car avoid 1/r */
  static avoidChaseStrength = 24500;

  onSpawned(spawnConfig = {}) {
    const spritesheets = ['civil1', 'civil2', 'civil3'];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    this.rigidBody.linearDamping = PersonThatFollowsAFlowfield.defaultFriction;
    this.setFixedRotation(1);

    this.collider.radius = 10;
    this.collider.visualRange = 350;

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.98;
    this.spriteRenderer.animationSpeed = 0.15;

    const scale = 0.7 + rng() * 0.2;
    this.setScale(scale, scale);
    this.collider.radius = 10 * scale;

    this.lootableComponent.health = 1;
    this.lootableComponent.dropMoney = 0;

    PersonComponent.facingDirection[this.index] = DIRECTION_DOWN;
    PersonComponent.dead[this.index] = 0;
    PersonComponent.lastShotTime[this.index] = 0;
    PersonComponent.aimingAccuracy[this.index] =
      spawnConfig.aimingAccuracy ?? 0.8;
    PersonComponent.lastTeamDataUpdateTime[this.index] = 0;

    this.addShadowDecoration();
  }

  addShadowDecoration() {
    this.addDecoration('_whiteCircle_64x64', 0, 0, 0.33, 0.16, -1, {
      anchorX: 0.5,
      anchorY: 0.5,
      alpha: 0.25,
      offsetY: 0,
      tint: 0x000000,
    });
  }

  onCollisionEnter(other) {
    if (!CarComponent.active || !CarComponent.active[other]) return;

    const carVx = RigidBody.vx[other];
    const carVy = RigidBody.vy[other];
    const myVx = RigidBody.vx[this.index];
    const myVy = RigidBody.vy[this.index];
    const dvx = carVx - myVx;
    const dvy = carVy - myVy;
    const impactSpeed = Math.hypot(dvx, dvy);

    // px/s — was 3 frame-vel
    if (impactSpeed < 180) return;

    const damage = impactSpeed * 0.1;
    LootableComponent.health[this.index] -= damage;

    ParticleEmitter.emit({
      count: Math.floor(damage * 20),
      texture: 'blood',
      x: this.x,
      y: this.y,
      z: -10,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.7, max: 2 },
      vz: { min: -4, max: 0 },
      lifespan: 2000,
      gravity: 0.15,
      scale: { min: 0.1, max: 0.2 },
      alpha: { min: 0.4, max: 0.9 },
      tint: { min: 0xaaaaaa, max: 0xffffff },
      stayOnTheFloor: true,
    });
  }

  die() {
    if (PersonComponent.dead[this.index] === 1) return;

    this.rigidBody.linearDamping = 0.9;
    PersonComponent.dead[this.index] = 1;

    const deathSounds = ['dolor1', 'dolor2', 'dolor3', 'dolor4'];
    const deathSound = deathSounds[(rng() * deathSounds.length) | 0];
    SoundManager.play(deathSound, 0.8, 0.9, 1.1, 0, 0, this.x, this.y);

    ParticleEmitter.emit({
      count: Math.floor(10 + rng() * 5),
      texture: 'blood',
      x: this.x,
      y: this.y,
      z: -10,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.7, max: 2 },
      vz: { min: -4, max: 0 },
      lifespan: 2000,
      gravity: 0.15,
      scale: { min: 0.1, max: 0.2 },
      alpha: { min: 0.4, max: 0.9 },
      tint: { min: 0xaaaaaa, max: 0xffffff },
      stayOnTheFloor: true,
    });

    this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.DYING);
  }

  onDeathAnimationComplete() {
    const spritesheetId = this.spriteRenderer.spritesheetId;
    const spritesheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);

    ParticleEmitter.stampDecal({
      spritesheet: spritesheetName,
      animation: 'hurt',
      frame: -1,
      x: this.x,
      y: this.y - 8,
      scaleX: this.spriteRenderer.scaleX,
      scaleY: this.spriteRenderer.scaleY,
      tint: this.spriteRenderer.baseTint,
      alpha: 1,
    });

    this.despawn();
  }

  avoidCars() {
    const myX = this.x;
    const myY = this.y;
    const lookAheadSec = 0.25;

    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      if (!CarComponent.active || !CarComponent.active[neighborIndex]) continue;

      const carX =
        Transform.x[neighborIndex] + RigidBody.vx[neighborIndex] * lookAheadSec;
      const carY =
        Transform.y[neighborIndex] + RigidBody.vy[neighborIndex] * lookAheadSec;
      const speed = RigidBody.speed[neighborIndex];
      const dx = myX - carX;
      const dy = myY - carY;
      const dist2 = dx * dx + dy * dy;
      if (!(dist2 > 1)) continue;

      // 1/r push — same order as MySoldier.chaseStrength, scaled by car speed
      const avoidStrength =
        PersonThatFollowsAFlowfield.avoidChaseStrength *
        (0.25 + Math.min(1, speed / 600));
      this.addAcceleration((dx / dist2) * avoidStrength, (dy / dist2) * avoidStrength);
    }
  }

  tick(dtRatio) {
    const isDead = PersonComponent.dead[this.index] === 1;

    if (!isDead && LootableComponent.health[this.index] <= 0) {
      this.die();
      return;
    }

    if (isDead) {
      if (this.spriteRenderer?.spritesheetId) {
        this.personAnimationFSM.tick(dtRatio, this);
      }
      return;
    }

    this.avoidCars();

    NavGrid.requestVectorFromStaticFlowfield(
      PersonThatFollowsAFlowfield.flowfieldName,
      this.x,
      this.y,
      _navVec,
    );
    const factor = PersonThatFollowsAFlowfield.flowFollowStrength;
    this.addAcceleration(_navVec.x * factor, _navVec.y * factor);

    const myX = this.x;
    const myY = this.y;
    const myEntityType = this.entityType;
    const separationRadiusSq = PersonThatFollowsAFlowfield.separationRadiusSq;
    const separationForce = PersonThatFollowsAFlowfield.separationForce;

    let separateX = 0;
    let separateY = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      if (Transform.entityType[neighborIndex] !== myEntityType) continue;

      const nx = Transform.x[neighborIndex];
      const ny = Transform.y[neighborIndex];
      const dx = myX - nx;
      const dy = myY - ny;
      const distSq = dx * dx + dy * dy;

      if (distSq < separationRadiusSq && distSq > 1) {
        const strength = (separationRadiusSq - distSq) / separationRadiusSq;
        separateX += (dx / distSq) * strength;
        separateY += (dy / distSq) * strength;
      }
    }

    if (separateX !== 0 || separateY !== 0) {
      this.addAcceleration(separateX * separationForce, separateY * separationForce);
    }

    // px/s — was 0.166 frame-vel
    if (RigidBody.speed[this.index] < 10) {
      this.setVelocity(0, 0);
    }

    if (this.spriteRenderer?.spritesheetId) {
      this.personAnimationFSM.tick(dtRatio, this);
    }
  }
}
