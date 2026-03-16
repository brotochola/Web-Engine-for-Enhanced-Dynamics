// zenithalParticleTestScene.js - Test zenithal camera view: Z renders as scale, decals on floor
// Click (button 0) to emit blood particles that stamp decals on the floor

import WEED from '/src/index.js';
import { Layer } from '/src/core/Layer.js';
import { ZenithalCar } from '../gameObjects/zenithalCar.js';
import { ZenithalLight } from '../gameObjects/zenithalLight.js';
const { ParticleEmitter, Scene, Camera, Mouse, Transform, RigidBody, enums } = WEED;
const { CAMERA_TYPES } = enums;

const DRAG_PICK_RADIUS_SQ = 50 * 50;

export class ZenithalParticleTestScene extends Scene {
  static config = {
    worldWidth: 4000,
    worldHeight: 4000,

    particle: {
      maxParticles: 2000,
      decals: true,
      decalsTileSize: 256,
      decalsResolution: 0.5,
      cameraView: CAMERA_TYPES.ZENITHAL,
      zenithalMaxHeight: 100,
      zenithalScaleFactor: 1,
      zenithalAlphaFade: 0.2,
    },

    logic: { noLimitFPS: true },
    physics: { gravity: { x: 0, y: 0 }, noLimitFPS: true },
    spatial: { noLimitFPS: true, cellSize: 128, maxNeighbors: 64 },
    renderer: {
      noLimitFPS: true,
      ySorting: false,
      maxVisibleRenderables: 5000
    },

    lighting: {
      enabled: true,
      baseAmbient: 0.05,
      maxLights: 20,
      shadowsEnabled: true,
      maxShadowCastingLights: 5,
      maxShadowsPerLight: 10,
      maxShadowSprites: 200,
      resolution: 0.25,
      shadowResolution: 0.5,
      raycasted: true,
      maxPolygonVertices: 5000,
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
    [ZenithalCar, 10],
    [ZenithalLight, 5],
  ];

  async preload() {
    await Layer.get('BACKGROUND').setTilemapBackground('roads_tilemap', { scale: 1 });

  }

  create() {
    Camera.centerOn(this.config.worldWidth / 2, this.config.worldHeight / 2);
    Camera.setZoom(1.2);
    const cx = this.config.worldWidth / 2;
    const cy = this.config.worldHeight / 2;
    ZenithalCar.spawn({ x: cx, y: cy });
    ZenithalCar.spawn({ x: cx + 100, y: cy - 80 });
    ZenithalCar.spawn({ x: cx - 120, y: cy + 60 });

    ZenithalLight.spawn({ x: cx, y: cy - 150 });
    // ZenithalLight.spawn({ x: cx + 200, y: cy + 100 });

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
        Transform.x[this._dragIdx] = Mouse.x;
        Transform.y[this._dragIdx] = Mouse.y;
        RigidBody.px[this._dragIdx] = Mouse.x;
        RigidBody.py[this._dragIdx] = Mouse.y;
        RigidBody.vx[this._dragIdx] = 0;
        RigidBody.vy[this._dragIdx] = 0;
        RigidBody.sleeping[this._dragIdx] = 0;
      } else {
        this._dragIdx = null;
      }
    }

    // --- Blood particles on click (only when not dragging) ---
    if (Mouse.isButton0Down && this._dragIdx == null) {
      ParticleEmitter.emit({
        x: Mouse.x,
        y: Mouse.y,
        z: -100,
        texture: 'blood',
        count: 12,
        angleXY: { min: 0, max: 360 },
        speed: 10,
        vz: -10,
        gravity: 1,
        stayOnTheFloor: true,
        scale: 1,
        lifespan: 10000,
      });
    }
  }
}
