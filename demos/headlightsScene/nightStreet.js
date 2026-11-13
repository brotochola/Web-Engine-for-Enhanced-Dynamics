// The night street's entities: houses, street lamps and cars. Every light here is a LightEmitter set up once, in
// onSpawned; the scene's panel changes some of its fields at run time to show what each one does.

import WEED from '/src/index.js';
import { LAP, roadPoint } from '../sunStreetScene/streetLayout.js';

const { GameObject, Collider, SpriteRenderer, LightEmitter, LightOccluder, VolumeShadowCaster, LIGHT_OCCLUDER_MASK_SPRITE, enums } = WEED;
const { ShapeType } = enums;

// ?carSpeed= reaches this module on the logic worker through WEED.params (`location` there is the worker script's).
const CAR_SPEED = Number(WEED.params?.get('carSpeed') ?? 3);
const LANE = -28; // px inside the road's centre line

// ---------------------------------------------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------------------------------------------

/** The headlights' cone at spawn. The scene's panel changes these on every car. */
export const HEADLIGHT = {
  radius: 1600, // px the beam reaches (about 1 % of its light is left there; half of it at 160 px)
  color: 0xfff1c4, // warm white
  coneAngle: Math.PI / 3, // the whole aperture: 60 degrees, 30 each side of the car's heading
  coneSoftness: 0.35, // the outer 35 % of each half fades out; 0 is a hard edge
  ahead: 46, // px ahead of the car's centre: its front bumper (offsetX, turned with the car)
};

/** A street lamp: a round light (no coneAngle), its bulb up the post. */
export const LAMP = {
  radius: 1300,
  color: 0xffc98a,
  elevation: 80, // the bulb's height above the floor: a flatter pool, peaking at I / (I + h²) = 0.73 at its foot
  glow: 0.18, // the halo's alpha on the bulb (0 draws none)
  glowOffsetY: -118, // the halo 118 px up the screen, on the lamp's head
};

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

// A house picture (house1.png / house2.png, its foot on the bottom edge) shows a front wall 104 px high under a roof
// 72 px deep. As a volume that is a box 176 wide, 72 deep and 104 tall.
const HOUSE_WIDTH = 176;
const HOUSE_DEPTH = 72;
const HOUSE_HEIGHT = 104;
const HOUSE_PICTURE_HEIGHT = 180;

// A car as a volume, x forward: a body 78 x 38 and 13 tall, and a cabin on it whose roof is smaller than its base.
const CAR_BODY = [39, -19, 39, 19, -39, 19, -39, -19];
const CAR_BODY_HEIGHT = 13;
const CAR_CABIN = [16, -17, 16, 17, -30, 17, -30, -17];
const CAR_ROOF = [2, -13, 2, 13, -22, 13, -22, -13];
const CAR_ROOF_HEIGHT = 27;
// carScene's pictures are drawn with the floor 0.7 as tall (the scene's lighting.groundScaleY), and the picture's
// centre sits 7 px above the car's spot on the floor.
const CAR_FLOOR_SCALE = 0.7;
const CAR_FLOOR_DROP = 7;
// carScene's sheets hold a picture every 7.5 degrees, each animation named by its heading.
const CAR_FRAMES = Array.from({ length: 48 }, (_, i) => String(i * 7.5));
const CAR_FRAME_STEP = (Math.PI * 2) / CAR_FRAMES.length;

const roadAt = new Float64Array(3); // roadPoint's x, y and heading, reused every tick

// ---------------------------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------------------------

/**
 * A house with geometry for both kinds of shadow:
 * - VolumeShadowCaster: the box it is, so the sun's shadow is the shadow of that box at the hour's angle.
 * - LightOccluder + Collider: what stops the lamps and the headlights under lighting.raycasted. Lights work on the
 *   floor, and in this view the house's walls and roof are drawn over the floor behind it, so the Collider covers the
 *   whole picture (not only the footprint) and the occluder lights the house through the picture's own outline
 *   (LIGHT_OCCLUDER_MASK_SPRITE): the wall that faces a beam is lit, the far side stays dark.
 */
