// zenithalParticleTestScene.js - Test zenithal particles: Z renders as scale, decals on floor
// Click (button 0) to emit blood particles that stamp decals on the floor

import WEED from '/src/index.js';
import { ZenithalCar } from './gameObjects/zenithalCar.js';
import { ZenithalLight } from './gameObjects/zenithalLight.js';

const { rng, ParticleEmitter, Scene, Camera, Mouse, Transform, RigidBody, LAYER_KIND } = WEED;

const DRAG_PICK_RADIUS_SQ = 50 * 50;

export class ZenithalParticleTestScene extends Scene {
  static config = {
    worldWidth: 1920,
    worldHeight: 1080,

    particle: {
      maxParticles: 2000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
      zenithalMaxHeight: 100,
      zenithalScaleFactor: 1,
      zenithalAlphaFade: 0.2,
    },

    logic: { noLimitFPS: false },
    physics: { gravity: { x: 0, y: 0 }, noLimitFPS: false },
    spatial: { noLimitFPS: false, cellSize: 128, maxNeighbors: 64 },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySorting: false,
      maxVisibleRenderables: 5000
    },

    lighting: {
      enabled: true,
      // Umbra = this floor under multiply. 0.05 reads as pitch black; soft
      // casted-shadow sprites used ~0.33 alpha (much lighter). Raycasted path
      // disables CASTED_SHADOWS cookies so this is the only umbra control.
      baseAmbient: 0.15,
      maxLights: 20,
      shadowsEnabled: true,
      maxShadowCastingLights: 5,
      maxShadowsPerLight: 10,
      maxShadowSprites: 200,
      resolution: 0.5,
      // shadowResolution: 0.5,
      raycasted: true,
      maxPolygonVertices: 5000,
    },

    layers: {
      ground: {
        kind: LAYER_KIND.TILEMAP,
        tilemap: 'roads_tilemap',
        scale: 1,
        zIndex: 0.5,
      },
    },
  };

  static assets = {
    textures: {
      blood: '/demos/img/blood.png',
      zenithal_car: '/demos/img/zenithal_car.png',
    },
    tilemaps: {
      roads_tilemap: {
        json: '/demos/map_n_flowfield/tilemap.json',
        png: '/demos/img/tilemap/2.png',
      },
    },
  };

  static entities = [
    [ZenithalCar, 100],
    [ZenithalLight, 10],
  ];

  create() {
    Camera.centerOn(this.config.worldWidth / 2, this.config.worldHeight / 2);
    Camera.setZoom(1.2);


  }

  

  createNewGame() {
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    for (let i = 0; i < 100; i++) {
      ZenithalCar.spawn({ x: i * 50, y: i * 80 });
    }
    ZenithalLight.spawn({ x: cx, y: cy });


  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.001));

    // --- Drag-and-drop cars ---
    if (Mouse.isButton0Down && this._dragIdx == null) {
      let bestDist = DRAG_PICK_RADIUS_SQ;
      let bestIdx = null;
      for (const idx of ZenithalCar.getAllActive()) {
        const dx = Transform.x[idx] - Mouse.x;
        const dy = Transform.y[idx] - Mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = idx; }
      }
      this._dragIdx = bestIdx;
    }

    if (this._dragIdx != null) {
      if (Mouse.isButton0Down) {
        const body = this.getEntityView(this._dragIdx, { cache: true });
        body.setPosition(Mouse.x, Mouse.y);
        body.setVelocity(0, 0);
        RigidBody.sleeping[this._dragIdx] = 0;
      } else {
        this._dragIdx = null;
      }
    }

    // --- Blood particles on click (only when not dragging) ---
    if (Mouse.isButton0Down && this._dragIdx == null) {
      ParticleEmitter.emitZenithal({
        x: Mouse.x,
        y: Mouse.y,
        // Random height / kick — fixed speed was painting a perfect landing ring
        z: { min: -140, max: -40 },
        texture: 'blood',
        count: 12,
        angleXY: { min: 0, max: 360 },
        speed: { min: 1, max: 14 },
        vz: { min: -12, max: 4 },
        gravity: 1,
        stayOnTheFloor: true,
        scale: { min: 0.7, max: 1.3 },
        lifespan: 10000,
      });
    }
  }
}
