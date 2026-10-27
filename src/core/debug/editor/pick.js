// pick.js — which entity a click in edit mode points at (VISUAL_EDITOR_PLAN.md ED-8).
//
// A click tests every active entity: its collider when it has one (pointInCollider, the shape itself), else its
// sprite's box (the one the overlay draws as the selection: frame size times scale about the anchor, turned with the
// sprite). The spatial grid is not asked: it files an entity under its center, so the far end of a 1200 px platform
// is not "near" a click on it. Among several hits the smallest wins, the one usually drawn over the others; a click
// on the same spot again takes the next one (a platform under the player). One pass per click, into buffers made
// once: nothing is allocated per click or per frame.

import { Transform } from '../../../components/transform.js';
import { Collider } from '../../../components/collider.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { pointInCollider } from '../../../util/colliderUtils.js';

/** Hits kept per click; past it, the rest are not considered. */
export const PICK_CAP = 64;

const hits = new Int32Array(PICK_CAP);
const areas = new Float64Array(PICK_CAP);

/** Classes the editor never picks: the engine's own helpers. */
const UNPICKABLE = new Set(['Flash']);

/**
 * Whether a world point is in the entity's sprite box, as the overlay draws it (physicsDebugRenderer
 * drawSelectedEntity): frame size times signed scale about the anchor, turned with the sprite.
 * @param {number} i
 * @param {number} x
 * @param {number} y
 */
export function pointInSprite(i, x, y) {
  if (!SpriteRenderer.active || !SpriteRenderer.active[i]) return false;
  const w = SpriteRenderer.getOriginalWidth(i) * SpriteRenderer.scaleX[i];
  const h = SpriteRenderer.getOriginalHeight(i) * SpriteRenderer.scaleY[i];
  if (!(w !== 0 && h !== 0)) return false;
  let c = Transform.rotC ? Transform.rotC[i] : 1;
  let s = Transform.rotS ? Transform.rotS[i] : 0;
  const inherit = SpriteRenderer.inheritTransformRotation;
  if (inherit && !inherit[i]) {
    c = SpriteRenderer.spriteRotC[i];
    s = SpriteRenderer.spriteRotS[i];
  }
  const dx = x - Transform.x[i];
  const dy = y - Transform.y[i];
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  // (v - anchor) * size * scale for v in [0, 1]; a negative scale (a flip) swaps the ends.
  const ax = SpriteRenderer.anchorX[i];
  const ay = SpriteRenderer.anchorY[i];
  const x0 = -ax * w;
  const x1 = (1 - ax) * w;
  const y0 = -ay * h;
  const y1 = (1 - ay) * h;
  return lx >= Math.min(x0, x1) && lx <= Math.max(x0, x1) && ly >= Math.min(y0, y1) && ly <= Math.max(y0, y1);
}

/**
 * The box an entity is picked by, into `out`: center x and y, half width and height, and its turn (cos, sin). The
 * collider's when it has one (a circle's square), else the sprite's. False when it has neither.
 * @param {number} i
 * @param {Float64Array} out - 6 values
 */
export function entityBox(i, out) {
  let c = Transform.rotC ? Transform.rotC[i] : 1;
  let s = Transform.rotS ? Transform.rotS[i] : 0;
  const x = Transform.x[i];
  const y = Transform.y[i];
  if (Collider.active && Collider.active[i] === 1) {
    const ox = Collider.offsetX[i] || 0;
    const oy = Collider.offsetY[i] || 0;
    const r = Collider.radius[i];
    out[0] = x + c * ox - s * oy;
    out[1] = y + s * ox + c * oy;
    out[2] = r > 0 ? r : Collider.width[i] * 0.5;
    out[3] = r > 0 ? r : Collider.height[i] * 0.5;
  } else if (SpriteRenderer.active && SpriteRenderer.active[i]) {
    const inherit = SpriteRenderer.inheritTransformRotation;
    if (inherit && !inherit[i]) {
      c = SpriteRenderer.spriteRotC[i];
      s = SpriteRenderer.spriteRotS[i];
    }
    const w = SpriteRenderer.getOriginalWidth(i) * SpriteRenderer.scaleX[i];
    const h = SpriteRenderer.getOriginalHeight(i) * SpriteRenderer.scaleY[i];
    // The box's center sits (0.5 - anchor) of the size from the entity's position.
    const lx = (0.5 - SpriteRenderer.anchorX[i]) * w;
    const ly = (0.5 - SpriteRenderer.anchorY[i]) * h;
    out[0] = x + c * lx - s * ly;
    out[1] = y + s * lx + c * ly;
    out[2] = Math.abs(w) * 0.5;
    out[3] = Math.abs(h) * 0.5;
  } else {
    return false;
  }
  out[4] = c;
  out[5] = s;
  return true;
}

/** Whether a world point is on the entity, by the same test a click uses. */
export function pointOnEntity(i, x, y) {
  return Collider.active && Collider.active[i] === 1 ? pointInCollider(i, x, y) : pointInSprite(i, x, y);
}

/** The area a hit covers, to prefer the smaller of overlapping entities. */
function hitArea(i, byCollider) {
  if (byCollider) {
    const r = Collider.radius[i];
    if (r > 0) return Math.PI * r * r;
    return Math.abs(Collider.width[i] * Collider.height[i]);
  }
  return Math.abs(
    SpriteRenderer.getOriginalWidth(i) * SpriteRenderer.scaleX[i] * SpriteRenderer.getOriginalHeight(i) * SpriteRenderer.scaleY[i],
  );
}

/**
 * The entity at a world point, or -1.
 * @param {number} x
 * @param {number} y
 * @param {number} current - the selected entity, or -1: when it is among the hits, the next one is returned
 * @param {(entityType: number) => string} classNameOf
 * @param {((index: number) => boolean)|null} [skip] - asked of each hit: true leaves it out (a locked or hidden
 *   layer's entity, ED-24)
 * @returns {number}
 */
export function pickEntityAt(x, y, current, classNameOf, skip = null) {
  const active = Transform.active;
  if (!active) return -1;
  const types = Transform.entityType;
  const colliders = Collider.active;
  let n = 0;
  for (let i = 0; i < active.length && n < PICK_CAP; i++) {
    if (!active[i] || UNPICKABLE.has(classNameOf(types[i]))) continue;
    const byCollider = colliders !== undefined && colliders !== null && colliders[i] === 1;
    if (byCollider ? !pointInCollider(i, x, y) : !pointInSprite(i, x, y)) continue;
    if (skip !== null && skip(i)) continue;
    // Insertion by area, smallest first; equal areas keep index order.
    const area = hitArea(i, byCollider);
    let k = n++;
    while (k > 0 && areas[k - 1] > area) {
      hits[k] = hits[k - 1];
      areas[k] = areas[k - 1];
      k--;
    }
    hits[k] = i;
    areas[k] = area;
  }
  if (n === 0) return -1;
  for (let k = 0; k < n; k++) {
    if (hits[k] === current) return hits[(k + 1) % n];
  }
  return hits[0];
}
