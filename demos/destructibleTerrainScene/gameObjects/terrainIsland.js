import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, MeshRenderer } = WEED;

export class TerrainIsland extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [RigidBody, Collider, MeshRenderer];

  setup() {
    this.collider.visualRange = 0;
    this.collider.friction = 0.5;
    this.collider.restitution = 0.05;
  }

  onSpawned(spawnConfig = {}) {
    this.isStatic = !!spawnConfig.isStatic;
    this.rigidBody.linearDamping = spawnConfig.isStatic ? 0 : 0.15;
    this.rigidBody.angularDamping = spawnConfig.isStatic ? 0 : 0.2;

    const polys = spawnConfig.polys;
    if (!polys || !polys.length || !this.collider.replacePolygons(polys)) {
      this.despawn();
      return;
    }

    this.meshRenderer.tint = spawnConfig.tint ?? 0x88aa66;
    this.setLayer('terrain');
    const hw = (this.collider.width || 0) * 0.5;
    const hh = (this.collider.height || 0) * 0.5;
    this.collider.visualRange = Math.hypot(hw, hh) + 80;
  }

  tick() {}
}
