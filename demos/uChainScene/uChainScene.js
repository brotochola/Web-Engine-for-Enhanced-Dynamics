// U Chain — twelve draggable points, one open chain, one rope mesh.
//
// The chain is the collision. An open chain treats the first and last stored
// points as ghosts, so those edges do not collide. The twelve points the user
// drags are all solid: each rebuild writes a ghost extended back along the
// first segment, then the twelve points, then a ghost extended forward along
// the last segment.
//
// The picture is MeshRenderer.setRope on those same twelve points. setRope
// offsets a left and a right vertex along the normal, so the line grows into
// a strip of constant half-width. The point count never changes, so the chain
// arena overwrites in place and the rope keeps the same vertex span.
//
// Left button picks the nearest point within PICK px and drags it. While the
// cursor is that close, one decoration on this entity marks the vertex. A move
// that setChain rejects (two points closer than the slop) is put back.
// Middle click drops a ball at the cursor. Right click sprays water.
// The water picture is the dulceDeLeche fragment, sampled from LiquidFun
// density, tinted as water. The rope samples rocky.jpg.

import { BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } from '/src/util/configDefaults.js';
import WEED from '/src/index.js';

const {
  Scene,
  GameObject,
  Camera,
  Collider,
  MeshRenderer,
  RigidBody,
  SpriteRenderer,
  Mouse,
  Decoration,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  LAYER_KIND,
  rng,
} = WEED;

const WORLD_W = 1400;
const WORLD_H = 1000;
const POINTS = 12;
const HALF_WIDTH = 24;
const PICK = 28;
const PICK_SQR = PICK * PICK;

function writeU(xy) {
  const leftX = -280;
  const rightX = 280;
  const topY = -300;
  const botY = 300;
  const left = [topY, -150, 0, 150, botY];
  let o = 0;
  for (let i = 0; i < left.length; i++) {
    xy[o++] = leftX;
    xy[o++] = left[i];
  }
  xy[o++] = -90;
  xy[o++] = botY;
  xy[o++] = 90;
  xy[o++] = botY;
  const right = [botY, 150, 0, -150, topY];
  for (let i = 0; i < right.length; i++) {
    xy[o++] = rightX;
    xy[o++] = right[i];
  }
}

function writeChain(src, dst) {
  const x0 = src[0];
  const y0 = src[1];
  const x1 = src[2];
  const y1 = src[3];
  dst[0] = x0 - (x1 - x0);
  dst[1] = y0 - (y1 - y0);
  for (let i = 0; i < POINTS * 2; i++) dst[2 + i] = src[i];
  const a = (POINTS - 2) * 2;
  const b = (POINTS - 1) * 2;
  const ax = src[a];
  const ay = src[a + 1];
  const bx = src[b];
  const by = src[b + 1];
  const tail = 2 + POINTS * 2;
  dst[tail] = bx + (bx - ax);
  dst[tail + 1] = by + (by - ay);
}

class Drop extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(spawnConfig = {}) {
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.setSprite('ball');
    const radius = spawnConfig.radius || 12;
    this.collider.radius = radius;
    this.collider.visualRange = 0;
    this.collider.friction = 0.3;
    this.collider.restitution = 0.15;
    const scale = (radius * 2) / 14;
    this.spriteRenderer.scaleX = scale;
    this.spriteRenderer.scaleY = scale;
    this.rigidBody.linearDamping = 0.05;
  }
}

class UChain extends GameObject {
  static components = [Collider, MeshRenderer];

  onSpawned() {
    this.setLayer('snake');
    this.collider.friction = 0.4;
    this.collider.restitution = 0.05;
    this._pts = new Float32Array(POINTS * 2);
    this._chain = new Float32Array((POINTS + 2) * 2);
    this._drag = -1;
    this._hint = -1;
    writeU(this._pts);
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setTexture('rocky');
    this._publish();
  }

  tick() {
    const pts = this._pts;
    const ox = this.x;
    const oy = this.y;
    const down = Mouse.isButton0Down;

    let near = -1;
    if (this._drag < 0) {
      let bestD = PICK_SQR;
      for (let i = 0; i < POINTS; i++) {
        const dx = ox + pts[i * 2] - Mouse.x;
        const dy = oy + pts[i * 2 + 1] - Mouse.y;
        const d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          near = i;
        }
      }
    }

    if (!down) this._drag = -1;
    else if (this._drag < 0 && near >= 0) this._drag = near;

    if (down && this._drag >= 0) {
      const i = this._drag;
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      pts[i * 2] = Mouse.x - ox;
      pts[i * 2 + 1] = Mouse.y - oy;
      if (!this._publish()) {
        pts[i * 2] = px;
        pts[i * 2 + 1] = py;
      }
    }

