// PhysicsDebugRenderer.js — Draws entity-level debug overlays
// Colliders, velocity, acceleration, neighbors, raycasts, sleeping, constraints, origins, indices

import { Transform } from '../../../components/Transform.js';
import { RigidBody } from '../../../components/RigidBody.js';
import { Collider } from '../../../components/Collider.js';
import { SpriteRenderer } from '../../../components/SpriteRenderer.js';
import { Mouse } from '../../Mouse.js';
import { Grid } from '../../Grid.js';
import { Constraint } from '../../Constraint.js';
import { distanceSq2D } from '../../utils.js';

export class PhysicsDebugRenderer {
  constructor() {
    this.scene = null;
  }

  attach(scene) {
    this.scene = scene;
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

    ctx.strokeStyle = 'rgba(255, 255, 0, 0.2)';
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

  drawColliders(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const shapeType = Collider.shapeType;
    const isTrigger = Collider.isTrigger;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    const viewLeft = camera.x - 100;
    const viewRight = camera.x + canvas.width / zoom + 100;
    const viewTop = camera.y - 100;
    const viewBottom = camera.y + canvas.height / zoom + 100;

    ctx.lineWidth = 2;

    for (let i = 0; i < active.length; i++) {
      if (!active[i]) continue;
      const entityX = x[i];
      const entityY = y[i];
      const onScreen = isOnScreen[i] || (entityX >= viewLeft && entityX <= viewRight && entityY >= viewTop && entityY <= viewBottom);
      if (!onScreen) continue;

      const posX = entityX + (offsetX?.[i] || 0);
      const posY = entityY + (offsetY?.[i] || 0);
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      ctx.strokeStyle = isTrigger[i] ? 'rgba(255, 255, 0, 0.8)' : 'rgba(0, 255, 0, 0.8)';

      if (shapeType[i] === 0) {
        const r = radius[i];
        if (r === 0) continue;
        ctx.beginPath();
        ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shapeType[i] === 1) {
        const w = width[i];
        const h = height[i];
        if (w === 0 || h === 0) continue;
        ctx.strokeRect(sx - (w / 2) * zoom, sy - (h / 2) * zoom, w * zoom, h * zoom);
      }
    }
  }

  // ------- entity origins -------

  drawEntityOrigins(ctx, canvas, camera, zoom, flags) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const selectedIdx = flags?.getSelectedEntity?.() ?? -1;

    const crossSize = 4;
    const selectedCrossSize = 8;

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      const sx = (x[i] - camera.x) * zoom;
      const sy = (y[i] - camera.y) * zoom;
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

  drawVelocityVectors(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;

    ctx.strokeStyle = 'rgba(0, 136, 255, 0.9)';
    ctx.lineWidth = 2 / zoom;
    const scale = 10;

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      const velX = vx[i];
      const velY = vy[i];
      if (Math.abs(velX) < 0.01 && Math.abs(velY) < 0.01) continue;

      const sx = (x[i] - camera.x) * zoom;
      const sy = (y[i] - camera.y) * zoom;
      const endX = sx + velX * scale * zoom;
      const endY = sy + velY * scale * zoom;

      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(endX, endY); ctx.stroke();
      this._drawArrowHead(ctx, endX, endY, velX, velY, 5 * zoom);
    }
  }

  // ------- acceleration -------

