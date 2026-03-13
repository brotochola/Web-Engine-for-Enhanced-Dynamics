// NavDebugRenderer.js — Draws navigation debug overlays (walkability grid, flowfields, paths)

import { NavGrid } from '../../NavGrid.js';

export class NavDebugRenderer {
  constructor() {
    this.selectedFlowfieldSlot = -1;
    this.selectedPathSlot = -1;
    this.selectedStaticFlowfield = null;
    this.showWalkabilityGrid = false;
  }

  attach(_scene) { /* no-op for now */ }

  hasActiveVisualization() {
    return (
      this.showWalkabilityGrid ||
      this.selectedFlowfieldSlot >= 0 ||
      this.selectedPathSlot >= 0 ||
      this.selectedStaticFlowfield !== null
    );
  }

  clearSelection() {
    this.selectedFlowfieldSlot = -1;
    this.selectedPathSlot = -1;
    this.selectedStaticFlowfield = null;
    this.showWalkabilityGrid = false;
  }

  // ------- drawing methods -------

  drawWalkabilityGrid(ctx, canvas, camera, zoom) {
    if (!NavGrid._initialized) return;

    const gridWidth = NavGrid._gridWidth;
    const gridHeight = NavGrid._gridHeight;
    const cellSize = NavGrid._cellSize;
    const walkability = NavGrid._walkability;
    if (!walkability) return;

    const cellSizeScreen = cellSize * zoom;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(gridWidth, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(gridHeight, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);

    const worldStartX = startCellX * cellSize;
    const worldStartY = startCellY * cellSize;
    const worldEndX = endCellX * cellSize;
    const worldEndY = endCellY * cellSize;

    // Blocked cells
    ctx.fillStyle = 'rgba(255, 50, 50, 0.5)';
    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        if (walkability[y * gridWidth + x] === 0) {
          ctx.fillRect((x * cellSize - camera.x) * zoom, (y * cellSize - camera.y) * zoom, cellSizeScreen, cellSizeScreen);
        }
      }
    }

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
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

  drawFlowfield(ctx, canvas, camera, zoom, slotIndex) {
    const ffData = NavGrid.getFlowfieldForVisualization(slotIndex);
    if (!ffData) return;

    const { vectors, gridWidth, gridHeight, cellSize, targetCell } = ffData;
    const targetX = (targetCell % gridWidth) * cellSize + cellSize / 2;
    const targetY = Math.floor(targetCell / gridWidth) * cellSize + cellSize / 2;

    ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
    ctx.lineWidth = 1.5;
    const arrowLen = cellSize * 0.35 * zoom;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize) - 1);
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize) - 1);
    const endCellX = Math.min(gridWidth, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(gridHeight, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);

    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        const vecIdx = (y * gridWidth + x) * 2;
        const vx = vectors[vecIdx];
        const vy = vectors[vecIdx + 1];
        if (vx === 0 && vy === 0) continue;

        const dx = vx / 127;
        const dy = vy / 127;
        const sx = (x * cellSize + cellSize / 2 - camera.x) * zoom;
        const sy = (y * cellSize + cellSize / 2 - camera.y) * zoom;

        this._drawArrow(ctx, sx, sy, dx, dy, arrowLen);
      }
    }

    // Target marker
    const tSx = (targetX - camera.x) * zoom;
    const tSy = (targetY - camera.y) * zoom;
    ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
    ctx.beginPath();
    ctx.arc(tSx, tSy, 8 * zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawStaticFlowfield(ctx, canvas, camera, zoom, name) {
    const ff = NavGrid._staticFlowfields.get(name);
    if (!ff) return;

    const { vectors, gridWidth, gridHeight, cellSize } = ff;
    ctx.strokeStyle = 'rgba(100, 255, 100, 0.7)';
    ctx.lineWidth = 1.5;
    const arrowLen = cellSize * 0.35 * zoom;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize) - 1);
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize) - 1);
    const endCellX = Math.min(gridWidth, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(gridHeight, Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1);

    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        const vecIdx = (y * gridWidth + x) * 2;
        const vx = vectors[vecIdx];
        const vy = vectors[vecIdx + 1];
        if (vx === 0 && vy === 0) continue;

        const dx = vx / 127;
        const dy = vy / 127;
        const sx = (x * cellSize + cellSize / 2 - camera.x) * zoom;
        const sy = (y * cellSize + cellSize / 2 - camera.y) * zoom;

        this._drawArrow(ctx, sx, sy, dx, dy, arrowLen);
      }
    }
  }

  drawPath(ctx, canvas, camera, zoom, slotIndex) {
    const pathPoints = NavGrid.getPathForVisualization(slotIndex);
    if (!pathPoints || pathPoints.length === 0) return;

    ctx.strokeStyle = 'rgba(255, 200, 0, 0.9)';
    ctx.lineWidth = 3 * zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const sx = (p.x - camera.x) * zoom;
      const sy = (p.y - camera.y) * zoom;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const sx = (p.x - camera.x) * zoom;
      const sy = (p.y - camera.y) * zoom;

      if (i === 0) ctx.fillStyle = 'rgba(100, 255, 100, 0.9)';
      else if (i === pathPoints.length - 1) ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
      else ctx.fillStyle = 'rgba(255, 200, 0, 0.7)';

      const radius = (i === 0 || i === pathPoints.length - 1) ? 6 * zoom : 4 * zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ------- internal -------

  _drawArrow(ctx, sx, sy, dx, dy, arrowLen) {
    ctx.beginPath();
    ctx.moveTo(sx - dx * arrowLen * 0.5, sy - dy * arrowLen * 0.5);
    ctx.lineTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
    ctx.stroke();

    const headLen = arrowLen * 0.4;
    const angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
    ctx.lineTo(
      sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle - Math.PI / 6),
      sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
    ctx.lineTo(
      sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle + Math.PI / 6),
      sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
  }
}
