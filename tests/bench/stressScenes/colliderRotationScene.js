import WEED from '/src/index.js';

const { Scene, Camera, GameObject, Collider, SpriteRenderer, Transform, enums } = WEED;
const { ShapeType } = enums;

/**
 * The rotation of entities with a Collider and no RigidBody, whose body is an implicit static one. `RingWalker` walks a
 * circle from tick, writing x, y and then rotation, as a car on a road does; `update` reads its angle on the main thread
 * every frame and counts the reads that went backwards and the largest step. `PosedBox` gets its rotation in onSpawned
 * and never moves. Prints `[bench] colliderRotation reads N backward M worstStep W posed P`, where the walker turns
 * WALK_STEP radians a tick, and `posed` should read POSED_ANGLE.
 */
const WALK_STEP = 0.02;
const RADIUS = 200;
const CX = 640;
const CY = 360;
const POSED_ANGLE = 1;
const SETTLE_READS = 120;
const REPORT_READS = 600;

export const stressSceneConfig = { requested: {} };

class RingWalker extends GameObject {
  static components = [Collider, SpriteRenderer];

  angle = 0.5;

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 8;
    this.setSprite('box');
    this.setScale(0.4);
  }

  tick(dtRatio) {
    this.angle += WALK_STEP * dtRatio;
    this.x = CX + Math.cos(this.angle) * RADIUS;
    this.y = CY + Math.sin(this.angle) * RADIUS;
    this.rotation = this.angle;
  }
}

class PosedBox extends GameObject {
  static components = [Collider, SpriteRenderer];

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 8;
    this.setSprite('box');
    this.setScale(0.4);
    this.rotation = POSED_ANGLE;
  }
}

export class ColliderRotationScene extends Scene {
  static config = {
    worldWidth: 1280,
    worldHeight: 720,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
  };
  static assets = { textures: { box: '/demos/img/box_100_100.png' } };
  static entities = [
    [RingWalker, 1],
    [PosedBox, 1],
  ];

  _walker = 0;
  _posed = 0;
  _reads = 0;
  _backward = 0;
  _worstStep = 0;
  _last = NaN;

  create() {
    this._walker = RingWalker.spawn({ x: CX + RADIUS, y: CY }).index;
    this._posed = PosedBox.spawn({ x: CX, y: CY }).index;
    Camera.centerOn(CX, CY);
  }

  update() {
    const i = this._walker;
    const angle = Math.atan2(Transform.rotS[i], Transform.rotC[i]);
    const last = this._last;
    this._last = angle;
    this._reads++;
    if (this._reads <= SETTLE_READS) return;
    let step = angle - last;
    if (step > Math.PI) step -= Math.PI * 2;
    if (step < -Math.PI) step += Math.PI * 2;
    if (step < 0) this._backward++;
    if (Math.abs(step) > this._worstStep) this._worstStep = Math.abs(step);
    if ((this._reads - SETTLE_READS) % REPORT_READS === 0) {
      const posed = Transform.rotation[this._posed];
      console.log(`[bench] colliderRotation reads ${this._reads - SETTLE_READS} backward ${this._backward} worstStep ${this._worstStep.toFixed(4)} posed ${posed.toFixed(3)}`);
    }
  }
}
