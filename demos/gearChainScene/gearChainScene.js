// Gear Chain — one static chain loop shaped like a cog, drawn by MeshRenderer.
//
// The chain is the collision. The mesh is the picture of the same outline.
// A chain edge is solid on the side of its right-hand normal. For an edge
// that runs +X, that side is -Y. Weed +Y points down the screen, so a loop
// walked by decreasing angle keeps the interior solid and lets the balls
// pile up inside the teeth instead of falling through.
//
// The gear has no RigidBody: a collider-only entity is a static body.
// Balls are the dynamic circles from the Balls demo, on the sprite layer,
// drawn in front of the mesh.

import { Ball } from '../ballsScene/gameObjects/ball.js';
import WEED from '/src/index.js';

const { Scene, GameObject, Camera, Collider, MeshRenderer, LAYER_KIND, rng } = WEED;

const WORLD_W = 2000;
const WORLD_H = 2000;
const TEETH = 8;
const INNER_R = 600;
const OUTER_R = 820;
const BALLS = 5000;

function gearOutline(teeth, innerR, outerR) {
  const xy = new Float32Array(teeth * 8);
  const step = (Math.PI * 2) / teeth;
  let o = 0;
  for (let i = 0; i < teeth; i++) {
    const a = -i * step;
    const ang = [a, a - step * 0.22, a - step * 0.5, a - step * 0.72];
    const rad = [innerR, outerR, outerR, innerR];
    for (let k = 0; k < 4; k++) {
      xy[o++] = Math.cos(ang[k]) * rad[k];
      xy[o++] = Math.sin(ang[k]) * rad[k];
    }
  }
  return xy;
}

const GEAR = gearOutline(TEETH, INNER_R, OUTER_R);

class Gear extends GameObject {
  static components = [Collider, MeshRenderer];

  onSpawned() {
    this.setLayer('gear');
    this.collider.friction = 0.4;
    this.collider.restitution = 0.05;
    if (!this.collider.setChain(GEAR, GEAR.length >> 1, true)) {
      console.warn('Gear chain was rejected');
    }
    this.meshRenderer.tint = 0x5c6b73;
    this.meshRenderer.setPolygon(GEAR);
  }
}

export class GearChainScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,

    spatial: {
      cellSize: 96,
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
      maxChainPoints: 256,
    },

    renderer: {
      backend: 'webgpu',
      noLimitFPS: false,
      maxMeshVerts: 1024,
      maxMeshIndices: 2048,
    },

    lighting: {
      enabled: false,
    },

    layers: {
      gear: {
        kind: LAYER_KIND.MESH,
        zIndex: 2,
      },
    },
  };

  static assets = {
    textures: {
      ball: '/demos/img/bola.png',
    },
  };

  static entities = [
    [Gear, 1],
    [Ball, BALLS],
  ];

  create() {
    const cx = WORLD_W * 0.5;
    const cy = WORLD_H * 0.5;
    Camera.setFree(true, { panSpeed: 12 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
    Camera.setZoom(1);
  }

  createNewGame() {
    const cx = WORLD_W * 0.5;
    const cy = WORLD_H * 0.5;
    Gear.spawn({ x: cx, y: cy });

    const spawnR = INNER_R - 80;
    for (let i = 0; i < BALLS; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * spawnR;
      Ball.spawn({
        x: cx + Math.cos(ang) * rad,
        y: cy + Math.sin(ang) * rad,
        radius: 5,
      });
    }
  }
}
