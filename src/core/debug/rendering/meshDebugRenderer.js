// Mesh wire on the debug canvas. Not a second Pixi mesh.
// Magenta: authored mesh (tile or solid). Cyan: per-vertex UVs. Orange: collider-fill fallback.
// Screen verts live in _sx/_sy, grown only when a mesh is larger than any seen so far.
// Pose matches the MESH packer: static bodies and an unpublished or stale pose use live Transform.

import { Transform } from '../../../components/transform.js';
import { RigidBody } from '../../../components/rigidBody.js';
import { Collider } from '../../../components/collider.js';
import { MeshRenderer } from '../../../components/meshRenderer.js';
import { MeshGeometry } from '../../meshGeometry.js';
import { ColliderFixture } from '../../colliderFixture.js';
import { DEBUG_FLAGS } from '../debugFlags.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../../../util/configDefaults.js';

const INV = 0xffff;
const LIVE_SLACK_SQ = 48 * 48;
const CIRCLE_N = MAX_POLYGON_VERTICES;

export class MeshDebugRenderer {
  constructor() {
    this._sx = new Float32Array(64);
    this._sy = new Float32Array(64);
    this._boxX = new Float32Array(4);
    this._boxY = new Float32Array(4);
    this._pose4 = new Float32Array(4);
    this._styleMesh = 'rgba(255, 70, 210, 0.95)';
    this._styleUv = 'rgba(80, 220, 255, 0.95)';
    this._styleFill = 'rgba(255, 170, 40, 0.9)';
    this._circC = new Float32Array(CIRCLE_N);
    this._circS = new Float32Array(CIRCLE_N);
    const step = (Math.PI * 2) / CIRCLE_N;
    for (let i = 0; i < CIRCLE_N; i++) {
      const a = i * step;
      this._circC[i] = Math.cos(a);
      this._circS[i] = Math.sin(a);
    }
  }

  draw(ctx, canvas, camera, zoom, pose, flags) {
    const meshActive = MeshRenderer.active;
    const xformActive = Transform.active;
    if (!meshActive || !xformActive) return;

    const visible = MeshRenderer.renderVisible;
    const selectedOnly = !!(flags && flags.isEnabled(DEBUG_FLAGS.SHOW_ACTIVE_ONLY));
    const selectedIdx = flags ? flags.getSelectedEntity() : -1;
    const camX = camera.x;
    const camY = camera.y;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const n = meshActive.length < xformActive.length ? meshActive.length : xformActive.length;
    const vertOff = MeshGeometry.vertOffset;

    ctx.lineWidth = 1;

    for (let i = 0; i < n; i++) {
      if (!xformActive[i] || !meshActive[i]) continue;
      if (visible && !visible[i]) continue;
      if (selectedOnly && selectedIdx >= 0 && i !== selectedIdx) continue;

      this._poseInto(i, pose);
      const pose4 = this._pose4;
      const explicit = vertOff && (vertOff[i] | 0) >= 0;
      if (explicit) {
        ctx.strokeStyle = MeshGeometry.hasUv && MeshGeometry.hasUv[i]
          ? this._styleUv
          : this._styleMesh;
        this._strokeExplicit(ctx, i, pose4[0], pose4[1], pose4[2], pose4[3], camX, camY, zoom, canvasW, canvasH);
      } else {
        ctx.strokeStyle = this._styleFill;
        this._strokeColliderFill(ctx, i, pose4, camX, camY, zoom, canvasW, canvasH);
      }
    }
  }

  _poseInto(i, pose) {
    const out = this._pose4;
    const liveX = Transform.x[i];
    const liveY = Transform.y[i];
    const liveC = Transform.rotC ? Transform.rotC[i] : 1;
    const liveS = Transform.rotS ? Transform.rotS[i] : 0;
    const rb = RigidBody.active;
    if (pose && pose.x && rb && rb[i]) {
      const pc = pose.rotC ? pose.rotC[i] : 0;
      const ps = pose.rotS ? pose.rotS[i] : 0;
      const published = pc * pc + ps * ps > 0.25;
      const dx = liveX - pose.x[i];
      const dy = liveY - (pose.y ? pose.y[i] : liveY);
      const stale = dx * dx + dy * dy > LIVE_SLACK_SQ;
      const isStatic = RigidBody.static && RigidBody.static[i];
      if (published && !isStatic && !stale) {
        out[0] = pose.x[i];
        out[1] = pose.y ? pose.y[i] : liveY;
        out[2] = pc;
        out[3] = ps;
        return;
      }
    }
    out[0] = liveX;
    out[1] = liveY;
    out[2] = liveC;
    out[3] = liveS;
  }

  _grow(count) {
    if (this._sx.length >= count) return;
    let cap = this._sx.length;
    while (cap < count) cap <<= 1;
    this._sx = new Float32Array(cap);
    this._sy = new Float32Array(cap);
  }

  _project(count, srcX, srcY, base, px, py, c, s, camX, camY, zoom, canvasW, canvasH, outset) {
    this._grow(count);
    const sx = this._sx;
    const sy = this._sy;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = 0; v < count; v++) {
      let lx = srcX[base + v];
      let ly = srcY[base + v];
      if (outset > 0) {
        const len = Math.hypot(lx, ly);
        if (len > 1e-6) {
          const k = 1 + outset / len;
          lx *= k;
          ly *= k;
        }
      }
      const x = (px + c * lx - s * ly - camX) * zoom;
      const y = (py + s * lx + c * ly - camY) * zoom;
      sx[v] = x;
      sy[v] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return maxX >= 0 && minX <= canvasW && maxY >= 0 && minY <= canvasH;
  }

