import { AdobeAnimateCharacter } from './gameObjects/adobeAnimateCharacter.js';

import WEED from '/src/index.js';
const { Scene, Camera } = WEED;

// `?adobeTablesMB=<n>` sizes the Adobe tables' region (preRender.adobeTablesMB, default 4): with physics on, the
// region is part of the block reserved in Box2D's heap before the world, so its size moves the world's arrays
// (REVIEW_PLAN N-74).
function queryTablesMB() {
  try {
    const n = parseInt(new URLSearchParams(globalThis.location?.search || '').get('adobeTablesMB'), 10);
    return n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
const TABLES_MB = queryTablesMB();

export class AdobeAnimateScene extends Scene {
  static config = {
    worldWidth: 20600,
    worldHeight: 15000,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 64,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
    },
    physics: {
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: false,
      commandRingCapacity: 65535
    },
    particle: {
      noLimitFPS: false,
      maxParticles: 0,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySort: true,
      maxVisibleRenderables: 350000,
    },
    lighting: {
      enabled: false,
    },
    preRender: {
      // packGpuSprites: 'pixi',
      // sortSprites: 'pixi',
      ...(TABLES_MB === undefined ? {} : { adobeTablesMB: TABLES_MB }),
    }
  };

  static assets = {
    AdobeAnimateAnimations: {
      blue_character: {
        atlas: '/demos/img/adobe_blue_character/spritemap1.json',
        animation: '/demos/img/adobe_blue_character/Animation.json',
        png: '/demos/img/adobe_blue_character/spritemap1.png',
      },
      willian: {
        atlas: '/demos/fla/willian/willian2/spritemap1.json?df=2',
        animation: '/demos/fla/willian/willian2/Animation.json?dfdfd=55',
        png: '/demos/fla/willian/willian2/spritemap1.png?fdfdf=55',
      },
    },
  };

  static entities = [[AdobeAnimateCharacter, 20000]];

  constructor(game) {
    super(game);
    this._lastClipKey = '';
  }

  create() {
    const cx = this.config.worldWidth * 0.5;
    const cy = this.config.worldHeight * 0.5;
    Camera.setFree(true, { panSpeed: 18, zoomSensitivity: 0.001, smoothing: 0.18 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
    Camera.setZoom(1.4);

    this.createNewGame();
  }

  createNewGame() {
    const cx = this.config.worldWidth * 0.5;
    const cy = this.config.worldHeight * 0.5;
    const totalCharacters = 10000;
    const gridCols = Math.sqrt(totalCharacters);
    const spacingX = 50;
    const spacingY = 50;
    const startX = cx;
    const startY = cy;

    for (let i = 0; i < totalCharacters; i++) {
      const col = i % gridCols;
      const row = Math.floor(i / gridCols);
      AdobeAnimateCharacter.spawn({
        x: startX + col * spacingX,
        y: startY + row * spacingY,
        playbackRate: 1 + i * 0.001,
        scaleX: 0.25,
        scaleY: 0.25,
      });
    }
  }

  update() {
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
