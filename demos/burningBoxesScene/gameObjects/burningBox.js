import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Grab, LightEmitter, Mouse, Keyboard, enums, LiquidFun, LIQUIDFUN_GROUP_FLAGS } = WEED;
const { ShapeType } = enums;

const HEAT = 1;
const IGNITE_RANGE_SQ = 80 * 80;
const LIGHT_BASE = 9000;
const LIGHT_RANGE = 640;
const QUERY = new Int32Array(1024);
const HOT = new Int32Array(1024);
const MELT_T = 180;
const RIGID = LIQUIDFUN_GROUP_FLAGS.RIGID;

export class BurningBox extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, Grab, LightEmitter];

  ignite() {
    this.setFeedBits(this.getFeedBits() | HEAT);
    this.lightEmitter.active = 1;
    this.lightEmitter.lightColor = 0xff9944;
    this.lightEmitter.lightIntensity = LIGHT_BASE;
    this.collider.visualRange = LIGHT_RANGE;
    return this;
  }

  extinguish() {
    this.setFeedBits(this.getFeedBits() & ~HEAT);
    this.lightEmitter.lightIntensity = 0;
    this.lightEmitter.active = 0;
    return this;
  }

  onSpawned(spawnConfig = {}) {
    const config = spawnConfig || {};
    this.setSprite(config.sprite || 'box');

    const width = config.width || 100;
    const height = config.height || 100;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.shapeType = ShapeType.Box;
    this.collider.friction = config.friction ?? 0.6;
    this.collider.visualRange = Math.hypot(width, height) / 2 + 200;
    this.rigidBody.linearDamping = 0.01;

    const origW = this.spriteRenderer.originalWidth || 100;
    const origH = this.spriteRenderer.originalHeight || 100;
    this.setScale(width / origW, height / origH);
    this.setAnchor(0.5, 0.5);
    this.setTint(config.tint ?? 0xc68642);
    this.setAlpha(1);

    this.rigidBody.static = config.static ? 1 : 0;
    this.lightEmitter.active = 0;
    this.lightEmitter.hasGlowSprite = 1;
    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = height * 0.25;
    this.lightEmitter.lightIntensity = 0;
    this.setLayer('fire');
    if (config.startIgnited) this.ignite();
    else this.extinguish();
  }

  tick(dtRatio, deltaTime, accTime) {
    if (this.getFeedBits() & HEAT) {
      const t = (accTime || 0) * 0.001;
      const flick = 1 + Math.sin(t * 8 + this.index) * 0.15 + Math.sin(t * 12.7 + this.index * 1.7) * 0.1;
      this.lightEmitter.lightIntensity = Math.max(400, LIGHT_BASE * flick);
      this._meltIce(deltaTime);
    }

    if (!Mouse.isButton0Pressed && !Keyboard.isPressed('f')) return;

    const dx = this.x - Mouse.x;
    const dy = this.y - Mouse.y;
    if (dx * dx + dy * dy < IGNITE_RANGE_SQ) this.ignite();
  }
  _meltIce(deltaTime) {
    const views = LiquidFun.getViews();
    if (!views || !views.userData || !views.groupIndex) return;
    const hw = (this.collider.width || 100) * 0.5 + 48;
    const hh = (this.collider.height || 100) * 0.5 + 48;
    let n = 0;
    try {
      n = LiquidFun.queryAABB(this.x - hw, this.y - hh, this.x + hw, this.y + hh, QUERY);
    } catch (_) {
      return;
    }
    if (n <= 0) return;
    const live = views.count ? views.count[0] | 0 : 0;
    const groups = LiquidFun.getGroups();
    const add = Math.max(1, ((deltaTime || 16) * 0.25) | 0);
    let gid = -1;
    let hotN = 0;
    const cap = n < QUERY.length ? n : QUERY.length;
    for (let i = 0; i < cap; i++) {
      const idx = QUERY[i] | 0;
      if (idx < 0 || idx >= live) continue;
      const g = views.groupIndex[idx] | 0;
      let gFlags = 0;
      for (let k = 0; k < groups.length; k++) {
        if (groups[k].id === g) {
          gFlags = groups[k].groupFlags | 0;
          break;
        }
      }
      if (!(gFlags & RIGID)) continue;
      const prev = views.userData[idx] >>> 0;
      let t = (prev & 255) + add;
      if (t > 255) t = 255;
      const next = (prev & ~255) | t;
      if (next !== prev) LiquidFun.setUserData(idx, next);
      if (t < MELT_T) continue;
      if (gid < 0) gid = g;
      if (g !== gid) continue;
      if (hotN < HOT.length) HOT[hotN++] = idx;
    }
    if (gid < 0 || hotN <= 0) return;
    const newId = LiquidFun.extract(gid, HOT, hotN, { groupFlags: 0, trackGroup: true });
    if (newId >= 0) {
      LiquidFun.setGroupViscousScale(newId, 4);
    }
  }
}
