// CR-38: the JS twin of visibilityGather.wasm (E-76 W2b), with the kernel's binding's shape, for the tests that hold
// the kernel's rows to the JS's bit for bit. This was pre-render's own JS gather until CR-38 (preRenderWorker.js
// _buildVisibilityPolygonsSwept): a light's neighbour walk that packs circles, boxes and convex polygons into the
// visibility scratch, names each with the code its edges carry in the lamp's row (OL-12), and stops at the scratch's
// occluder cap. A compound solid goes back as an event with its pose, as the kernel sends it, and pre-render rasters it.
// The cone forms gather what the full one does: the JS never culled by the wedge (the kernel drops what lies wholly
// outside it; tests/node/visibilityConeWired.test.js holds the two to the same light inside the cone).
import { Collider } from '../../src/components/collider.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { Transform } from '../../src/components/transform.js';
import { ShapeType } from '../../src/box2d/box2dConstants.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Grid } from '../../src/core/grid.js';
import { gbufEntityId } from '../../src/render/gbufWord.js';
import {
  OCC_CIRCLE,
  OCC_POLY,
  writeOrientedBoxVerts,
  writePolygonVerts,
} from '../../src/render/visibility/angularSweep.js';
import { wallEdgeCode } from '../../src/render/visibility/lampWallRow.js';
import {
  GATHER_ARGS,
  GATHER_EVENT_F64,
  GATHER_EVENT_I32,
  GATHER_EV_SOLID,
} from '../../src/render/visibility/visibilityGatherClient.js';
import { GATHER_EVENT_BYTES } from '../../src/util/wasmMemoryMap.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';

/**
 * A gather with bindVisibilityGather's shape that runs in JS, for pre-render's `_visGather`. The worker must have
 * bound the kernel first (the placed memory: tests/helpers/visibilityWired.mjs bootPreRenderGather), so its column
 * table is written as for the kernel: the twin takes the kernel's buffer and event count.
 * @param {object} pre a pre-render worker the harness booted
 */
export function visibilityGatherJs(pre) {
  const k = pre._visGather;
  if (!k) throw new Error('visibilityGatherJs: the worker has no gather kernel bound (boot it with bootPreRenderGather)');
  const events = k.events;
  const eventBuffer = new ArrayBuffer(events * GATHER_EVENT_BYTES);
  const results = new Int32Array(4);
  const args = new Float64Array(GATHER_ARGS);
  const eventsI32 = new Int32Array(eventBuffer);
  const eventsF64 = new Float64Array(eventBuffer);
  const gather = (_tableByte, light) => gatherLightJs(pre, light, args, results, eventsI32, eventsF64, events);
  return {
    buffer: k.buffer,
    table: new Uint32Array(k.table.length),
    tableByte: 0,
    gather16: gather,
    gather32: gather,
    gather,
    gatherCone16: gather,
    gatherCone32: gather,
    gatherCone: gather,
    args,
    results,
    eventsI32,
    eventsF64,
    events,
  };
}

/**
 * One light's gather (args: lx, ly, radius): the occluders packed into the worker's scratch in neighbour order, the
 * compound solids as events. results: [0] occluders, [1] vertices, [2] events, [3] 1 when the occluder cap stopped
 * the walk. Returns the occluders packed.
 */
