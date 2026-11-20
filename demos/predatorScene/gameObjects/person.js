// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations

import WEED from '/src/index.js';

import { Destination } from './destination.js';
import { Lootable } from './lootable.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { PersonComponent } from '../components/personComponent.js';
import { PersonAnimationFSM, WALK_SPEED_THRESHOLD } from '../fsm/personAnimationFsm.js';
import { LIGHT3D } from '../light3d.js';
import {
  ParticleEmitter,
  SpriteSheetRegistry,
  Ray,
  Flash,
  SoundManager,
  GameObject,
  Decal,
  BulletPool,
  randomColor,
} from '/src/index.js';

const { ShadowCaster, RigidBody, Collider, DirectionalSprite, Transform, rng, NavGrid } = WEED;

/** How close to the world's edge (px) a person starts to be pushed back in, and how hard (px/s²). */
const EDGE_MARGIN = 50;
const EDGE_PUSH = 360;
/** Under this speed (px/s) a person that is not shooting stops: friction alone would leave it creeping. */
const STOP_SPEED = 0.166;

/** The living among the entities a tickAll got, for the behaviour FSMs (grown when a bigger list comes). */
let living = new Int32Array(1024);

export class Person extends Lootable {
  static deriveSpeed = true;

  static defaultFriction = 0.005;

  static punchRangeSq = 30 ** 2; // Distance to start punching
  static punchDamage = 0.3; // Damage per punch
  static muzzleDistancePx = 30; // Distance from actor center to muzzle in world px
  static muzzleHeightPx = -30; // Visual muzzle height (negative = above ground)

  // Damage resistance (static - same for all Person instances)
  static resistance = 0.5;
  // Civilian panic sprint — 1/r accel coeff (faster than flee); subclasses may override
  static panicFleeFactor = 70000;
  // Floor for 1/r accel (chase/flee/panic) — close range can't rocket
  static accelDistFloorSq = 35 ** 2;

  static components = [
    ...Lootable.components,
    RigidBody,
    Collider,
    DirectionalSprite,
    ShadowCaster,
    PersonComponent,
    PersonAnimationFSM,
  ];

  // ==========================================
  // WEAPON DEFINITIONS - damage, cooldown (ms), range (px)
  // ==========================================
  static WEAPON_SOUND_VOLUME = 0.33;
  static WEAPON_SOUND_RATE_MIN = 0.9;
  static WEAPON_SOUND_RATE_MAX = 1.1;

  static WEAPONS = {
    PISTOL: {
      damage: 0.66,
      cooldown: 500,
      range: 180,
      rangeSq: 180 ** 2,
      bulletSpeed: 1500,
      sound: 'pistola_disparo',
    },
    MACHINE_GUN: {
      damage: 0.2,
      cooldown: 133,
      range: 500,
      rangeSq: 500 ** 2,
      bulletSpeed: 2300,
      rapidFire: true,
      sound: 'ametralladora_disparo',
    },
  };

  getRandomTint() {
    let r = 0.8 + rng() * 0.2;
    let g = 0.8 + rng() * 0.2;
    let b = 0.8 + rng() * 0.2;

    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }

