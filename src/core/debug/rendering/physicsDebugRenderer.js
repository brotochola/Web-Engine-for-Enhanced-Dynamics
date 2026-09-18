// PhysicsDebugRenderer.js — Draws entity-level debug overlays
// Colliders, velocity, acceleration, neighbors, raycasts, sleeping, constraints, origins, indices

import { Transform } from '../../../components/transform.js';
import { RigidBody } from '../../../components/rigidBody.js';
import { Collider } from '../../../components/collider.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { LightEmitter } from '../../../components/lightEmitter.js';
import { DecorationComponent } from '../../../components/decorationComponent.js';
import { ParticleComponent } from '../../../components/particleComponent.js';
import { BulletComponent } from '../../../components/bulletComponent.js';
import { Mouse } from '../../mouse.js';
import { Grid } from '../../grid.js';
import { Joint } from '../../joint.js';
import { ColliderFixture } from '../../colliderFixture.js';
import { DebugDraw } from '../debugDraw.js';
import { DEBUG_FLAGS } from '../debugFlags.js';
import { distanceSq2D, lightInfluenceRadius } from '../../../util/utils.js';
import { ShapeType } from '../../../util/configDefaults.js';
import { getColliderBounds, _boundsResult } from '../../../util/colliderUtils.js';
import { SpriteSheetRegistry } from '../../spriteSheetRegistry.js';

const DECORATION_NO_PARENT = 0xffff;
const EMPTY_DASH = [];
const DASH_DECO_PARENT = [4, 3];

export class PhysicsDebugRenderer {
  constructor() {
    this.scene = null;
    this._pos = { x: 0, y: 0 };
    this._worldA = { x: 0, y: 0 };
    this._worldB = { x: 0, y: 0 };
    this._filter = { selectedOnly: false, selectedIdx: -1 };
    this._indexLabels = [];
    this._indexWidths = [];
    this._typeNames = [];
    this._hoverIdx = -1;
    this._hoverSpeedI = -1;
    this._hoverLabel = '';
    this._hoverWidth = 0;
    this._velSpeedI = -1;
    this._velLabel = '';
    this._selLabelIdx = -1;
    this._selLabelWidth = 0;
    this._ddRgb = new Map();
    this._ddRgba30 = new Map();
    this._ddText = [];
    this._ddTextHash = [];
    this._ddTextWidth = [];
    this._jointKey = 0x7fffffff;
    this._jointCss = '';
    this._jointFillCss = '';
    this._decoSize = { w: 20, h: 20 };
    this._decoSizeTex = -1;
    this._decoSizeW = 20;
    this._decoSizeH = 20;
  }

  attach(scene) {
    this.scene = scene;
    const names = this._typeNames;
    names.length = 0;
    const regs = scene?.registeredClasses;
    if (regs) {
      for (let i = 0; i < regs.length; i++) {
        names[regs[i].entityType] = regs[i].class.name;
      }
    }
  }

  _indexLabel(i) {
    const labels = this._indexLabels;
    let s = labels[i];
    if (s === undefined) {
      s = '' + i;
      labels[i] = s;
    }
    return s;
  }

  _skipUnselected(i, selectedOnly, selectedIdx) {
    return selectedOnly && selectedIdx >= 0 && i !== selectedIdx;
  }

  /** Pose SAB starts as zeros. Unpublished slot: rotC=rotS=0. Published identity: rotC=1. */
  _posePublished(i, poseRotC, poseRotS) {
    if (!poseRotC) return false;
    const c = poseRotC[i];
    const s = poseRotS ? poseRotS[i] : 0;
    return c * c + s * s > 0.25;
  }

  _worldXY(i, pose, out) {
    const rb = RigidBody.active;
    if (pose && pose.x && rb && rb[i] && this._posePublished(i, pose.rotC, pose.rotS)) {
      out.x = pose.x[i];
      out.y = pose.y ? pose.y[i] : Transform.y[i];
    } else {
      out.x = Transform.x[i];
      out.y = Transform.y[i];
    }
    return out;
  }

  _selectedFilter(flags) {
    const f = this._filter;
    f.selectedOnly = !!(flags && flags.isEnabled(DEBUG_FLAGS.SHOW_ACTIVE_ONLY));
    f.selectedIdx = flags ? flags.getSelectedEntity() : -1;
    return f;
  }

  /**
   * MeshRenderer-only bodies never get SpriteRenderer.isItOnScreen.
   * Compound terrain also sits far from the body origin — pad by local AABB.
   */
  _colliderDebugInView(i, entityX, entityY, viewLeft, viewRight, viewTop, viewBottom) {
    const spriteOn = SpriteRenderer.isItOnScreen;
    if (spriteOn && spriteOn[i]) return true;
    const w = Collider.width ? Collider.width[i] : 0;
    const h = Collider.height ? Collider.height[i] : 0;
    const vr = Collider.visualRange ? Collider.visualRange[i] : 0;
    const cx = Collider.polyCentroidX ? Collider.polyCentroidX[i] : 0;
    const cy = Collider.polyCentroidY ? Collider.polyCentroidY[i] : 0;
    const pad = Math.max(Math.abs(cx) + w * 0.5, Math.abs(cy) + h * 0.5, vr, 32);
    return entityX + pad >= viewLeft && entityX - pad <= viewRight &&
      entityY + pad >= viewTop && entityY - pad <= viewBottom;
  }

  _cssRgb(colorInt) {
    const key = colorInt & 0xffffff;
    let s = this._ddRgb.get(key);
    if (s === undefined) {
      s = 'rgb(' + ((key >> 16) & 255) + ',' + ((key >> 8) & 255) + ',' + (key & 255) + ')';
      this._ddRgb.set(key, s);
    }
    return s;
  }

