import WEED from '/src/index.js';

const { Scene, Camera, GameObject, MeshRenderer, LAYER_KIND } = WEED;

/**
 * Do MESH layers keep their zIndex? One still mesh of `?tris=` triangles on the low layer, a big square on the high
 * one, both over a white ground. The upper half of the picture must be the square's colour whatever `?tris=` says.
 * `?tris=` (default 2000), `?backend=webgpu`, `?ySort=1`.
 */
// WEED.params, not location: inside a worker location is the worker script's, and the mesh is built there.
const query = (key) => WEED.params?.get(key) ?? null;

const TRIS = Math.max(1, Number(query('tris') ?? 2000));
const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const stressSceneConfig = { requested: { tris: TRIS, backend: BACKEND, ySort: query('ySort') === '1' ? 1 : 0 } };

class LowField extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('low');
    this.meshRenderer.tint = 0xff0000;
    const xy = new Float32Array(TRIS * 6);
    const indices = new Uint32Array(TRIS * 3);
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < TRIS; i++) {
      const x = (next() - 0.5) * 1280;
      const y = (next() - 0.5) * 720;
      xy.set([x - 12, y, x + 12, y, x, y - 18], i * 6);
      indices.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
    }
    this.meshRenderer.setMesh(xy, indices);
  }
}

class HighSquare extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('high');
    this.meshRenderer.tint = 0x0000ff;
    this.meshRenderer.setMesh([-640, -180, 640, -180, 640, 180, -640, 180], [0, 1, 2, 0, 2, 3]);
  }
}

export class MeshLayerOrderScene extends Scene {
  static config = {
    worldWidth: 1280,
    worldHeight: 720,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, noLimitFPS: false, ySort: query('ySort') === '1', maxMeshVerts: TRIS * 3 + 64, maxMeshIndices: TRIS * 3 + 64 },
    layers: {
      ground: { kind: LAYER_KIND.COVER, texture: '_white', zIndex: 0 },
      low: { kind: LAYER_KIND.MESH, zIndex: 0.4 },
      high: { kind: LAYER_KIND.MESH, zIndex: 3 },
    },
    lighting: { enabled: false },
  };
  static entities = [
    [LowField, 1],
    [HighSquare, 1],
  ];

  create() {
    LowField.spawn({ x: 640, y: 360 });
    HighSquare.spawn({ x: 640, y: 180 });
    Camera.centerOn(640, 360);
  }
}
