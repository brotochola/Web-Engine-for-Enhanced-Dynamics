// Collider.js - Collision shapes for Box2D sync + spatial/Ray queries
// Supports circles, oriented boxes, convex polygons (max 8 verts)
//
// CUSTOM SETTERS FOR MASS AUTO-COMPUTATION:
// radius / width / height setters recompute RigidBody.mass / invMass.
//
// Mass formulas:
// - Circle: mass = π * radius²  (area)
// - Box:    mass = width * height (area)
// - Polygon: mass = polygon area (shoelace)

import { Component } from '../core/component.js';
import { RigidBody } from './rigidBody.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty } from '../box2d/box2dBodySync.js';

class Collider extends Component {
  // Array schema - defines all collision properties
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active

    // Shape type
    shapeType: Uint8Array, // ShapeType: Box=0, Circle=1, Polygon=2 (WASM C)

    // Offset from entity position
    offsetX: Float32Array,
    offsetY: Float32Array,

    // Circle shape (also polygon skin radius; 0 = sharp)
    radius: Float32Array,

    // Box shape (local AABB extents; rotates with Transform unless fixedRotation)
    width: Float32Array,
    height: Float32Array,

    // Trigger mode
    isTrigger: Uint8Array, // trigger=only events, no physical response

    // Collision filtering (32 layers max; layer is index 0-31, mask is bitmask)
    // collisionGroupIndex: Box2D-style group (0 = ignore; same negative = never; same positive = always)
    collisionLayer: Uint8Array,
    collisionMask: Uint32Array,
    collisionGroupIndex: Int32Array,

    // Box2D fixture friction (μ). Pair μ = min(μi, μj); 0 = off
    friction: Float32Array,

    // Box2D restitution (bounce), typically 0..1
    restitution: Float32Array,

    // Opt-in contact hit events (impact above world hit threshold)
    enableHitEvents: Uint8Array,

    // Perception / neighbor radius (spatial queries). With LightEmitter: also point-shadow
    // caster search radius — spatial neighbors feed the shadow queue; soft alpha fades at this rim.
    visualRange: Float32Array,

    // Convex polygon (local space) — appended so Circle/AABB field offsets stay stable
    polyCount: Uint8Array, // 0 or 3..MAX_POLYGON_VERTICES
    polyCentroidX: Float32Array,
    polyCentroidY: Float32Array,
    // Strided: index = entity * MAX_POLYGON_VERTICES + vert
    polyVertexX: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyVertexY: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyNormalX: { type: Float32Array, length: MAX_POLYGON_VERTICES },
    polyNormalY: { type: Float32Array, length: MAX_POLYGON_VERTICES },

    // Compute-layer feed (append-only so prior field offsets stay stable)
    layerMask: Uint16Array, // bit i = Layer.id; compute pack uses matching bits
    feedBits: Uint8Array, // opaque shader flags; engine ORs COMPUTE_FLAG_STATIC at pack

