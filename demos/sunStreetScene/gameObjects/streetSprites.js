// What the street draws as sprites: houses, trees, lamps, people, cars and clouds.

import WEED from '/src/index.js';
import { LAP, WORLD_W, roadPoint } from '../streetLayout.js';

const { GameObject, Collider, SpriteRenderer, ShadowCaster, LightEmitter, Sun, enums } = WEED;
const { ShapeType } = enums;

// ?carSpeed= reaches this module on the logic worker through WEED.params: `location` there is the worker script's.
const CAR_SPEED = Number(WEED.params?.get('carSpeed') ?? 4);
const LANE = -28; // inside of the centre line
const LAMP_INTENSITY = 9000;
const HEADLIGHT_INTENSITY = 9000;

const point = new Float64Array(3);

/** A house seen from the front, its roof going up the screen. A ShadowCaster would flip this picture: see HouseShadow. */
export class StreetHouse extends GameObject {
  static components = [SpriteRenderer];

  onSpawned(config = {}) {
    this.setSprite(config.texture);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
  }
}

/** A tree. The panel's T changes the shadow it casts, not the sprite: ShadowCaster.setTexture. */
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
    this.collider.visualRange = 520;
    this.setSprite('tallLight');
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    this.lightEmitter.lightColor = 0xffc98a;
    this.lightEmitter.lightIntensity = 0;
    this.lightEmitter.sourceHeight = 40;
  }

  tick() {
    this.lightEmitter.lightIntensity = LAMP_INTENSITY * Sun.nightFactor;
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

/** A car on the road. Its one light sits ahead of it, off the entity's centre: the panel's O. */
export class StreetCar extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter];

  distance = 0.5;

  onSpawned(config = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 20;
    this.collider.visualRange = 400;
    this.distance = config.distance + 0.5;
    this.setSprite('car');
    this.setScale(0.55);
    this.lightEmitter.lightColor = 0xfff1c4;
    this.lightEmitter.lightIntensity = 0;
    this.lightEmitter.offsetY = -config.offset;
  }

  tick(dtRatio) {
    this.distance = (this.distance + CAR_SPEED * dtRatio) % LAP;
    roadPoint(this.distance, LANE, point);
    // The rotation first: set x and set y send the body the rotation they find.
    this.rotation = point[2] + Math.PI / 2; // the picture points up the screen
    this.x = point[0];
    this.y = point[1];
    this.lightEmitter.lightIntensity = HEADLIGHT_INTENSITY * Sun.nightFactor;
  }
}

/** A cloud drifting over the street. */
export class StreetCloud extends GameObject {
  static components = [SpriteRenderer];

  speed = 0.5;

  onSpawned(config = {}) {
    this.setLayer('clouds');
    this.setSprite('cloud');
    this.setScale(config.scale);
    this.speed = config.speed;
  }

  tick(dtRatio) {
    this.x += this.speed * dtRatio;
    if (this.x > WORLD_W + 300) this.x = -300;
  }
}
