// What the street draws as sprites: houses, trees, lamps, people, cars and clouds.

import WEED from '/src/index.js';
import { setUpStreetCar } from '../streetCars.js';
import { LAP, WORLD_W, roadPoint } from '../streetLayout.js';

const { GameObject, Collider, SpriteRenderer, DirectionalSprite, ShadowCaster, LightEmitter, Sun, enums } = WEED;
const { ShapeType } = enums;

// ?carSpeed= reaches this module on the logic worker through WEED.params: `location` there is the worker script's.
const CAR_SPEED = Number(WEED.params?.get('carSpeed') ?? 4);
// ?raycast=0: the scene's camera is not flat, so there are no walls (sunStreetScene.js reads the same knob).
const RAYCAST = Number(WEED.params?.get('raycast') ?? 1) === 1;
const LANE = -28; // inside of the centre line
// The lights' reach at night; by day it shrinks with Sun.nightFactor (as √nightFactor), and their glow fades with it.
const LAMP_RADIUS = 949;
const HEADLIGHT_RADIUS = 949;
const NIGHT_GLOW = 0.18;

// A house sprite (186 px, its foot at the bottom edge) shows a front wall 104 px high and a roof 72 px deep.
const HOUSE_WIDTH = 176;
const HOUSE_DEPTH = 72;
const HOUSE_HEIGHT = 104;
const TANK_HEIGHT = 140;
const TANK = [];
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  TANK.push(-50 + Math.cos(a) * 20, -46 + Math.sin(a) * 12);
}


const point = new Float64Array(3);

/**
 * A house seen from the front, its roof going up the screen. Its sprite's silhouette would flip this picture, so its
 * ShadowCaster says what it is instead: a box with a water tank on it (setBox, addLevel: a volume).
 * It blocks lamps and headlights with its whole picture, not its footprint (lamps.setWall({ shape: 'sprite' }), under
 * raycasted lighting): lights work on the floor, and in this view a wall and a roof are drawn over the floor behind the house, so
 * with the footprint the wall facing a lamp falls in the footprint's own shadow, and the wall facing away is lit.
 */
export class StreetHouse extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 176;
    this.collider.height = 180;
    this.collider.offsetY = -90;
    this.collider.visualRange = 120;
    this.setSprite(config.texture);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    this.shadowCaster.setBox(HOUSE_WIDTH, HOUSE_DEPTH, HOUSE_HEIGHT, { offsetY: -HOUSE_DEPTH / 2 });
    this.shadowCaster.addLevel(TANK, HOUSE_HEIGHT, TANK_HEIGHT);
    if (RAYCAST) this.shadowCaster.lamps.setWall({ shape: 'sprite' });
  }
}

/** A tree. The panel's T changes the shadow it casts, not the sprite: shadowCaster.setSprite({ frame }). */
export class StreetTree extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 10;
    this.collider.visualRange = 120;
    this.setSprite(config.texture);
    this.setScale(config.scale);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
  }
}

/** A street lamp: lit by the night factor, its shadow the sprite's. */
export class StreetLamp extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster, LightEmitter];

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 6;
    this.setSprite('tallLight');
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    this.lightEmitter.color = 0xffc98a;
    this.lightEmitter.radius = 0;
    this.lightEmitter.elevation = 40;
  }

  tick() {
    const night = Sun.nightFactor;
    this.lightEmitter.radius = LAMP_RADIUS * Math.sqrt(night);
    this.lightEmitter.glow = NIGHT_GLOW * night;
  }
}

/** Someone walking along the sidewalk, and back. */
export class StreetWalker extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  direction = 1;
  from = 0;
  to = 0;

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 8;
    this.collider.visualRange = 60;
    this.from = config.from;
    this.to = config.to;
    this.direction = config.direction;
    this.setSpritesheet(config.sheet);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.9;
    this._face();
  }

  _face() {
    this.setAnimation(this.direction > 0 ? 'walk_right' : 'walk_left');
  }

  tick(dtRatio) {
    this.x += this.direction * dtRatio * 0.9;
    if ((this.direction > 0 && this.x > this.to) || (this.direction < 0 && this.x < this.from)) {
      this.direction = -this.direction;
      this._face();
    }
  }
}

/**
 * A car on the road (a standard sheet: streetCars.js), drawn by its heading. Its one light sits ahead of it, off the
 * entity's centre: the panel's O. Its shadow is a body and a cabin for the sun, and its picture as a wall that blocks
 * other lights.
 */
export class StreetCar extends GameObject {
  static components = [Collider, DirectionalSprite, LightEmitter, ShadowCaster];

  distance = 0.5;

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Box;
    this.distance = config.distance + 0.5;
    setUpStreetCar(this, config.sheet);
    this.lightEmitter.color = 0xfff1c4;
    this.lightEmitter.radius = 0;
    this.lightEmitter.offsetX = config.offset;
    if (RAYCAST) this.shadowCaster.lamps.setWall({ shape: 'sprite' });
  }

  tick(dtRatio) {
    this.distance = (this.distance + CAR_SPEED * dtRatio) % LAP;
    roadPoint(this.distance, LANE, point);
    // The rotation first: set x and set y send the body the rotation they find.
    this.rotation = point[2];
    this.x = point[0];
    this.y = point[1];
    // The frame drawn: the sheet's heading nearest the road's (a car going west shows the east frame mirrored).
    this.directionalSprite.facing = point[2];
    const night = Sun.nightFactor;
    this.lightEmitter.radius = HEADLIGHT_RADIUS * Math.sqrt(night);
    this.lightEmitter.glow = NIGHT_GLOW * night;
  }
}

/** A cloud drifting over the street. */
export class StreetCloud extends GameObject {
  static components = [SpriteRenderer];

  drift = 0.5;

  onSpawned(config = {}) {
    this.setLayer('clouds');
    this.setSprite('cloud');
    this.setScale(config.scale);
    this.drift = config.drift;
  }

  tick(dtRatio) {
    this.x += this.drift * dtRatio;
    if (this.x > WORLD_W + 300) this.x = -300;
  }
}
