// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations

import WEED from '/src/index.js';

import { NavGrid } from '../../src/core/NavGrid.js';

import { Destination } from '../gameObjects/destination.js';
import { Lootable } from './lootable.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { PersonComponent, DIRECTION_DOWN, DIRECTION_NAMES } from '../components/personComponent.js';
import { PersonAnimationFSM } from '../fsm/PersonAnimationFSM.js';
import {
  ParticleEmitter,
  SpriteSheetRegistry,
  Ray,
  Flash,
  getDirectionFromAngle,
  GameObject,
} from '../../src/index.js';

const { RigidBody, Collider, SpriteRenderer, ShadowCaster, Transform, rng } = WEED;

export class Person extends Lootable {
  static scriptUrl = import.meta.url;
  static defaultFriction = 0.005;

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
    PISTOL: { damage: 0.66, cooldown: 200, range: 180, rangeSq: 180 ** 2 },
    MACHINE_GUN: { damage: 10, cooldown: 1, range: 500, rangeSq: 500 ** 2 },
  };

  setup() {
    // Physics properties
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.15;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = Person.defaultFriction;

    // Collision/perception
    this.collider.radius = 10;
    this.collider.visualRange = 150;

    // Sprite setup
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1.0;
    this.spriteRenderer.animationSpeed = 0.15;

    // Shadow
    this.shadowCaster.shadowRadius = 10;
    this.shadowCaster.height = 50;

    //people's defaults
    this.personComponent.minSquaredDistanceToGroup = 140 ** 2;
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
    this.shadowCaster.shadowRadius = this.collider.radius;
    this.shadowCaster.height = this.collider.radius * 5;

    this.lootableComponent.health = 1;
    this.lootableComponent.resistance = 0.5;
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

    // // Trigger hurt animation immediately (if not already dying)
    // if (!PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DYING) &&
    //     !PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD)) {
    //     PersonAnimationFSM.forceChangeState(this.index, PersonAnimationFSM.states.HURT, this);
    // }

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
      gravity: 0.15,
      scale: { min: 0.1, max: 0.2 },
      alpha: { min: 0.4, max: 0.9 },
      tint: { min: 0xaaaaaa, max: 0xffffff },
      stayOnTheFloor: true,
    });
  }

  tick(dtRatio) {
    const isDead = PersonComponent.dead[this.index] === 1;
    const animBefore = SpriteRenderer.animationState[this.index];

    // Skip Lootable.tick() if already dead (prevents re-triggering die())
    if (!isDead) {
      super.tick(dtRatio);
    }

    this.keepWithinBounds(dtRatio);

    const animAfterDie = SpriteRenderer.animationState[this.index];

    // Animation FSM handles all animation state
    this.personAnimationFSM.tick(dtRatio, this);

    const animAfterFSM = SpriteRenderer.animationState[this.index];

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
    const radius = this.collider.radius;
    const separationRadius = 3 * radius;
    const separationRadiusSq = separationRadius * separationRadius;
    const myIndex = this.index;

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
      if (!Ray.hasLineOfSight(myIndex, neighborIndex)) continue

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

      if (distSq < separationRadiusSq && distSq > 0) {
        const dist = Math.sqrt(distSq);
        const strength = (separationRadius - dist) / separationRadius;
        separateX += (dx / dist) * strength;
        separateY += (dy / dist) * strength;
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
    this.updateTeamData();
    if (PersonComponent.numberOfTeamMembersICanSee[this.index] == 0) return;

    const dist = PersonComponent.squaredDistanceToGroup[this.index];
    const minDist = PersonComponent.minSquaredDistanceToGroup[this.index];
    const groupingForce = PersonComponent.groupingForce[this.index];

    if (groupingForce == 0) return;
    if (dist < minDist) return;

    this.accelerateTowards(
      PersonComponent.myTeamAvgX[this.index],
      PersonComponent.myTeamAvgY[this.index],
      groupingForce
    );
  }

  separateFromTeam() {
    const separationForce = PersonComponent.separationForce[this.index];
    if (separationForce == 0) return;

    const separateX = PersonComponent.separateX[this.index];
    const separateY = PersonComponent.separateY[this.index];

    if (separateX !== 0 || separateY !== 0) {
      RigidBody.ax[this.index] += separateX * separationForce;
      RigidBody.ay[this.index] += separateY * separationForce;
    }
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
    if (this.isPerformingAction()) return false;

    const weapon = this.getBestWeapon();
    if (!weapon) return false;

    // Check cooldown
    if (!this.canFire(weapon)) return false;

    this.rigidBody.friction = 0.5;

    // Face the target
    const targetX = Transform.x[targetEntityIndex];
    const targetY = Transform.y[targetEntityIndex];
    const angle = Math.atan2(targetY - this.y, targetX - this.x);
    const direction = getDirectionFromAngle(angle);
    const dirIndex = DIRECTION_NAMES.indexOf(direction);
    if (dirIndex >= 0) {
      PersonComponent.facingDirection[this.index] = dirIndex;
    }

    // Record shot time
    PersonComponent.lastShotTime[this.index] = performance.now();

    // Trigger shoot animation
    this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.SHOOTING);

    // Muzzle flash
    const flashOffsetX = direction === 'right' ? 20 : direction === 'left' ? -20 : 0;
    const flashOffsetY = direction === 'down' ? 10 : -25;

    //Deal Damage
    const target = GameObject.get(targetEntityIndex);
    if (target && target.recieveDamage) {
      target.recieveDamage(weapon.damage);
    }

    setTimeout(() => {
      Flash.create({
        x: this.x + flashOffsetX,
        y: this.y + flashOffsetY,
        z: 0,
        lifespan: 18,
        color: 0xffaa00,
        intensity: 15000,
      });
      this.rigidBody.friction = Person.defaultFriction;
    }, 30)

    return true;
  }

  /**
   * Trigger punch animation
   * @returns {boolean} True if action started, false if busy or dead
   */
  punch() {
    if (PersonComponent.dead[this.index] === 1) return false;
    if (this.isPerformingAction()) return false;
    PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.PUNCHING);
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
      RigidBody.ax[i] += turnFactor * dtRatio;
    }
    if (x > worldWidth - margin) {
      RigidBody.ax[i] -= turnFactor * dtRatio;
    }
    if (y < margin) {
      RigidBody.ay[i] += turnFactor * dtRatio;
    }
    if (y > worldHeight - margin) {
      RigidBody.ay[i] -= turnFactor * dtRatio;
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
      z: -30,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0.7, max: 1.66 },
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
      y: this.y - 32,
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
