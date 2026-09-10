// liquidFunDemoScene.js - LiquidFun Particle Physics Demo Scene in WeedJS
// WASD pans. Q/E/R/F/G/T pick a liquid; LMB sprays at the cursor.
// Dynamic Box bodies fall into the tank with the fluids.
// Density: LAYER_DENSITY_SOURCE.LIQUID_FUN (procedural splat → dulceDeLeche look frag).

import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Box } from '/demos/ballsAndRectanglesScene/gameObjects/box.js';
import { Camera } from '/src/core/Camera.js';
import { BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } from '/src/core/ConfigDefaults.js';
import WEED from '/src/index.js';

const { Mouse, Keyboard, LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS, Layer } = WEED;

const F = LIQUIDFUN_FLAGS;
const GF = LIQUIDFUN_GROUP_FLAGS;

const LAYER = 'dulceDeLeche';

// Keys avoid WASD. Jelly is elastic (a group per burst) so it sprays slower.
// Ice = rigid+solid particle group (Google groupFlags), not a Box2D body.
const LIQUID_TOOLS = [
  { key: 'q', name: 'water', shape: 'circle', radius: 100, flags: F.WATER | F.TENSILE, viscousScale: 1, tint: 0x3399ff },
  { key: 'e', name: 'oil', shape: 'circle', radius: 130, flags: F.VISCOUS, viscousScale: 1, tint: 0x6b3a1f },
  { key: 'r', name: 'cream', shape: 'circle', radius: 130, flags: F.VISCOUS | F.TENSILE, viscousScale: 2, tint: 0xf5f0e1 },
  { key: 'f', name: 'dulceDeLeche', shape: 'circle', radius: 110, flags: F.VISCOUS | F.TENSILE, viscousScale: 10, tint: 0xc6862a },
  { key: 'g', name: 'jelly', shape: 'circle', radius: 70, flags: F.ELASTIC, strength: 0.55, viscousScale: 1, tint: 0x33ff66, grouped: true },
  { key: 't', name: 'sand', shape: 'box', halfWidth: 80, halfHeight: 80, flags: F.POWDER, viscousScale: 1, tint: 0xffcc00 },
  {
    key: 'y',
    name: 'ice',
    shape: 'box',
    halfWidth: 90,
    halfHeight: 60,
    flags: F.WATER,
    groupFlags: GF.SOLID | GF.RIGID,
    viscousScale: 1,
    tint: 0xaadfff,
    grouped: true,
  },
];

export class LiquidFunDemoScene extends WEED.Scene {
  static config = {
    worldWidth: 5000,
    worldHeight: 5000,
    debug: { collectDetailedStats: true },

    spatial: {
      cellSize: 128,
      maxNeighbors: 900,
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
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 2000 },
      sleeping: false,
      liquidFun: {
        enabled: true,
        radius: 16,
        maxCount: 20000,
        subSteps: 2,
      },
    },

    renderer: {
      noLimitFPS: false,
      maxVisibleRenderables: 120000,
    },

    preRender: {
      // interpolation: {
      //   mode: 'interpolate',
      // },
    },

    lighting: {
      enabled: false,
    },

