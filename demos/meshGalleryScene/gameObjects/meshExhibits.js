// MeshPicture and MeshBody are the two entity types in Mesh Gallery.
//
// Both carry MeshRenderer and call setLayer('gallery'). That bit is what the
// MESH packer reads. A collider, if any, is only physics: the packer draws an
// explicit mesh when one is stored, and otherwise fans the collider.
//
// MeshPicture is Transform + MeshRenderer. No body is created, so these pieces
// stay where they are spawned. Plane and rope rewrite geometry every tick.
// setVertices keeps the plane's span (same vertex count). setRope keeps the
// rope's span because the control-point count does not change.
//
// MeshBody is Transform + RigidBody + Collider + MeshRenderer. The floor and
// the crate never call setMesh, so the orange debug wire and the picture are
// the collider itself (the crate inflated by visualOutset). The gem's diamond
// replaces that fill. The toggle starts as a star and clearMesh() hands the
// draw back to the box. visualOutset is ignored while the star is the draw.

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, MeshRenderer, enums } = WEED;
const { ShapeType } = enums;

const STAR = starPoints(52, 22, 5);

function starPoints(outer, inner, points) {
  const xy = new Float32Array(points * 4);
  let o = 0;
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = (i & 1) === 0 ? outer : inner;
    xy[o++] = Math.cos(a) * r;
    xy[o++] = Math.sin(a) * r;
  }
  return xy;
}

export class MeshPicture extends GameObject {
  static components = [MeshRenderer];

  onSpawned(spawnConfig = {}) {
    this._kind = spawnConfig.kind;
    this.setLayer('gallery');
    if (spawnConfig.kind === 'fan') this._fan();
    else if (spawnConfig.kind === 'quad') this._quad();
    else if (spawnConfig.kind === 'polygon') this._polygon();
    else if (spawnConfig.kind === 'plane') this._plane();
    else if (spawnConfig.kind === 'rope') this._rope();
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    const t = (accumulatedTime || 0) * 0.001;
    if (this._kind === 'plane') this._wavePlane(t);
    else if (this._kind === 'rope') this._waveRope(t);
  }

  // Convex triangle. Omitting indices fans from vertex 0. Omitting uvs keeps a solid tint.
  _fan() {
    this.meshRenderer.tint = 0xf0c14a;
    this.meshRenderer.setMesh(new Float32Array([0, -70, 80, 60, -80, 60]));
  }

  // Four corners, two triangles, UVs 0..1 over the rocky frame. Not a sprite quad.
  _quad() {
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setTexture('rocky');
    this.meshRenderer.setMesh(
      new Float32Array([-90, -50, 100, -30, 70, 60, -80, 45]),
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    );
  }

  // Concave arrow. setPolygon ear-clips once. setTileLocal repeats rocky in mesh space.
  _polygon() {
    this.meshRenderer.tint = 0xb7e0c8;
    this.meshRenderer.setTexture('rocky');
    this.setTileLocal(56);
    this.meshRenderer.setPolygon([
      0, -80,
      70, -20,
      28, -20,
      28, 70,
      -28, 70,
      -28, -20,
      -70, -20,
    ]);
  }

  // segX / segY are cell counts. The grid is centered on the entity. UVs come from setPlane.
  _plane() {
    this._sx = 10;
    this._sy = 4;
    this._w = 280;
    this._h = 110;
    const n = (this._sx + 1) * (this._sy + 1);
    this._planeXY = new Float32Array(n * 2);
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setTexture('rocky');
    this.meshRenderer.setPlane(this._w, this._h, this._sx, this._sy);
    this._wavePlane(0);
  }

  // Same vertex count as setPlane, so setVertices rewrites the span and does not allocate one.
  _wavePlane(time) {
    const sx = this._sx;
    const sy = this._sy;
    const vx = sx + 1;
    const vy = sy + 1;
    const w = this._w;
    const h = this._h;
    const x0 = -w * 0.5;
    const y0 = -h * 0.5;
    const xy = this._planeXY;
    let p = 0;
    for (let j = 0; j < vy; j++) {
      const v = j / sy;
      const y = y0 + h * v;
      for (let i = 0; i < vx; i++) {
        const u = i / sx;
        const x = x0 + w * u;
        xy[p++] = x;
        xy[p++] = y + Math.sin(u * Math.PI * 2 + time * 2.2) * Math.sin(v * Math.PI) * 16;
      }
    }
    this.meshRenderer.setVertices(xy);
  }

  // The {x,y} list is allocated once. Each tick only writes x and y, then setRope.
  _rope() {
    this._ropeN = 18;
    this._ropePts = [];
    for (let i = 0; i < this._ropeN; i++) this._ropePts.push({ x: 0, y: 0 });
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setTexture('rocky');
    this._waveRope(0);
  }

  _waveRope(time) {
    const n = this._ropeN;
    const pts = this._ropePts;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      pts[i].x = -300 + u * 600;
      pts[i].y = Math.sin(u * Math.PI * 3 + time * 2.4) * 34;
    }
    this.meshRenderer.setRope(pts, 12);
  }
}

export class MeshBody extends GameObject {
  static components = [RigidBody, Collider, MeshRenderer];

  onSpawned(spawnConfig = {}) {
    this._kind = spawnConfig.kind;
    this._cleared = false;
    this.setLayer('gallery');
    this.collider.shapeType = ShapeType.Box;
    this.collider.isTrigger = 0;
    this.collider.friction = spawnConfig.friction ?? 0.6;
    this.collider.restitution = spawnConfig.restitution ?? 0.05;
    this.rigidBody.static = spawnConfig.static ? 1 : 0;
    this.rigidBody.linearDamping = 0.08;
    this.rigidBody.angularDamping = 0.05;
    this.rigidBody.sleeping = 0;

    if (spawnConfig.kind === 'floor') this._floor();
    else if (spawnConfig.kind === 'crate') this._crate();
    else if (spawnConfig.kind === 'gem') this._gem();
    else if (spawnConfig.kind === 'toggle') this._toggle();
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    if (this._kind !== 'toggle' || this._cleared) return;
    if ((accumulatedTime || 0) < 2800) return;
    this.meshRenderer.clearMesh();
    this.meshRenderer.setTexture('rocky');
    this.setTileWorld(48);
    this._cleared = true;
  }

  // Static box. No setMesh, so the fill is the collider.
  _floor() {
    this.collider.width = 1400;
    this.collider.height = 56;
    this.meshRenderer.tint = 0x3a4150;
  }

  // Dynamic box. visualOutset grows the draw only. World tiling follows the body.
  _crate() {
    this.collider.width = 72;
    this.collider.height = 56;
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setTexture('rocky');
    this.meshRenderer.visualOutset = 4;
    this.setTileWorld(40);
    this.rigidBody.angularVelocity = 0.4;
  }

  // The physics box is 36×36. The diamond is a 4-vert fan and is what you see.
  _gem() {
    this.collider.width = 36;
    this.collider.height = 36;
    this.collider.friction = 0.35;
    this.collider.restitution = 0.15;
    this.meshRenderer.tint = 0x5ce1ff;
    this.meshRenderer.setMesh(new Float32Array([-46, 0, 0, -64, 46, 0, 0, 64]));
    this.rigidBody.angularVelocity = 1.6;
  }

  // Star now. After tick() calls clearMesh, this same body draws the box instead.
  _toggle() {
    this.collider.width = 88;
    this.collider.height = 64;
    this.meshRenderer.tint = 0xff6b4a;
    this.meshRenderer.visualOutset = 8;
    this.meshRenderer.setPolygon(STAR);
  }
}
