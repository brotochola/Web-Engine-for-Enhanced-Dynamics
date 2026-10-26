// Mesh Gallery — one LAYER_KIND.MESH layer that shows every MeshRenderer path.
//
// The picture is not the collider. MeshRenderer draws on the "gallery" layer.
// renderer.maxMeshVerts / maxMeshIndices size the shared vertex and index arenas
// (both default to 0, which is why this scene sets them). Indices are uint16 up
// to 65535 vertices and uint32 past that (maxMeshVerts caps at 1048576).
//
// Top row has no RigidBody and no Collider. Transform is the only pose.
//   fan      setMesh(positions)              convex fan, solid tint
//   quad     setMesh(positions, indices, uvs) skewed quad, rocky texture
//   polygon  setPolygon + setTileLocal        concave arrow, tiled in local space
//   plane    setPlane, then setVertices       rocky grid that waves every tick
//   rope     setRope                          rocky strip, same point count each tick
//
// Bottom row has a body. Gravity is +Y (down the screen). The floor is static.
//   floor    collider box only                dark fill, no setMesh
//   crate    collider box + visualOutset      rocky world-tile fill, never setMesh
//   gem      small box collider + setMesh     cyan diamond, not the same shape as the box
//   toggle   static box + setPolygon          orange star for ~3s, then clearMesh
//            reveals the outset rocky box that was hidden under the star
//
// Debug UI → Visual Aids → Meshes strokes the triangles on top of the picture.
// Magenta is an authored mesh, cyan means per-vertex UVs, orange is the collider fill.
// Colliders (green / gray) stays a separate toggle, so the gem's box and diamond
// can be on screen at the same time.
//
// Drag to pan. The camera starts centered on the gallery.

import { MeshPicture, MeshBody } from './gameObjects/meshExhibits.js';
import WEED from '/src/index.js';

const { Scene, Camera, LAYER_KIND } = WEED;

const WORLD_W = 1400;
const WORLD_H = 980;

export class MeshGalleryScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,

    spatial: {
      cellSize: 120,
      maxNeighbors: 32,
      noLimitFPS: false,
    },

    logic: {
      noLimitFPS: false,
    },

    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
    },

    physics: {
      subStepCount: 4,
      noLimitFPS: false,
      gravity: { x: 0, y: 1600 },
      sleeping: true,
    },

    renderer: {
      backend: 'webgpu',
      noLimitFPS: false,
      maxMeshVerts: 4096,
      maxMeshIndices: 8192,
    },

    lighting: {
      enabled: false,
    },

    layers: {
      gallery: {
        kind: LAYER_KIND.MESH,
        zIndex: 2,
      },
    },
  };

  static assets = {
    textures: {
      rocky: '/demos/img/rocky.jpg',
    },
  };

  static entities = [
    [MeshPicture, 8],
    [MeshBody, 8],
  ];

  create() {
    const cx = WORLD_W * 0.5;
    const cy = WORLD_H * 0.46;
    Camera.setFree(true, { panSpeed: 12 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
    Camera.setZoom(1);
  }

  createNewGame() {
    MeshPicture.spawn({ x: 160, y: 170, kind: 'fan' });
    MeshPicture.spawn({ x: 430, y: 180, kind: 'quad' });
    MeshPicture.spawn({ x: 700, y: 180, kind: 'polygon' });
    MeshPicture.spawn({ x: 1080, y: 190, kind: 'plane' });
    MeshPicture.spawn({ x: 520, y: 430, kind: 'rope' });

    MeshBody.spawn({ x: WORLD_W * 0.5, y: 930, kind: 'floor', static: 1 });
    MeshBody.spawn({ x: 360, y: 560, kind: 'crate' });
    MeshBody.spawn({ x: 1120, y: 520, kind: 'gem' });
    MeshBody.spawn({ x: 980, y: 430, kind: 'toggle', static: 1 });
  }
}
