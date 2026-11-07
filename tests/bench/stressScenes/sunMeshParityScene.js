import WEED from '/src/index.js';

const { Scene, Camera, GameObject, MeshRenderer, Collider, SpriteRenderer, ShadowCaster, VolumeShadowCaster, Sun, LAYER_KIND, enums } = WEED;
const { ShapeType } = enums;

/**
 * DX-SUNMESH's parity: one thin vertical bar, `?bar=sprite` as a ShadowCaster with an invisible sprite, `?bar=mesh` as a
 * post on a sunProjected layer, `?bar=volume` as a VolumeShadowCaster's box, on a plain ground, the sun stopped at `?hour=`. sunMeshParity.mjs reads where each
 * shadow ends: houses and people must agree. `?height=` (default 200), `?backend=webgpu`.
 */
function query(key) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(key);
  } catch {
    return null;
  }
}

const HOUR = Number(query('hour') ?? 9);
const HEIGHT = Number(query('height') ?? 200);
const BAR = query('bar') || 'sprite';
export const BACKEND = query('backend') === 'webgpu' ? 'webgpu' : 'webgl';
export const stressSceneConfig = { requested: { hour: HOUR, height: HEIGHT, bar: BAR, backend: BACKEND } };

const HALF_WIDTH = 1;
const X = 640;
const Y = 360;

class ParitySprite extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster];

  onSpawned() {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 2;
    this.collider.visualRange = 8;
    this.setSprite('bar');
    this.setFixedRotation?.(1);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    this.spriteRenderer.scaleX = (HALF_WIDTH * 2) / 100;
    this.spriteRenderer.scaleY = HEIGHT / 100;
    this.spriteRenderer.alpha = 0;
  }
}

class ParityWall extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('shadows');
    this.meshRenderer.tint = 0x000000;
    // A square post, not a flat wall: edge on to a low sun a wall's shadow is thinner than a pixel.
    const w = HALF_WIDTH;
    const corners = [-w, -w, w, -w, w, w, -w, w];
    this.meshRenderer.setMesh(
      [...corners, ...corners],
      [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
    );
    this.meshRenderer.setHeights([0, 0, 0, 0, HEIGHT, HEIGHT, HEIGHT, HEIGHT]);
  }
}

class ParityVolume extends GameObject {
  static components = [VolumeShadowCaster];

  onSpawned() {
    this.volumeShadowCaster.setBox(HALF_WIDTH * 2, HALF_WIDTH * 2, HEIGHT);
  }
}

export class SunMeshParityScene extends Scene {
  static config = {
    worldWidth: 1280,
    worldHeight: 720,
    seed: 7,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 255, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, noLimitFPS: false, maxMeshVerts: 64, maxMeshIndices: 64 },
    preRender: { noLimitFPS: false, packGpuSprites: 'pixi', sortSprites: 'pixi' },
    layers: {
      ground: { kind: LAYER_KIND.COVER, texture: '_white', zIndex: 0 },
      shadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, sunProjected: true },
    },
    lighting: {
      enabled: true,
      baseAmbient: 1,
      shadowsEnabled: true,
      maxShadowCastingLights: 1,
      maxShadowsPerLight: 1,
      resolution: 1,
      shadowResolution: 1,
      sun: { enabled: true, startHour: HOUR, shadowAlpha: 1, dayCycle: { enabled: false } },
    },
  };
  static assets = { textures: { bar: '/demos/img/box_100_100.png' } };
  static entities = [
    [ParitySprite, 1],
    [ParityWall, 1],
    [ParityVolume, 1],
  ];

  create() {
    Sun.setTimeOfDay(HOUR);
    if (BAR === 'mesh') ParityWall.spawn({ x: X, y: Y });
    else if (BAR === 'volume') ParityVolume.spawn({ x: X, y: Y });
    else ParitySprite.spawn({ x: X, y: Y });
    Camera.centerOn(640, 360);
  }
}
