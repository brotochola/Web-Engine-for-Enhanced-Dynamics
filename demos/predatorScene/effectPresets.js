// Predator's particle and flash presets (E-538). Each effect a game object fires again and again is defined once, when
// this module loads (in every thread that imports it: each logic worker has its own), and fired with
// ParticleEmitter.emitPreset / Flash.spawnPreset and what varies per shot. A preset emit makes no garbage: no config
// object, no {min, max} objects, no texture name built per shot. The values are the ones the game objects wrote in
// every emit's config before; what a call site still draws itself (a count, a height, a burst's vz or flip, a fire's
// fade) it passes per emit, in the order it drew them before, so the game draws what it drew.
import { BulletPool, Flash, ParticleEmitter } from '/src/index.js';

const ALL_AROUND = { min: 0, max: 360 };
const ANY_TURN = { min: 0, max: 360 };

// ---------------------------------------------------------------------------------------------------------------------
// People (person.js)
// ---------------------------------------------------------------------------------------------------------------------

/** A muzzle sprite, one of three, facing the shot (the shot's direction per emit), for 50 ms. Two per shot. */
export const MUZZLE_SPRITE = ParticleEmitter.define({
  count: 1,
  texture: ['muzzle1', 'muzzle2', 'muzzle3'],
  scaleX: { min: 0.5, max: 1 },
  scaleY: { min: 0.5, max: 1 },
  alpha: { min: 0.5, max: 1 },
  faceDirection: true,
  gravity: 0,
  lifespan: 50,
});

// The weapons' bullets (E-541), one preset a weapon (Person.WEAPONS names its own): the bullet sprite, its tip at the
// muzzle (anchorX 1), a trail 4 px wide, and the weapon's damage. The shot passes its place, the muzzle's height, its
// velocity and its shooter.
const BULLET_LOOK = { texture: 'bullet', scale: 1, anchorX: 1, anchorY: 0.5, trailWidth: 4 };
export const PISTOL_BULLET = BulletPool.define({ ...BULLET_LOOK, damage: 0.66 });
export const MACHINE_GUN_BULLET = BulletPool.define({ ...BULLET_LOOK, damage: 0.2 });

/** The muzzle's flash: orange, 18 ms, no halo; 30 px up, the gun's height (person.js muzzleHeightPx), for its shadows. */
export const MUZZLE_FLASH = Flash.define({ lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0, elevation: 30 });

/** A shot's sparks, thrown along it (its direction per emit) within 10 degrees either side; gone when they land. */
export const SHOT_SPARKS = ParticleEmitter.define({
  spread: (10 * Math.PI) / 180,
  speed: { min: 0.1, max: 10 },
  rotation: ANY_TURN,
  vz: { min: -1, max: 5 },
  gravity: 0.4,
  lifespan: { min: 33, max: 100 },
  scale: { min: 0.15, max: 0.5 },
  texture: '_whiteCircle',
  tint: { min: 0xffff00, max: 0xffffff },
  alpha: { min: 0.5, max: 0.8 },
  despawnOnGroundContact: true,
});

/** A wound's blood (as many drops as the damage, per emit), left on the floor. */
export const WOUND_BLOOD = ParticleEmitter.define({
  texture: 'blood',
  angleXY: ALL_AROUND,
  speed: { min: 0.7, max: 1.66 },
  vz: { min: -4, max: 0 },
  lifespan: 2000,
  gravity: 0.22,
  scale: { min: 0.12, max: 0.3 },
  alpha: { min: 0.66, max: 0.95 },
  tint: { min: 0xaaaaaa, max: 0xffffff },
  stayOnTheFloor: true,
});

/** The blood of a death, left on the floor. */
export const DEATH_BLOOD = ParticleEmitter.define({
  texture: 'blood',
  angleXY: ALL_AROUND,
  speed: { min: 0.7, max: 2 },
  vz: { min: -4, max: 0 },
  lifespan: 2000,
  gravity: 0.15,
  scale: { min: 0.1, max: 0.2 },
  alpha: { min: 0.4, max: 0.9 },
  tint: { min: 0xaaaaaa, max: 0xffffff },
  stayOnTheFloor: true,
});

/** The player's muzzle flash (player.js), 35 px up as it is drawn. */
export const PLAYER_MUZZLE_FLASH = Flash.define({ lifespan: 17, color: 0xffbb11, radius: 1581, glow: 0.5, elevation: 35 });

// ---------------------------------------------------------------------------------------------------------------------
// Fire and explosions (fire.js, explosion.js)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A fire's square sparks, floating up: a burst's vz per emit (withVz), its scale and alpha fading with the fire
 * (withScaleFactor and withAlphaFactor of its fade).
 */
