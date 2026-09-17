import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, enums } = WEED;
const { ShapeType } = enums;

export class CmdSamePoseBody extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = true;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 12;
    this.collider.height = 12;
    this.rigidBody.syncMassFromCollider();
  }

  tick() {
    this.x = this.x;
    this.y = this.y;
    this.setVelocity(this.vx, this.vy);
  }
}