  drawAccelerationVectors(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;

    ctx.strokeStyle = 'rgba(255, 0, 68, 0.9)';
    ctx.lineWidth = 2 / zoom;
    const scale = 50;

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      const accX = ax[i];
      const accY = ay[i];
      if (Math.abs(accX) < 0.01 && Math.abs(accY) < 0.01) continue;

      const sx = (x[i] - camera.x) * zoom;
      const sy = (y[i] - camera.y) * zoom;
      const endX = sx + accX * scale * zoom;
      const endY = sy + accY * scale * zoom;

      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(endX, endY); ctx.stroke();
      this._drawArrowHead(ctx, endX, endY, accX, accY, 5 * zoom);
    }
  }

  // ------- sleeping entities -------

  drawSleepingEntities(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const rigidBodyActive = RigidBody.active;
    const sleeping = RigidBody.sleeping;
    if (!sleeping) return;

    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    ctx.strokeStyle = 'rgba(255, 0, 255, 0.8)';
    ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
    ctx.lineWidth = 3 / zoom;

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (!rigidBodyActive[i] || !sleeping[i]) continue;

      const posX = x[i] + (offsetX?.[i] || 0);
      const posY = y[i] + (offsetY?.[i] || 0);
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      if (shapeType && shapeType[i] === 0) {
        const r = radius?.[i] || 10;
        if (r === 0) continue;
        ctx.beginPath(); ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else if (shapeType && shapeType[i] === 1) {
        const w = width?.[i] || 20;
        const h = height?.[i] || 20;
        if (w === 0 || h === 0) continue;
        const halfW = (w / 2) * zoom;
        const halfH = (h / 2) * zoom;
        ctx.fillRect(sx - halfW, sy - halfH, w * zoom, h * zoom);
        ctx.strokeRect(sx - halfW, sy - halfH, w * zoom, h * zoom);
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

    const highlightRadius = (Collider.radius[closest] * 1.5 || 10) * zoom;
    ctx.strokeStyle = 'rgba(255, 255, 0, 1.0)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mySx, mySy, highlightRadius, 0, Math.PI * 2); ctx.stroke();

    const offset = closest * Grid._stride;
    const neighborCount = Grid.neighborData[offset];

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.7)';
    ctx.lineWidth = 2;

    for (let n = 0; n < neighborCount; n++) {
      const nIdx = Grid.neighborData[offset + 2 + n];
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

  // ------- collision candidates -------

  drawCollisionCandidateConnections(ctx, canvas, camera, zoom) {
    if (!Grid.neighborData || !Mouse.isPresent) return;

    const closest = this._findClosestEntity(Mouse.x, Mouse.y, 150);
    if (closest === -1) return;

    const myX = Transform.x[closest];
    const myY = Transform.y[closest];
    const mySx = (myX - camera.x) * zoom;
    const mySy = (myY - camera.y) * zoom;

    const highlightRadius = (Collider.radius[closest] * 1.5 || 10) * zoom;
    ctx.strokeStyle = 'rgba(255, 140, 0, 1.0)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mySx, mySy, highlightRadius, 0, Math.PI * 2); ctx.stroke();

    const offset = closest * Grid._stride;
    const candidateCount = Grid.neighborData[offset + 1];

    ctx.strokeStyle = 'rgba(255, 100, 0, 0.8)';
    ctx.lineWidth = 2;

    for (let n = 0; n < candidateCount; n++) {
      const cIdx = Grid.neighborData[offset + 2 + n];
      if (!Transform.active[cIdx]) continue;
      const cSx = (Transform.x[cIdx] - camera.x) * zoom;
      const cSy = (Transform.y[cIdx] - camera.y) * zoom;
      ctx.beginPath(); ctx.moveTo(mySx, mySy); ctx.lineTo(cSx, cSy); ctx.stroke();
      ctx.fillStyle = 'rgba(255, 100, 0, 0.6)';
      ctx.beginPath(); ctx.arc(cSx, cSy, 4 * zoom, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = `${12 * zoom}px monospace`;
    ctx.fillText(`${candidateCount} candidates`, mySx + 10, mySy - 10);
  }

  // ------- raycasts -------

  drawRaycasts(ctx, canvas, camera, zoom, scene) {
    const raycastBuffer = scene?.buffers?.raycastDebugData;
    if (!raycastBuffer) return;

    const raycastView = new Float32Array(raycastBuffer);
    const count = Math.min(raycastView[0], scene?.maxDebugRaycasts || 100);
    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const o = 1 + i * 7;
      const startX = raycastView[o];
      const startY = raycastView[o + 1];
      const endX = raycastView[o + 2];
      const endY = raycastView[o + 3];
      const hitX = raycastView[o + 4];
      const hitY = raycastView[o + 5];
      const didHit = raycastView[o + 6] === 1;

      const sStartX = (startX - camera.x) * zoom;
      const sStartY = (startY - camera.y) * zoom;
      const sEndX = (endX - camera.x) * zoom;
      const sEndY = (endY - camera.y) * zoom;
      const sHitX = (hitX - camera.x) * zoom;
      const sHitY = (hitY - camera.y) * zoom;

      if (didHit) {
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sStartX, sStartY); ctx.lineTo(sHitX, sHitY); ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)'; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(sHitX, sHitY); ctx.lineTo(sEndX, sEndY); ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(255, 0, 0, 1.0)';
        ctx.beginPath(); ctx.arc(sHitX, sHitY, 4, 0, Math.PI * 2); ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)'; ctx.lineWidth = 2;
        const cs = 8;
        ctx.beginPath();
        ctx.moveTo(sHitX - cs, sHitY); ctx.lineTo(sHitX + cs, sHitY);
        ctx.moveTo(sHitX, sHitY - cs); ctx.lineTo(sHitX, sHitY + cs);
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sStartX, sStartY); ctx.lineTo(sEndX, sEndY); ctx.stroke();
      }

      ctx.fillStyle = 'rgba(0, 255, 255, 0.8)';
      ctx.beginPath(); ctx.arc(sStartX, sStartY, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ------- entity indices -------

  drawEntityIndices(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    ctx.font = `${Math.max(10, 12 / zoom)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (let i = 0; i < active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      const sx = (x[i] - camera.x) * zoom;
      const sy = (y[i] - camera.y) * zoom - 15;
      const text = String(i);
      const metrics = ctx.measureText(text);
      const pad = 2;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(sx - metrics.width / 2 - pad, sy - 12, metrics.width + pad * 2, 14);
      ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.fillText(text, sx, sy);
    }
  }

  // ------- constraints -------

  drawConstraints(ctx, canvas, camera, zoom) {
    if (!Constraint.initialized || !Constraint.pairs || !Constraint.active) return;

    const pairs = Constraint.pairs;
    const restLength = Constraint.restLength;
    const stiffness = Constraint.stiffness;
    const constraintActive = Constraint.active;
    const maxConstraints = Constraint.maxCount;
    const x = Transform.x;
    const y = Transform.y;
    const entityActive = Transform.active;

    ctx.lineWidth = 2;

    for (let i = 0; i < maxConstraints; i++) {
      if (!constraintActive[i]) continue;
      const packed = pairs[i];
      const entityA = packed >>> 16;
      const entityB = packed & 0xFFFF;
      if (!entityActive[entityA] || !entityActive[entityB]) continue;

      const sax = (x[entityA] - camera.x) * zoom;
      const say = (y[entityA] - camera.y) * zoom;
      const sbx = (x[entityB] - camera.x) * zoom;
      const sby = (y[entityB] - camera.y) * zoom;

      if ((sax < -50 && sbx < -50) || (sax > canvas.width + 50 && sbx > canvas.width + 50) ||
          (say < -50 && sby < -50) || (say > canvas.height + 50 && sby > canvas.height + 50)) continue;

      const dx = x[entityB] - x[entityA];
      const dy = y[entityB] - y[entityA];
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      const targetDist = restLength[i];
      const stretchRatio = currentDist / targetDist;

      let r, g, b;
      if (stretchRatio < 0.9) { r = 0; g = 200; b = 255; }
      else if (stretchRatio < 1.1) { r = 50; g = 255; b = 50; }
      else if (stretchRatio < 1.3) {
        const t = (stretchRatio - 1.1) / 0.2;
        r = Math.floor(50 + 205 * t); g = 255; b = Math.floor(50 * (1 - t));
      } else {
        r = 255; g = Math.max(0, Math.floor(255 * (2 - stretchRatio))); b = 0;
      }

      const alpha = 0.4 + stiffness[i] * 0.5;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.beginPath(); ctx.moveTo(sax, say); ctx.lineTo(sbx, sby); ctx.stroke();

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha + 0.2})`;
      ctx.beginPath(); ctx.arc(sax, say, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sbx, sby, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ------- selected entity -------

  drawSelectedEntity(ctx, canvas, camera, zoom, flags) {
    const selectedIdx = flags?.getSelectedEntity?.() ?? -1;
    if (selectedIdx < 0 || !Transform.active[selectedIdx]) return;

    const posX = Transform.x[selectedIdx];
    const posY = Transform.y[selectedIdx];

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
    for (const [cx, cy] of [[sLeft, sTop], [sLeft + sWidth, sTop], [sLeft, sTop + sHeight], [sLeft + sWidth, sTop + sHeight]]) {
      ctx.beginPath(); ctx.arc(cx, cy, cornerSize, 0, Math.PI * 2); ctx.fill();
    }

    const sx = (posX - camera.x) * zoom;
    const labelY = sTop - 15;
    const text = String(selectedIdx);
    ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const metrics = ctx.measureText(text);
    ctx.fillStyle = 'rgba(255, 200, 100, 0.9)';
    ctx.fillRect(sx - metrics.width / 2 - 4, labelY - 12, metrics.width + 8, 16);
    ctx.fillStyle = 'rgba(0, 0, 0, 1.0)';
    ctx.fillText(text, sx, labelY);
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

  _drawArrowHead(ctx, endX, endY, dirX, dirY, arrowSize) {
    const angle = Math.atan2(dirY, dirX);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
}
