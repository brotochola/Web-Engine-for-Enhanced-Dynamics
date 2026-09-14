// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations

import WEED from '/src/index.js';

import { NavGrid } from '/src/core/navGrid.js';

import { Destination } from './destination.js';
import { Lootable } from './lootable.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { PersonComponent, DIRECTION_DOWN, DIRECTION_NAMES } from '../components/personComponent.js';
import { PersonAnimationFSM, WALK_SPEED_THRESHOLD } from '../fsm/personAnimationFsm.js';
import {
  ParticleEmitter,
  SpriteSheetRegistry,
  Ray,
  Flash,
  SoundManager,
  getDirectionFromVector,
  GameObject,
  DecorationPool,
  BulletPool,
  randomColor,
} from '/src/index.js';

const { RigidBody, Collider, SpriteRenderer, ShadowCaster, Transform, rng } = WEED;

export class Person extends Lootable {
  static scriptUrl = import.meta.url;
  static deriveSpeed = true;
  static defaultFriction = 0.005;

  static punchRangeSq = 30 ** 2; // Distance to start punching
  static punchDamage = 0.3; // Damage per punch
  static muzzleDistancePx = 30; // Distance from actor center to muzzle in world px
  static muzzleHeightPx = -30; // Visual muzzle height (negative = above ground)

  // Flocking behavior (static - same for all Person instances)
  static minSquaredDistanceToGroup = 140 ** 2;
  static groupingForce = 0; // Default: no grouping (subclasses override)
  static separationForce = 0; // Default: no separation (subclasses override)
  static separationRadius = 30;
  static separationRadiusSq = this.separationRadius * this.separationRadius;
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
    SpriteRenderer,
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

  setup() {
    // Collision/perception — size before damping so Box2D never sees Circle r=0
    this.collider.radius = 10;
    this.collider.visualRange = 150;
    this.rigidBody.linearDamping = Person.defaultFriction;

    // Sprite setup
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.98;
    this.spriteRenderer.animationSpeed = 0.15;
    this.shadowCaster.heightMultiplier = 1.5

    // Shadow uses default heightMultiplier = 1 (matches sprite scale)

    // Flocking and resistance now use static class properties (no per-entity arrays needed)
  }

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
    // this.setSpritesheet("poli");
    // this.setAnimation("idle_down");

    this.setTint(this.getRandomTint());

    // Random scale
    const scale = 0.9 + rng() * 0.2;
    this.collider.radius = 10 * scale;
    this.setScale(scale, scale);
    // Shadow uses default heightMultiplier = 1 (matches sprite scale)

    this.lootableComponent.health = 1;
    // resistance now uses static class property (Person.resistance)
    this.lootableComponent.dropMoney = 0//100;

    // Initialize facing direction (default: down)
    PersonComponent.facingDirection[this.index] = DIRECTION_DOWN;

    // Reset dead flag (entity indices are reused)
    PersonComponent.dead[this.index] = 0;

    // Reset shot cooldown (so recycled entities can fire immediately)
    PersonComponent.lastShotTime[this.index] = 0;

    // Aiming accuracy: 0 = max spread, 1 = perfect aim (default 0.8)
    PersonComponent.aimingAccuracy[this.index] = spawnConfig.aimingAccuracy ?? 0.8;

    // Reset team-throttle timestamp (entity indices are reused)
    PersonComponent.lastTeamDataUpdateTime[this.index] = 0;

