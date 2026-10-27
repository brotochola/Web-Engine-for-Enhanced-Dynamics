import WEED from '/src/index.js';
import { BluePlatformerPlayer } from './gameObjects/bluePlatformerPlayer.js';
import { Platform } from './gameObjects/platform.js';
import { Goal } from './gameObjects/goal.js';

const { Scene, Camera, Transform, Layer, BLEND_MODES } = WEED;

const BLOOM_LAYER = 'bloom';
const BLOOM_RESOLUTION = 1;
/** The player's name in every level file. */
const PLAYER = 'Player';

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
      raycasted: false,
      maxPolygonVertices: 5000,
    },
    layers: {
      // bloom: {
      //   zIndex: 3.5,
      //   blendMode: BLEND_MODES.NORMAL,
      //   resolution: BLOOM_RESOLUTION,
      //   maxItems: 2048,
      //   ySorting: false,
      //   shader: {
      //     fragment: 'bloom',
      //     containerBlend: BLEND_MODES.NORMAL,
      //     uniforms: {
      //       uThreshold: { value: 0.05, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Threshold', tip: 'Luma below this does not bloom.' },
      //       uIntensity: { value: 0.4, type: 'f32', min: 0, max: 4, step: 0.05, label: 'Intensity', tip: 'How strong the glow add is.' },
      //       uBlurSize: { value: 12, type: 'f32', min: 1, max: 30, step: 1, label: 'Blur', tip: 'StackBlur radius in pixels (1–8).' },
      //       uTexelSize: { value: [0.002, 0.002], type: 'vec2<f32>' },
      //     },
      //   },
      // },
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
      // bloom: '/demos/shaders/bloom.frag',
    },
  };

  static entities = [
    // One player, and a free slot: the editor respawns it on each edit before the old one's slot is free.
    [BluePlatformerPlayer, 2],
    [Platform, 64],
    [Goal, 4],
  ];

  // Loaded by this module (benches, old links), the scene places what its first level file does.
  static defaultSceneFile = './levels/1-1.scene.json';

  constructor(game) {
    super(game);
    this.playerIndex = -1;
  }

  // The player, the platforms and the goal are in the level's scene file (levels/1-1.scene.json, 1-2, …): the
  // player is its Player record, where it starts and its params (BluePlatformerPlayer.spawnParams).
  create() {
    Camera.setZoom(1.25);
    // this._syncBloomTexels();
    this.playerIndex = this.getByName(PLAYER)?.index ?? -1;
    if (this.playerIndex >= 0) Camera.centerOn(Transform.x[this.playerIndex], Transform.y[this.playerIndex]);
    // The player reached a goal (Goal.onCollisionEnter, on a logic worker): the next level.
    this.on('goalReached', (_data, goalIndex) => this.goToNextLevel(goalIndex));
  }

  /**
   * Load the level the reached goal names, relative to this level's file. Another level of
   * this scene class is a fast swap: the workers, memory and atlas stay. What carries over
   * travels in data (levels done so far). A second touch while the level loads is ignored.
   * @param {number} goalIndex
   */
  goToNextLevel(goalIndex) {
    if (this.game.isTransitioning) return;
    const goal = this.sceneFile?.entities.find((e) => e.class === 'Goal' && this.getByName(e.name)?.index === goalIndex);
    const next = goal?.config?.next;
    if (!next) return;
    const levelsDone = (this.data?.levelsDone ?? 0) + 1;
    this.game.loadScene(new URL(next, this.sceneFileUrl).href, { data: { levelsDone } });
  }

  _syncBloomTexels() {
    const w = Camera.canvasWidth * BLOOM_RESOLUTION;
    const h = Camera.canvasHeight * BLOOM_RESOLUTION;
    if (w <= 0 || h <= 0) return;
    if (w === this._bloomRtW && h === this._bloomRtH) return;
    this._bloomRtW = w;
    this._bloomRtH = h;
    Layer.get(BLOOM_LAYER).setUniform('uTexelSize', [1 / w, 1 / h]);
  }

  update() {
    // this._syncBloomTexels();
    // By name each frame: the editor respawns the player when one of its params changes, at another index.
    const player = this.getByName(PLAYER);
    if (player === null) return; // a level without one
    this.playerIndex = player.index;
    this._playerX = Transform.x[this.playerIndex];
    this._playerY = Transform.y[this.playerIndex];
    Camera.follow(this._playerX, this._playerY, 0.15);
  }
}
