import { AdobeAnimateCharacter } from '/demos/gameObjects/adobeAnimateCharacter.js';

import WEED from '/src/index.js';
const { Scene, Camera, Mouse } = WEED;

const CLIPS = ['idle', 'running', 'jumping'];

export class AdobeAnimateScene extends Scene {
  static config = {
    worldWidth: 3600,
    worldHeight: 2200,
    spatial: {
      numberOfSpatialWorkers: 2,
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
    },
    particle: {
      noLimitFPS: true,
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      noLimitFPS: true,
      maxVisibleRenderables: 12000,
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
    },
  };

  static entities = [[AdobeAnimateCharacter, 512]];

  constructor(game) {
    super(game);
    this.cameraFollowX = this.config.worldWidth * 0.5;
    this.cameraFollowY = this.config.worldHeight * 0.5;
    this._lastClipKey = '';
  }

  create() {
    this.spawnEntity(AdobeAnimateCharacter, {
      x: this.config.worldWidth * 0.5,
      y: this.config.worldHeight * 0.65,
      clipName: 'running',
      playbackRate: 1,
      scaleX: 1,
      scaleY: 1,
    });

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

    if (kb.one) this.setAllCharactersClip('idle', 'one');
    if (kb.two) this.setAllCharactersClip('running', 'two');
    if (kb.three) this.setAllCharactersClip('jumping', 'three');
  }

  setAllCharactersClip(clipName, keyId) {
    if (this._lastClipKey === keyId) return;
    this._lastClipKey = keyId;

    const instances = AdobeAnimateCharacter.instances;
    for (let i = 0; i < instances.length; i++) {
      const character = instances[i];
      if (character && character.active) {
        character.playAdobeClip(clipName, true);
      }
    }
  }
}