    this.setScale(scale, scale);
  }

  recieveDamage(damage, sourceX, sourceY) {
    // Don't process damage if already dead
    if (PersonComponent.dead[this.index] === 1) return;

    super.recieveDamage(damage, sourceX, sourceY);

    // Trigger death immediately on lethal damage (don't wait for next tick)
    if (LootableComponent.health[this.index] <= 0) {
      this.die();
      return;
    }

    if (damage < 0.1) return;

    ParticleEmitter.emit({
      count: Math.floor(damage * (rng() * 10 + 4)),
      texture: 'blood',
      x: this.x,
      y: this.y,
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

  tick(dtRatio) {
    const isDead = PersonComponent.dead[this.index] === 1;
    const isShooting = PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.SHOOTING);

    if (!isDead) {
      super.tick(dtRatio);
    }

    // When shooting: don't run (no acceleration from behavior) but allow being pushed.
    // We skip keepWithinBounds and low-speed zero so external pushes (knockback, collisions) work.
    if (!isShooting) {
      this.keepWithinBounds(dtRatio);
      if (RigidBody.speed[this.index] < 0.166) {
        const i = this.index;
        if (RigidBody.vx[i] !== 0 || RigidBody.vy[i] !== 0) {
          this.setVelocity(0, 0);
        }
      }
    }

    // const animAfterDie = SpriteRenderer.animationState[this.index];

    // Animation FSM handles all animation state
    if (this.spriteRenderer?.spritesheetId) this.personAnimationFSM.tick(dtRatio, this);

    // const animAfterFSM = SpriteRenderer.animationState[this.index];

    // Debug: track animation state changes for dying entities
    // if (isDead && animBefore !== animAfterFSM) {
    //     console.log(`[Person ${this.index}] DYING - Anim changed! Before:${animBefore} AfterDie:${animAfterDie} AfterFSM:${animAfterFSM}`);
    // }

    // Check if dying animation finished (FSM transitioned to DEAD)
    // if (PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD)) {
    // this.onDeathAnimationComplete();
    // }
  }

  updateTeamData() {
    const neighborCount = this.neighborCount;
    const myX = this.x;
    const myY = this.y;

    const separationRadiusSq = this.constructor.separationRadiusSq;

    let myTeamAvgX = 0;
    let myTeamAvgY = 0;
    let myTeamMemberCount = 0;
    let separateX = 0;
    let separateY = 0;

    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      // Skip if not same entity type
      if (Transform.entityType[neighborIndex] !== this.entityType) continue;
      // Skip if no line of sight to neighbor
      // if (!Ray.hasLineOfSight(myIndex, neighborIndex)) continue

      const nx = Transform.x[neighborIndex];
      const ny = Transform.y[neighborIndex];

      // Cohesion: accumulate for average

      myTeamAvgX += nx;
      myTeamAvgY += ny;
      myTeamMemberCount++;

      // Separation: check if too close
      const dx = myX - nx;
      const dy = myY - ny;
      const distSq = dx * dx + dy * dy;

      // Guard: distSq must be > 1 to avoid division producing huge/Infinity values
      // (entities at same position would have distSq ≈ 0, causing Infinity)
      if (distSq < separationRadiusSq && distSq > 1) {
        const strength = (separationRadiusSq - distSq) / separationRadiusSq;
        separateX += (dx / distSq) * strength;
        separateY += (dy / distSq) * strength;
      }
    }

    const i = this.index;
    PersonComponent.separateX[i] = separateX;
    PersonComponent.separateY[i] = separateY;

    if (myTeamMemberCount > 0) {
      myTeamAvgX /= myTeamMemberCount;
      myTeamAvgY /= myTeamMemberCount;
      PersonComponent.myTeamAvgX[i] = myTeamAvgX;
      PersonComponent.myTeamAvgY[i] = myTeamAvgY;
      PersonComponent.numberOfTeamMembersICanSee[i] = myTeamMemberCount;
      PersonComponent.squaredDistanceToGroup[i] = (myTeamAvgX - myX) ** 2 + (myTeamAvgY - myY) ** 2;
    } else {
      PersonComponent.myTeamAvgX[i] = -1;
      PersonComponent.myTeamAvgY[i] = -1;
      PersonComponent.numberOfTeamMembersICanSee[i] = 0;
      PersonComponent.squaredDistanceToGroup[i] = -1;
    }
  }

  groupWithMyTeam() {

    if (PersonComponent.numberOfTeamMembersICanSee[this.index] == 0) return;

    const dist = PersonComponent.squaredDistanceToGroup[this.index];
    const minDist = this.constructor.minSquaredDistanceToGroup;
    const groupingForce = this.constructor.groupingForce;

    if (groupingForce == 0) return;
    if (dist < minDist) return;

    this.accelerateTowards(
      PersonComponent.myTeamAvgX[this.index],
      PersonComponent.myTeamAvgY[this.index],
      groupingForce
    );
  }

  separateFromTeam() {
    const separationForce = this.constructor.separationForce;
    if (separationForce == 0) return;

    const separateX = PersonComponent.separateX[this.index];
    const separateY = PersonComponent.separateY[this.index];

    if (separateX == 0 && separateY == 0) return

    this.addAcceleration(
      separateX * separationForce,
      separateY * separationForce
    );

  }

  // ==========================================
  // WEAPON HELPERS - Check inventory and get best weapon
  // ==========================================

  /**
   * Check if this person has any ranged weapon
   * @returns {boolean} True if has pistol or machine gun
   */
  hasGun() {
    const i = this.index;
    return LootableComponent.dropPistol[i] > 0 || LootableComponent.dropMachineGun[i] > 0;
  }

  /**
   * Get the best weapon this person has (machine gun > pistol > null)
   * @returns {Object|null} Weapon definition from Person.WEAPONS or null if unarmed
   */
  getBestWeapon() {
    const i = this.index;
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

    const weapon = this.getBestWeapon();
    if (!weapon) return false;

    // Block if performing action (unless rapid-fire weapon + already in shooting animation)
    if (this.isPerformingAction()) {
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

    const direction = getDirectionFromVector(dx, dy);
    const dirIndex = DIRECTION_NAMES.indexOf(direction);
    if (dirIndex >= 0) {
      PersonComponent.facingDirection[this.index] = dirIndex;
    }

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
        muzzleY
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

    Flash.create({
      x: muzzleX,
      y: muzzleY,
      z: -muzzleHeightPx,
      lifespan: 18,
      color: 0xffaa00,
      intensity: 10000,
      hasGlowSprite: 0,
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
    if (this.isPerformingAction()) return false;
    PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.PUNCHING);

    // Face the target
    const targetX = Transform.x[targetEntityIndex];
    const targetY = Transform.y[targetEntityIndex];
    const direction = getDirectionFromVector(targetX - this.x, targetY - this.y);
    const dirIndex = DIRECTION_NAMES.indexOf(direction);
    if (dirIndex >= 0) {
      PersonComponent.facingDirection[this.index] = dirIndex;
    }

    const target = GameObject.get(targetEntityIndex);
    if (target && target.recieveDamage) {
      const damage = this.constructor.punchDamage;
      target.recieveDamage(damage, this.x, this.y);
    }

    return true;
  }

  /**
   * Trigger stick hit animation
   * @returns {boolean} True if action started, false if busy or dead
   */
  hitWithStick() {
    if (PersonComponent.dead[this.index] === 1) return false;
    if (this.isPerformingAction()) return false;
    PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.STICK_HIT);
    return true;
  }

  /**
   * Check if currently performing a one-shot action
   * @returns {boolean} True if busy with an action
   */
  isPerformingAction() {
    const state = PersonAnimationFSM.state[this.index];
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

  /**
   * Keep entity within world boundaries
   */
  keepWithinBounds(dtRatio) {
    const margin = 50;
    const turnFactor = 360; // px/s²
    const i = this.index;

    const x = Transform.x[i];
    const y = Transform.y[i];
    const worldWidth = this.config.worldWidth || 1000;
    const worldHeight = this.config.worldHeight || 1000;

    if (x < margin) {
      this.addAcceleration(turnFactor * dtRatio, 0);
    }
    if (x > worldWidth - margin) {
      this.addAcceleration(-turnFactor * dtRatio, 0);
    }
    if (y < margin) {
      this.addAcceleration(0, turnFactor * dtRatio);
    }
    if (y > worldHeight - margin) {
      this.addAcceleration(0, -turnFactor * dtRatio);
    }
  }

  die() {
    // Already dead? Don't trigger again
    if (PersonComponent.dead[this.index] === 1) return;
    this.rigidBody.linearDamping = 0.9;
    // Mark as dead immediately - prevents firing and other actions
    PersonComponent.dead[this.index] = 1;

    const deathSounds = ['dolor1', 'dolor2', 'dolor3', 'dolor4'];
    const deathSound = deathSounds[(rng() * deathSounds.length) | 0];
    SoundManager.play(deathSound, 0.8, 0.9, 1.1, 0, 0, this.x, this.y);

    // Emit blood particles
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

    // Start dying animation IMMEDIATELY - forceChangeState executes transition now
    // (changeState only queues for next tick, which can cause animation issues)
    // console.log(`[Person ${this.index}] die() called, forcing DYING state. AnimState BEFORE:`, SpriteRenderer.animationState[this.index]);
    this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.DYING);
    // console.log(`[Person ${this.index}] After forceChangeState, FSM state:`, PersonAnimationFSM.getStateName(this.index), `AnimState AFTER:`, SpriteRenderer.animationState[this.index]);
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
    ParticleEmitter.stampDecal({
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

    // Spawn loot drops (from Lootable.die())
    super.die();

    // Remove the entity
    this.despawn();
  }
}