  _cssRgba30(colorInt) {
    const key = colorInt & 0xffffff;
    let s = this._ddRgba30.get(key);
    if (s === undefined) {
      s = 'rgba(' + ((key >> 16) & 255) + ',' + ((key >> 8) & 255) + ',' + (key & 255) + ',0.3)';
      this._ddRgba30.set(key, s);
    }
    return s;
  }

  _ddTextAt(slot, buf, off) {
    const len = buf[off + 7] | 0;
    let hash = len;
    for (let c = 0; c < len; c++) hash = (Math.imul(hash, 31) + (buf[off + 8 + c] | 0)) | 0;
    if (this._ddTextHash[slot] === hash) return this._ddText[slot];
    this._ddTextHash[slot] = hash;
    let text = '';
    for (let c = 0; c < len; c++) text += String.fromCharCode(buf[off + 8 + c]);
    this._ddText[slot] = text;
    this._ddTextWidth[slot] = -1;
    return text;
  }

  _indexWidth(ctx, i) {
    const widths = this._indexWidths;
    let w = widths[i];
    if (w === undefined) {
      w = ctx.measureText(this._indexLabel(i)).width;
      widths[i] = w;
    }
    return w;
  }

  // ------- spatial grid -------

  drawSpatialGrid(ctx, canvas, camera, zoom) {
    if (!Grid.cellSize) return;

    const cellSize = Grid.cellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const worldWidth = gridCols * cellSize;
    const worldHeight = gridRows * cellSize;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(gridCols, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(gridRows, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);

    const worldStartX = startCellX * cellSize;
    const worldStartY = startCellY * cellSize;
    const worldEndX = Math.min(endCellX * cellSize, worldWidth);
    const worldEndY = Math.min(endCellY * cellSize, worldHeight);

    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = startCellX; x <= endCellX; x++) {
      const sx = (x * cellSize - camera.x) * zoom;
      ctx.moveTo(sx, (worldStartY - camera.y) * zoom);
      ctx.lineTo(sx, (worldEndY - camera.y) * zoom);
    }
    for (let y = startCellY; y <= endCellY; y++) {
      const sy = (y * cellSize - camera.y) * zoom;
      ctx.moveTo((worldStartX - camera.x) * zoom, sy);
      ctx.lineTo((worldEndX - camera.x) * zoom, sy);
    }
    ctx.stroke();
  }

  // ------- sleeping cells -------

