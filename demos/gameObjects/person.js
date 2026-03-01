// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations

import WEED from '/src/index.js';

import { NavGrid } from '../../src/core/NavGrid.js';

import { Destination } from '../gameObjects/destination.js';
import { Lootable } from './lootable.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { PersonComponent, DIRECTION_DOWN, DIRECTION_NAMES } from '../components/personComponent.js';
import { PersonAnimationFSM, WALK_SPEED_THRESHOLD } from '../fsm/PersonAnimationFSM.js';
import {
  ParticleEmitter,
  SpriteSheetRegistry,
  Ray,
  Flash,
  getDirectionFromAngle,
  GameObject,
  DecorationPool,
  BulletPool,
  randomColor,
} from '../../src/index.js';

const { RigidBody, Collider, SpriteRenderer, ShadowCaster, Transform, rng } = WEED;

const HALF_PI = Math.PI / 2;

export class Person extends Lootable {
  static scriptUrl = import.meta.url;
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
  static WEAPONS = {
    PISTOL: { damage: 0.66, cooldown: 200, range: 180, rangeSq: 180 ** 2, bulletSpeed: 900 },
    MACHINE_GUN: { damage: 0.2, cooldown: 100, range: 500, rangeSq: 500 ** 2, bulletSpeed: 1500, rapidFire: true },
  };

  setup() {
    // Physics properties
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.5;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = Person.defaultFriction;

    // Collision/perception
    this.collider.radius = 10;
    this.collider.visualRange = 150;

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
    this.setScale(scale, scale);

    this.collider.radius = 10 * scale;
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

    this.setScale(scale, scale);
  }

  recieveDamage(damage) {
    // console.log('recieveDamage', this.index, damage, this.lootableComponent.health);
    // Don't process damage if already dead
    if (PersonComponent.dead[this.index] === 1) return;

    super.recieveDamage(damage);

    if (damage < 0.1) return;

    ParticleEmitter.emit({
      count: Math.floor(damage * (Math.random() * 5 + 3)),
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

    // When shooting: no movement (zero velocity, skip acceleration)
    if (isShooting) {
      this.setVelocity(0, 0);
    } else {
      this.keepWithinBounds(dtRatio);
      if (RigidBody.speed[this.index] < 0.166) {
        this.setVelocity(0, 0);
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

    this.setVelocity(0, 0);

    // Face the target
    const targetX = Transform.x[targetEntityIndex];
    const targetY = Transform.y[targetEntityIndex];

    const angle = Math.atan2(targetY - this.y, targetX - this.x) + HALF_PI;

    // Calculate distance from shooter to target
    const dx = targetX - this.x;
    const dy = targetY - this.y;
    // const distance = Math.sqrt(dx * dx + dy * dy);

    // Spawn white line decoration from shooter to target
    // _white texture is 8x8, so:
    // - scaleX = distance / 8 (stretch horizontally to distance)
    // - scaleY = 2 / 8 = 0.25 (make it 2px high)
    // - rotation = angle to target (without HALF_PI offset for horizontal line)
    // - anchorX = 0 (line starts at shooter position)
    // - anchorY = 0.5 (center vertically)
    const lineAngle = Math.atan2(dy, dx); // Angle for horizontal line (no HALF_PI offset)

    // this.rigidBody.friction = 0.5;
    const direction = getDirectionFromAngle(angle);

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

    // Muzzle position from shooter center using target angle.
    const muzzleDistancePx = this.constructor.muzzleDistancePx;
    const muzzleHeightPx = this.constructor.muzzleHeightPx;
    const muzzleX = this.x + Math.cos(lineAngle) * muzzleDistancePx;
    const muzzleY = this.y + Math.sin(lineAngle) * muzzleDistancePx;

    // Spawn bullet (raycast hit handled by engine; target.onGotShot called on impact)
    const speed = weapon.bulletSpeed ?? 800;
    const vx = Math.cos(lineAngle) * speed;
    const vy = Math.sin(lineAngle) * speed;
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
      scale: 2,
      rotation: lineAngle,
      anchorX: 1,
      anchorY: 0.5,
    });

    //little fire: muzzle effect
    // Sprite renders at gun height (y + offsetY), but sorts at ground level (y)
    // Bullet tracer particle (travels from shooter to victim in 3 frames)

    const angleDeg = (lineAngle * 180) / Math.PI;

    ParticleEmitter.emit({
      count: 2,
      x: muzzleX,
      y: muzzleY + 1, // Base Y position for sorting (ground level)
      texture: "muzzle" + Math.floor(Math.random() * 3 + 1),
      scaleX: 1,
      scaleY: 1,
      rotation: { min: angleDeg * 0.9, max: angleDeg * 1.1 },
      alpha: 0.9,
      anchorX: 0, // Start at shooter position
      anchorY: 0.5, // Center vertically
      z: muzzleHeightPx,
      gravity: 0,
      lifespan: 50,
      speed: 0
    })

    //create flash!
    Flash.create({
      x: muzzleX,
      y: muzzleY,
      z: -muzzleHeightPx,
      lifespan: 18,
      color: 0xffaa00,
      intensity: 10000,
      hasGlowSprite: 0,
    });

    this.shootingSparks(lineAngle, muzzleX, muzzleY, muzzleHeightPx)

    // }, howMuchTimeToWaitUntilFire)

    return true;
  }

  shootingSparks(shootAngle, muzzleX, muzzleY, muzzleHeightPx) {
    // Convert angle from radians to degrees for ParticleEmitter (which uses degrees)
    const angleDeg = (shootAngle * 180) / Math.PI;
    // Shotgun spread: 35 degree cone
    const spreadDeg = 10;

    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 10) + 10,
      x: muzzleX,
      y: muzzleY + 1,
      z: muzzleHeightPx,
      angleXY: { min: angleDeg - spreadDeg / 2, max: angleDeg + spreadDeg / 2 },
      speed: { min: 0.1, max: 10 },
      rotation: { min: 0, max: 360 },
      vz: { min: -1, max: 5 }, // Some sparks fly up, others fall
      gravity: 0.4,
      lifespan: { min: 33, max: 100 },
      scale: { min: 0.5, max: 0.1 },
      texture: 'square',
      tint: randomColor({ min: 0xffff00, max: 0xffffff }),
      alpha: { min: 0.5, max: 0.8 },
      despawnOnGroundContact: true, // Despawn immediately when particles touch the ground
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
    const angle = Math.atan2(targetY - this.y, targetX - this.x) + HALF_PI;
    const direction = getDirectionFromAngle(angle);
    const dirIndex = DIRECTION_NAMES.indexOf(direction);
    if (dirIndex >= 0) {
      PersonComponent.facingDirection[this.index] = dirIndex;
    }

    const target = GameObject.get(targetEntityIndex);
    if (target && target.recieveDamage) {
      const damage = this.constructor.punchDamage;
      target.recieveDamage(damage);
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
    const turnFactor = 0.1;
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
    this.rigidBody.friction = 0.9;
    // Mark as dead immediately - prevents firing and other actions
    PersonComponent.dead[this.index] = 1;

    // Emit blood particles
    ParticleEmitter.emit({
      count: Math.floor(10 + Math.random() * 5),
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
