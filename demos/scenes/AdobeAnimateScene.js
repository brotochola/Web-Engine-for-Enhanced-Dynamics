import { AdobeAnimateCharacter } from '/demos/gameObjects/adobeAnimateCharacter.js';

import WEED from '/src/index.js';
const { Scene, Camera, Mouse } = WEED;



export class AdobeAnimateScene extends Scene {
  static config = {
    worldWidth: 20600,
    worldHeight: 15000,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: true,
    },
    logic: {
      noLimitFPS: true,
    },
    physics: {
      noLimitFPS: true,
      gravity: { x: 0, y: 0 },
      sleepThreshold: 999,
      wakeUpThreshold: -1,
      sleepDuration: 30,
    },
    particle: {
      noLimitFPS: true,
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      noLimitFPS: true,
      maxVisibleRenderables: 100000,
      ySorting: true,
    },
    lighting: {
      enabled: false,
    },
  };

  static assets = {
    AdobeAnimateAnimations: {
      blue_character: {
        atlas: '/demos/img/adobe_blue_character/spritemap1.json',
        animation: '/demos/img/adobe_blue_character/Animation.json',
        png: '/demos/img/adobe_blue_character/spritemap1.png',
      },
      willian: {
        atlas: '/demos/fla/willian/spritemap1.json',
        animation: '/demos/fla/willian/Animation.json',
        png: '/demos/fla/willian/spritemap1.png',
      },
    },
  };

  static entities = [[AdobeAnimateCharacter, 20000]];

  constructor(game) {
    super(game);
    this.cameraFollowX = this.config.worldWidth * 0.5;
    this.cameraFollowY = this.config.worldHeight * 0.5;
    this._lastClipKey = '';
  }

  create() {

    // Set up grid parameters
    const totalCharacters = 10000;
    const gridCols = Math.sqrt(totalCharacters);
    const gridRows = gridCols
    const spacingX = 50;
    const spacingY = 50;
    const startX = this.cameraFollowX
    const startY = this.cameraFollowY

    for (let i = 0; i < totalCharacters; i++) {
      const col = i % gridCols;
      const row = Math.floor(i / gridCols);
      this.spawnEntity(AdobeAnimateCharacter, {
        x: startX + col * spacingX,
        y: startY + row * spacingY,
        // clipName: 'idle',
        playbackRate: 1 + i * 0.001,
        scaleX: 0.25,
        scaleY: 0.25,
      });
    }

    Camera.centerOn(this.cameraFollowX, this.cameraFollowY);
    Camera.setZoom(1.4);
  }

  update() {
    const kb = this.keyboard;
    const panSpeed = 18 / Camera.zoom;

    if (kb.w || kb.arrowup) this.cameraFollowY -= panSpeed;
    if (kb.s || kb.arrowdown) this.cameraFollowY += panSpeed;
    if (kb.a || kb.arrowleft) this.cameraFollowX -= panSpeed;
    if (kb.d || kb.arrowright) this.cameraFollowX += panSpeed;

    this.cameraFollowX = Math.max(0, Math.min(this.cameraFollowX, this.config.worldWidth));
    this.cameraFollowY = Math.max(0, Math.min(this.cameraFollowY, this.config.worldHeight));

    Camera.follow(this.cameraFollowX, this.cameraFollowY, 0.18);
    Camera.setZoom(Camera.zoom * (1 - Mouse.wheel * 0.08));

    // if (kb.j) this.setAllCharactersClip('idle', 'one');
    // if (kb.two) this.setAllCharactersClip('running', 'two');
    // if (kb.three) this.setAllCharactersClip('jumping', 'three');
  }

  setAllCharactersClip(clipName, keyId) {
    if (this._lastClipKey === keyId) return;
    this._lastClipKey = keyId;

    const instances = AdobeAnimateCharacter.instances;
    for (let i = 0; i < instances.length; i++) {
      const character = instances[i];
      if (character && character.active) {
        character.adobeAnimComponent.play(clipName, true);
      }
    }
  }
}