  drawSleepingCells(ctx, canvas, camera, zoom) {
    if (!Grid.cellSleepingData || !Grid.cellSize) return;

    const cellSize = Grid.cellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSleepingData = Grid.cellSleepingData;
    const cellSizeScreen = cellSize * zoom;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(gridCols, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(gridRows, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);

    ctx.fillStyle = 'rgba(0, 200, 255, 0.3)';
    for (let row = startCellY; row < endCellY; row++) {
      for (let col = startCellX; col < endCellX; col++) {
        if (cellSleepingData[row * gridCols + col] === 1) {
          ctx.fillRect((col * cellSize - camera.x) * zoom, (row * cellSize - camera.y) * zoom, cellSizeScreen, cellSizeScreen);
        }
      }
    }

    ctx.strokeStyle = 'rgba(0, 200, 255, 0.6)';
    ctx.lineWidth = 1;
    for (let row = startCellY; row < endCellY; row++) {
      for (let col = startCellX; col < endCellX; col++) {
        if (cellSleepingData[row * gridCols + col] === 1) {
          ctx.strokeRect((col * cellSize - camera.x) * zoom, (row * cellSize - camera.y) * zoom, cellSizeScreen, cellSizeScreen);
        }
      }
    }
  }

  // ------- colliders -------

  drawColliders(ctx, canvas, camera, zoom, pose, flags) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const colActive = Collider.active;
    const shapeType = Collider.shapeType;
    const isTrigger = Collider.isTrigger;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const rbActive = RigidBody.active;
    const rbStatic = RigidBody.static;
    const poseX = pose ? pose.x : null;
    const poseY = pose ? pose.y : null;
    const poseRotC = pose ? pose.rotC : null;
    const poseRotS = pose ? pose.rotS : null;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const n = Math.min(active.length, x.length);

    const viewLeft = camera.x - 100;
    const viewRight = camera.x + canvas.width / zoom + 100;
    const viewTop = camera.y - 100;
    const viewBottom = camera.y + canvas.height / zoom + 100;

    ctx.lineWidth = 2;

    for (let i = 0; i < n; i++) {
      if (!active[i] || !colActive?.[i]) continue;
      if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
      const usePose = !!(poseX && rbActive && rbActive[i] && this._posePublished(i, poseRotC, poseRotS));
      const entityX = usePose ? poseX[i] : x[i];
      const entityY = usePose ? (poseY ? poseY[i] : y[i]) : y[i];
      if (!this._colliderDebugInView(i, entityX, entityY, viewLeft, viewRight, viewTop, viewBottom)) continue;

      const ox = offsetX?.[i] || 0;
      const oy = offsetY?.[i] || 0;
      const shape = shapeType[i];
      const c = usePose && poseRotC ? poseRotC[i] : (Transform.rotC ? Transform.rotC[i] : 1);
      const s = usePose && poseRotS ? poseRotS[i] : (Transform.rotS ? Transform.rotS[i] : 0);

      // Rotate offset for Box and Polygon (Circle keeps axis-aligned offset)
      let posX;
      let posY;
      if (shape === ShapeType.Circle) {
        posX = entityX + ox;
        posY = entityY + oy;
      } else {
        posX = entityX + c * ox - s * oy;
        posY = entityY + s * ox + c * oy;
      }

      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      ctx.strokeStyle = isTrigger[i]
        ? 'rgba(255, 255, 0, 0.8)'
        : (rbStatic && rbStatic[i] ? 'rgba(180, 180, 180, 0.85)' : 'rgba(0, 255, 0, 0.8)');

      const extras = Collider.fixtureCount ? (Collider.fixtureCount[i] | 0) : 0;
      if (extras > 0 && ColliderFixture.head) {
        this._strokeFixtures(ctx, i, sx, sy, c, s, zoom, false);
        continue;
      }

      if (shape === ShapeType.Circle) {
        const r = radius[i];
        if (!(r > 0)) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shape === ShapeType.Box) {
        const w = width[i];
        const h = height[i];
        if (!(w > 0) || !(h > 0)) continue;
        this._strokeOrientedBox(ctx, sx, sy, w * zoom, h * zoom, c, s);
      } else if (shape === ShapeType.Polygon) {
        const count = Collider.polyCount?.[i] || 0;
        if (count >= 3) {
          const base = i * 8;
          const vx = Collider.polyVertexX;
          const vy = Collider.polyVertexY;
          ctx.beginPath();
          for (let v = 0; v < count; v++) {
            const lx = vx[base + v];
            const ly = vy[base + v];
            const wx = sx + (c * lx - s * ly) * zoom;
            const wy = sy + (s * lx + c * ly) * zoom;
            if (v === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.closePath();
          ctx.stroke();
        } else {
          const w = width[i];
          const h = height[i];
          if (!(w > 0) || !(h > 0)) continue;
          this._strokeOrientedBox(ctx, sx, sy, w * zoom, h * zoom, c, s);
        }
      }
    }
  }

  _strokeFixtures(ctx, entityIdx, sx, sy, c, s, zoom, fill) {
    ColliderFixture.forEach(entityIdx, (fi) => {
      const count = ColliderFixture.vertCount[fi] | 0;
      if (count < 3) return;
      const base = ColliderFixture.vertBase(fi);
      const vx = ColliderFixture.vertexX;
      const vy = ColliderFixture.vertexY;
      ctx.beginPath();
      for (let v = 0; v < count; v++) {
        const lx = vx[base + v];
        const ly = vy[base + v];
        const wx = sx + (c * lx - s * ly) * zoom;
        const wy = sy + (s * lx + c * ly) * zoom;
        if (v === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      }
      ctx.closePath();
      if (fill) ctx.fill();
      ctx.stroke();
    });
  }

  /** Stroke a width×height box centered at (sx,sy), oriented by cos/sin. */
  _strokeOrientedBox(ctx, sx, sy, wZoom, hZoom, c, s, fill = false) {
    const hw = wZoom * 0.5;
    const hh = hZoom * 0.5;
    const x0 = -hw, y0 = -hh;
    const x1 = hw, y1 = -hh;
    const x2 = hw, y2 = hh;
    const x3 = -hw, y3 = hh;
    ctx.beginPath();
    ctx.moveTo(sx + c * x0 - s * y0, sy + s * x0 + c * y0);
    ctx.lineTo(sx + c * x1 - s * y1, sy + s * x1 + c * y1);
    ctx.lineTo(sx + c * x2 - s * y2, sy + s * x2 + c * y2);
    ctx.lineTo(sx + c * x3 - s * y3, sy + s * x3 + c * y3);
    ctx.closePath();
    if (fill) ctx.fill();
    ctx.stroke();
  }

  // ------- entity origins -------

  drawEntityOrigins(ctx, canvas, camera, zoom, flags, pose) {
    const active = Transform.active;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const pos = this._pos;

    const crossSize = 4;
    const selectedCrossSize = 8;

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
      this._worldXY(i, pose, pos);
      const sx = (pos.x - camera.x) * zoom;
      const sy = (pos.y - camera.y) * zoom;
      const isSelected = i === selectedIdx;
      const size = isSelected ? selectedCrossSize : crossSize;

      ctx.strokeStyle = isSelected ? 'rgba(255, 50, 255, 1.0)' : 'rgba(255, 50, 255, 0.7)';
      ctx.lineWidth = isSelected ? 2 : 1;

      ctx.beginPath();
      ctx.moveTo(sx - size, sy); ctx.lineTo(sx + size, sy);
      ctx.moveTo(sx, sy - size); ctx.lineTo(sx, sy + size);
      ctx.stroke();

      ctx.fillStyle = isSelected ? 'rgba(255, 50, 255, 1.0)' : 'rgba(255, 50, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(sx, sy, isSelected ? 3 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ------- velocity -------

  drawVelocityVectors(ctx, canvas, camera, zoom, flags, pose) {
    if (!RigidBody.vx || !RigidBody.vy) return;
    const active = Transform.active;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const angVel = RigidBody.angularVelocity;
    const scale = 0.05;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const pos = this._pos;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 136, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash(EMPTY_DASH);
    const maxLen = 80;
    ctx.beginPath();
    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
      const velX = vx[i];
      const velY = vy[i];
      if (Math.abs(velX) < 0.01 && Math.abs(velY) < 0.01) continue;

      let dx = velX * scale * zoom;
      let dy = velY * scale * zoom;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > maxLen) { const s = maxLen / len; dx *= s; dy *= s; }

      this._worldXY(i, pose, pos);
      const sx = (pos.x - camera.x) * zoom;
      const sy = (pos.y - camera.y) * zoom;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + dx, sy + dy);
    }
    ctx.stroke();

    if (selectedIdx >= 0 && active[selectedIdx] && isOnScreen[selectedIdx]) {
      this._worldXY(selectedIdx, pose, pos);
      const sx = (pos.x - camera.x) * zoom;
      const sy = (pos.y - camera.y) * zoom;
      const velX = vx[selectedIdx];
      const velY = vy[selectedIdx];
      if (Math.abs(velX) >= 0.01 || Math.abs(velY) >= 0.01) {
        let dx = velX * scale * zoom;
        let dy = velY * scale * zoom;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > maxLen) { const s = maxLen / len; dx *= s; dy *= s; }
        if (len > 4) {
          const inv = 1 / (len > maxLen ? maxLen : len);
          const ux = dx * inv;
          const uy = dy * inv;
          const ah = 7;
          ctx.beginPath();
          ctx.moveTo(sx + dx, sy + dy);
          ctx.lineTo(sx + dx - ux * ah + uy * ah * 0.5, sy + dy - uy * ah - ux * ah * 0.5);
          ctx.moveTo(sx + dx, sy + dy);
          ctx.lineTo(sx + dx - ux * ah - uy * ah * 0.5, sy + dy - uy * ah + ux * ah * 0.5);
          ctx.stroke();
        }
        const speedI = (Math.sqrt(velX * velX + velY * velY) * 10) | 0;
        if (this._velSpeedI !== speedI) {
          this._velSpeedI = speedI;
          this._velLabel = (speedI / 10).toFixed(1) + ' px/s';
        }
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0, 136, 255, 0.95)';
        ctx.fillText(this._velLabel, sx + 8, sy - 8);
      }
      const w = angVel ? angVel[selectedIdx] : 0;
      if (Math.abs(w) > 0.02) {
        const r = 14;
        ctx.strokeStyle = 'rgba(180, 120, 255, 0.9)';
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.min(Math.PI * 1.6, Math.abs(w) * 0.4));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ------- acceleration -------

  drawAccelerationVectors(ctx, canvas, camera, zoom, flags, pose) {
    const active = Transform.active;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    if (!ax || !ay) return;
    const scale = 50;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const pos = this._pos;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 0, 68, 0.9)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash(EMPTY_DASH);
    const maxLen = 80;
    ctx.beginPath();
    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
      const accX = ax[i];
      const accY = ay[i];
      if (Math.abs(accX) < 0.01 && Math.abs(accY) < 0.01) continue;

      let dx = accX * scale * zoom;
      let dy = accY * scale * zoom;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > maxLen) { const s = maxLen / len; dx *= s; dy *= s; }