export const FIRE_SPARKS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 0, max: 1 },
  gravity: -0.1,
  lifespan: { min: 200, max: 500 },
  scale: 0.25,
  texture: 'square',
  tint: { min: 0xffff00, max: 0xffbb00 },
  alpha: { min: 0.8, max: 1 },
});

/**
 * A smoke puff, a fire's or an explosion's: a burst's vz and flip per emit (withVz, withFlip); a fire's smoke is
 * scaled by its size and fade, and fades with it (withScaleFactor, withAlphaFactor).
 */
export const SMOKE = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 0, max: 1 },
  gravity: 0,
  rotation: ANY_TURN,
  lifespan: { min: 500, max: 2000 },
  scale: { min: 1, max: 3 },
  texture: 'smoke',
  tint: { min: 0xaaaaaa, max: 0x666666 },
  alpha: { from: { min: 0.15, max: 0.3 }, to: 0 },
});

/** An explosion's square sparks, fast (a burst's vz per emit). */
export const EXPLOSION_SPARKS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 10, max: 20 },
  rotation: ANY_TURN,
  gravity: 0.6,
  lifespan: { min: 100, max: 300 },
  scale: { min: 0.25, max: 0.5 },
  texture: 'square',
  tint: { min: 0xffff00, max: 0xffbb00 },
  alpha: { min: 0.8, max: 1 },
  stayOnTheFloor: false,
});

// ---------------------------------------------------------------------------------------------------------------------
// Hits on things (barrel.js, rock.js, house.js, tallLight.js, tree.js, lootable.js)
// ---------------------------------------------------------------------------------------------------------------------

/** Sparks off a barrel's metal, as fast as the barrel is wide (withSpeedFactor of its radius), a hit's vz per emit. */
export const BARREL_SPARKS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 0.2, max: 0.4 },
  rotation: ANY_TURN,
  gravity: 0.6,
  lifespan: { min: 100, max: 300 },
  scale: { min: 0.15, max: 0.5 },
  texture: '_whiteCircle',
  tint: { min: 0xffff00, max: 0xffbb00 },
  alpha: { min: 0.8, max: 1 },
  stayOnTheFloor: false,
  despawnOnGroundContact: true,
});

/** A barrel's spark of light: its strength drawn per hit gives its reach and halo (withRadius, withGlow); 20 px up. */
export const BARREL_FLASH = Flash.define({ lifespan: 18, color: 0xffee00, elevation: 20 });

/** Sparks off a rock (a hit's vz per emit). */
export const ROCK_SPARKS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 2, max: 4 },
  rotation: ANY_TURN,
  gravity: 0.6,
  lifespan: { min: 100, max: 300 },
  scale: { min: 0.15, max: 0.5 },
  texture: '_whiteCircle',
  tint: { min: 0xffff00, max: 0xffbb00 },
  alpha: { min: 0.8, max: 1 },
  stayOnTheFloor: false,
  despawnOnGroundContact: true,
});

/** Yellow chips off a wall or a lamp post (as many as the damage, per emit). */
export const WALL_CHIPS = ParticleEmitter.define({
  texture: 'square',
  angleXY: ALL_AROUND,
  speed: { min: 1.5, max: 4 },
  vz: { min: 2, max: 6 },
  lifespan: { min: 400, max: 800 },
  gravity: 0.35,
  scale: { min: 0.15, max: 0.4 },
  alpha: { min: 0.7, max: 1 },
  tint: { min: 0xffff00, max: 0xffffff },
  rotation: ANY_TURN,
  stayOnTheFloor: false,
  despawnOnGroundContact: true,
});

/** The short flash of a hit on a wall or a lamp post, 20 px up. */
export const WALL_HIT_FLASH = Flash.define({ lifespan: 18, color: 0xffee00, radius: 707, glow: 0.1, elevation: 20 });

/** Bark and wood chips off a tree (a hit's vz per emit), left on the floor. */
export const TREE_CHIPS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 2, max: 8 },
  rotation: ANY_TURN,
  gravity: 0.6,
  lifespan: { min: 100, max: 300 },
  scale: { min: 0.15, max: 1 },
  texture: '_whiteCircle',
  tint: { min: 0x4a3728, max: 0xc4a484 },
  alpha: 1,
  stayOnTheFloor: true,
});

/** Square sparks off something hard, as fast as it is wide (withSpeedFactor of its radius), a hit's vz per emit. */
export const HARD_HIT_SPARKS = ParticleEmitter.define({
  angleXY: ALL_AROUND,
  speed: { min: 0.1, max: 0.2 },
  rotation: ANY_TURN,
  gravity: 0.6,
  lifespan: { min: 100, max: 300 },
  scale: { min: 0.25, max: 0.5 },
  texture: 'square',
  tint: { min: 0xffff00, max: 0xffbb00 },
  alpha: { min: 0.8, max: 1 },
  stayOnTheFloor: false,
});
