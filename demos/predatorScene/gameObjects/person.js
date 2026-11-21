// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations
//
// Written ECS-style (E-530): every method is a static that takes the person's entity index first and runs with the
// person's class as `this` (MySoldier, Civilian), so a subclass's tuning statics (punchDamage, muzzleDistancePx) apply.
// The state lives in the components' columns (Transform.x[i], LootableComponent.health[i]); no instance is made for
// anything a person does, from its spawn to its corpse.

import WEED from '/src/index.js';

import { Lootable } from './lootable.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { PersonComponent } from '../components/personComponent.js';
import { PersonAnimationFSM } from '../fsm/personAnimationFsm.js';
import { LIGHT3D } from '../light3d.js';
import { DEATH_BLOOD, MUZZLE_FLASH, MUZZLE_SPRITE, SHOT_SPARKS, WOUND_BLOOD } from '../effectPresets.js';
import {
  ParticleEmitter,
  SpriteSheetRegistry,
  Flash,
  SoundManager,
  GameObject,
  Decal,
  BulletPool,
} from '/src/index.js';

const { ShadowCaster, RigidBody, Collider, DirectionalSprite, SpriteRenderer, Transform, rng } = WEED;

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

  /** A random pale tint, 0xRRGGBB (each channel 80-100 %), so a crowd drawn from one spritesheet is not all alike. */
  static getRandomTint() {
    const r = 0.8 + rng() * 0.2;
    const g = 0.8 + rng() * 0.2;
    const b = 0.8 + rng() * 0.2;

    return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
  }

  /**
   * LIFECYCLE: each spawn of person i from the pool. Indices are reused, so everything a past life left is reset here.
   * The subclasses set the spritesheet first, then call this.
   */
  static onSpawned(i, spawnConfig = {}) {
    // Collision/perception — size before damping so Box2D never sees Circle r=0
    Collider.setRadius(i, 10);
    Collider.visualRange[i] = 150;
    RigidBody.setLinearDamping(i, Person.defaultFriction);

    // Sprite setup: drawn from its feet, so it stands where its body is
    SpriteRenderer.setAnchor(i, 0.5, 0.98);
    SpriteRenderer.setAnimationSpeed(i, 0.15);
    // The shadow: the sprite's silhouette, its card 1.5 times as long. With ?light3d=1 the camera gives its height, and the
    // silhouette is the ShadowCaster's default (each light sees its own view of the person).
    if (!LIGHT3D) ShadowCaster.setSprite(i, { heightScale: 1.5 });

    SpriteRenderer.setTint(i, this.getRandomTint());

    // Random scale; the body grows with the sprite
    const scale = 0.9 + rng() * 0.2;
    Collider.setRadius(i, 10 * scale);
    SpriteRenderer.setScale(i, scale, scale);

    LootableComponent.health[i] = 1;
    // A plain person carries no money (its subclasses give theirs); its resistance is the class's static
    LootableComponent.dropMoney[i] = 0;

    // Facing south. The walk follows the velocity (PersonAnimationFSM), with no margin at the borders.
    DirectionalSprite.setTurnMargin(i, 0);
    DirectionalSprite.setFacing(i, Math.PI / 2);

    // Alive again: a reused index may still hold a corpse's flag
    PersonComponent.dead[i] = 0;

    // Reset shot cooldown (so recycled entities can fire immediately)
    PersonComponent.lastShotTime[i] = 0;

    // Aiming accuracy: 0 = max spread, 1 = perfect aim (default 0.8)
    PersonComponent.aimingAccuracy[i] = spawnConfig.aimingAccuracy ?? 0.8;
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

    // Blood from 30 px up, as many drops as the damage.
    ParticleEmitter.emitPreset(WOUND_BLOOD, Transform.x[i], Transform.y[i], -30, Math.floor(damage * (rng() * 10 + 4)));
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
   * Whether person i's weapon is ready to fire again (its cooldown since the last shot has passed).
   * Uses performance.now() for frame-rate independent timing
   * @param {number} i - entity index
   * @param {Object} weapon - Weapon definition from Person.WEAPONS
   * @returns {boolean} True if can fire
   */
  static canFire(i, weapon) {
    const lastShot = PersonComponent.lastShotTime[i];
    return performance.now() - lastShot >= weapon.cooldown;
  }

  // ==========================================
  // ACTION TRIGGERS - Call these to trigger animations
  // ==========================================

  /**
   * Person i shoots at a target: it faces it (leading a moving one), plays the shoot animation and fires a bullet from
   * its muzzle, with the sound, the flash and the sparks. Call it on the person's class (`this` gives the muzzle's
   * place), as the soldiers' FSM does.
   * @param {number} i - entity index of the shooter
   * @param {number} targetEntityIndex - Entity index to shoot at
   * @returns {boolean} True if shot fired, false if on cooldown/busy/dead/no weapon
   */
  static shoot(i, targetEntityIndex) {
    if (PersonComponent.dead[i] === 1) return false;

    const weapon = Person.bestWeapon(i);
    if (!weapon) return false;

    // Block if performing action (unless rapid-fire weapon + already in shooting animation)
    if (Person.isPerformingAction(i)) {
      const rapidFireInShooting = weapon.rapidFire && PersonAnimationFSM.isInState(i, PersonAnimationFSM.states.SHOOTING);
      if (!rapidFireInShooting) return false;
    }

    // Check cooldown
    if (!this.canFire(i, weapon)) return false;

    // Aim where the target will be: lead ~10 frames at 60Hz → 1/6 s
    const targetX = Transform.x[targetEntityIndex] + RigidBody.vx[targetEntityIndex] * (10 / 60);
    const targetY = Transform.y[targetEntityIndex] + RigidBody.vy[targetEntityIndex] * (10 / 60);

    const shooterX = Transform.x[i];
    const shooterY = Transform.y[i];
    const dx = targetX - shooterX;
    const dy = targetY - shooterY;
    const lenSq = dx * dx + dy * dy;
    let dirX = 1;
    let dirY = 0;
    if (lenSq > 1e-12) {
      const inv = 1 / Math.sqrt(lenSq);
      dirX = dx * inv;
      dirY = dy * inv;
    }

    // Face the target (the shooting state keeps the facing; the walk takes it from the velocity again).
    DirectionalSprite.setFacingFrom(i, 'manual');
    if (lenSq > 1e-12) DirectionalSprite.setFacing(i, Math.atan2(dy, dx));

    // Record shot time
    PersonComponent.lastShotTime[i] = performance.now();

    // Trigger shoot animation (skip if rapid-fire and already shooting - avoids resetting animation)
    const alreadyShooting = PersonAnimationFSM.isInState(i, PersonAnimationFSM.states.SHOOTING);
    if (!(weapon.rapidFire && alreadyShooting)) {
      PersonAnimationFSM.forceChangeState(i, PersonAnimationFSM.states.SHOOTING);
    }

    // Muzzle position from shooter center along aim unit vector (the class's statics: a subclass may hold its gun elsewhere).
    const muzzleDistancePx = this.muzzleDistancePx;
    const muzzleHeightPx = this.muzzleHeightPx;
    const muzzleX = shooterX + dirX * muzzleDistancePx;
    const muzzleY = shooterY + dirY * muzzleDistancePx;

    // Spawn bullet (raycast hit handled by engine; the target's onGotShot is called on impact)
    const speed = weapon.bulletSpeed ?? 800;
    // Apply aiming spread: accuracy 1 = no spread, 0 = max spread (~12°)
    const accuracy = PersonComponent.aimingAccuracy[i];
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
      ownerId: i,
      shooterEntityType: Transform.entityType[i],
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

    // Two muzzle sprites facing the shot (its direction turns them: no degree→trig round-trip), and the muzzle's flash.
    ParticleEmitter.emitPreset(MUZZLE_SPRITE, muzzleX, muzzleY + 1, muzzleHeightPx, 1, shotDirX, shotDirY);
    ParticleEmitter.emitPreset(MUZZLE_SPRITE, muzzleX, muzzleY + 1, muzzleHeightPx, 1, shotDirX, shotDirY);
    Flash.spawnPreset(MUZZLE_FLASH, muzzleX, muzzleY, -muzzleHeightPx);

    this.shootingSparks(shotDirX, shotDirY, muzzleX, muzzleY, muzzleHeightPx);

    return true;
  }

  /**
   * The sparks of a shot, thrown from the muzzle along the shot. They belong to a point of the world, not to the
   * shooter, so they take no entity index.
   */
  static shootingSparks(dirX, dirY, muzzleX, muzzleY, muzzleHeightPx) {
    // 10 to 19 of them, along the unit direction (the preset's spread turns each): no atan2→deg→angleXY round-trip.
    ParticleEmitter.emitPreset(SHOT_SPARKS, muzzleX, muzzleY + 1, muzzleHeightPx, Math.floor(rng() * 10) + 10, dirX, dirY);
  }

  /**
   * Person i punches a target: the punch animation, facing it, and the target's class takes the damage (this class's
   * punchDamage, from where person i stands).
   * @param {number} i - entity index of the puncher
   * @param {number} targetEntityIndex - entity index of the one punched
   * @returns {boolean} True if action started, false if busy or dead
   */
  static punch(i, targetEntityIndex) {
    if (targetEntityIndex < 0) return false;
    if (PersonComponent.dead[i] === 1) return false;
    if (Person.isPerformingAction(i)) return false;
    PersonAnimationFSM.changeState(i, PersonAnimationFSM.states.PUNCHING);

    // Face the target
    DirectionalSprite.setFacingFrom(i, 'manual');
    DirectionalSprite.lookAt(i, Transform.x[targetEntityIndex], Transform.y[targetEntityIndex]);

    // The target's class takes the damage (its recieveDamage is static, like this one's).
    const Target = GameObject.classByType[Transform.entityType[targetEntityIndex]];
    if (Target && typeof Target.recieveDamage === 'function') {
      Target.recieveDamage(targetEntityIndex, this.punchDamage, Transform.x[i], Transform.y[i]);
    }

    return true;
  }

  /**
   * Person i swings a stick (the stick hit animation).
   * @param {number} i - entity index
   * @returns {boolean} True if action started, false if busy or dead
   */
  static hitWithStick(i) {
    if (PersonComponent.dead[i] === 1) return false;
    if (Person.isPerformingAction(i)) return false;
    PersonAnimationFSM.changeState(i, PersonAnimationFSM.states.STICK_HIT);
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
   * Whether person i is dead: marked so, out of health, or lying in the DEAD state.
   * @param {number} i - entity index
   * @returns {boolean}
   */
  static isDead(i) {
    if (PersonComponent.dead[i] === 1) return true;
    if (LootableComponent.health[i] <= 0) return true;
    return PersonAnimationFSM.isInState(i, PersonAnimationFSM.states.DEAD);
  }

  /** Person i dies: it stops fighting, falls (the dying animation) and bleeds; its loot drops when the fall ends. */
  static die(i) {
    // Already dead? Don't trigger again
    if (PersonComponent.dead[i] === 1) return;
    // The body slides to a stop as it falls (the setter tells Box2D; a raw column write would not reach it)
    RigidBody.setLinearDamping(i, 0.9);
    // Mark as dead immediately - prevents firing and other actions
    PersonComponent.dead[i] = 1;

    const x = Transform.x[i];
    const y = Transform.y[i];
    const deathSounds = ['dolor1', 'dolor2', 'dolor3', 'dolor4'];
    const deathSound = deathSounds[(rng() * deathSounds.length) | 0];
    SoundManager.play(deathSound, 0.8, 0.9, 1.1, 0, 0, x, y, 'voice');

    // 10 to 14 drops of blood, from 10 px up
    ParticleEmitter.emitPreset(DEATH_BLOOD, x, y, -10, Math.floor(10 + rng() * 5));

    // Start dying animation IMMEDIATELY - forceChangeState executes transition now
    // (changeState only queues for next tick, which can cause animation issues).
    PersonAnimationFSM.forceChangeState(i, PersonAnimationFSM.states.DYING);
  }

  /**
   * Person i's fall ended (PersonAnimationFSM's DEAD state calls this on the person's class): its body stays on the
   * floor as a decal, its loot drops, and the entity goes back to the pool.
   * @param {number} i - entity index
   */
  static onDeathAnimationComplete(i) {
    // The spritesheet this person uses (e.g., "civil1"), by name: the decal draws from it
    const spritesheetName = SpriteSheetRegistry.getSpritesheetName(SpriteRenderer.spritesheetId[i]);

    // Stamp the last frame of the hurt animation as a dead body decal: (spritesheet, animation, frame)
    Decal.stamp({
      spritesheet: spritesheetName,
      animation: 'hurt',
      frame: -1, // Last frame = death pose
      x: Transform.x[i],
      y: Transform.y[i] - 8,
      scaleX: SpriteRenderer.scaleX[i],
      scaleY: SpriteRenderer.scaleY[i],
      tint: SpriteRenderer.baseTint[i],
      alpha: 1,
    });

    // Spawn loot drops
    Lootable.dropLoot(i);

    // Remove the entity (`this` is its class)
    this.despawn(i);
  }
}
