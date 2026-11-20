// Collider.js - Collision shapes for Box2D sync + spatial/Ray queries
// Supports circles, oriented boxes, convex polygons (max 8 verts)
//
// CUSTOM SETTERS FOR MASS AUTO-COMPUTATION:
// radius / width / height setters recompute RigidBody.mass / invMass. Every
// setter with a side effect is a static by entity index (Collider.setRadius(i, r),
// E-533); the instance setters call it.
//
// Mass formulas:
// - Circle: mass = π * radius²  (area)
// - Box:    mass = width * height (area)
// - Polygon: mass = polygon area (shoelace)

import { Component } from '../core/component.js';
import { RigidBody } from './rigidBody.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { ChainPoints } from '../core/chainPoints.js';
import { MAX_POLYGON_VERTICES, ShapeType } from '../util/configDefaults.js';
import { BODY_DIRTY, markBodyDirty, remakeBody } from '../box2d/box2dBodySync.js';
import { Transform } from './transform.js';
import { SpriteRenderer } from './spriteRenderer.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';

const _chainFailWarned = new Set();

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

    // Perception / neighbour radius: an entity with one gets a neighbour list (SST-21), which its code reads. The shadow
    // stamp finds its casters itself (LightEmitter.shadowRange); under lighting.walls a casting light on an entity with a
    // visualRange looks for its walls within it (E-529: the lists once fed the CPU shadows, no longer).
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

  static initializeArrays(buffer, count, byteOffset = 0) {
    super.initializeArrays(buffer, count, byteOffset);
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
    Collider.setPolygonShape(index);

    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
    return true;
  }

  /**
   * Switch a collider to Polygon. On a polygon, radius is the Box2D skin (a
   * rounded border around the hull), so a radius left from a circle is
   * cleared rather than turned into one. A polygon keeps the skin it has.
   * @param {number} index
   */
  static setPolygonShape(index) {
    if (Collider.shapeType[index] !== ShapeType.Polygon) Collider.radius[index] = 0;
    Collider.shapeType[index] = ShapeType.Polygon;
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
  /**
   * One Box2D chain. xy is local interleaved x,y and stays caller-owned.
   * Open: first and last points are ghosts. Loop: every edge collides.
   */
  static setChain(index, xy, count, loop) {
    const n = count == null ? ((xy && xy.length) >> 1) : count | 0;
    const ok = ChainPoints.setForEntity(index, xy, n, loop);
    if (!ok) {
      const code = ChainPoints.lastError.code || 'failed';
      if (!_chainFailWarned.has(code)) {
        _chainFailWarned.add(code);
        console.warn(`[Collider] setChain failed: ${code}`);
      }
    }
    return ok;
  }

  static clearChain(index) {
    ChainPoints.clearForEntity(index);
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // SETTERS BY ENTITY INDEX (E-533)
  // The implementation of every collider write with a side effect: a collider's
  // setters (this.collider.radius = 10) and an entity's (this.radius = 10) call
  // these, and ECS code calls them with no instance (Collider.setRadius(i, 10)).
  // A plain column write (Collider.visualRange[i] = r) needs none.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Toggle Collider participation. Off + RigidBody still on → shapeless body
   * (moves, no Box2D contacts). Host clears/adds shapes via GEOMETRY dirty.
   * Compound fixtures (replacePolygons*) are kept while off, so turning it back on
   * restores the whole shape. Rays, spatial and pointInCollider skip inactive colliders.
   * @param {number} index
   * @param {boolean|number} on
   */
  static setActive(index, on) {
    const next = on ? 1 : 0;
    if (Collider.active[index] === next) return;
    Collider.active[index] = next;
    markBodyDirty(index, BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.MASS);
  }

  /**
   * @param {number} index
   * @param {number} shapeType - ShapeType
   */
  static setShapeType(index, shapeType) {
    Collider.shapeType[index] = shapeType | 0;
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /** @param {number} index @param {number} x */
  static setOffsetX(index, x) {
    Collider.offsetX[index] = Number(x) || 0;
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /** @param {number} index @param {number} y */
  static setOffsetY(index, y) {
    Collider.offsetY[index] = Number(y) || 0;
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /** Both offsets, one body mark. @param {number} index @param {number} x @param {number} y */
  static setOffset(index, x, y) {
    Collider.offsetX[index] = Number(x) || 0;
    Collider.offsetY[index] = Number(y) || 0;
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /**
   * A positive radius makes a box a circle. A polygon keeps its shape: radius is
   * the Box2D border around the hull (0 = sharp). Syncs RigidBody mass.
   * @param {number} index
   * @param {number} radius
   */
  static setRadius(index, radius) {
    Collider.radius[index] = radius;
    const shape = Collider.shapeType[index];
    if (radius > 0 && shape !== ShapeType.Chain && shape !== ShapeType.Polygon) {
      Collider.shapeType[index] = ShapeType.Circle;
    }
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /**
   * A positive width makes a circle a box (polygons and chains keep their shape). Syncs RigidBody mass.
   * @param {number} index
   * @param {number} width
   */
  static setWidth(index, width) {
    Collider.width[index] = width;
    const shape = Collider.shapeType[index];
    if (width > 0 && shape !== ShapeType.Polygon && shape !== ShapeType.Chain) {
      Collider.shapeType[index] = ShapeType.Box;
    }
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /**
   * A positive height makes a circle a box (polygons and chains keep their shape). Syncs RigidBody mass.
   * @param {number} index
   * @param {number} height
   */
  static setHeight(index, height) {
    Collider.height[index] = height;
    const shape = Collider.shapeType[index];
    if (height > 0 && shape !== ShapeType.Polygon && shape !== ShapeType.Chain) {
      Collider.shapeType[index] = ShapeType.Box;
    }
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /**
   * Width and height, one mass sync from the final box (setWidth then setHeight
   * synced it from the half-changed one in between) and one body mark.
   * @param {number} index
   * @param {number} width
   * @param {number} height
   */
  static setSize(index, width, height) {
    Collider.width[index] = width;
    Collider.height[index] = height;
    const shape = Collider.shapeType[index];
    if ((width > 0 || height > 0) && shape !== ShapeType.Polygon && shape !== ShapeType.Chain) {
      Collider.shapeType[index] = ShapeType.Box;
    }
    RigidBody.syncMassFromCollider(index);
    markBodyDirty(index, BODY_DIRTY.GEOMETRY);
  }

  /** @param {number} index @param {number} layer - 0..31 */
  static setCollisionLayer(index, layer) {
    Collider.collisionLayer[index] = layer & 31;
    markBodyDirty(index, BODY_DIRTY.FILTER);
  }

  /** @param {number} index @param {number} mask - bit i = layer i */
  static setCollisionMask(index, mask) {
    Collider.collisionMask[index] = mask;
    markBodyDirty(index, BODY_DIRTY.FILTER);
  }

  /** @param {number} index @param {number} group - 0 ignore; same negative never; same positive always */
  static setCollisionGroupIndex(index, group) {
    Collider.collisionGroupIndex[index] = group | 0;
    markBodyDirty(index, BODY_DIRTY.FILTER);
  }

  /** @param {number} index @param {number} friction - μ, 0 or more */
  static setFriction(index, friction) {
    Collider.friction[index] = Math.max(0, Number(friction) || 0);
    markBodyDirty(index, BODY_DIRTY.FRICTION);
  }

  /** @param {number} index @param {number} restitution - bounce, 0 or more */
  static setRestitution(index, restitution) {
    Collider.restitution[index] = Math.max(0, Number(restitution) || 0);
    markBodyDirty(index, BODY_DIRTY.FRICTION);
  }

  /**
   * A sensor: events, no physical response. Box2D reads it when it makes the body, so a change makes the body again
   * (N-131: a write after the body existed did nothing).
   * @param {number} index
   * @param {boolean|number} on
   */
  static setIsTrigger(index, on) {
    const next = on ? 1 : 0;
    if (Collider.isTrigger[index] === next) return;
    Collider.isTrigger[index] = next;
    remakeBody(index, Transform.active?.[index] === 1);
  }

  /**
   * A shape's hit events: Box2D reads them when it makes the body, so a change makes it again (N-135).
   * @param {number} index
   * @param {boolean|number} on
   */
  static setEnableHitEvents(index, on) {
    const next = on ? 1 : 0;
    if (Collider.enableHitEvents[index] === next) return;
    Collider.enableHitEvents[index] = next;
    remakeBody(index, Transform.active?.[index] === 1);
  }

  /** @param {number} index @param {number} layer - 0..31 */
  static addLayerToMask(index, layer) {
    Collider.collisionMask[index] |= (1 << (layer & 31));
    markBodyDirty(index, BODY_DIRTY.FILTER);
  }

  /** @param {number} index @param {number} layer - 0..31 */
  static removeLayerFromMask(index, layer) {
    Collider.collisionMask[index] &= ~(1 << (layer & 31));
    markBodyDirty(index, BODY_DIRTY.FILTER);
  }

  /** @param {number} index @param {number} layer - 0..31 @returns {boolean} */
  static collidesWithLayer(index, layer) {
    return !!(Collider.collisionMask[index] & (1 << (layer & 31)));
  }

  /**
   * Size the collider to the sprite as drawn (frame × scale): a box gets its
   * width and height, a circle a radius of half the smaller side. The offset
   * follows the sprite anchor (and a flip), so box and sprite line up.
   * Polygons and chains are left alone. Call after setSprite and setScale.
   * @param {number} index
   * @param {number} [factor=1] - 0.8 = a collider 80 % of the sprite
   * @returns {boolean} false when there is no sprite to fit
   */
  static fitToSprite(index, factor = 1) {
    const i = index;
    const shape = Collider.shapeType[i];
    if (shape === ShapeType.Polygon || shape === ShapeType.Chain) {
      console.warn('Collider.fitToSprite: polygon and chain colliders keep their shape');
      return false;
    }
    const active = SpriteRenderer.active;
    const dims = active && active[i]
      ? SpriteSheetRegistry.frameSizeOf(SpriteRenderer.spritesheetId[i], SpriteRenderer.animationState[i])
      : null;
    if (dims === null || !(dims.w > 0) || !(dims.h > 0)) return false;
    const sx = SpriteRenderer.scaleX[i];
    const sy = SpriteRenderer.scaleY[i];
    const w = dims.w * (sx < 0 ? -sx : sx) * factor;
    const h = dims.h * (sy < 0 ? -sy : sy) * factor;
    if (shape === ShapeType.Circle) {
      Collider.setRadius(i, (w < h ? w : h) * 0.5);
    } else {
      Collider.setWidth(i, w);
      Collider.setHeight(i, h);
    }
    // The sprite's centre sits at (0.5 - anchor) × drawn size from the transform.
    Collider.setOffset(
      i,
      (0.5 - SpriteRenderer.anchorX[i]) * dims.w * sx,
      (0.5 - SpriteRenderer.anchorY[i]) * dims.h * sy,
    );
    return true;
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

  setChain(xy, count, loop) {
    return Collider.setChain(this.index, xy, count, loop);
  }

  clearChain() {
    Collider.clearChain(this.index);
  }

  clearFixtures() {
    Collider.clearFixtures(this.index);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOM GETTERS/SETTERS
  // Each setter with a side effect is its static above, by this collider's index.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Collider participation (Collider.setActive). */
  get active() {
    return Collider.active[this.index];
  }
  set active(value) {
    Collider.setActive(this.index, value);
  }

  get shapeType() {
    return Collider.shapeType[this.index];
  }
  set shapeType(value) {
    Collider.setShapeType(this.index, value);
  }

  /**
   * Size the collider to the sprite as drawn (Collider.fitToSprite). Call after setSprite and setScale.
   * @param {number} [factor=1] - 0.8 = a collider 80 % of the sprite
   * @returns {boolean} false when there is no sprite to fit
   */
  fitToSprite(factor = 1) {
    return Collider.fitToSprite(this.index, factor);
  }

  get offsetX() {
    return Collider.offsetX[this.index];
  }
  set offsetX(value) {
    Collider.setOffsetX(this.index, value);
  }

  get offsetY() {
    return Collider.offsetY[this.index];
  }
  set offsetY(value) {
    Collider.setOffsetY(this.index, value);
  }

  get radius() {
    return Collider.radius[this.index];
  }
  set radius(value) {
    Collider.setRadius(this.index, value);
  }

  get width() {
    return Collider.width[this.index];
  }
  set width(value) {
    Collider.setWidth(this.index, value);
  }

  get height() {
    return Collider.height[this.index];
  }
  set height(value) {
    Collider.setHeight(this.index, value);
  }

  get collisionLayer() {
    return Collider.collisionLayer[this.index];
  }
  set collisionLayer(value) {
    Collider.setCollisionLayer(this.index, value);
  }

  get collisionMask() {
    return Collider.collisionMask[this.index];
  }
  set collisionMask(value) {
    Collider.setCollisionMask(this.index, value);
  }

  get collisionGroupIndex() {
    return Collider.collisionGroupIndex[this.index];
  }
  set collisionGroupIndex(value) {
    Collider.setCollisionGroupIndex(this.index, value);
  }

  get friction() {
    return Collider.friction[this.index];
  }
  set friction(value) {
    Collider.setFriction(this.index, value);
  }

  get restitution() {
    return Collider.restitution[this.index];
  }
  set restitution(value) {
    Collider.setRestitution(this.index, value);
  }

  /** A sensor (Collider.setIsTrigger: a change makes the body again). */
  get isTrigger() {
    return Collider.isTrigger[this.index];
  }
  set isTrigger(value) {
    Collider.setIsTrigger(this.index, value);
  }

  get enableHitEvents() {
    return Collider.enableHitEvents[this.index] !== 0;
  }
  /** A shape's hit events (Collider.setEnableHitEvents: a change makes the body again). */
  set enableHitEvents(value) {
    Collider.setEnableHitEvents(this.index, value);
  }

  addLayerToMask(layer) {
    Collider.addLayerToMask(this.index, layer);
  }

  removeLayerFromMask(layer) {
    Collider.removeLayerFromMask(this.index, layer);
  }

  collidesWithLayer(layer) {
    return Collider.collidesWithLayer(this.index, layer);
  }

  get fixtureCount() {
    return Collider.fixtureCount ? Collider.fixtureCount[this.index] | 0 : 0;
  }
}

// ES6 module export
export { Collider };