    // Compound extras (ColliderFixture pool). 0 = single-shape path.
    fixtureCount: Uint16Array,
  };

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.layerMask) this.layerMask.fill(0);
    if (this.fixtureCount) this.fixtureCount.fill(0);
  }

  /** @type {number} */
  static MAX_POLYGON_VERTICES = MAX_POLYGON_VERTICES;

  /**
   * Stride base for polygon vert/normal arrays.
   * @param {number} index
   * @returns {number}
   */
  static polyBase(index) {
    return index * MAX_POLYGON_VERTICES;
  }

  /**
   * Convex polygon from local CCW points (3..MAX_POLYGON_VERTICES).
   * Computes outward normals + centroid. Rejects degenerate / wrong-count input.
   * @param {number} index
   * @param {ArrayLike<{x:number,y:number}|number>|number[]} points - [{x,y},...] or flat [x0,y0,...]
   * @returns {boolean}
   */
  static makePolygon(index, points) {
    const flat = [];
    if (points && typeof points[0] === 'number') {
      for (let i = 0; i + 1 < points.length; i += 2) {
        flat.push(points[i], points[i + 1]);
      }
    } else if (points && points.length) {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        flat.push(p.x, p.y);
      }
    }
    const count = (flat.length / 2) | 0;
    if (count < 3 || count > MAX_POLYGON_VERTICES) return false;

    // Signed area (shoelace); require positive CCW area
    let twiceArea = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      twiceArea += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
    }
    if (!(twiceArea > 1e-8)) return false;

    const base = Collider.polyBase(index);
    const vx = Collider.polyVertexX;
    const vy = Collider.polyVertexY;
    const nx = Collider.polyNormalX;
    const ny = Collider.polyNormalY;

    let cx = 0;
    let cy = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < count; i++) {
      const x = flat[i * 2];
      const y = flat[i * 2 + 1];
      vx[base + i] = x;
      vy[base + i] = y;
      const j = i + 1 < count ? i + 1 : 0;
      const w = x * flat[j * 2 + 1] - flat[j * 2] * y;
      cx += (x + flat[j * 2]) * w;
      cy += (y + flat[j * 2 + 1]) * w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const inv6A = 1 / (3 * twiceArea);
    cx *= inv6A;
    cy *= inv6A;

    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      const ex = vx[base + j] - vx[base + i];
      const ey = vy[base + j] - vy[base + i];
      // Outward normal (right of edge for CCW winding)
      let nnx = ey;
      let nny = -ex;
      const len = Math.sqrt(nnx * nnx + nny * nny);
      if (!(len > 1e-12)) return false;
      const inv = 1 / len;
      nx[base + i] = nnx * inv;
      ny[base + i] = nny * inv;
    }

    ColliderFixture.removeAllForEntity(index);
    Collider.polyCount[index] = count;
    Collider.polyCentroidX[index] = cx;
    Collider.polyCentroidY[index] = cy;
    Collider.width[index] = maxX - minX;
    Collider.height[index] = maxY - minY;
    Collider.shapeType[index] = ShapeType.Polygon;

    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
    return true;
  }

  /**
   * Replace every extra convex piece on this body (3..8 CCW verts each).
   * Zeros the primary polyCount. Requires physics.maxFixturePoolSize > 0.
   * Prefer replacePolygonsFlat when the caller already has SoA data.
   * @param {number} index
   * @param {Array<ArrayLike<{x:number,y:number}|number>>} polys
   * @returns {boolean}
   */
  static replacePolygons(index, polys) {
    return ColliderFixture.replaceForEntity(index, polys);
  }

  /**
   * Same contract as replacePolygons, from packed x,y + per-poly counts.
   * vertexXY is caller-owned (no slice). Prefer this when the caller already has SoA.
   * @param {number} index
   * @param {Float32Array|ArrayLike<number>} vertexXY
   * @param {Uint8Array|ArrayLike<number>} vertexCounts
   * @param {number} polygonCount
   * @returns {boolean}
   */
  static replacePolygonsFlat(index, vertexXY, vertexCounts, polygonCount) {
    return ColliderFixture.replaceForEntityFlat(index, vertexXY, vertexCounts, polygonCount);
  }

  /**
   * Drop extra fixtures. If polyCount is 0 the body is shapeless until
   * makePolygon / box / circle setters restore a primary shape. Leftover
   * width/height from the compound AABB are not a box.
   * @param {number} index
   */
  static clearFixtures(index) {
    ColliderFixture.removeAllForEntity(index);
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
  }

  /**
   * Polygon area via shoelace (local verts). 0 if count < 3.
   * @param {number} index
   * @returns {number}
   */
  static polygonArea(index) {
    const count = Collider.polyCount[index];
    if (count < 3) return 0;
    const base = Collider.polyBase(index);
    const vx = Collider.polyVertexX;
    const vy = Collider.polyVertexY;
    let twice = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      twice += vx[base + i] * vy[base + j] - vx[base + j] * vy[base + i];
    }
    return twice * 0.5;
  }

  /**
   * Rotational inertia about centroid for unit density, then scaled by mass/area.
   * Matches Box2D b2ComputePolygonMass style (about centroid).
   * @param {number} index
   * @param {number} mass
   * @returns {number}
   */
  static polygonInertia(index, mass) {
    const count = Collider.polyCount[index];
    if (count < 3 || !(mass > 0)) return 0;
    const area = Collider.polygonArea(index);
    if (!(area > 1e-12)) return 0;

    const base = Collider.polyBase(index);
    const vx = Collider.polyVertexX;
    const vy = Collider.polyVertexY;
    const cx = Collider.polyCentroidX[index];
    const cy = Collider.polyCentroidY[index];

    let I = 0;
    for (let i = 0; i < count; i++) {
      const j = i + 1 < count ? i + 1 : 0;
      const ax = vx[base + i] - cx;
      const ay = vy[base + i] - cy;
      const bx = vx[base + j] - cx;
      const by = vy[base + j] - cy;
      const cross = ax * by - ay * bx;
      I += cross * (ax * ax + ay * ay + ax * bx + ay * by + bx * bx + by * by);
    }
    // Unit-density inertia about centroid; scale to actual mass
    const unitI = I / 12;
    return (mass / area) * unitI;
  }

  makePolygon(points) {
    return Collider.makePolygon(this.index, points);
  }

  replacePolygons(polys) {
    return Collider.replacePolygons(this.index, polys);
  }

  replacePolygonsFlat(vertexXY, vertexCounts, polygonCount) {
    return Collider.replacePolygonsFlat(this.index, vertexXY, vertexCounts, polygonCount);
  }

  clearFixtures() {
    Collider.clearFixtures(this.index);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOM GETTERS/SETTERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Toggle Collider participation. Off + RigidBody still on → shapeless body
   * (moves, no Box2D contacts). Host clears/adds shapes via GEOMETRY dirty.
   */
  get active() {
    return Collider.active[this.index];
  }
  set active(value) {
    const next = value ? 1 : 0;
    if (Collider.active[this.index] === next) return;
    if (!next) ColliderFixture.removeAllForEntity(this.index);
    Collider.active[this.index] = next;
    markBodyDirty(
      this.index,
      BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS,
    );
  }

  get shapeType() {
    return Collider.shapeType[this.index];
  }
  set shapeType(value) {
    Collider.shapeType[this.index] = value | 0;
    RigidBody.syncMassFromCollider(this.index);
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get offsetX() {
    return Collider.offsetX[this.index];
  }
  set offsetX(value) {
    Collider.offsetX[this.index] = Number(value) || 0;
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get offsetY() {
    return Collider.offsetY[this.index];
  }
  set offsetY(value) {
    Collider.offsetY[this.index] = Number(value) || 0;
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get radius() {
    return Collider.radius[this.index];
  }
  set radius(value) {
    Collider.radius[this.index] = value;
    // Authoring sugar: positive radius ⇒ circle (SAB default 0 is now Box in C numbering)
    if (value > 0) Collider.shapeType[this.index] = ShapeType.Circle;
    RigidBody.syncMassFromCollider(this.index);
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get width() {
    return Collider.width[this.index];
  }
  set width(value) {
    Collider.width[this.index] = value;
    if (value > 0 && Collider.shapeType[this.index] !== ShapeType.Polygon) {
      Collider.shapeType[this.index] = ShapeType.Box;
    }
    RigidBody.syncMassFromCollider(this.index);
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get height() {
    return Collider.height[this.index];
  }
  set height(value) {
    Collider.height[this.index] = value;
    if (value > 0 && Collider.shapeType[this.index] !== ShapeType.Polygon) {
      Collider.shapeType[this.index] = ShapeType.Box;
    }
    RigidBody.syncMassFromCollider(this.index);
    markBodyDirty(this.index, BODY_DIRTY.GEOMETRY);
  }

  get collisionLayer() {
    return Collider.collisionLayer[this.index];
  }
  set collisionLayer(value) {
    Collider.collisionLayer[this.index] = value & 31;
    markBodyDirty(this.index, BODY_DIRTY.FILTER);
  }

  get collisionMask() {
    return Collider.collisionMask[this.index];
  }
  set collisionMask(value) {
    Collider.collisionMask[this.index] = value;
    markBodyDirty(this.index, BODY_DIRTY.FILTER);
  }

  get collisionGroupIndex() {
    return Collider.collisionGroupIndex[this.index];
  }
  set collisionGroupIndex(value) {
    Collider.collisionGroupIndex[this.index] = value | 0;
    markBodyDirty(this.index, BODY_DIRTY.FILTER);
  }

  get friction() {
    return Collider.friction[this.index];
  }
  set friction(value) {
    Collider.friction[this.index] = Math.max(0, Number(value) || 0);
    markBodyDirty(this.index, BODY_DIRTY.FRICTION);
  }

  get restitution() {
    return Collider.restitution[this.index];
  }
  set restitution(value) {
    Collider.restitution[this.index] = Math.max(0, Number(value) || 0);
    markBodyDirty(this.index, BODY_DIRTY.FRICTION);
  }

  get enableHitEvents() {
    return Collider.enableHitEvents[this.index] !== 0;
  }
  set enableHitEvents(value) {
    Collider.enableHitEvents[this.index] = value ? 1 : 0;
    markBodyDirty(this.index, BODY_DIRTY.LIFECYCLE);
  }

  addLayerToMask(layer) {
    Collider.collisionMask[this.index] |= (1 << (layer & 31));
    markBodyDirty(this.index, BODY_DIRTY.FILTER);
  }

  removeLayerFromMask(layer) {
    Collider.collisionMask[this.index] &= ~(1 << (layer & 31));
    markBodyDirty(this.index, BODY_DIRTY.FILTER);
  }

  collidesWithLayer(layer) {
    return !!(Collider.collisionMask[this.index] & (1 << (layer & 31)));
  }

  get fixtureCount() {
    return Collider.fixtureCount ? Collider.fixtureCount[this.index] | 0 : 0;
  }
}

// ES6 module export
export { Collider };
