import { MachineBox } from './gameObjects/machineBox.js';
import { MachineWheel } from './gameObjects/machineWheel.js';
import { MachineRocket } from './gameObjects/machineRocket.js';
import { GhostMachineBox } from './gameObjects/ghostMachineBox.js';
import { GhostMachineWheel } from './gameObjects/ghostMachineWheel.js';
import { GhostMachineRocket } from './gameObjects/ghostMachineRocket.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { Camera } from '/src/core/Camera.js';
import WEED from '/src/index.js';
import {
  CELL,
  DEFAULT_ROCKET_ANGLE,
  PALETTE_BOX,
  PALETTE_ROCKET,
  PALETTE_WHEEL,
  WHEEL_RADIUS,
  canPlaceBox,
  canPlaceRocket,
  canPlaceWheel,
  cellKey,
  cellToWorld,
  heightsToSegments,
  parseCellKey,
  planJoints,
  snapWorld,
  worldToCell,
} from './utils/badPiggiesGrid.js';

const { Scene, Mouse, Keyboard, Transform, RigidBody, Joint, Noise2D, LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } =
  WEED;

const F = LIQUIDFUN_FLAGS;
const GF = LIQUIDFUN_GROUP_FLAGS;

const WALL = 150;
const TERRAIN_DX = 160;
const TERRAIN_THICK = 100;
const PAD_SAMPLES = 48;
const HILL_AMP = 900;
const MOTOR_SPEED = 1000;
const MOTOR_TORQUE = 80e8;
const MODE_EDITOR = 'editor';
const MODE_PLAY = 'play';

// Cream uses 'c' (not 'r') — R returns to editor in PLAY.
const LIQUID_TOOLS = [
  { key: 'q', name: 'water', shape: 'circle', radius: 60, flags: F.WATER | F.TENSILE, viscousScale: 1, tint: 0x3399ff },
  { key: 'e', name: 'oil', shape: 'circle', radius: 60, flags: F.VISCOUS, viscousScale: 1, tint: 0x6b3a1f },
  { key: 'c', name: 'cream', shape: 'circle', radius: 60, flags: F.VISCOUS | F.TENSILE, viscousScale: 2, tint: 0xf5f0e1 },
  { key: 'f', name: 'dulceDeLeche', shape: 'circle', radius: 60, flags: F.VISCOUS | F.TENSILE, viscousScale: 8, tint: 0xc6862a },
  { key: 'g', name: 'jelly', shape: 'circle', radius: 170, flags: F.ELASTIC, strength: 0.55, viscousScale: 1, tint: 0x33ff66, grouped: true },
  { key: 't', name: 'sand', shape: 'box', halfWidth: 20, halfHeight: 20, flags: F.POWDER, viscousScale: 1, tint: 0xffcc00 },
  {
    key: 'y',
    name: 'ice',
    shape: 'box',
    halfWidth: 290,
    halfHeight: 60,
    flags: F.WATER,
    groupFlags: GF.SOLID | GF.RIGID,
    viscousScale: 1,
    tint: 0xaadfff,
    grouped: true,
  },
];

export class BadPiggiesScene extends Scene {
  static config = {
    worldWidth: 120000,
    worldHeight: 40000,

    spatial: {
      cellSize: 512,
      maxNeighbors: 0,
      noLimitFPS: false,
    },

    logic: { noLimitFPS: false },

    particle: {
      noLimitFPS: false,
      maxParticles: 40000,
      decals: false,
    },

    physics: {
      subStepCount: 5,
      noLimitFPS: false,
      maxJoints: 8024,
      commandRingCapacity: 32768,
      gravity: { x: 0, y: 1800 },
      sleeping: false,
      liquidFun: {
        // strictContactCheck: true,
        // pressureStrength: 0,
        // density: 0.01,
        enabled: true,
        radius: 16,
        maxCount: 65534,
        subSteps: 2,
      },
    },

    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 120000,
    },

