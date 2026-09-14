import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Grab, LightEmitter, Mouse, Keyboard, enums, LiquidFun, LIQUIDFUN_GROUP_FLAGS } = WEED;
const { ShapeType } = enums;

const HEAT = 1;
const IGNITE_RANGE_SQ = 80 * 80;
const LIGHT_BASE = 9000;
const LIGHT_RANGE = 640;
const HOT = new Int32Array(4096);
const BOX_X0 = new Float32Array(256);
const BOX_Y0 = new Float32Array(256);
const BOX_X1 = new Float32Array(256);
const BOX_Y1 = new Float32Array(256);
const MELT_T = 180;
const RIGID = LIQUIDFUN_GROUP_FLAGS.RIGID;
const EXTRACT_OPTS = { groupFlags: 0 };

export class BurningBox extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, Grab, LightEmitter];
  static _meltAcc = -1;

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
      if (BurningBox._meltAcc !== accTime) {
        BurningBox._meltAcc = accTime;
        BurningBox.meltIce(deltaTime);
      }
    }

    if (!Mouse.isButton0Pressed && !Keyboard.isPressed('f')) return;

    const dx = this.x - Mouse.x;
    const dy = this.y - Mouse.y;
    if (dx * dx + dy * dy < IGNITE_RANGE_SQ) this.ignite();
  }

  /** One pass over RIGID slabs. No queryAABB. One extract per ice group. */
  static meltIce(deltaTime) {
    const views = LiquidFun.getViews();
    const gv = LiquidFun.getGroupViews();
    if (!views || !views.userData || !views.x || !views.y || !gv || !gv.count) return;
    const list = BurningBox.instances;
    let boxN = 0;
    for (let i = 0; i < list.length && boxN < BOX_X0.length; i++) {
      const box = list[i];
      if (!box || !(box.getFeedBits() & HEAT)) continue;
      const hw = (box.collider.width || 100) * 0.5 + 48;
      const hh = (box.collider.height || 100) * 0.5 + 48;
      BOX_X0[boxN] = box.x - hw;
      BOX_Y0[boxN] = box.y - hh;
      BOX_X1[boxN] = box.x + hw;
      BOX_Y1[boxN] = box.y + hh;
      boxN++;
    }
    if (boxN <= 0) return;

    const live = views.count ? views.count[0] | 0 : 0;
    const gn = gv.count[0] | 0;
    const add = Math.max(1, ((deltaTime || 16) * 0.25) | 0);
    const xArr = views.x;
    const yArr = views.y;
    const ud = views.userData;
    for (let k = 0; k < gn; k++) {
      if (!(gv.groupFlags[k] & RIGID)) continue;
      const first = gv.firstIndex[k] | 0;
      const last = gv.lastIndex[k] | 0;
      const gid = gv.id[k] | 0;
      let hotN = 0;
      const hi = last < live ? last : live;
      for (let idx = first; idx < hi; idx++) {
        if (idx < 0) continue;
        const x = xArr[idx];
        const y = yArr[idx];
        let hit = false;
        for (let b = 0; b < boxN; b++) {
          if (x >= BOX_X0[b] && x <= BOX_X1[b] && y >= BOX_Y0[b] && y <= BOX_Y1[b]) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        const prev = ud[idx] >>> 0;
        let t = (prev & 255) + add;
        if (t > 255) t = 255;
        const next = (prev & ~255) | t;
        if (next !== prev) LiquidFun.setUserData(idx, next);
        if (t < MELT_T) continue;
        if (hotN < HOT.length) HOT[hotN++] = idx;
      }
      if (hotN <= 0) continue;
      const newId = LiquidFun.extract(gid, HOT, hotN, EXTRACT_OPTS);
      if (newId >= 0) LiquidFun.setGroupViscousScale(newId, 4);
    }
  }
}