    this._syncHint(this._drag >= 0 ? this._drag : near);
  }

  _publish() {
    writeChain(this._pts, this._chain);
    if (!this.collider.setChain(this._chain, POINTS + 2, false)) return false;
    this.meshRenderer.setRope(this._pts, HALF_WIDTH);
    return true;
  }

  _syncHint(index) {
    if (index < 0) {
      this._clearHint();
      return;
    }
    const x = this._pts[index * 2];
    const y = this._pts[index * 2 + 1];
    const scale = (PICK * 2) / 64;
    if (this._hint < 0) {
      this._hint = this.addDecoration('_whiteCircle_64x64', x, y, scale, scale, 1, {
        anchorX: 0.5,
        anchorY: 0.5,
        tint: 0xffcc33,
      });
      return;
    }
    const deco = Decoration.get(this._hint);
    deco.localX = x;
    deco.localY = y;
  }

  _clearHint() {
    if (this._hint < 0) return;
    Decoration.despawn(this._hint);
    this._hint = -1;
  }
}

const WATER = LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE;

export class UChainScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,

    spatial: {
      cellSize: 120,
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
      maxChainPoints: 32,
      liquidFun: {
        enabled: true,
        radius: 12,
        maxCount: 8000,
        subSteps: 2,
      },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxMeshVerts: 64,
      maxMeshIndices: 128,
    },

    lighting: {
      enabled: false,
    },

    decoration: {
      maxDecorations: 4,
    },

    layers: {
      snake: {
        kind: LAYER_KIND.MESH,
        zIndex: 2,
      },
      water: {
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
            radius: 28,
            falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,
            useParticleTint: true,
            intensity: 0.166,
          },
          uniforms: {
            uCutoff: { value: 0.29, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Cutoff', tip: 'Hide density below this. Higher = thinner looking fluid.' },
            uRim: { value: 0.4, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Rim', tip: 'Density where the rim ends and the body starts. Keep above cutoff.' },
            uDepth: { value: 0.5, type: 'f32', min: 0.01, max: 2, step: 0.01, label: 'Depth', tip: 'How quickly the body darkens from rim to core.' },
            uBodyAlpha: { value: 0.85, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Body alpha', tip: 'Opacity of thick fluid.' },
            uEdgeAlpha: { value: 0.7, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Edge alpha', tip: 'Opacity of the thin rim.' },
          },
        },
      },
    },
  };

  static assets = {
    textures: {
      rocky: '/demos/img/rocky.jpg',
      ball: '/demos/img/bola.png',
    },
    shaders: {
      dulceDeLeche: '/demos/shaders/dulceDeLeche.frag',
    },
  };

  static entities = [
    [UChain, 1],
    [Drop, 400],
  ];

  constructor(game) {
    super(game);
    this._spray = 0;
    this._rightWasDown = false;
    this._hud = null;
  }

  create() {
    const cx = WORLD_W * 0.5;
    const cy = WORLD_H * 0.5;
    Camera.setFree(true, { panSpeed: 12 });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
    Camera.setZoom(1);
    this._createHud();
  }

  createNewGame() {
    UChain.spawn({ x: WORLD_W * 0.5, y: WORLD_H * 0.5 });
  }

  async destroy() {
    this._removeHud();
    await super.destroy();
  }

  update(_dtRatio, deltaTime) {
    if (Mouse.isMiddleButtonPressed) {
      Drop.spawn({
        x: Mouse.x,
        y: Mouse.y,
        radius: 10 + rng() * 6,
      });
    }

    const down = Mouse.isRightButtonDown;
    const justDown = down && !this._rightWasDown;
    this._rightWasDown = down;
    if (!down) {
      this._spray = 0;
      return;
    }
    this._spray += deltaTime;
    if (!justDown && this._spray < 50) return;
    this._spray = 0;
    LiquidFun.emit({
      flags: WATER,
      viscousScale: 1,
      tint: 0x3399ff,
      shape: 'circle',
      posX: Mouse.x,
      posY: Mouse.y,
      radius: 36,
      layer: 'water',
    });
  }

  _createHud() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:900;color:#fff;font:13px/1.4 sans-serif;' +
      'background:rgba(0,0,0,0.65);padding:8px 10px;border-radius:6px;pointer-events:none;';
    el.textContent = 'LMB drag a point    MMB drop a ball    RMB spray water';
    document.body.appendChild(el);
    this._hud = el;
  }

  _removeHud() {
    if (this._hud) this._hud.remove();
    this._hud = null;
  }
}