  /**
   * LIFECYCLE: Called when spawned - runs EVERY spawn
   */
  onSpawned(spawnConfig = {}) {
    // Collision/perception — size before damping so Box2D never sees Circle r=0
    this.collider.radius = 10;
    this.collider.visualRange = 150;
    this.rigidBody.linearDamping = Person.defaultFriction;

    // Sprite setup
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.98;
    this.spriteRenderer.animationSpeed = 0.15;
    // The shadow: the sprite's silhouette, its card 1.5 times as long. With ?light3d=1 the camera gives its height, and the
    // silhouette is the ShadowCaster's default (each light sees its own view of the person).
    if (!LIGHT3D) this.shadowCaster.setSprite({ heightScale: 1.5 });

    // Flocking and resistance now use static class properties (no per-entity arrays needed)
    // this.setSpritesheet("poli");
    // this.setAnimation("idle_down");

    this.setTint(this.getRandomTint());

    // Random scale
    const scale = 0.9 + rng() * 0.2;
    this.collider.radius = 10 * scale;
    this.setScale(scale, scale);

    this.lootableComponent.health = 1;
    // resistance now uses static class property (Person.resistance)
    this.lootableComponent.dropMoney = 0//100;

    // Facing south. The walk follows the velocity (PersonAnimationFSM), with no margin at the borders.
    this.directionalSprite.turnMargin = 0;
    this.directionalSprite.facing = Math.PI / 2;

    // Reset dead flag (entity indices are reused)
    PersonComponent.dead[this.index] = 0;

    // Reset shot cooldown (so recycled entities can fire immediately)
    PersonComponent.lastShotTime[this.index] = 0;

    // Aiming accuracy: 0 = max spread, 1 = perfect aim (default 0.8)
    PersonComponent.aimingAccuracy[this.index] = spawnConfig.aimingAccuracy ?? 0.8;

    // Reset team-throttle timestamp (entity indices are reused)

    this.setScale(scale, scale);
  }

