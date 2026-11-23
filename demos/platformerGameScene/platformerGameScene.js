import WEED from '/src/index.js';
import { BluePlatformerPlayer } from './gameObjects/bluePlatformerPlayer.js';
import { Platform } from './gameObjects/platform.js';

const { Scene, Camera, Transform, BLEND_MODES } = WEED;

const BLOOM_LAYER = 'bloom';
const BLOOM_RESOLUTION = 1;

export class PlatformerGameScene extends Scene {
  static config = {
    worldWidth: 5200,
    worldHeight: 2200,
    spatial: {
      cellSize: 96,
      maxNeighbors: 256,
      numberOfSpatialWorkers: 1,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
    },
    physics: {
      noLimitFPS: false,
      gravity: { x: 0, y: 3600 },
      sleeping: false,
    },
    particle: {
      noLimitFPS: false,
      maxParticles: 9990,
      decals: false,
    },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      ySort: false,
      maxVisibleRenderables: 10000,
    },
    preRender: {
      noLimitFPS: false,
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
      maxPolygonVertices: 5000,
    },
    layers: {
      bloom: {
        zIndex: 3.5,
        blendMode: BLEND_MODES.NORMAL,
        resolution: BLOOM_RESOLUTION,
        maxItems: 2048,
        ySorting: false,
        shader: {
          // Two passes: the bright parts blurred along x at half size, then along y and added to the layer's picture.
          passes: [{ fragment: 'bloomRows', resolution: 0.5 }, { fragment: 'bloomColumns' }],
          containerBlend: BLEND_MODES.NORMAL,
          uniforms: {
            uThreshold: { value: 0.05, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Threshold', tip: 'Luma below this does not bloom.' },
            uIntensity: { value: 0.4, type: 'f32', min: 0, max: 4, step: 0.05, label: 'Intensity', tip: 'How strong the glow add is.' },
            uBlurSize: { value: 12, type: 'f32', min: 1, max: 30, step: 1, label: 'Blur', tip: 'StackBlur radius in pixels (1–8).' },
          },
        },
      },
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
    shaders: {
      bloomRows: { webgl: '/demos/shaders/bloomRows.frag', webgpu: '/demos/shaders/bloomRows.wgsl' },
      bloomColumns: { webgl: '/demos/shaders/bloomColumns.frag', webgpu: '/demos/shaders/bloomColumns.wgsl' },
    },
  };

  static entities = [
    [BluePlatformerPlayer, 1],
    [Platform, 64],
  ];

  constructor(game) {
    super(game);
    this.playerIndex = -1;
  }

  create() {
    this.spawnLevelPlatforms();
    Camera.setZoom(1.25);
  }

  createNewGame() {
    const playerHandle = BluePlatformerPlayer.spawn({
      x: 240,
      y: 1700,
      scaleX: 0.42,
      scaleY: 0.42,
      worldWidth: this.config.worldWidth,
      worldHeight: this.config.worldHeight,
      layer: BLOOM_LAYER,
    });

    this.playerIndex = playerHandle.index;
    const startX = this.playerIndex >= 0 ? Transform.x[this.playerIndex] : 240;
    const startY = this.playerIndex >= 0 ? Transform.y[this.playerIndex] : 1700;
    Camera.centerOn(startX, startY);

  }

  spawnLevelPlatforms() {
    const defs = [
      { x: 600, y: 2050, width: 1200, height: 60, tint: 0x5a708f },
      { x: 1820, y: 1760, width: 420, height: 50, tint: 0x4f6983 },
      { x: 2300, y: 1630, width: 280, height: 44, tint: 0x4f6983 },
      { x: 2670, y: 1700, width: 260, height: 44, tint: 0x4f6983 },
      { x: 3070, y: 1560, width: 300, height: 44, tint: 0x4f6983 },
      { x: 3520, y: 1720, width: 420, height: 44, tint: 0x4f6983 },
      { x: 4020, y: 1880, width: 500, height: 54, tint: 0x5a708f },
      { x: 4680, y: 2040, width: 920, height: 60, tint: 0x5a708f },
      { x: 1260, y: 1740, width: 220, height: 36, tint: 0x7289a5 },
      { x: 1500, y: 1620, width: 180, height: 32, tint: 0x7289a5 },
      { x: 3320, y: 1400, width: 170, height: 32, tint: 0x7289a5 },
      { x: 4560, y: 1650, width: 180, height: 32, tint: 0x7289a5 },
      // A step up from the start ground: the jump rises about 245 px, the platform at 1260 needs 298.
      { x: 960, y: 1886, width: 180, height: 32, tint: 0x7289a5 },
    ];

    for (let i = 0; i < defs.length; i++) {
      defs[i].layer = BLOOM_LAYER;
      Platform.spawn(defs[i]);
    }
  }

  update() {
    this._playerX = Transform.x[this.playerIndex];
    this._playerY = Transform.y[this.playerIndex];
    Camera.follow(this._playerX, this._playerY, 0.15);
  }
}