  _strokeFan(ctx, count) {
    const sx = this._sx;
    const sy = this._sy;
    const x0 = sx[0];
    const y0 = sy[0];
    ctx.beginPath();
    for (let t = 0; t < count - 2; t++) {
      ctx.moveTo(x0, y0);
      ctx.lineTo(sx[t + 1], sy[t + 1]);
      ctx.lineTo(sx[t + 2], sy[t + 2]);
      ctx.closePath();
    }
    ctx.stroke();
  }

  _strokeIndexed(ctx, vertN, indices, iAt, indexN) {
    const sx = this._sx;
    const sy = this._sy;
    const triN = (indexN / 3) | 0;
    ctx.beginPath();
    for (let t = 0; t < triN; t++) {
      const o = iAt + t * 3;
      const a = indices[o] | 0;
      const b = indices[o + 1] | 0;
      const c = indices[o + 2] | 0;
      if (a < 0 || b < 0 || c < 0 || a >= vertN || b >= vertN || c >= vertN) continue;
      ctx.moveTo(sx[a], sy[a]);
      ctx.lineTo(sx[b], sy[b]);
      ctx.lineTo(sx[c], sy[c]);
      ctx.closePath();
    }
    ctx.stroke();
  }

  _strokeExplicit(ctx, i, px, py, c, s, camX, camY, zoom, canvasW, canvasH) {
    const vertN = MeshGeometry.vertCount[i] | 0;
    const vx = MeshGeometry.vertexX;
    const vy = MeshGeometry.vertexY;
    if (vertN < 3 || !vx || !vy) return;
    const base = MeshGeometry.vertOffset[i] | 0;
    if (!this._project(vertN, vx, vy, base, px, py, c, s, camX, camY, zoom, canvasW, canvasH, 0)) return;
    const iAt = MeshGeometry.indexOffset[i] | 0;
    if (iAt >= 0 && MeshGeometry.indices && MeshGeometry.indexCount) {
      this._strokeIndexed(ctx, vertN, MeshGeometry.indices, iAt, MeshGeometry.indexCount[i] >>> 0);
    } else {
      this._strokeFan(ctx, vertN);
    }
  }

  _strokeColliderFill(ctx, i, pose4, camX, camY, zoom, canvasW, canvasH) {
    if (!Collider.shapeType) return;
    const c = pose4[2];
    const s = pose4[3];
    const ox = Collider.offsetX ? Collider.offsetX[i] : 0;
    const oy = Collider.offsetY ? Collider.offsetY[i] : 0;
    const px = pose4[0] + c * ox - s * oy;
    const py = pose4[1] + s * ox + c * oy;
    const outset = MeshRenderer.visualOutset ? MeshRenderer.visualOutset[i] : 0;
    const extras = Collider.fixtureCount ? (Collider.fixtureCount[i] | 0) : 0;

    if (extras > 0 && ColliderFixture.head && ColliderFixture.vertexX) {
      const head = ColliderFixture.head;
      const next = ColliderFixture.next;
      const fxActive = ColliderFixture.active;
      const vertCount = ColliderFixture.vertCount;
      const vx = ColliderFixture.vertexX;
      const vy = ColliderFixture.vertexY;
      const maxFx = ColliderFixture.maxCount | 0;
      let cur = head[i];
      let guard = 0;
      while (cur !== INV && guard++ < maxFx) {
        if (fxActive[cur]) {
          const count = vertCount[cur] | 0;
          if (count >= 3 && count <= MAX_POLYGON_VERTICES) {
            const base = ColliderFixture.vertBase(cur);
            if (this._project(count, vx, vy, base, px, py, c, s, camX, camY, zoom, canvasW, canvasH, outset)) {
              this._strokeFan(ctx, count);
            }
          }
        }
        cur = next[cur];
      }
      return;
    }

    const shape = Collider.shapeType[i] | 0;
    if (shape === ShapeType.Polygon && Collider.polyCount && (Collider.polyCount[i] | 0) >= 3) {
      const count = Collider.polyCount[i] | 0;
      const base = i * MAX_POLYGON_VERTICES;
      if (this._project(count, Collider.polyVertexX, Collider.polyVertexY, base, px, py, c, s, camX, camY, zoom, canvasW, canvasH, outset)) {
        this._strokeFan(ctx, count);
      }
      return;
    }

    if (shape === ShapeType.Box && Collider.width && Collider.height) {
      const hw = Collider.width[i] * 0.5;
      const hh = Collider.height[i] * 0.5;
      if (!(hw > 0) || !(hh > 0)) return;
      const boxX = this._boxX;
      const boxY = this._boxY;
      boxX[0] = -hw;
      boxY[0] = -hh;
      boxX[1] = hw;
      boxY[1] = -hh;
      boxX[2] = hw;
      boxY[2] = hh;
      boxX[3] = -hw;
      boxY[3] = hh;
      if (this._project(4, boxX, boxY, 0, px, py, c, s, camX, camY, zoom, canvasW, canvasH, outset)) {
        this._strokeFan(ctx, 4);
      }
      return;
    }

    if (shape === ShapeType.Circle && Collider.radius) {
      const r = Collider.radius[i] + (outset > 0 ? outset : 0);
      if (!(r > 0)) return;
      this._grow(CIRCLE_N);
      const sx = this._sx;
      const sy = this._sy;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let v = 0; v < CIRCLE_N; v++) {
        const lx = this._circC[v] * r;
        const ly = this._circS[v] * r;
        const x = (px + c * lx - s * ly - camX) * zoom;
        const y = (py + s * lx + c * ly - camY) * zoom;
        sx[v] = x;
        sy[v] = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (maxX >= 0 && minX <= canvasW && maxY >= 0 && minY <= canvasH) this._strokeFan(ctx, CIRCLE_N);
    }
  }
}