      this._worldXY(i, pose, pos);
      const sx = (pos.x - camera.x) * zoom;
      const sy = (pos.y - camera.y) * zoom;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + dx, sy + dy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ------- sleeping entities -------

  drawSleepingEntities(ctx, canvas, camera, zoom, pose) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const rigidBodyActive = RigidBody.active;
    const sleeping = RigidBody.sleeping;
    if (!sleeping) return;

    const colActive = Collider.active;
    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;
    const poseX = pose ? pose.x : null;
    const poseY = pose ? pose.y : null;
    const poseRotC = pose ? pose.rotC : null;
    const poseRotS = pose ? pose.rotS : null;
    const n = Math.min(active.length, x.length);

    const viewLeft = camera.x - 100;
    const viewRight = camera.x + canvas.width / zoom + 100;
    const viewTop = camera.y - 100;
    const viewBottom = camera.y + canvas.height / zoom + 100;

    ctx.strokeStyle = 'rgba(255, 0, 255, 0.8)';
    ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
    ctx.lineWidth = 3 / zoom;

    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      if (!rigidBodyActive[i] || !sleeping[i]) continue;
      if (colActive && !colActive[i]) continue;

      const usePose = !!(poseX && rigidBodyActive[i] && this._posePublished(i, poseRotC, poseRotS));
      const entityX = usePose ? poseX[i] : x[i];
      const entityY = usePose ? (poseY ? poseY[i] : y[i]) : y[i];
      if (!this._colliderDebugInView(i, entityX, entityY, viewLeft, viewRight, viewTop, viewBottom)) continue;

      const ox = offsetX?.[i] || 0;
      const oy = offsetY?.[i] || 0;
      const shape = shapeType?.[i];
      const c = usePose && poseRotC ? poseRotC[i] : (Transform.rotC ? Transform.rotC[i] : 1);
      const s = usePose && poseRotS ? poseRotS[i] : (Transform.rotS ? Transform.rotS[i] : 0);

      let posX;
      let posY;
      if (shape === ShapeType.Circle) {
        posX = entityX + ox;
        posY = entityY + oy;
      } else {
        posX = entityX + c * ox - s * oy;
        posY = entityY + s * ox + c * oy;
      }
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      const extras = Collider.fixtureCount ? (Collider.fixtureCount[i] | 0) : 0;
      if (extras > 0 && ColliderFixture.head) {
        this._strokeFixtures(ctx, i, sx, sy, c, s, zoom, true);
        continue;
      }

