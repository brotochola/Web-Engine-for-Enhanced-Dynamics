// The night street's entities: houses, street lamps and cars. Every light here is a LightEmitter set up once, in
// onSpawned; the scene's panel changes some of its fields at run time to show what each one does.

import WEED from '/src/index.js';
import { CARS } from '/demos/img/autos/index.js';
import { LAP, roadPoint } from '../sunStreetScene/streetLayout.js';

const { GameObject, Collider, SpriteRenderer, DirectionalSprite, LightEmitter, ShadowCaster, enums } = WEED;
const { ShapeType } = enums;

// ?carSpeed= reaches this module on the logic worker through WEED.params (`location` there is the worker script's).
const CAR_SPEED = Number(WEED.params?.get('carSpeed') ?? 3);
// ?raycast=0: the scene's camera is not flat, so there are no walls (headlightsScene.js reads the same knob).
const RAYCAST = Number(WEED.params?.get('raycast') ?? 1) === 1;
const LANE = -28; // px inside the road's centre line

// ---------------------------------------------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------------------------------------------

/** The headlights' cone at spawn, at each car's front bumper (Car). The scene's panel changes these on every car. */
export const HEADLIGHT = {
  radius: 1600, // px the beam reaches (about 1 % of its light is left there; half of it at 160 px)
  color: 0xfff1c4, // warm white
  coneAngle: Math.PI / 3, // the whole aperture: 60 degrees, 30 each side of the car's heading
  coneSoftness: 0.35, // the outer 35 % of each half fades out; 0 is a hard edge
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

// The cars are the standard sheets of demos/img/autos (MinZiin's TopDown Vehicles, CC BY 4.0, baked by
// demos/tools/bakeCarSheet.mjs): every cell has the car's centre on the floor at the sheet's anchor, and index.js gives
// that anchor and the car's box (x0, x1, y0, y1 in floor px, x along the car with its front at x1, and its roof's
// height). The pack's pictures draw the floor 0.736 as tall and a px of height 0.752 px tall (its projection, as
// nm-core fitted it: demos/tools/nmCore.cjs). A volume's heights are screen px, so they are the car's times 0.752, and
// its floor is drawn as the pictures draw it.
const CAR_FLOOR_SCALE = 0.7364193217154872;
const CAR_HEIGHT_SCALE = 0.7516549042792687;

/**
 * The scene's cars, in the order it paints them, with what their boxes do not say: the height of the body, and the
 * cabin on it (the glass and the roof: from x0 to x1 at its base, from roofX0 to roofX1 at the roof, halfWidth either
 * side), floor px. Both are the model the bake fitted to the car's pictures (nm-core's buildParts).
 */
const CAR_SHAPES = {
  hatch_rojo: { bodyTop: 8.3, cabin: [-33.7, 31, -29.7, 18.6, 15.2] },
  taxi: { bodyTop: 14.4, cabin: [-25.7, 26.6, -14.9, 7.1, 14.6] },
  hatch_azul: { bodyTop: 8.3, cabin: [-33.7, 31, -29.7, 18.6, 15.2] },
  sedan_blanco: { bodyTop: 14.4, cabin: [-26.3, 26.3, -16, 8.6, 14.4] },
  sedan_negro: { bodyTop: 14.4, cabin: [-26.3, 26.3, -16, 8.6, 14.4] },
  policia: { bodyTop: 14.4, cabin: [-25.6, 21.8, -14.1, 6.7, 15.3] },
};
/** The car sheets, in the order the scene paints its cars; the scene loads each under its own name. */
export const CAR_SHEETS = Object.keys(CAR_SHAPES);

/** A level's outline: the rectangle x0..x1 by y0..y1, its front right corner first. */
const outline = (x0, x1, y0, y1) => [x1, y0, x1, y1, x0, y1, x0, y0];

const roadAt = new Float64Array(3); // roadPoint's x, y and heading, reused every tick

// ---------------------------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------------------------

/**
 * A house whose ShadowCaster has geometry for both kinds of shadow:
 * - setBox: the box it is (a volume), so the sun's shadow is the shadow of that box at the hour's angle.
 * - lamps.setWall + Collider: what stops the lamps and the headlights under raycasted lighting (the flat camera). Lights
 *   work on the floor, and in this view the house's walls and roof are drawn over the floor behind it, so the Collider
 *   covers the whole picture (not only the footprint) and the wall lights the house through the picture's own outline
 *   ({ shape: 'sprite' }): the wall that faces a beam is lit, the far side stays dark.
 */
export class House extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.setSprite(config.texture);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1; // the picture stands on the entity's spot

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = HOUSE_WIDTH;
    this.collider.height = HOUSE_PICTURE_HEIGHT;
    this.collider.offsetY = -HOUSE_PICTURE_HEIGHT / 2; // up from the foot, over the picture

    this.shadowCaster.setBox(HOUSE_WIDTH, HOUSE_DEPTH, HOUSE_HEIGHT, { offsetY: -HOUSE_DEPTH / 2 });
    if (RAYCAST) this.shadowCaster.lamps.setWall({ shape: 'sprite' });
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
 * One of the standard cars lapping the road, with its headlights as one cone light at the front bumper. The cone turns
 * with the car: `direction` (0, straight ahead) and `offsetX` are in the car's own frame, and the entity's rotation
 * turns both. The picture does not turn: the sheet has a frame every 7.5 degrees (the left half its right half
 * mirrored), and DirectionalSprite draws the one nearest the heading tick gives it. The car is a wall too: it stops the
 * other cars' beams and the lamps.
 */
export class Car extends GameObject {
  static components = [Collider, SpriteRenderer, DirectionalSprite, LightEmitter, ShadowCaster];

  distance = 0.5; // px along the road; a double from the start (the tick adds fractions)

  onSpawned(config = {}) {
    this.distance = config.distance + 0.5;
    const { anchor, box } = CARS[config.sheet];
    const [x0, x1, y0, y1, roof] = box;
    const { bodyTop, cabin } = CAR_SHAPES[config.sheet];
    const [cabinX0, cabinX1, roofX0, roofX1, half] = cabin;

    this.setSpritesheet(config.sheet);
    // The car's centre on the floor, where every cell of the sheet puts it: the entity's spot.
    this.spriteRenderer.anchorX = anchor[0];
    this.spriteRenderer.anchorY = anchor[1];
    // The sheet draws the heading: the entity turns, its picture does not.
    this.spriteRenderer.inheritTransformRotation = 0;
    this.spriteRenderer.spriteRotation = 0;
    this.setAnimation('drive');

    // The box's footprint, and the car as a volume for the sun: its body, and the cabin on it whose roof is shorter
    // than its base.
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = x1 - x0;
    this.collider.height = y1 - y0;
    const body = outline(x0, x1, y0, y1);
    const bodyHeight = bodyTop * CAR_HEIGHT_SCALE;
    this.shadowCaster.addLevel(body, 0, bodyHeight, body, { floorScaleY: CAR_FLOOR_SCALE });
    this.shadowCaster.addLevel(
      outline(cabinX0, cabinX1, -half, half),
      bodyHeight,
      roof * CAR_HEIGHT_SCALE,
      outline(roofX0, roofX1, -half, half),
    );
    if (RAYCAST) this.shadowCaster.lamps.setWall({ shape: 'sprite' });

    const light = this.lightEmitter;
    light.radius = HEADLIGHT.radius;
    light.color = HEADLIGHT.color;
    light.offsetX = x1; // the box's front: the front bumper
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
    this.y = roadAt[1];
    // The frame drawn: the sheet's heading nearest the road's (a car going west shows the east frame mirrored).
    this.directionalSprite.facing = roadAt[2];
  }
}
