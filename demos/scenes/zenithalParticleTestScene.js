// zenithalParticleTestScene.js - Test zenithal camera view: Z renders as scale, decals on floor
// Click (button 0) to emit blood particles that stamp decals on the floor

import WEED from '/src/index.js';

const { ParticleEmitter, Scene, Camera, Mouse, enums } = WEED;
const { CAMERA_TYPES } = enums;

export class ZenithalParticleTestScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,

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
    renderer: { noLimitFPS: true, ySorting: true },
  };

  static assets = {
    textures: {
      blood: '/demos/img/blood.png',
    },
  };

  static entities = [
    // [ZenithalParticleSpawner, 1],
  ];

  create() {
    Camera.centerOn(this.config.worldWidth / 2, this.config.worldHeight / 2);
    Camera.setZoom(1.2);
    // this.spawnEntity(ZenithalParticleSpawner, { x: this.config.worldWidth / 2, y: this.config.worldHeight / 2 });
  }

  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {

    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.001));

    if (Mouse.isButton0Down) {

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