function gatherLightJs(pre, lightIdx, args, results, evI32, evF64, maxEvents) {
  const lx = args[0];
  const ly = args[1];
  const influenceRadius = args[2];
  const neighborData = Grid.neighborData;
  const stride = Grid._stride;
  const transformActive = Transform.active;
  const occluderActive = LightOccluder.active;
  const occluderBlock = LightOccluder.block;
  const colliderActive = Collider.active;
  const shapeType = Collider.shapeType;
  const colRadius = Collider.radius;
  const colWidth = Collider.width;
  const colHeight = Collider.height;
  const colOffX = Collider.offsetX;
  const colOffY = Collider.offsetY;
  const polyCountArr = Collider.polyCount;
  const polyVertX = Collider.polyVertexX;
  const polyVertY = Collider.polyVertexY;
  const polyCentroidX = Collider.polyCentroidX;
  const polyCentroidY = Collider.polyCentroidY;
  const fixtureCountArr = Collider.fixtureCount;
  const kind = pre._vpOccKind;
  const cX = pre._vpCircleX;
  const cY = pre._vpCircleY;
  const cR = pre._vpCircleR;
  const vertStart = pre._vpVertStart;
  const vertCountArr = pre._vpVertCount;
  const vertsX = pre._vpVertsX;
  const vertsY = pre._vpVertsY;
  const maxOccluders = pre._vpMaxOccluders;
  const wallOccCode = pre._wallOccCode;
  const pose = pre._displayPoseOut;
  const heads = ColliderFixture.head;

  let occCount = 0;
  let vertPool = 0;
  let events = 0;
  let occluderLimitHit = false;
  if (neighborData && stride > 0) {
    const offset = lightIdx * stride;
    const nCount = neighborData[offset];
    for (let k = 0; k < nCount; k++) {
      if (occCount >= maxOccluders) {
        occluderLimitHit = true;
        break;
      }
      const nIdx = neighborData[offset + 1 + k];
      if (!transformActive[nIdx] || !occluderActive[nIdx] || !colliderActive[nIdx]) continue;
      if (occluderBlock && !(occluderBlock[nIdx] > 0)) continue;

      pre._displayPose(nIdx, pose);
      const wx = pose[0];
      const wy = pose[1];
      const c = pose[2];
      const s = pose[3];

      const shape = shapeType[nIdx];
      if (shape === ShapeType.Chain) continue;
      const ox = colOffX[nIdx] || 0;
      const oy = colOffY[nIdx] || 0;
      const nFixtures = fixtureCountArr ? (fixtureCountArr[nIdx] | 0) : 0;
      if (nFixtures > 0 && heads && nIdx < heads.length) {
        const lcx = polyCentroidX ? polyCentroidX[nIdx] : 0;
        const lcy = polyCentroidY ? polyCentroidY[nIdx] : 0;
        const centX = wx + c * (ox + lcx) - s * (oy + lcy);
        const centY = wy + s * (ox + lcx) + c * (oy + lcy);
        const hw = (colWidth[nIdx] || 0) * 0.5;
        const hh = (colHeight[nIdx] || 0) * 0.5;
        const reach = Math.sqrt(hw * hw + hh * hh);
        const cdx = centX - lx;
        const cdy = centY - ly;
        const bound = influenceRadius + reach;
        if (cdx * cdx + cdy * cdy > bound * bound) continue;
        // A compound solid: an event with its pose, which pre-render rasters (the kernel's GATHER_EV_SOLID).
        if (events >= maxEvents) throw new Error('visibilityGatherJs: more compound solids than event records');
        const ei = events * GATHER_EVENT_I32;
        const ef = events * GATHER_EVENT_F64;
        evI32[ei] = GATHER_EV_SOLID;
        evI32[ei + 1] = nIdx;
        evF64[ef + 2] = wx;
        evF64[ef + 3] = wy;
        evF64[ef + 4] = c;
        evF64[ef + 5] = s;
        events++;
        continue;
      }
      const occX = wx + ox;
      const occY = wy + oy;
      const dx = occX - lx;
      const dy = occY - ly;
      let reach = 0;
      if (shape === ShapeType.Circle) {
        reach = colRadius[nIdx] || 0;
      } else {
        const hw = (colWidth[nIdx] || 0) * 0.5;
        const hh = (colHeight[nIdx] || 0) * 0.5;
        reach = Math.sqrt(hw * hw + hh * hh);
      }
      const maxReach = influenceRadius + reach;
      if (dx * dx + dy * dy > maxReach * maxReach) continue;

      let packed = false;
      if (shape === ShapeType.Circle) {
        const r = colRadius[nIdx];
        if (!(r > 0)) continue;
        kind[occCount] = OCC_CIRCLE;
        cX[occCount] = wx + ox;
        cY[occCount] = wy + oy;
        cR[occCount] = r;
        vertStart[occCount] = 0;
        vertCountArr[occCount] = 0;
        packed = true;
      } else if (shape === ShapeType.Box) {
        const w = colWidth[nIdx];
        const h = colHeight[nIdx];
        if (!(w > 0) || !(h > 0)) continue;
        kind[occCount] = OCC_POLY;
        vertStart[occCount] = vertPool;
        writeOrientedBoxVerts(vertsX, vertsY, vertPool, wx, wy, w, h, c, s, ox, oy);
        vertCountArr[occCount] = 4;
        vertPool += 4;
        packed = true;
      } else if (shape === ShapeType.Polygon) {
        const pc = polyCountArr[nIdx] | 0;
        if (pc >= 3) {
          kind[occCount] = OCC_POLY;
          vertStart[occCount] = vertPool;
          const base = nIdx * MAX_POLYGON_VERTICES;
          writePolygonVerts(vertsX, vertsY, vertPool, wx, wy, c, s, ox, oy, polyVertX, polyVertY, base, pc);
          vertCountArr[occCount] = pc;
          vertPool += pc;
          packed = true;
        } else {
          // Fallback to box extents when poly not filled
          const w = colWidth[nIdx];
          const h = colHeight[nIdx];
          if (!(w > 0) || !(h > 0)) continue;
          kind[occCount] = OCC_POLY;
          vertStart[occCount] = vertPool;
          writeOrientedBoxVerts(vertsX, vertsY, vertPool, wx, wy, w, h, c, s, ox, oy);
          vertCountArr[occCount] = 4;
          vertPool += 4;
          packed = true;
        }
      }
      if (!packed) continue;
      // The code its edges carry in the lamp's row (its entity and how much it blocks), as the kernel writes it (OL-12).
      wallOccCode[occCount] = wallEdgeCode(gbufEntityId(nIdx), occluderBlock[nIdx]);
      occCount++;
    }
  }
  results[0] = occCount;
  results[1] = vertPool;
  results[2] = events;
  results[3] = occluderLimitHit ? 1 : 0;
  return occCount;
}
