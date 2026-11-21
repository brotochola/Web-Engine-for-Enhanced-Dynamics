import WEED from '/src/index.js';
import { TREE_CHIPS } from '../effectPresets.js';
import { FARM_TREES, LIGHT3D } from '../light3d.js';

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  RigidBody,
  ShadowCaster,
  ParticleEmitter,
  enums, rng,
} = WEED;
const { ShapeType } = enums;

// Written ECS-style (E-530): every hook is static, takes the tree's index and writes its components' columns, so the
// logic workers make no instance for a tree.
export class Tree extends GameObject {
  static serializable = true;
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];

  /** A bullet hit tree i: bark and wood chips, as many as the trunk is wide, scattered around the hit. */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    // const count = Math.floor(damage * 8) + 3;
    const radius = Collider.radius[i];
    const count = Math.floor(rng() * radius) + radius * 0.5;
    const x = hitX + (rng() * radius - radius * 0.5);
    const y = hitY + (rng() * radius - radius * 0.5);
    const z = -rng() * 40;
    const vz = -rng() * 4 - 2;
    ParticleEmitter.withVz(vz).emitPreset(TREE_CHIPS, x, y, z, count);
  }

  /** Tree i spawned: one of the two tree sprites, a random size and facing, a static trunk for a body. */
  static onSpawned(i, spawnConfig) {
    if (LIGHT3D) {
      this.spawnFarmTree(i);
      return;
    }
    RigidBody.setStatic(i, 1);
    const whichTree = rng() > 0.5 ? 1 : 2;
    SpriteRenderer.setSprite(i, 'tree' + whichTree);
    const scale = rng() * 0.5 + 1;
    SpriteRenderer.setScale(i, rng() > 0.5 ? scale : -scale, scale);
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, 12 * scale);
    // The anchor at the trunk's foot.
    SpriteRenderer.setAnchor(i, 0.45, 0.95);
    // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
    Collider.visualRange[i] = 0;
  }

  /**
   * ?light3d=1: the light bench's trees, with their height and normal maps. One view each, so every light casts its
   * silhouette (the ShadowCaster's default for one view), standing on the base the engine measures.
   */
  static spawnFarmTree(i) {
    RigidBody.setStatic(i, 1);
    const whichTree = rng() > 0.5 ? 1 : 2;
    SpriteRenderer.setSpritesheet(i, 'arboles');
    SpriteRenderer.setAnimation(i, whichTree === 1 ? 'arbol_verde' : 'arbol_jacaranda');
    const scale = rng() * 0.5 + 1;
    SpriteRenderer.setScale(i, rng() > 0.5 ? scale : -scale, scale);
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, 12 * scale);
    SpriteRenderer.setAnchor(i, FARM_TREES.anchorX, FARM_TREES.anchorY);
    // Reads no neighbours: no visualRange (a visualRange gives an entity its neighbour list, SST-21).
    Collider.visualRange[i] = 0;
  }
}
