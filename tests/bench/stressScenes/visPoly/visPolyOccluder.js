import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LightOccluder, enums } = WEED;
const { ShapeType } = enums;

export class VisPolyOccluder extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({ x = 0, y = 0, width = 48, height = 48, circle = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    if (circle) {
      this.collider.shapeType = ShapeType.Circle;
      this.collider.radius = width * 0.5;
    } else {
      this.collider.shapeType = ShapeType.Box;
      this.collider.width = width;
      this.collider.height = height;
    }
    this.collider.visualRange = 80;
    this.lightOccluder.active = 1;
  }
}