      if (shape === ShapeType.Circle) {
        const r = radius?.[i] || 10;
        if (!(r > 0)) continue;
        ctx.beginPath(); ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else if (shape === ShapeType.Box) {
        const w = width?.[i] || 20;
        const h = height?.[i] || 20;
        if (!(w > 0) || !(h > 0)) continue;
        this._strokeOrientedBox(ctx, sx, sy, w * zoom, h * zoom, c, s, true);
      } else if (shape === ShapeType.Polygon) {
        const count = Collider.polyCount?.[i] || 0;
        if (count >= 3) {
          const base = i * 8;
          const vx = Collider.polyVertexX;
          const vy = Collider.polyVertexY;
          ctx.beginPath();
          for (let v = 0; v < count; v++) {
            const lx = vx[base + v];
            const ly = vy[base + v];
            const wx = sx + (c * lx - s * ly) * zoom;
            const wy = sy + (s * lx + c * ly) * zoom;
            if (v === 0) ctx.moveTo(wx, wy);
            else ctx.lineTo(wx, wy);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const w = width?.[i] || 20;
          const h = height?.[i] || 20;
          if (!(w > 0) || !(h > 0)) continue;
          this._strokeOrientedBox(ctx, sx, sy, w * zoom, h * zoom, c, s, true);
        }
      } else {
        ctx.beginPath(); ctx.arc(sx, sy, 10 * zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  // ------- neighbor connections -------

  drawNeighborConnections(ctx, canvas, camera, zoom) {
    if (!Grid.neighborData || !Mouse.isPresent) return;

    const closest = this._findClosestEntity(Mouse.x, Mouse.y, 150);
    if (closest === -1) return;

    const myX = Transform.x[closest];
    const myY = Transform.y[closest];
    const mySx = (myX - camera.x) * zoom;
    const mySy = (myY - camera.y) * zoom;

    getColliderBounds(closest, _boundsResult);
    const highlightRadius = (Math.max(_boundsResult.halfW, _boundsResult.halfH) * 1.5 || 10) * zoom;
    ctx.strokeStyle = 'rgba(255, 255, 0, 1.0)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mySx, mySy, highlightRadius, 0, Math.PI * 2); ctx.stroke();

    const offset = closest * Grid._stride;
    const neighborCount = Grid.neighborData[offset];

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.7)';
    ctx.lineWidth = 2;

    for (let n = 0; n < neighborCount; n++) {
      const nIdx = Grid.neighborData[offset + 1 + n];
      if (!Transform.active[nIdx]) continue;
      const nSx = (Transform.x[nIdx] - camera.x) * zoom;
      const nSy = (Transform.y[nIdx] - camera.y) * zoom;
      ctx.beginPath(); ctx.moveTo(mySx, mySy); ctx.lineTo(nSx, nSy); ctx.stroke();
      ctx.fillStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.beginPath(); ctx.arc(nSx, nSy, 3 * zoom, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath(); ctx.arc(mySx, mySy - 20, 4 * zoom, 0, Math.PI * 2); ctx.fill();
  }

  // ------- debug draw primitives -------

  drawDebugPrimitives(ctx, canvas, camera, zoom) {
    if (!DebugDraw._initialized || !DebugDraw._buffer) return;

    const buf    = DebugDraw._buffer;
    const stride = DebugDraw.ENTRY_STRIDE;
    const max    = DebugDraw._maxEntries;
    const now    = performance.now();

    for (let i = 0; i < max; i++) {
      const off  = i * stride;
      const type = buf[off];
      if (type === 0) continue;

      const expireTime = buf[off + 6];
      if (now > expireTime) {
        buf[off] = 0; // mark expired
        continue;
      }

      const colorInt = buf[off + 5] | 0;
      const rgb = this._cssRgb(colorInt);

      switch (type) {
        case DebugDraw.TYPE_LINE: {
          const sx1 = (buf[off + 1] - camera.x) * zoom;
          const sy1 = (buf[off + 2] - camera.y) * zoom;
          const sx2 = (buf[off + 3] - camera.x) * zoom;
          const sy2 = (buf[off + 4] - camera.y) * zoom;
          ctx.strokeStyle = rgb;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.stroke();
          break;
        }
        case DebugDraw.TYPE_CIRCLE: {
          const sx = (buf[off + 1] - camera.x) * zoom;
          const sy = (buf[off + 2] - camera.y) * zoom;
          const sr = buf[off + 3] * zoom;
          ctx.strokeStyle = rgb;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case DebugDraw.TYPE_RECT: {
          const rx = buf[off + 1];
          const ry = buf[off + 2];
          const rw = buf[off + 3];
          const rh = buf[off + 4];
          ctx.strokeStyle = rgb;
          ctx.lineWidth = 2;
          ctx.strokeRect(
            (rx - rw / 2 - camera.x) * zoom,
            (ry - rh / 2 - camera.y) * zoom,
            rw * zoom,
            rh * zoom
          );
          break;
        }
        case DebugDraw.TYPE_TEXT: {
          const tx = (buf[off + 1] - camera.x) * zoom;
          const ty = (buf[off + 2] - camera.y) * zoom;
          const text = this._ddTextAt(i, buf, off);
          ctx.font = '12px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          let tw = this._ddTextWidth[i];
          if (!(tw >= 0)) {
            tw = ctx.measureText(text).width;
            this._ddTextWidth[i] = tw;
          }
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(tx - tw / 2 - 2, ty - 12, tw + 4, 14);
          ctx.fillStyle = rgb;
          ctx.fillText(text, tx, ty);
          break;
        }
        case DebugDraw.TYPE_CELL: {
          const cellSize = Grid.cellSize || 64;
          const cx = buf[off + 1] * cellSize;
          const cy = buf[off + 2] * cellSize;
          const scx = (cx - camera.x) * zoom;
          const scy = (cy - camera.y) * zoom;
          const scs = cellSize * zoom;
          ctx.fillStyle = this._cssRgba30(colorInt);
          ctx.fillRect(scx, scy, scs, scs);
          ctx.strokeStyle = rgb;
          ctx.lineWidth = 2;
          ctx.strokeRect(scx, scy, scs, scs);
          break;
        }
        case DebugDraw.TYPE_POINT: {
          const px = (buf[off + 1] - camera.x) * zoom;
          const py = (buf[off + 2] - camera.y) * zoom;
          ctx.fillStyle = rgb;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
  }

  // ------- entity indices -------

  drawEntityIndices(ctx, canvas, camera, zoom, flags, pose) {
    const active = Transform.active;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const pos = this._pos;

    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
      this._worldXY(i, pose, pos);
      const sx = (pos.x - camera.x) * zoom;
      const sy = (pos.y - camera.y) * zoom - 15;
      const text = this._indexLabel(i);
      const tw = this._indexWidth(ctx, i);
      const pad = 2;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(sx - tw / 2 - pad, sy - 12, tw + pad * 2, 14);
      ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.fillText(text, sx, sy);
    }
  }

  // ------- joints -------

  /** Body-local anchor → world (inverse of Joint._worldToLocal). */
  _localAnchorToWorld(entity, lx, ly, out) {
    const c = Transform.rotC ? Transform.rotC[entity] : 1;
    const s = Transform.rotS ? Transform.rotS[entity] : 0;
    out.x = Transform.x[entity] + lx * c - ly * s;
    out.y = Transform.y[entity] + lx * s + ly * c;
    return out;
  }

  drawJoints(ctx, canvas, camera, zoom, flags) {
    if (!Joint.initialized || !Joint.pairs || !Joint.active) return;
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);

    const pairs = Joint.pairs;
    const restLength = Joint.length;
    const jointActive = Joint.active;
    const jointType = Joint.type;
    const activeIndices = Joint.activeIndices;
    const activeJointCount = Joint.getDenseActiveCount();
    const entityActive = Transform.active;
    const laX = Joint.localAnchorAX;
    const laY = Joint.localAnchorAY;
    const lbX = Joint.localAnchorBX;
    const lbY = Joint.localAnchorBY;

    const worldA = this._worldA;
    const worldB = this._worldB;

    ctx.lineWidth = 2;

    for (let slot = 0; slot < activeJointCount; slot++) {
      const i = activeIndices[slot];
      if (!jointActive[i]) continue;
      const packed = pairs[i];
      const entityA = packed >>> 16;
      const entityB = packed & 0xFFFF;
      if (!entityActive[entityA] || !entityActive[entityB]) continue;
      if (selectedOnly && selectedIdx >= 0 && entityA !== selectedIdx && entityB !== selectedIdx) continue;

      this._localAnchorToWorld(entityA, laX[i], laY[i], worldA);
      this._localAnchorToWorld(entityB, lbX[i], lbY[i], worldB);

      const sax = (worldA.x - camera.x) * zoom;
      const say = (worldA.y - camera.y) * zoom;
      const sbx = (worldB.x - camera.x) * zoom;
      const sby = (worldB.y - camera.y) * zoom;

      if ((sax < -50 && sbx < -50) || (sax > canvas.width + 50 && sbx > canvas.width + 50) ||
        (say < -50 && sby < -50) || (say > canvas.height + 50 && sby > canvas.height + 50)) continue;

      const t = jointType[i] | 0;

      if (t === Joint.TYPE.DISTANCE) {
        const dx = worldB.x - worldA.x;
        const dy = worldB.y - worldA.y;
        const currentDist = Math.sqrt(dx * dx + dy * dy);
        const targetDist = restLength[i] > 0 ? restLength[i] : currentDist || 1;
        const stretchRatio = currentDist / targetDist;

        let r, g, b;
        if (stretchRatio < 0.9) { r = 0; g = 200; b = 255; }
        else if (stretchRatio < 1.1) { r = 50; g = 255; b = 50; }
        else if (stretchRatio < 1.3) {
          const u = (stretchRatio - 1.1) / 0.2;
          r = Math.floor(50 + 205 * u); g = 255; b = Math.floor(50 * (1 - u));
        } else {
          r = 255; g = Math.max(0, Math.floor(255 * (2 - stretchRatio))); b = 0;
        }

        const alpha = Joint.enableSpring[i] ? 0.55 : 0.9;
        const key = (r << 24) | (g << 16) | (b << 8) | ((alpha * 20) | 0);
        if (key !== this._jointKey) {
          this._jointKey = key;
          this._jointCss = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
          this._jointFillCss = 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha + 0.2) + ')';
        }
        ctx.strokeStyle = this._jointCss;
        ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby); ctx.stroke();

        ctx.fillStyle = this._jointFillCss;
        ctx.beginPath(); ctx.arc(sax, say, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(sbx, sby, 3, 0, Math.PI * 2); ctx.fill();
        continue;
      }

      // Weld / revolute: draw at attachment point(s), not body centers
      const mx = (sax + sbx) * 0.5;
      const my = (say + sby) * 0.5;
      const sep = Math.hypot(sbx - sax, sby - say);

      if (t === Joint.TYPE.WELD) {
        ctx.strokeStyle = 'rgba(255, 180, 40, 0.95)';
        ctx.fillStyle = 'rgba(255, 180, 40, 0.85)';
        // Thin line only if anchors drifted apart (breaking / soft)
        if (sep > 2) {
          ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby); ctx.stroke();
        }
        const s = 5;
        ctx.beginPath();
        ctx.moveTo(mx - s, my); ctx.lineTo(mx + s, my);
        ctx.moveTo(mx, my - s); ctx.lineTo(mx, my + s);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, Math.PI * 2); ctx.fill();
      } else if (t === Joint.TYPE.REVOLUTE) {
        ctx.strokeStyle = 'rgba(80, 200, 255, 0.95)';
        ctx.fillStyle = 'rgba(80, 200, 255, 0.75)';
        if (sep > 2) {
          ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fill();
      } else {
        // Unknown / prismatic fallback: line between world anchors
        ctx.strokeStyle = 'rgba(200, 200, 200, 0.8)';
        ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby); ctx.stroke();
        ctx.fillStyle = 'rgba(200, 200, 200, 0.9)';
        ctx.beginPath(); ctx.arc(sax, say, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(sbx, sby, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ------- selected entity -------

  drawSelectedEntity(ctx, canvas, camera, zoom, flags, pose) {
    const selectedIdx = flags ? flags.getSelectedEntity() : -1;
    if (selectedIdx < 0 || !Transform.active[selectedIdx]) return;

    const pos = this._pos;
    this._worldXY(selectedIdx, pose, pos);
    const posX = pos.x;
    const posY = pos.y;

    const width = SpriteRenderer.getOriginalWidth(selectedIdx) || 20;
    const height = SpriteRenderer.getOriginalHeight(selectedIdx) || 20;
    const scaleX = SpriteRenderer.scaleX?.[selectedIdx] || 1;
    const scaleY = SpriteRenderer.scaleY?.[selectedIdx] || 1;
    const anchorX = SpriteRenderer.anchorX?.[selectedIdx] || 0.5;
    const anchorY = SpriteRenderer.anchorY?.[selectedIdx] || 0.5;

    const w = width * Math.abs(scaleX);
    const h = height * Math.abs(scaleY);
    const left = posX - w * anchorX;
    const top = posY - h * anchorY;

    const sLeft = (left - camera.x) * zoom;
    const sTop = (top - camera.y) * zoom;
    const sWidth = w * zoom;
    const sHeight = h * zoom;

    ctx.strokeStyle = 'rgba(255, 200, 100, 1.0)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sLeft, sTop, sWidth, sHeight);

    const cornerSize = 6;
    ctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
    ctx.beginPath(); ctx.arc(sLeft, sTop, cornerSize, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sLeft + sWidth, sTop, cornerSize, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sLeft, sTop + sHeight, cornerSize, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sLeft + sWidth, sTop + sHeight, cornerSize, 0, Math.PI * 2); ctx.fill();

    const sx = (posX - camera.x) * zoom;
    const labelY = sTop - 15;
    const text = this._indexLabel(selectedIdx);
    ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    if (this._selLabelIdx !== selectedIdx) {
      this._selLabelIdx = selectedIdx;
      this._selLabelWidth = ctx.measureText(text).width;
    }
    const tw = this._selLabelWidth;
    ctx.fillStyle = 'rgba(255, 200, 100, 0.9)';
    ctx.fillRect(sx - tw / 2 - 4, labelY - 12, tw + 8, 16);
    ctx.fillStyle = 'rgba(0, 0, 0, 1.0)';
    ctx.fillText(text, sx, labelY);
  }

  drawLights(ctx, canvas, camera, zoom, flags, pose, visPoly) {
    const { selectedOnly, selectedIdx } = this._selectedFilter(flags);
    const pos = this._pos;
    const active = LightEmitter.active;
    if (active) {
      const n = active.length;
      ctx.strokeStyle = 'rgba(255, 220, 80, 0.7)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < n; i++) {
        if (!active[i] || !Transform.active[i]) continue;
        if (this._skipUnselected(i, selectedOnly, selectedIdx)) continue;
        this._worldXY(i, pose, pos);
        const sx = (pos.x - camera.x) * zoom;
        const sy = (pos.y - camera.y) * zoom;
        ctx.fillStyle = 'rgba(255, 220, 80, 0.95)';
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fill();
        const range = Collider.visualRange?.[i] || 0;
        const influence = lightInfluenceRadius(LightEmitter.sqrtLightIntensity?.[i] || 0);
        const r = (range > influence ? range : influence) * zoom;
        if (r > 2) {
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    if (!visPoly || !visPoly.buf || visPoly.lightCount < 1) return;
    const f32 = visPoly.buf.f32;
    const i32 = visPoly.buf.i32;
    const maxVerts = visPoly.maxVerts;
    const slotBytes = visPoly.slotBytes;
    const lightCount = visPoly.lightCount;
    ctx.strokeStyle = 'rgba(255, 180, 40, 0.85)';
    ctx.lineWidth = 1.5;
    for (let li = 0; li < lightCount; li++) {
      const baseIndex = (4 + li * slotBytes) >> 2;
      const vertCount = i32[baseIndex + 3];
      if (vertCount < 3) continue;
      const xStart = baseIndex + 4;
      const yStart = xStart + maxVerts;
      ctx.beginPath();
      for (let v = 0; v < vertCount; v++) {
        const wx = (f32[xStart + v] - camera.x) * zoom;
        const wy = (f32[yStart + v] - camera.y) * zoom;
        if (v === 0) ctx.moveTo(wx, wy);
        else ctx.lineTo(wx, wy);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  drawEntityInfo(ctx, canvas, camera, zoom, pose) {
    if (!Mouse.isPresent) return;
    const closest = this._findClosestEntity(Mouse.x, Mouse.y, 80);
    if (closest < 0) return;
    this._worldXY(closest, pose, this._pos);
    const sx = (this._pos.x - camera.x) * zoom;
    const sy = (this._pos.y - camera.y) * zoom;
    const vx = RigidBody.vx ? RigidBody.vx[closest] : 0;
    const vy = RigidBody.vy ? RigidBody.vy[closest] : 0;
    const speedI = (Math.sqrt(vx * vx + vy * vy) * 10) | 0;
    if (this._hoverIdx !== closest || this._hoverSpeedI !== speedI) {
      this._hoverIdx = closest;
      this._hoverSpeedI = speedI;
      const name = this._typeNames[Transform.entityType[closest]] || 'Entity';
      this._hoverLabel = name + ' #' + closest + '  ' + (speedI / 10).toFixed(1) + ' px/s';
      this._hoverWidth = -1;
    }
    const text = this._hoverLabel;
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    if (this._hoverWidth < 0) this._hoverWidth = ctx.measureText(text).width;
    const w = this._hoverWidth;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(sx - w * 0.5 - 4, sy - 28, w + 8, 16);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(text, sx, sy - 14);
  }

  drawPoolSelection(ctx, canvas, camera, zoom, kind, index) {
    if (index < 0 || !kind) return;
    let x = 0;
    let y = 0;
    let w = 16;
    let h = 16;
    if (kind === 'decoration') {
      if (!DecorationComponent.active || !DecorationComponent.active[index]) return;
      x = DecorationComponent.x[index];
      y = DecorationComponent.y[index];
      const size = this._decorationTextureSize(index);
      w = size.w * Math.abs(DecorationComponent.scaleX[index] || 1);
      h = size.h * Math.abs(DecorationComponent.scaleY[index] || 1);
      const ax = DecorationComponent.anchorX ? DecorationComponent.anchorX[index] : 0.5;
      const ay = DecorationComponent.anchorY ? DecorationComponent.anchorY[index] : 0.5;
      const c = DecorationComponent.rotC ? DecorationComponent.rotC[index] : 1;
      const s = DecorationComponent.rotS ? DecorationComponent.rotS[index] : 0;
      const ox = (0.5 - ax) * w;
      const oy = (0.5 - ay) * h;
      const cx = x + c * ox - s * oy;
      const cy = y + s * ox + c * oy;
      const sx0 = (cx - camera.x) * zoom;
      const sy0 = (cy - camera.y) * zoom;
      ctx.strokeStyle = 'rgba(80, 220, 140, 1)';
      ctx.lineWidth = 2;
      this._strokeOrientedBox(ctx, sx0, sy0, w * zoom, h * zoom, c, s);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc((x - camera.x) * zoom, (y - camera.y) * zoom, 3, 0, Math.PI * 2);
      ctx.fill();
      if (DecorationComponent.parentEntityIndex) {
        const p = DecorationComponent.parentEntityIndex[index];
        if (p !== DECORATION_NO_PARENT && Transform.active[p]) {
          const px = (Transform.x[p] - camera.x) * zoom;
          const py = (Transform.y[p] - camera.y) * zoom;
          ctx.setLineDash(DASH_DECO_PARENT);
          ctx.beginPath();
          ctx.moveTo((x - camera.x) * zoom, (y - camera.y) * zoom);
          ctx.lineTo(px, py);
          ctx.stroke();
          ctx.setLineDash(EMPTY_DASH);
        }
      }
      return;
    } else if (kind === 'particle') {
      if (!ParticleComponent.active || !ParticleComponent.active[index]) return;
      x = ParticleComponent.x[index];
      y = ParticleComponent.y[index];
      w = 12 * Math.abs(ParticleComponent.scaleX[index] || 1);
      h = 12 * Math.abs(ParticleComponent.scaleY[index] || 1);
    } else if (kind === 'bullet') {
      if (!BulletComponent.active || !BulletComponent.active[index]) return;
      x = BulletComponent.x[index];
      y = BulletComponent.y[index];
      w = 16 * (BulletComponent.scale[index] || 1);
      h = 8;
    } else {
      return;
    }
    const sx = (x - camera.x) * zoom;
    const sy = (y - camera.y) * zoom;
    ctx.strokeStyle = kind === 'bullet' ? 'rgba(255, 160, 60, 1)' : 'rgba(250, 140, 220, 1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx - w * 0.5 * zoom, sy - h * 0.5 * zoom, w * zoom, h * zoom);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  _decorationTextureSize(index) {
    const texId = DecorationComponent.textureId[index] | 0;
    if (texId === this._decoSizeTex) {
      this._decoSize.w = this._decoSizeW;
      this._decoSize.h = this._decoSizeH;
      return this._decoSize;
    }
    let w = 0;
    let h = 0;
    const meta = this.scene?.textureMetadata;
    const start = meta?.animationFrameStart ? meta.animationFrameStart[texId] : undefined;
    if (start != null && meta.frameWidth && meta.frameHeight) {
      w = meta.frameWidth[start] | 0;
      h = meta.frameHeight[start] | 0;
    }
    if (!(w > 0) || !(h > 0)) {
      const name = SpriteSheetRegistry.getAnimationName('bigAtlas', texId);
      const dims = name ? SpriteSheetRegistry.getFrameDimensions('bigAtlas', name) : null;
      if (dims) {
        w = dims.w | 0;
        h = dims.h | 0;
      }
    }
    if (!(w > 0)) w = 20;
    if (!(h > 0)) h = 20;
    this._decoSizeTex = texId;
    this._decoSizeW = w;
    this._decoSizeH = h;
    this._decoSize.w = w;
    this._decoSize.h = h;
    return this._decoSize;
  }

  // ------- internal helpers -------

  _findClosestEntity(mouseX, mouseY, searchRadius) {
    const { count, entities } = Grid.getEntitiesInRadius(mouseX, mouseY, searchRadius);
    let closest = -1;
    let closestDist2 = Infinity;

    for (let i = 0; i < count; i++) {
      const id = entities[i];
      if (!Transform.active[id]) continue;
      const d2 = distanceSq2D(mouseX, mouseY, Transform.x[id], Transform.y[id]);
      if (d2 < closestDist2) { closestDist2 = d2; closest = id; }
    }
    return closest;
  }
}
