import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Grab, LightEmitter, LightOccluder, Mouse, Keyboard, enums, LiquidFun, LIQUIDFUN_GROUP_FLAGS } = WEED;
const { ShapeType } = enums;

const HEAT = 1;
const IGNITE_RANGE_SQ = 80 * 80;
const LIGHT_BASE = 9000;
const LIGHT_RANGE = 640;
const HOT = new Int32Array(4096);
const SCRATCH = new Int32Array(4096);
const JOB_GID = new Int32Array(32);
const JOB_OFF = new Int32Array(32);
const JOB_N = new Int32Array(32);
const BOX_X0 = new Float32Array(256);
const BOX_Y0 = new Float32Array(256);
const BOX_X1 = new Float32Array(256);
const BOX_Y1 = new Float32Array(256);
const GROUP_HIT = new Uint8Array(256);
const MELT_T = 180;
const RIGID = LIQUIDFUN_GROUP_FLAGS.RIGID;
const EXTRACT_OPTS = { groupFlags: 0 };

export class BurningBox extends GameObject {
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, Grab, LightEmitter, LightOccluder];
  static _meltAcc = -1;

  ignite() {
    this.setFeedBits(this.getFeedBits() | HEAT);
    this.lightEmitter.active = 1;
    this.lightEmitter.lightColor = 0xff9944;
    this.lightEmitter.lightIntensity = LIGHT_BASE;
    this.collider.visualRange = LIGHT_RANGE;
    this.lightOccluder.active = 0
    return this;
  }

  extinguish() {
    this.setFeedBits(this.getFeedBits() & ~HEAT);
    this.lightEmitter.lightIntensity = 0;
    this.lightEmitter.active = 0;
    this.lightOccluder.active = 1
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
    if (dx * dx + dy * dy < IGNITE_RANGE_SQ) {
      if (!this.amIBurning()) this.ignite();
      else this.extinguish();
    }
  }
  amIBurning() {
    return this.getFeedBits() & HEAT;
  }

  /** One pass over RIGID slabs. Overlap any heat AABB → heat every member. */
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

    const meltBench = list[0] && list[0].config && list[0].config.meltBench;
    const keepWriting = !!(meltBench && meltBench.keepWriting);

    const live = views.count ? views.count[0] | 0 : 0;
    const gn = gv.count[0] | 0;
    const add = Math.max(1, ((deltaTime || 16) * 0.25) | 0);
    const xArr = views.x;
    const yArr = views.y;
    const ud = views.userData;
    const gi = views.groupIndex;
    if (gn > 0) GROUP_HIT.fill(0, 0, gn);

    const inHeat = (x, y) => {
      for (let b = 0; b < boxN; b++) {
        if (x >= BOX_X0[b] && x <= BOX_X1[b] && y >= BOX_Y0[b] && y <= BOX_Y1[b]) return true;
      }
      return false;
    };

    const spanOk = (first, last) => first >= 0 && last > first;

    for (let k = 0; k < gn; k++) {
      if (!(gv.groupFlags[k] & RIGID)) continue;
      const gid = gv.id[k] | 0;
      const first = gv.firstIndex[k] | 0;
      const last = gv.lastIndex[k] | 0;
      const hi = last < live ? last : live;
      let hit = false;
      if (spanOk(first, hi)) {
        for (let idx = first; idx < hi; idx++) {
          if (inHeat(xArr[idx], yArr[idx])) {
            hit = true;
            break;
          }
        }
      } else if (gi) {
        for (let idx = 0; idx < live; idx++) {
          if ((gi[idx] | 0) !== gid) continue;
          if (inHeat(xArr[idx], yArr[idx])) {
            hit = true;
            break;
          }
        }
      }
      if (hit) GROUP_HIT[k] = 1;
    }

    let hotPacked = 0;
    let jobs = 0;
    for (let k = 0; k < gn; k++) {
      if (!GROUP_HIT[k]) continue;
      const gid = gv.id[k] | 0;
      const first = gv.firstIndex[k] | 0;
      const last = gv.lastIndex[k] | 0;
      const hi = last < live ? last : live;
      let hotN = 0;
      const hotOff = hotPacked;
      const heatIdx = (idx) => {
        const prev = ud[idx] >>> 0;
        let t = (prev & 255) + add;
        if (t > 255) t = 255;
        ud[idx] = (prev & ~255) | t;
        if (keepWriting || t < MELT_T) return;
        if (hotPacked < HOT.length) {
          HOT[hotPacked++] = idx;
          hotN++;
        }
      };
      if (spanOk(first, hi)) {
        for (let idx = first; idx < hi; idx++) heatIdx(idx);
      } else if (gi) {
        for (let idx = 0; idx < live; idx++) {
          if ((gi[idx] | 0) === gid) heatIdx(idx);
        }
      }
      if (hotN <= 0 || jobs >= JOB_GID.length) continue;
      JOB_GID[jobs] = gid;
      JOB_OFF[jobs] = hotOff;
      JOB_N[jobs] = hotN;
      jobs++;
    }
    for (let j = 0; j < jobs; j++) {
      const n = JOB_N[j];
      const off = JOB_OFF[j];
      for (let i = 0; i < n; i++) SCRATCH[i] = HOT[off + i];
      const newId = LiquidFun.extract(JOB_GID[j], SCRATCH, n, EXTRACT_OPTS);
      if (newId >= 0) LiquidFun.setGroupViscousScale(newId, 4);
    }
  }
}