  /** Damage to person i: none once dead; a lethal one kills at once; a real one bleeds. */
  static recieveDamage(i, damage, sourceX, sourceY) {
    // Don't process damage if already dead
    if (PersonComponent.dead[i] === 1) return;

    super.recieveDamage(i, damage, sourceX, sourceY);

    // Trigger death immediately on lethal damage (don't wait for next tick)
    if (LootableComponent.health[i] <= 0) {
      this.die(i);
      return;
    }

    if (damage < 0.1) return;

    ParticleEmitter.emit({
      count: Math.floor(damage * (rng() * 10 + 4)),
      texture: 'blood',
      x: Transform.x[i],
      y: Transform.y[i],
      z: -30,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.7, max: 1.66 },
      vz: { min: -4, max: 0 },
      lifespan: 2000,
      gravity: 0.22,
      scale: { min: 0.12, max: 0.3 },
      alpha: { min: 0.66, max: 0.95 },
      tint: { min: 0xaaaaaa, max: 0xffffff },
      stayOnTheFloor: true,
    });
  }

  /**
   * Each frame, for the whole type at once (E-530: Predator written static). Every person: a living one with no health
   * left dies (Lootable's check); one that is not shooting is pushed back in near the world's edges and stops when too
   * slow to walk (a shooter skips both, so knockback and collisions still move it). Then the animation FSM for all, and
   * the type's behaviour FSM (static behaviorFSM) for the living. All from the columns, by index.
   */
  static tickAll(list, count, dtRatio) {
    const dead = PersonComponent.dead;
    const animationState = PersonAnimationFSM.state;
    const shooting = PersonAnimationFSM.states.SHOOTING.stateIndex;
    const health = LootableComponent.health;
    const x = Transform.x;
    const y = Transform.y;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    const speed = RigidBody.speed;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const config = this.config;
    const maxX = (config.worldWidth || 1000) - EDGE_MARGIN;
    const maxY = (config.worldHeight || 1000) - EDGE_MARGIN;

    for (let k = 0; k < count; k++) {
      const i = list[k];
      const isShooting = animationState[i] === shooting;
      if (dead[i] !== 1 && health[i] <= 0) this.die(i);
      if (isShooting) continue;

      const px = x[i];
      const py = y[i];
      if (px < EDGE_MARGIN) ax[i] += EDGE_PUSH;
      if (px > maxX) ax[i] -= EDGE_PUSH;
      if (py < EDGE_MARGIN) ay[i] += EDGE_PUSH;
      if (py > maxY) ay[i] -= EDGE_PUSH;
      if (speed[i] < STOP_SPEED && (vx[i] !== 0 || vy[i] !== 0)) RigidBody.setVelocity(i, 0, 0);
    }

    PersonAnimationFSM.tickAll(list, count, dtRatio, this);

    const BehaviorFSM = this.behaviorFSM;
    if (BehaviorFSM === null) return;
    if (living.length < count) living = new Int32Array(count);
    let alive = 0;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      if (dead[i] !== 1) living[alive++] = i;
    }
    BehaviorFSM.tickAll(living, alive, dtRatio, this);
  }

  /** The FSM that decides what a person of this type does (its subclasses name theirs); null for none. */
  static behaviorFSM = null;

  // ==========================================
  // WEAPON HELPERS - Check inventory and get best weapon
  // ==========================================

  /**
   * Whether the person at entity index i has any ranged weapon
   * @param {number} i - entity index
   * @returns {boolean} True if has pistol or machine gun
   */
  static hasGun(i) {
    return LootableComponent.dropPistol[i] > 0 || LootableComponent.dropMachineGun[i] > 0;
  }

  /**
   * The best weapon the person at entity index i has (machine gun > pistol > null)
   * @param {number} i - entity index
   * @returns {Object|null} Weapon definition from Person.WEAPONS or null if unarmed
   */
  static bestWeapon(i) {
    if (LootableComponent.dropMachineGun[i] > 0) return Person.WEAPONS.MACHINE_GUN;
    if (LootableComponent.dropPistol[i] > 0) return Person.WEAPONS.PISTOL;
    return null;
  }

  /**
   * Check if weapon cooldown has elapsed (ready to fire)
   * Uses performance.now() for frame-rate independent timing
   * @param {Object} weapon - Weapon definition from Person.WEAPONS
   * @returns {boolean} True if can fire
   */
  canFire(weapon) {
    const lastShot = PersonComponent.lastShotTime[this.index];
    return performance.now() - lastShot >= weapon.cooldown;
  }

  // ==========================================
  // ACTION TRIGGERS - Call these to trigger animations
  // ==========================================

  /**
   * Trigger shoot at target entity
   * @param {number} targetEntityIndex - Entity index to shoot at
   * @returns {boolean} True if shot fired, false if on cooldown/busy/dead/no weapon
   */
  shoot(targetEntityIndex) {
    if (PersonComponent.dead[this.index] === 1) return false;

    const weapon = Person.bestWeapon(this.index);
    if (!weapon) return false;

    // Block if performing action (unless rapid-fire weapon + already in shooting animation)
    if (Person.isPerformingAction(this.index)) {
      const rapidFireInShooting = weapon.rapidFire && PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.SHOOTING);
      if (!rapidFireInShooting) return false;
    }

    // Check cooldown
    if (!this.canFire(weapon)) return false;

    // Face the target
    // Lead ~10 frames at 60Hz → 1/6 s
    const targetX = Transform.x[targetEntityIndex] + RigidBody.vx[targetEntityIndex] * (10 / 60);
    const targetY = Transform.y[targetEntityIndex] + RigidBody.vy[targetEntityIndex] * (10 / 60);

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const lenSq = dx * dx + dy * dy;
    let dirX = 1;
    let dirY = 0;
    if (lenSq > 1e-12) {
      const inv = 1 / Math.sqrt(lenSq);
      dirX = dx * inv;
      dirY = dy * inv;
    }

    // Face the target (the shooting state keeps the facing; the walk takes it from the velocity again).
    this.directionalSprite.facingFrom = 'manual';
    if (lenSq > 1e-12) this.directionalSprite.facing = Math.atan2(dy, dx);

    // Record shot time
    PersonComponent.lastShotTime[this.index] = performance.now();

    // Trigger shoot animation (skip if rapid-fire and already shooting - avoids resetting animation)
    const alreadyShooting = PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.SHOOTING);
    if (!(weapon.rapidFire && alreadyShooting)) {
      this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.SHOOTING);
    }

    // Muzzle position from shooter center along aim unit vector.
    const muzzleDistancePx = this.constructor.muzzleDistancePx;
    const muzzleHeightPx = this.constructor.muzzleHeightPx;
    const muzzleX = this.x + dirX * muzzleDistancePx;
    const muzzleY = this.y + dirY * muzzleDistancePx;

    // Spawn bullet (raycast hit handled by engine; target.onGotShot called on impact)
    const speed = weapon.bulletSpeed ?? 800;
    // Apply aiming spread: accuracy 1 = no spread, 0 = max spread (~12°)
    const accuracy = PersonComponent.aimingAccuracy[this.index];
    const maxSpreadRad = 0.21; // ~12 degrees when accuracy is 0
    const spreadRad = maxSpreadRad * (1 - accuracy);
    const angleOffset = (rng() - 0.5) * 2 * spreadRad;
    let shotDirX = dirX;
    let shotDirY = dirY;
    if (angleOffset !== 0) {
      const ad = angleOffset < 0 ? -angleOffset : angleOffset;
      const dc = ad < 0.08 ? 1 : Math.cos(angleOffset);
      const ds = ad < 0.08 ? angleOffset : Math.sin(angleOffset);
      shotDirX = dirX * dc - dirY * ds;
      shotDirY = dirX * ds + dirY * dc;
    }
    const vx = shotDirX * speed;
    const vy = shotDirY * speed;
    BulletPool.spawn({
      x: muzzleX,
      y: muzzleY,
      offsetY: muzzleHeightPx,
      vx,
      vy,
      damage: weapon.damage,
      ownerId: this.index,
      shooterEntityType: Transform.entityType[this.index],
      texture: 'bullet',
      scale: 1,
      anchorX: 1,
      anchorY: 0.5,
      trailWidth: 4,
      // layerId: Layer.getId('bullets')
    });

    if (weapon.sound) {
      SoundManager.play(
        weapon.sound,
        Person.WEAPON_SOUND_VOLUME,
        Person.WEAPON_SOUND_RATE_MIN,
        Person.WEAPON_SOUND_RATE_MAX,
        0,
        0,
        muzzleX,
        muzzleY,
        'sfx'
      );
    }

    // Muzzle flash sprites face shot direction (CS, no degree→trig round-trip)
    ParticleEmitter.emit({
      count: 1,
      x: muzzleX,
      y: muzzleY + 1,
      texture: "muzzle" + Math.floor(rng() * 3 + 1),
      scaleX: rng() * 0.5 + 0.5,
      scaleY: rng() * 0.5 + 0.5,
      rotC: shotDirX,
      rotS: shotDirY,
      alpha: rng() * 0.5 + 0.5,
      anchorX: 0,
      anchorY: 0.5,
      z: muzzleHeightPx,
      gravity: 0,
      lifespan: 50,
      speed: 0
    })

    ParticleEmitter.emit({
      count: 1,
      x: muzzleX,
      y: muzzleY + 1,
      texture: "muzzle" + Math.floor(rng() * 3 + 1),
      scaleX: rng() * 0.5 + 0.5,
      scaleY: rng() * 0.5 + 0.5,
      rotC: shotDirX,
      rotS: shotDirY,
      alpha: rng() * 0.5 + 0.5,
      anchorX: 0,
      anchorY: 0.5,
      z: muzzleHeightPx,
      gravity: 0,
      lifespan: 50,
      speed: 0
    })

    Flash.spawn({
      x: muzzleX,
      y: muzzleY,
      z: -muzzleHeightPx,
      lifespan: 18,
      color: 0xffaa00,
      radius: 1000,
      glow: 0,
    });

    this.shootingSparks(shotDirX, shotDirY, muzzleX, muzzleY, muzzleHeightPx)

    // }, howMuchTimeToWaitUntilFire)

    return true;
  }

  shootingSparks(dirX, dirY, muzzleX, muzzleY, muzzleHeightPx) {
    // Unit dir + spread rad — no atan2→deg→angleXY round-trip
    ParticleEmitter.emit({
      count: Math.floor(rng() * 10) + 10,
      x: muzzleX,
      y: muzzleY + 1,
      z: muzzleHeightPx,
      dirX,
      dirY,
      spread: (10 * Math.PI) / 180,
      speed: { min: 0.1, max: 10 },
      rotation: { min: 0, max: 360 },
      vz: { min: -1, max: 5 },
      gravity: 0.4,
      lifespan: { min: 33, max: 100 },
      scale: { min: 0.15, max: 0.5 },
      texture: '_whiteCircle',
      tint: { min: 0xffff00, max: 0xffffff },
      alpha: { min: 0.5, max: 0.8 },
      despawnOnGroundContact: true,
    });
  }

  /**
   * Trigger punch animation
   * @returns {boolean} True if action started, false if busy or dead
   */
  punch(targetEntityIndex) {
    if (targetEntityIndex < 0) return false;
    if (PersonComponent.dead[this.index] === 1) return false;
    if (Person.isPerformingAction(this.index)) return false;
    PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.PUNCHING);

    // Face the target
    this.directionalSprite.facingFrom = 'manual';
    this.directionalSprite.lookAt(Transform.x[targetEntityIndex], Transform.y[targetEntityIndex]);

    // The target's class takes the damage (its recieveDamage is static, like this one's).
    const Target = GameObject.classByType[Transform.entityType[targetEntityIndex]];
    if (Target && typeof Target.recieveDamage === 'function') {
      Target.recieveDamage(targetEntityIndex, this.constructor.punchDamage, this.x, this.y);
    }

    return true;
  }

  /**
   * Trigger stick hit animation
   * @returns {boolean} True if action started, false if busy or dead
   */
  hitWithStick() {
    if (PersonComponent.dead[this.index] === 1) return false;
    if (Person.isPerformingAction(this.index)) return false;
    PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.STICK_HIT);
    return true;
  }

  /**
   * Whether the person at entity index i is performing a one-shot action
   * @param {number} i - entity index
   * @returns {boolean} True if busy with an action
   */
  static isPerformingAction(i) {
    const state = PersonAnimationFSM.state[i];
    const idleIndex = PersonAnimationFSM.states.IDLE.stateIndex;
    const walkingIndex = PersonAnimationFSM.states.WALKING.stateIndex;
    const runningIndex = PersonAnimationFSM.states.RUNNING.stateIndex;
    // Not performing action if in any locomotion state
    return state !== idleIndex && state !== walkingIndex && state !== runningIndex;
  }

  /**
   * Check if dead
   * @returns {boolean} True if in DEAD state
   */
  isDead() {
    if (PersonComponent.dead[this.index] === 1) return true;
    if (LootableComponent.health[this.index] <= 0) return true;
    return PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD);
  }

  /** Person i dies: it stops fighting, falls (the dying animation) and bleeds; its loot drops when the fall ends. */
  static die(i) {
    // Already dead? Don't trigger again
    if (PersonComponent.dead[i] === 1) return;
    RigidBody.linearDamping[i] = 0.9;
    // Mark as dead immediately - prevents firing and other actions
    PersonComponent.dead[i] = 1;

    const x = Transform.x[i];
    const y = Transform.y[i];
    const deathSounds = ['dolor1', 'dolor2', 'dolor3', 'dolor4'];
    const deathSound = deathSounds[(rng() * deathSounds.length) | 0];
    SoundManager.play(deathSound, 0.8, 0.9, 1.1, 0, 0, x, y, 'voice');

    // Emit blood particles
    ParticleEmitter.emit({
      count: Math.floor(10 + rng() * 5),
      texture: 'blood',
      x,
      y,
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

    // Start dying animation IMMEDIATELY - forceChangeState executes transition now
    // (changeState only queues for next tick, which can cause animation issues).
    PersonAnimationFSM.forceChangeState(i, PersonAnimationFSM.states.DYING);
  }

  /**
   * Called when the DYING animation finishes (FSM enters DEAD state)
   * Stamps corpse decal, spawns loot, and despawns entity
   */
  onDeathAnimationComplete() {
    // Get the spritesheet name this person uses (e.g., "civil1")
    const spritesheetId = this.spriteRenderer.spritesheetId;
    const spritesheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);

    // Stamp the last frame of the hurt animation as a dead body decal
    // Using the new helper params: (spritesheet, animation, frame)
    Decal.stamp({
      spritesheet: spritesheetName,
      animation: 'hurt',
      frame: -1, // Last frame = death pose
      x: this.x,
      y: this.y - 8,
      scaleX: this.spriteRenderer.scaleX,
      scaleY: this.spriteRenderer.scaleY,
      tint: this.spriteRenderer.baseTint,
      alpha: 1,
    });

    // Spawn loot drops
    Lootable.dropLoot(this.index);

    // Remove the entity
    this.despawn();
  }
}