    preRender: {
      // interpolation: {
      //   mode: 'interpolate',
      // },
    },

    lighting: { enabled: false },
  };

  static assets = {
    textures: {
      box: '/demos/img/box_100_100.png',
      ball: '/demos/img/bola.png',
      rocky: '/demos/img/rocky.jpg',
      smoke: '/demos/img/smoke.png',
    },
  };

  static entities = [
    [MachineBox, 1500],
    [MachineWheel, 1500],
    [MachineRocket, 1500],
    [GhostMachineBox, 4],
    [GhostMachineWheel, 4],
    [GhostMachineRocket, 4],
    [Floor, 2024],
  ];

  constructor(game) {
    super(game);
    this.mode = MODE_EDITOR;
    this.palette = PALETTE_BOX;
    this.occupancy = new Map();
    this.originX = 0;
    this.originY = 0;
    this.floorTop = 0;
    this.ghostBoxIdx = -1;
    this.ghostWheelIdx = -1;
    this.ghostRocketIdx = -1;
    this._hud = null;
    this._paletteBar = null;
    this._fluidBar = null;
    this._wheelJoints = [];
    this._padSurfaceY = 0;
    this._placeAngle = DEFAULT_ROCKET_ANGLE;
    this.liquidTool = 0;
    this.spawnTimer = 0;
    this._mouse0WasDown = false;
    this.followMachine = false;
    this._followToggle = null;
  }

  create() {
    this.spawnFloorAndWalls();

    this.floorTop = this._padSurfaceY;
    this.originX = WALL + (PAD_SAMPLES * TERRAIN_DX) * 0.5;
    this.originY = this._padSurfaceY - CELL - CELL / 2;

    const cx = this.originX;
    const cy = this.originY - CELL * 4;
    Camera.setFree(true, { panSpeed: 12, zoomSensitivity: 0.001, maxZoom: 3, arrows: true });
    Camera.setFreeTarget(cx, cy);
    Camera.centerOn(cx, cy);
    Camera.setZoom(0.7);

    const ghostBox = GhostMachineBox.spawn({ x: -9999, y: -9999, ghost: true });
    const ghostWheel = GhostMachineWheel.spawn({ x: -9999, y: -9999, ghost: true });
    const ghostRocket = GhostMachineRocket.spawn({ x: -9999, y: -9999, ghost: true, rotation: this._placeAngle });
    this.ghostBoxIdx = ghostBox ? ghostBox.index : -1;
    this.ghostWheelIdx = ghostWheel ? ghostWheel.index : -1;
    this.ghostRocketIdx = ghostRocket ? ghostRocket.index : -1;

    this._createPalette();
    this._createFluidBar();
    this._createFollowToggle();
    this._createHud();
    this._refreshHud();
  }

  onLoadGame(_payload) {
    this._rebuildOccupancyFromEntities();
    this._rebuildWheelJointsFromActive();
    // Ghosts are non-serializable; ensure previews exist after remount.
    if (this.ghostBoxIdx < 0) {
      const ghostBox = GhostGhostMachineBox.spawn({ x: -9999, y: -9999, ghost: true });
      const ghostWheel = GhostGhostMachineWheel.spawn({ x: -9999, y: -9999, ghost: true });
      const ghostRocket = GhostMachineRocket.spawn({
        x: -9999,
        y: -9999,
        ghost: true,
        rotation: this._placeAngle,
      });
      this.ghostBoxIdx = ghostBox ? ghostBox.index : -1;
      this.ghostWheelIdx = ghostWheel ? ghostWheel.index : -1;
      this.ghostRocketIdx = ghostRocket ? ghostRocket.index : -1;
    }
  }

  _rebuildOccupancyFromEntities() {
    this.occupancy.clear();
    const boxes = MachineBox.getAllActive?.() || [];
    for (let a = 0; a < boxes.length; a++) {
      const i = boxes[a];
      if (Transform.active && Transform.active[i] !== 1) continue;
      const x = Transform.x[i];
      const y = Transform.y[i];
      if (x < -5000 || y < -5000) continue;
      const { gx, gy } = worldToCell(x, y, this.originX, this.originY);
      const key = cellKey(gx, gy);
      if (this.occupancy.has(key)) continue;
      this.occupancy.set(key, {
        boxIndex: i,
        wheelIndex: -1,
        rocketIndex: -1,
        rocketAngle: DEFAULT_ROCKET_ANGLE,
      });
    }

    const wheels = MachineWheel.getAllActive?.() || [];
    for (let a = 0; a < wheels.length; a++) {
      const i = wheels[a];
      if (Transform.active && Transform.active[i] !== 1) continue;
      const x = Transform.x[i];
      const y = Transform.y[i];
      if (x < -5000 || y < -5000) continue;
      const { gx, gy } = worldToCell(x, y, this.originX, this.originY);
      const rec = this.occupancy.get(cellKey(gx, gy));
      if (rec) rec.wheelIndex = i;
    }

    const rockets = MachineRocket.getAllActive?.() || [];
    for (let a = 0; a < rockets.length; a++) {
      const i = rockets[a];
      if (Transform.active && Transform.active[i] !== 1) continue;
      const x = Transform.x[i];
      const y = Transform.y[i];
      if (x < -5000 || y < -5000) continue;
      const { gx, gy } = worldToCell(x, y, this.originX, this.originY);
      const rec = this.occupancy.get(cellKey(gx, gy));
      if (rec) {
        rec.rocketIndex = i;
        const c = Transform.rotC ? Transform.rotC[i] : 1;
        const sn = Transform.rotS ? Transform.rotS[i] : 0;
        rec.rocketAngle = Math.atan2(sn, c);
      }
    }
  }

  _rebuildWheelJointsFromActive() {
    this._wheelJoints.length = 0;
    if (typeof Joint.getAllActive !== 'function') return;
    const wheelSet = new Set(MachineWheel.getAllActive?.() || []);
    const active = Joint.getAllActive();
    for (let i = 0; i < active.length; i++) {
      const j = active[i];
      if (j.type !== Joint.TYPE.REVOLUTE) continue;
      if (wheelSet.has(j.entityA) || wheelSet.has(j.entityB)) {
        this._wheelJoints.push(j.idx);
      }
    }
  }

  async destroy() {
    this._removePalette();
    this._removeFluidBar();
    this._removeFollowToggle();
    this._removeHud();
    await super.destroy();
  }

  update(_dtRatio, deltaTime) {
    if (this.mode === MODE_PLAY) this._driveMotors();
    this._panCamera();

    if (Keyboard.isPressed('1')) this.palette = PALETTE_BOX;
    if (Keyboard.isPressed('2')) this.palette = PALETTE_WHEEL;
    if (Keyboard.isPressed('3')) this.palette = PALETTE_ROCKET;

    if (Keyboard.isPressed(' ') || Keyboard.isPressed('enter')) {
      if (this.mode === MODE_EDITOR) this._enterPlay();
      else this._enterEditor();
    } else if (Keyboard.isPressed('r')) {
      if (this.mode === MODE_PLAY) this._enterEditor();
      else this._placeAngle -= Math.PI / 2;
    }

    if (this.mode === MODE_EDITOR) {
      this._editorInput();
      this._updateGhost();
    } else {
      this._hideGhosts();
      this._playFluidInput(deltaTime);
    }

    this._refreshHud();
  }

  _driveMotors() {
    const kb = this.keyboard;
    let speed = 0;
    if (kb.arrowright) speed = MOTOR_SPEED;
    else if (kb.arrowleft) speed = -MOTOR_SPEED;
    for (let i = 0; i < this._wheelJoints.length; i++) {
      Joint.update(this._wheelJoints[i], {
        enableMotor: true,
        motorSpeed: speed,
        maxMotorTorque: MOTOR_TORQUE,
      });
    }
  }

  _followMachine() {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const rec of this.occupancy.values()) {
      const i = rec.boxIndex;
      sx += Transform.x[i];
      sy += Transform.y[i];
      n++;
    }
    if (!n) return false;
    Camera.setFreeTarget(sx / n, sy / n);
    return true;
  }

  _panCamera() {
    // Play uses arrows for motors/thrust; WASD+wheel stay free-cam in both modes.
    Camera.freeArrows = this.mode === MODE_EDITOR;

    if (
      this.followMachine &&
      this.mode === MODE_PLAY &&
      this.occupancy.size &&
      !Camera.isFreePanning
    ) {
      this._followMachine();
    }

    if (this.mode === MODE_EDITOR && this._aimHoveredRocket()) {
      Camera.pauseFreeZoom();
    }
  }

  _editorInput() {
    if (Keyboard.isPressed('delete') || Keyboard.isPressed('backspace')) {
      const snap = snapWorld(Mouse.x, Mouse.y, this.originX, this.originY);
      this._deleteAt(snap.gx, snap.gy, this._pickKindAt(Mouse.x, Mouse.y));
    }

    if (Mouse.isButton2Down) {
      const snap = snapWorld(Mouse.x, Mouse.y, this.originX, this.originY);
      this._deleteAt(snap.gx, snap.gy, this._pickKindAt(Mouse.x, Mouse.y));
      return;
    }

    if (Mouse.isButton0Down) this._placeAtMouse();
  }

  _pickKindAt(mx, my) {
    const hit = this._pickAt(mx, my);
    return hit ? hit.kind : 'box';
  }

  _pickAt(mx, my) {
    const snap = snapWorld(mx, my, this.originX, this.originY);
    const key = cellKey(snap.gx, snap.gy);
    const rec = this.occupancy.get(key);
    if (!rec) return null;

    const dx = mx - snap.x;
    const dy = my - snap.y;
    const half = CELL * 0.5;
    const insideBox = Math.abs(dx) <= half && Math.abs(dy) <= half;
    const insideWheel =
      rec.wheelIndex >= 0 && dx * dx + dy * dy <= WHEEL_RADIUS * WHEEL_RADIUS;
    const insideRocket = rec.rocketIndex >= 0 && dx * dx + dy * dy <= CELL * CELL * 0.45;

    if (insideRocket && this.palette === PALETTE_ROCKET) {
      return { kind: 'rocket', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideWheel && this.palette === PALETTE_WHEEL) {
      return { kind: 'wheel', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideRocket && !insideBox) {
      return { kind: 'rocket', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideWheel && !insideBox) {
      return { kind: 'wheel', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideBox) {
      return { kind: 'box', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideRocket) {
      return { kind: 'rocket', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    if (insideWheel) {
      return { kind: 'wheel', key, gx: snap.gx, gy: snap.gy, ...rec };
    }
    return null;
  }

  _placeAtMouse() {
    const snap = snapWorld(Mouse.x, Mouse.y, this.originX, this.originY);
    if (!this._cellInBounds(snap.gx, snap.gy)) return;

    if (this.palette === PALETTE_BOX) {
      if (!canPlaceBox(this.occupancy, snap.gx, snap.gy)) return;
      const spawned = MachineBox.spawn({ x: snap.x, y: snap.y });
      if (!spawned) return;
      this.occupancy.set(cellKey(snap.gx, snap.gy), {
        boxIndex: spawned.index,
        wheelIndex: -1,
        rocketIndex: -1,
        rocketAngle: DEFAULT_ROCKET_ANGLE,
      });
      return;
    }

    if (this.palette === PALETTE_WHEEL) {
      if (!canPlaceWheel(this.occupancy, snap.gx, snap.gy)) return;
      const rec = this.occupancy.get(cellKey(snap.gx, snap.gy));
      const spawned = MachineWheel.spawn({ x: snap.x, y: snap.y });
      if (!spawned) return;
      rec.wheelIndex = spawned.index;
      return;
    }

    if (!canPlaceRocket(this.occupancy, snap.gx, snap.gy)) return;
    const rec = this.occupancy.get(cellKey(snap.gx, snap.gy));
    const spawned = MachineRocket.spawn({ x: snap.x, y: snap.y, rotation: this._placeAngle });
    if (!spawned) return;
    rec.rocketIndex = spawned.index;
    rec.rocketAngle = this._placeAngle;
  }

  _deleteAt(gx, gy, kind) {
    const key = cellKey(gx, gy);
    const rec = this.occupancy.get(key);
    if (!rec) return;

    if (kind === 'wheel' && rec.wheelIndex >= 0) {
      this.despawnEntity(rec.wheelIndex);
      rec.wheelIndex = -1;
      return;
    }

    if (kind === 'rocket' && rec.rocketIndex >= 0) {
      this.despawnEntity(rec.rocketIndex);
      rec.rocketIndex = -1;
      return;
    }

    if (rec.wheelIndex >= 0) this.despawnEntity(rec.wheelIndex);
    if (rec.rocketIndex >= 0) this.despawnEntity(rec.rocketIndex);
    this.despawnEntity(rec.boxIndex);
    this.occupancy.delete(key);
  }

  _snapPartsToKey(key) {
    const rec = this.occupancy.get(key);
    if (!rec) return;
    const { gx, gy } = parseCellKey(key);
    const pos = cellToWorld(gx, gy, this.originX, this.originY);
    this._moveEntity(rec.boxIndex, pos.x, pos.y, true);
    if (rec.wheelIndex >= 0) this._moveEntity(rec.wheelIndex, pos.x, pos.y, true);
    if (rec.rocketIndex >= 0) {
      this._moveEntity(rec.rocketIndex, pos.x, pos.y, false, rec.rocketAngle ?? DEFAULT_ROCKET_ANGLE);
    }
  }

  _cellInBounds(gx, gy) {
    const { x, y } = cellToWorld(gx, gy, this.originX, this.originY);
    const minX = WALL + CELL / 2;
    const maxX = this.config.worldWidth - WALL - CELL / 2;
    const minY = CELL / 2;
    const maxY = this.floorTop - CELL / 2;
    return x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  _view(index) {
    if (index < 0 || !Transform.active || !Transform.active[index]) return null;
    return this.getEntityView(index, { cache: true });
  }

  _moveEntity(index, x, y, resetPose = false, rotation = null) {
    const view = this._view(index);
    if (!view) return;
    view.setPosition(x, y);
    view.setVelocity(0, 0);
    view.angularVelocity = 0;
    if (rotation != null) view.rotation = rotation;
    else if (resetPose) view.rotation = 0;
    RigidBody.sleeping[index] = 0;
  }

  _setStatic(index, isStatic) {
    const view = this._view(index);
    if (!view) return;
    view.rigidBody.static = isStatic ? 1 : 0;
    view.setVelocity(0, 0);
    view.angularVelocity = 0;
    RigidBody.sleeping[index] = 0;
  }

  _enterPlay() {
    if (this.occupancy.size === 0) return;
    this.mode = MODE_PLAY;
    this.spawnTimer = 0;
    this._mouse0WasDown = false;
    this._setFluidBarVisible(true);

    for (const [key] of this.occupancy) this._snapPartsToKey(key);

    const { welds, revolutes } = planJoints(this.occupancy, this.originX, this.originY);
    for (const w of welds) {
      Joint.addWeld({
        entityA: w.entityA,
        entityB: w.entityB,
        worldAnchorX: w.worldAnchorX,
        worldAnchorY: w.worldAnchorY,
      });
    }
    this._wheelJoints.length = 0;
    for (const r of revolutes) {
      const idx = Joint.addRevolute({
        entityA: r.entityA,
        entityB: r.entityB,
        worldAnchorX: r.worldAnchorX,
        worldAnchorY: r.worldAnchorY,
        enableMotor: true,
        motorSpeed: 0,
        maxMotorTorque: MOTOR_TORQUE,
      });
      if (idx >= 0) this._wheelJoints.push(idx);
    }

    for (const rec of this.occupancy.values()) {
      this._setStatic(rec.boxIndex, false);
      if (rec.wheelIndex >= 0) this._setStatic(rec.wheelIndex, false);
      if (rec.rocketIndex >= 0) this._setStatic(rec.rocketIndex, false);
    }
  }

  _enterEditor() {
    this.mode = MODE_EDITOR;
    this._wheelJoints.length = 0;
    this._setFluidBarVisible(false);
    this._clearLiquidFun();

    for (const rec of this.occupancy.values()) {
      Joint.removeAllForEntity(rec.boxIndex);
      if (rec.wheelIndex >= 0) Joint.removeAllForEntity(rec.wheelIndex);
      if (rec.rocketIndex >= 0) Joint.removeAllForEntity(rec.rocketIndex);
    }

    for (const [key, rec] of this.occupancy) {
      this._setStatic(rec.boxIndex, true);
      if (rec.wheelIndex >= 0) this._setStatic(rec.wheelIndex, true);
      if (rec.rocketIndex >= 0) this._setStatic(rec.rocketIndex, true);
      this._snapPartsToKey(key);
    }
  }

  _clearLiquidFun() {
    LiquidFun.clear();
  }

  _playFluidInput(deltaTime) {
    for (let i = 0; i < LIQUID_TOOLS.length; i++) {
      if (Keyboard.isPressed(LIQUID_TOOLS[i].key)) {
        this.liquidTool = i;
        this._refreshFluidBar();
      }
    }

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
      texture: '_whiteCircle',
      scale: 1,
      alpha: 0.85,
    };
    if (tool.shape === 'box') {
      emit.halfWidth = tool.halfWidth;
      emit.halfHeight = tool.halfHeight;
    } else {
      emit.radius = tool.radius;
    }
    LiquidFun.emit(emit);
  }

  _updateGhost() {
    if (!Mouse.isPresent || Mouse.isButton0Down || Mouse.isButton2Down) {
      this._hideGhosts();
      return;
    }

    const snap = snapWorld(Mouse.x, Mouse.y, this.originX, this.originY);
    const valid =
      this._cellInBounds(snap.gx, snap.gy) &&
      (this.palette === PALETTE_BOX
        ? canPlaceBox(this.occupancy, snap.gx, snap.gy)
        : this.palette === PALETTE_WHEEL
          ? canPlaceWheel(this.occupancy, snap.gx, snap.gy)
          : canPlaceRocket(this.occupancy, snap.gx, snap.gy));

    const alpha = valid ? 0.4 : 0.15;
    this._placeGhost(this.ghostBoxIdx, this.palette === PALETTE_BOX ? snap.x : -9999, this.palette === PALETTE_BOX ? snap.y : -9999, this.palette === PALETTE_BOX ? alpha : 0);
    this._placeGhost(this.ghostWheelIdx, this.palette === PALETTE_WHEEL ? snap.x : -9999, this.palette === PALETTE_WHEEL ? snap.y : -9999, this.palette === PALETTE_WHEEL ? alpha : 0);
    this._placeGhost(
      this.ghostRocketIdx,
      this.palette === PALETTE_ROCKET ? snap.x : -9999,
      this.palette === PALETTE_ROCKET ? snap.y : -9999,
      this.palette === PALETTE_ROCKET ? alpha : 0,
      this._placeAngle
    );
  }

  _placeGhost(index, x, y, alpha, rotation = null) {
    const view = this._view(index);
    if (!view) return;
    view.setPosition(x, y);
    view.setAlpha(alpha);
    if (rotation != null) view.rotation = rotation;
  }

  _hideGhosts() {
    this._placeGhost(this.ghostBoxIdx, -9999, -9999, 0);
    this._placeGhost(this.ghostWheelIdx, -9999, -9999, 0);
    this._placeGhost(this.ghostRocketIdx, -9999, -9999, 0);
  }

  _aimHoveredRocket() {
    const wheel = Mouse.wheel;
    if (!wheel) return false;
    const snap = snapWorld(Mouse.x, Mouse.y, this.originX, this.originY);
    const rec = this.occupancy.get(cellKey(snap.gx, snap.gy));
    if (!rec || rec.rocketIndex < 0) return false;
    const dx = Mouse.x - snap.x;
    const dy = Mouse.y - snap.y;
    if (dx * dx + dy * dy > CELL * CELL * 0.45) return false;
    rec.rocketAngle = (rec.rocketAngle ?? DEFAULT_ROCKET_ANGLE) + wheel * 0.18;
    const view = this._view(rec.rocketIndex);
    if (view) view.rotation = rec.rocketAngle;
    return true;
  }

  _createHud() {
    const el = document.createElement('div');
    el.id = 'bad-piggies-hud';
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:900;color:#fff;font:14px/1.4 sans-serif;' +
      'background:rgba(0,0,0,0.65);padding:10px 12px;border-radius:6px;pointer-events:none;white-space:pre;';
    document.body.appendChild(el);
    this._hud = el;
  }

  _refreshHud() {
    if (!this._hud) return;
    const part =
      this.palette === PALETTE_BOX ? 'box' : this.palette === PALETTE_WHEEL ? 'wheel' : 'rocket';
    const fluid = LIQUID_TOOLS[this.liquidTool].name;
    this._hud.textContent =
      `Bad Piggies  |  ${this.mode === MODE_EDITOR ? 'EDITOR' : 'PLAY'}  |  part: ${part}` +
      (this.mode === MODE_PLAY ? `  |  fluid: ${fluid}` : '') +
      `\n1 box  2 wheel  3 rocket  LMB paint  RMB/Del erase  Space play/edit\n` +
      (this.mode === MODE_PLAY
        ? `LMB spray fluid  bar picks type  ← → drive  ↑ thrust  WASD camera  R/Space editor`
        : `R rotate rocket 90°  hover rocket + wheel aim  WASD camera`);
    this._refreshPalette();
    this._refreshFluidBar();
  }

  _removeHud() {
    if (this._hud && this._hud.parentNode) this._hud.parentNode.removeChild(this._hud);
    this._hud = null;
  }

  _createPalette() {
    const bar = document.createElement('div');
    bar.id = 'bad-piggies-palette';
    bar.style.cssText =
      'position:fixed;left:12px;top:80px;z-index:901;display:flex;gap:8px;font:14px/1 sans-serif;';
    const tools = [
      [PALETTE_BOX, '1 Caja'],
      [PALETTE_WHEEL, '2 Rueda'],
      [PALETTE_ROCKET, '3 Cohete'],
    ];
    for (let i = 0; i < tools.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tool = tools[i][0];
      btn.textContent = tools[i][1];
      btn.style.cssText =
        'padding:8px 12px;border:1px solid #888;border-radius:6px;background:#222;color:#fff;cursor:pointer;';
      btn.addEventListener('click', () => {
        this.palette = tools[i][0];
        this._refreshPalette();
      });
      bar.appendChild(btn);
    }
    document.body.appendChild(bar);
    this._paletteBar = bar;
    this._refreshPalette();
  }

  _refreshPalette() {
    if (!this._paletteBar) return;
    const buttons = this._paletteBar.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const on = buttons[i].dataset.tool === this.palette;
      buttons[i].style.background = on ? '#c45c12' : '#222';
      buttons[i].style.borderColor = on ? '#ffb070' : '#888';
    }
  }

  _removePalette() {
    if (this._paletteBar && this._paletteBar.parentNode) this._paletteBar.parentNode.removeChild(this._paletteBar);
    this._paletteBar = null;
  }

  _createFollowToggle() {
    const label = document.createElement('label');
    label.id = 'bad-piggies-follow';
    label.style.cssText =
      'position:fixed;left:12px;top:48px;z-index:901;display:flex;align-items:center;gap:8px;' +
      'color:#fff;font:14px/1 sans-serif;background:rgba(0,0,0,0.65);padding:8px 12px;border-radius:6px;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.followMachine;
    cb.addEventListener('change', () => {
      this.followMachine = cb.checked;
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode('Follow machine'));
    document.body.appendChild(label);
    this._followToggle = label;
  }

  _removeFollowToggle() {
    if (this._followToggle && this._followToggle.parentNode) {
      this._followToggle.parentNode.removeChild(this._followToggle);
    }
    this._followToggle = null;
  }

  _createFluidBar() {
    const bar = document.createElement('div');
    bar.id = 'bad-piggies-fluids';
    bar.style.cssText =
      'position:fixed;left:12px;top:128px;z-index:901;display:none;flex-wrap:wrap;gap:8px;max-width:520px;font:13px/1 sans-serif;';
    for (let i = 0; i < LIQUID_TOOLS.length; i++) {
      const tool = LIQUID_TOOLS[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.fluid = String(i);
      btn.textContent = tool.name;
      const hex = `#${tool.tint.toString(16).padStart(6, '0')}`;
      btn.style.cssText =
        'padding:8px 10px;border:1px solid #888;border-radius:6px;background:#222;color:#fff;cursor:pointer;' +
        `box-shadow:inset 0 -3px 0 ${hex};`;
      btn.addEventListener('click', () => {
        this.liquidTool = i;
        this._refreshFluidBar();
      });
      bar.appendChild(btn);
    }
    document.body.appendChild(bar);
    this._fluidBar = bar;
    this._setFluidBarVisible(false);
    this._refreshFluidBar();
  }

  _setFluidBarVisible(visible) {
    if (!this._fluidBar) return;
    this._fluidBar.style.display = visible ? 'flex' : 'none';
  }

  _refreshFluidBar() {
    if (!this._fluidBar) return;
    const buttons = this._fluidBar.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      const on = (buttons[i].dataset.fluid | 0) === this.liquidTool;
      buttons[i].style.background = on ? '#1a5a8a' : '#222';
      buttons[i].style.borderColor = on ? '#7ec8ff' : '#888';
    }
  }

  _removeFluidBar() {
    if (this._fluidBar && this._fluidBar.parentNode) this._fluidBar.parentNode.removeChild(this._fluidBar);
    this._fluidBar = null;
  }

  spawnFloorAndWalls() {
    const worldWidth = this.config.worldWidth;
    const worldHeight = this.config.worldHeight;
    const baseY = worldHeight * 0.5;
    this._padSurfaceY = baseY;

    const x0 = WALL;
    const x1 = worldWidth - WALL;
    const count = Math.floor((x1 - x0) / TERRAIN_DX) + 1;
    const heights = new Float32Array(count);
    const noise = new Noise2D(7);
    const minY = 200;
    const maxY = worldHeight - 200;
    for (let i = 0; i < count; i++) {
      if (i < PAD_SAMPLES) {
        heights[i] = baseY;
      } else {
        const n = noise.fbm((i - PAD_SAMPLES) * 0.04, 0.5, 5, 1, 1, 2, 0.5);
        const y = baseY - n * HILL_AMP;
        heights[i] = y < minY ? minY : y > maxY ? maxY : y;
      }
    }

    const segs = heightsToSegments(heights, x0, TERRAIN_DX, TERRAIN_THICK, 1.05);
    const maxSegs = (Floor.poolSize || 1024) - 2;
    const n = segs.length < maxSegs ? segs.length : maxSegs;
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      Floor.spawn({
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        rotation: s.rotation,
        sprite: 'rocky',
        friction: 0.9,
      });
    }

    Floor.spawn({
      x: WALL / 2,
      y: worldHeight / 2,
      width: WALL,
      height: worldHeight,
    });
    Floor.spawn({
      x: worldWidth - WALL / 2,
      y: worldHeight / 2,
      width: WALL,
      height: worldHeight,
    });
  }
}
