import WEED from '/src/index.js';
import { WALL_CHIPS, WALL_HIT_FLASH } from '../effectPresets.js';
import { ART_FLOOR_SCALE_Y, ART_HEIGHT_SCALE_Y, BARN, HOUSE_SCALE, LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  LightEmitter,
  RigidBody,
  Flash,
  ParticleEmitter,
  enums,
  ShadowCaster,
  rng,
} = WEED;
const { ShapeType } = enums;

// Written ECS-style (E-530): every hook is static, takes the house's index and writes its components' columns, so the
// logic workers make no instance for a house.
export class House extends GameObject {
  static serializable = true;
  // ?light3d=1: a ShadowCaster too, its shadow a box (the barn's).
  static components = LIGHT3D
    ? [Collider, SpriteRenderer, LightEmitter, RigidBody, ShadowCaster]
    : [Collider, SpriteRenderer, LightEmitter, RigidBody];

  /** A bullet hit house i: yellow chips fly off where it hit, with a short flash. */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    // As many chips as the damage, from 20 px up, and a short flash.
    const count = Math.floor(damage * 8) + 3;
    ParticleEmitter.emitPreset(WALL_CHIPS, hitX, hitY, -20, count);
    Flash.spawnPreset(WALL_HIT_FLASH, hitX, hitY);
  }

  /** House i spawned: one of the two house sprites, a static box for a body, and the light of its window. */
  static onSpawned(i, spawnConfig) {
    if (LIGHT3D) {
      this.spawnBarn(i);
      return;
    }
    RigidBody.setStatic(i, 1);
    const type = rng() > 0.5 ? 1 : 2;
    SpriteRenderer.setSprite(i, 'house' + type);

    // Its body: a box over the house's floor, 50 px up from the sprite's anchor.
    Collider.setShapeType(i, ShapeType.Box);
    Collider.setSize(i, 180, 110);
    Collider.setOffset(i, 0, -50);

    LightEmitter.color[i] = 0xffffaa;
    LightEmitter.offsetY[i] = -100; // the window's light, 100 px up the house
    LightEmitter.radius[i] = 632;
    LightEmitter.active[i] = 1;

    SpriteRenderer.setScale(i, 1, 1);
    LightEmitter.shadowRange[i] = 300;
  }

  /**
   * ?light3d=1: the light bench's barn (a render with its height and normal maps) looking at the camera, its collider its
   * footprint, its shadow a box for the sun and the lamps, and a lamp over its door.
   */
  static spawnBarn(i) {
    RigidBody.setStatic(i, 1);
    const s = HOUSE_SCALE;
    const [x0, x1, y0, y1, height] = BARN.box;
    SpriteRenderer.setSpritesheet(i, 'granero');
    SpriteRenderer.setAnimation(i, 'granero_0'); // the render that looks south, at the camera
    SpriteRenderer.setAnchor(i, BARN.anchorX, BARN.anchorY);
    SpriteRenderer.setScale(i, s, s);

    // Its footprint, as the floor is drawn (the anchor is its middle).
    Collider.setShapeType(i, ShapeType.Box);
    Collider.setSize(i, (x1 - x0) * s, (y1 - y0) * s * ART_FLOOR_SCALE_Y);
    Collider.setOffset(i, 0, 0);

    // A box: its width and depth on the floor, its height in screen px (DX-CASTER: ShadowCaster.setBox).
    ShadowCaster.setBox(i, (x1 - x0) * s, (y1 - y0) * s, height * s * ART_HEIGHT_SCALE_Y);

    // The lamp over its door, in front of the south wall; in an oblique scene elevation is the bulb's real height.
    LightEmitter.color[i] = 0xffffaa;
    LightEmitter.offsetY[i] = y1 * s * ART_FLOOR_SCALE_Y + 8;
    LightEmitter.elevation[i] = 45;
    LightEmitter.radius[i] = 632;
    LightEmitter.active[i] = 1;
    LightEmitter.shadowRange[i] = 300;
  }
}