export class House extends GameObject {
  static components = [Collider, SpriteRenderer, LightOccluder, VolumeShadowCaster];

  onSpawned(config = {}) {
    this.setSprite(config.texture);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1; // the picture stands on the entity's spot

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = HOUSE_WIDTH;
    this.collider.height = HOUSE_PICTURE_HEIGHT;
    this.collider.offsetY = -HOUSE_PICTURE_HEIGHT / 2; // up from the foot, over the picture
    this.lightOccluder.maskMode = LIGHT_OCCLUDER_MASK_SPRITE;

    this.volumeShadowCaster.setBox(HOUSE_WIDTH, HOUSE_DEPTH, HOUSE_HEIGHT, { offsetY: -HOUSE_DEPTH / 2 });
  }
}

/** A street lamp: a round light whose bulb is up the post, with a halo on it. */
export class StreetLamp extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter];

  onSpawned() {
    this.setSprite('tallLight');
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    // A Collider puts the lamp in the spatial grid, where its light finds the occluders around it.
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 6;

    const light = this.lightEmitter;
    light.radius = LAMP.radius;
    light.color = LAMP.color;
    light.elevation = LAMP.elevation;
    light.glow = LAMP.glow;
    light.glowOffsetY = LAMP.glowOffsetY;
    // Left at their defaults: brightness 1, castShadows 1, shadowRange 0 (its radius), and no cone.
  }
}

/**
 * One of carScene's cars lapping the road, with its headlights as one cone light at the front bumper. The cone turns
 * with the car: `direction` (0, straight ahead) and `offsetX` are in the car's own frame, and the entity's rotation
 * turns both, so tick only moves the car. The car is an occluder too: it stops the other cars' beams and the lamps.
 */
export class Car extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter, LightOccluder, VolumeShadowCaster];

  distance = 0.5; // px along the road; a double from the start (the tick adds fractions)
  frame = -1;

  onSpawned(config = {}) {
    this.distance = config.distance + 0.5;
    this.setSpritesheet(config.sheet);
    this.setAnimation(CAR_FRAMES[0]);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5 + CAR_FLOOR_DROP / this.spriteRenderer.originalHeight;
    // The sheet draws the heading: the entity turns, its picture does not.
    this.spriteRenderer.inheritTransformRotation = 0;
    this.spriteRenderer.spriteRotation = 0;

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 78;
    this.collider.height = 38;
    this.lightOccluder.maskMode = LIGHT_OCCLUDER_MASK_SPRITE;
    this.volumeShadowCaster.addLevel(CAR_BODY, 0, CAR_BODY_HEIGHT, CAR_BODY, { floorScaleY: CAR_FLOOR_SCALE });
    this.volumeShadowCaster.addLevel(CAR_CABIN, CAR_BODY_HEIGHT, CAR_ROOF_HEIGHT, CAR_ROOF);

    const light = this.lightEmitter;
    light.radius = HEADLIGHT.radius;
    light.color = HEADLIGHT.color;
    light.offsetX = HEADLIGHT.ahead;
    light.coneAngle = HEADLIGHT.coneAngle;
    light.coneSoftness = HEADLIGHT.coneSoftness;
    light.direction = 0; // where the cone points from the car's heading (radians); 0 is the default
  }

  tick(dtRatio) {
    this.distance = (this.distance + CAR_SPEED * dtRatio) % LAP;
    roadPoint(this.distance, LANE, roadAt);
    // The rotation first: x and y send the body the rotation they find.
    this.rotation = roadAt[2];
    this.x = roadAt[0];
    this.y = roadAt[1] + CAR_FLOOR_DROP;
    const frame = Math.round(roadAt[2] / CAR_FRAME_STEP) % CAR_FRAMES.length;
    if (frame !== this.frame) {
      this.frame = frame;
      this.setAnimation(CAR_FRAMES[frame]);
    }
  }
}
