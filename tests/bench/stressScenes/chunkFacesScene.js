import WEED from '/src/index.js';
import { face } from './faces/faceLightLayout.js';

const { Scene, GameObject, SpriteRenderer, ParticleEmitter, Camera, Decoration, LAYER_KIND } = WEED;

/**
 * N-463's picture: the entities batch drawn in chunks (gpuParticleChunks.js) while it takes pixel depth with faces and an
 * atlas where some frame has heights. Then the batch's opaque pass is two programs over the same instances (E-378, E-500):
 * its own keeps the frames with heights (the LPC people, civil1 with its height map), its vertex-depth twin the others
 * (the grey floor, the green posts, the walls: faces on plain white decorations). A GPU particle group sorted among the
 * entities (sortWithEntities) splits the batch into chunks, one behind the group and one in front.
 *
 * The barrio's camera (floor drawn 0.5 as tall as wide, a px of height 0.866 px up the screen), a nearest atlas (every
 * pixel solid or empty: no soft edge, so the edge pass draws nothing over the solid ones), no lighting. Nothing moves: for
 * compareCaptures.mjs, the chunked drawing against the batch's own (`--query-b group=0`).
 *
 * `?group=` 1 (default): one group that is never born in the run (it draws no pixel, yet the batch is drawn in chunks
 * around it); 0: none (the batch draws itself, unchunked); `show`: the group's particles drawn, a red puff between the
 * rows, still. `?groupAtMs=` (default 500): when the logic worker emits the group, after the faces turned the depth
 * programs on. `?zoom=` (default 2), `?nearest=0` (a linear atlas), `?indexed=0`, `?backend=webgpu`.
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const GROUP = P?.get('group') === '0' ? 'none' : P?.get('group') === 'show' ? 'show' : 'unborn';
const GROUP_AT_MS = Math.max(0, num('groupAtMs', 500));
const ZOOM = num('zoom', 2);
const NEAREST = P?.get('nearest') !== '0';
const INDEXED = P?.get('indexed') !== '0';
const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const W = 640;
const H = 360;
const GROUND = 0.5;
const HEIGHT = 0.866025403784;
/** The group's row on the screen: between the back rows (y 110, 140) and the front ones (y 230, 280). */
const GROUP_Y = 185;
/** Longer than any run. */
const NEVER_MS = 3.6e6;

export const stressSceneConfig = {
  requested: { group: GROUP, groupAtMs: GROUP_AT_MS, zoom: ZOOM, nearest: NEAREST ? 1 : 0, indexed: INDEXED ? 1 : 0, backend: BACKEND },
};

/** A green post: a plain sprite without maps (the vertex-depth twin's), standing on its foot. */
class Post extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('_white');
    this.setAnchor(0.5, 1);
    this.setDisplaySize(10, 44);
    this.setTint(0x3c9a4a);
  }
}

/** An LPC person facing the camera, held on its first frame: a frame with heights (the batch's own program's). */
class Person extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('civil1');
    this.setAnimation('idle_down');
    this.spriteRenderer.animationSpeed = 0;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 62 / 64;
    this.setScale(0.8, 0.8);
  }
}

/** Emits the GPU particle group once, `?groupAtMs=` into the run, from the logic worker. */
class GroupEmitter extends GameObject {
  static components = [];

  onSpawned() {
    this.elapsedMs = 0;
    this.emitted = false;
  }

  tick(dtRatio, deltaTime) {
    if (this.emitted || GROUP === 'none') return;
    this.elapsedMs += deltaTime;
    if (this.elapsedMs < GROUP_AT_MS) return;
    this.emitted = true;
    const show = GROUP === 'show';
    ParticleEmitter.emitGpu({
      layer: 'puff',
      count: show ? 24 : 4,
      x: { min: W / 2 - 20, max: W / 2 + 20 },
      y: { min: GROUP_Y - 6, max: GROUP_Y + 6 },
      speed: 0,
      gravity: 0,
      // Unborn: its draw costs vertices and no fragment, and the painter still sorts it among the entities.
      delay: show ? 0 : NEVER_MS,
      lifespan: NEVER_MS,
      scale: 0.25,
      alpha: 1,
      tint: 0xe03020,
      texture: '_whiteCircle_64x64',
      sortY: GROUP_Y,
    });
  }
}

export class ChunkFacesScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x463,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 64 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { enabled: false },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 32 },
    renderer: {
      backend: BACKEND,
      ySort: true,
      indexedSprites: INDEXED,
      atlasScaleMode: NEAREST ? 'nearest' : 'linear',
    },
    camera: { floorScaleY: GROUND, heightScaleY: HEIGHT },
    lighting: { enabled: false },
    layers: {
      puff: { kind: LAYER_KIND.GPU_PARTICLES, zIndex: 3.5, maxParticles: 4096, sortWithEntities: true },
    },
  };

  static assets = {
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png', heightMap: '/demos/img/civil1_h.png' },
    },
  };

  static entities = [[Post, 12], [Person, 12], [GroupEmitter, 1]];

  create() {
    // The floor: a grey sheet hung from the world's north edge (its foot, where pixel depth puts a sprite without heights,
    // behind everything; its sort key first).
    Decoration.spawn({ x: W / 2, y: 0, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0, tint: 0x6c6a62 });
    // Walls looking at the camera (faces): two behind the group, two in front. The floor point (x, y, z) is on the screen
    // at (x, y·0.5 − z·0.866); a wall sorts at its foot.
    const walls = [
      { x: 70, footY: 140, w: 120, h: 60, tint: 0xd8c8a0 },
      { x: 380, footY: 110, w: 150, h: 70, tint: 0xa0b8d8 },
      { x: 120, footY: 280, w: 140, h: 50, tint: 0xd8a0a0 },
      { x: 420, footY: 250, w: 130, h: 64, tint: 0xc0d8a0 },
    ];
    for (const wall of walls) {
      const f = face('wall', [wall.x, wall.footY / GROUND, wall.h], [wall.w, 0, 0], [0, 0, -wall.h], GROUND, HEIGHT);
      Decoration.spawn({
        x: f.x,
        y: f.y,
        texture: '_white',
        scaleX: f.scaleX / 8,
        scaleY: f.scaleY / 8,
        skewX: f.skewX,
        skewY: f.skewY,
        anchorX: 0.5,
        anchorY: 0.5,
        sortOffsetY: wall.footY - f.y,
        tint: wall.tint,
        faceNormalX: f.normal[0],
        faceNormalY: f.normal[1],
        faceNormalZ: f.normal[2],
        faceHeight: f.height,
      });
    }
    // Posts and people in four rows, two behind the group's row and two in front, some in front of a wall's foot.
    const rows = [110, 140, 230, 280];
    for (let r = 0; r < rows.length; r++) {
      for (let k = 0; k < 3; k++) {
        const x = 60 + k * 200 + r * 30;
        Post.spawn({ x, y: rows[r] + 6 });
        Person.spawn({ x: x + 50, y: rows[r] + 8 });
      }
    }
    GroupEmitter.spawn();
    Camera.setZoom(ZOOM);
    Camera.centerOn(W / 2, H / 2);
  }
}