    layers: {
      dulceDeLeche: {
        zIndex: 5,
        blendMode: BLEND_MODES.NORMAL,
        resolution: 1,
        scaleMode: LAYER_SCALE_MODE.LINEAR,
        maxItems: 0,
        ySorting: false,
        shader: {
          fragment: 'dulceDeLeche',
          containerBlend: BLEND_MODES.ADD,
          densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
          splat: {
            radius: 40,
            falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
            useParticleTint: true,
            intensity: 0.166,
          },
          uniforms: {
            uCutoff: { value: 0.29, type: 'f32' },
            uRim: { value: 0.4, type: 'f32' },
            uDepth: { value: 0.5, type: 'f32' },
            uBodyAlpha: { value: 0.85, type: 'f32' },
            uEdgeAlpha: { value: 0.7, type: 'f32' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
      ball: '/demos/img/bola.png',
    },
    shaders: {
      dulceDeLeche: '/demos/shaders/dulceDeLeche.wgsl',
    },
  };

  static entities = [
    [Floor, 50],
    [Box, 40],
  ];

  constructor(game) {
    super(game);
    this.spawnTimer = 0;
    this.liquidTool = 0;
    this._mouse0WasDown = false;
    this._hud = null;
    this._meltGroupId = -1;
    this._meltScale = 8;
  }

  create() {
    this.createEnvironment();
    this._createHud();

    Camera.setFree(true, { panSpeed: 15, zoomSensitivity: 0.001, maxZoom: 3 });
    Camera.setFreeTarget(2000, 1200);
    Camera.centerOn(2000, 1200);
    Camera.zoom = 0.3;
    Camera.setZoom(0.3);
    Camera.setWorldBounds(Infinity, Infinity);
  }

  createNewGame() {
    this.spawnBoxes();
    this.spawnParticleGroups();
  }

  async destroy() {
    this._removeHud();
    await super.destroy();
  }

  createEnvironment() {
    const floorX = 2000;
    const floorY = 2200;
    const floorW = 2400;
    const floorH = 260;
    const wallW = 260;
    const wallX0 = 800;
    const wallX1 = 3200;
    const wallTop = 400;
    const wallBottom = floorY;
    const wallH = wallBottom - wallTop;
    const wallY = (wallTop + wallBottom) / 2;

    this.spawnEntity(Floor, { x: floorX, y: floorY, width: floorW, height: floorH, tint: 0x444455 });
    this.spawnEntity(Floor, { x: wallX0, y: wallY, width: wallW, height: wallH, tint: 0x444455 });
    this.spawnEntity(Floor, { x: wallX1, y: wallY, width: wallW, height: wallH, tint: 0x444455 });

    this.spawnEntity(Floor, { x: 1400, y: 900, width: 800, height: 240, rotation: 0.4, tint: 0x667799 });
    this.spawnEntity(Floor, { x: 2600, y: 900, width: 800, height: 240, rotation: -0.4, tint: 0x667799 });

    this.spawnEntity(Floor, { x: 1800, y: 1300, width: 120, height: 240, rotation: -0.2, tint: 0x99aa88 });
    this.spawnEntity(Floor, { x: 2200, y: 1500, width: 120, height: 240, rotation: 0.2, tint: 0x99aa88 });
    this.spawnEntity(Floor, { x: 2000, y: 1750, width: 200, height: 240, rotation: 0, tint: 0xaa8899 });
  }

  spawnBoxes() {
    // Drop dynamic boxes into / above the tank so fluids couple to Box2D bodies.
    const spots = [
      { x: 1500, y: 350 },
      { x: 1700, y: 280 },
      { x: 1900, y: 400 },
      { x: 2100, y: 320 },
      { x: 2300, y: 380 },
      { x: 2500, y: 300 },
      { x: 1650, y: 600 },
      { x: 2050, y: 550 },
      { x: 2450, y: 620 },
      { x: 1800, y: 750 },
      { x: 2200, y: 700 },
      { x: 2000, y: 450 },
    ];
    for (let i = 0; i < spots.length; i++) {
      this.spawnEntity(Box, { x: spots[i].x, y: spots[i].y });
    }
  }

  spawnParticleGroups() {
    const layerId = Layer.getId(LAYER);
    LiquidFun.emit({
      flags: F.VISCOUS,
      viscousScale: 1,
      tint: 0x6b3a1f,
      shape: 'circle',
      posX: 1600,
      posY: 500,
      radius: 120,
      layerId,
    });
    LiquidFun.emit({
      flags: F.VISCOUS | F.TENSILE,
      viscousScale: 10,
      tint: 0xc6862a,
      shape: 'circle',
      posX: 2400,
      posY: 500,
      radius: 400,
      trackGroup: true,
      layerId,
    });
    LiquidFun.emit({
      flags: F.WATER,
      groupFlags: GF.SOLID | GF.RIGID,
      tint: 0xaadfff,
      shape: 'box',
      posX: 2000,
      posY: 200,
      halfWidth: 120,
      halfHeight: 80,
      layerId,
    });
  }

  update(dtRatio, deltaTime) {
    for (let i = 0; i < LIQUID_TOOLS.length; i++) {
      if (Keyboard.isPressed(LIQUID_TOOLS[i].key)) {
        this.liquidTool = i;
      }
    }

    if (Keyboard.isPressed('m')) {
      const groups = LiquidFun.getGroups();
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (g.viscousScale > 1.05) {
          const next = g.viscousScale - deltaTime * 3
          LiquidFun.setGroupViscousScale(g.id, next);
          this._meltGroupId = g.id;
          this._meltScale = next;
        }
      }
    }

    if (Keyboard.isPressed('n')) {
      const groups = LiquidFun.getGroups();
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const next = g.viscousScale * 1.1;
        LiquidFun.setGroupViscousScale(g.id, next);
        this._meltGroupId = g.id;
        this._meltScale = next;
      }
    }

    this._refreshHud();

    const tool = LIQUID_TOOLS[this.liquidTool];
    const down = Mouse.isButton0Down;
    const justDown = down && !this._mouse0WasDown;
    this._mouse0WasDown = down;
    if (!down) {
      this.spawnTimer = 0;
      return;
    }

    const interval = tool.grouped ? 0.25 : 0.05;
    this.spawnTimer += deltaTime;
    if (!justDown && this.spawnTimer < interval) return;
    this.spawnTimer = 0;

    const emit = {
      flags: tool.flags,
      viscousScale: tool.viscousScale,
      strength: tool.strength,
      groupFlags: tool.groupFlags || 0,
      tint: tool.tint,
      shape: tool.shape,
      posX: Mouse.x,
      posY: Mouse.y,
      layerId: Layer.getId(LAYER),
    };
    if (tool.shape === 'box') {
      emit.halfWidth = tool.halfWidth;
      emit.halfHeight = tool.halfHeight;
    } else {
      emit.radius = tool.radius;
    }
    LiquidFun.emit(emit);
  }

  _createHud() {
    const el = document.createElement('div');
    el.id = 'liquidfun-demo-hud';
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:900;color:#fff;font:13px/1.45 sans-serif;' +
      'background:rgba(0,0,0,0.65);padding:10px 12px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
    this._hud = el;
  }

  _refreshHud() {
    if (!this._hud) return;
    const lines = LIQUID_TOOLS.map((t, i) => {
      const mark = i === this.liquidTool ? '>' : ' ';
      const vs = t.viscousScale != null ? t.viscousScale : 1;
      return `${mark} ${t.key.toUpperCase()}  ${t.name}  vScale=${vs}`;
    });
    const tint = LIQUID_TOOLS[this.liquidTool].tint;
    const groups = LiquidFun.getGroups();
    const views = LiquidFun.getViews();
    const pCount = views?.count ? views.count[0] | 0 : 0;
    this._hud.textContent =
      `LiquidFun  |  ${LIQUID_TOOLS[this.liquidTool].name}` +
      (tint != null ? `  #${tint.toString(16).padStart(6, '0')}` : '') +
      `\n${lines.join('\n')}` +
      `\ngroups=${groups.length}  particles=${pCount}` +
      (this._meltGroupId >= 0 ? `  melt#${this._meltGroupId}=${this._meltScale.toFixed(2)}` : '') +
      `\nLMB spray  M melt  N thicken  Y ice  WASD pan  wheel zoom`;
  }

  _removeHud() {
    if (this._hud && this._hud.parentNode) this._hud.parentNode.removeChild(this._hud);
    this._hud = null;
  }
}
