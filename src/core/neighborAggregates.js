// E-199: what the spatial publish writes, with each neighbour row, for the entities whose type asks for it with
// `static neighborAggregates` (src/util/neighborAggregatesSpec.js resolves it; wasm/spatialPublish.c writes it).
// Columns by entity index, like a component's: views of the spatial publish memory, bound in every worker with the
// Grid (Grid.initialize). An output no type of the scene asks for stays an empty array of its class.

const EMPTY_F32 = new Float32Array(0);
const EMPTY_U16 = new Uint16Array(0);
const EMPTY_I32 = new Int32Array(0);

/**
 * NeighborAggregates - per entity, a summary of its neighbour list, written by the spatial workers.
 *
 * An entity type asks for them:
 *
 *   class Fish extends GameObject {
 *     static neighborAggregates = {
 *       separation: { radius: 40, falloff: 'linear' }, // push away from those within 40 px
 *       cohesion: { minDistance: 40, velocity: true }, // the others: their centroid and average velocity
 *       nearest: { ofType: Shark, count: 2 },          // the two nearest sharks
 *     };
 *   }
 *
 * and its code reads one row instead of every neighbour:
 *
 *   const i = this.index;
 *   if (NeighborAggregates.cohesionCount[i] > 0) ax += NeighborAggregates.centroidX[i] - Transform.x[i];
 *   const nearestShark = NeighborAggregates.nearestCount[i] > 0
 *     ? NeighborAggregates.nearestIndex[NeighborAggregates.nearestOffset(i)] : -1;
 *
 * Every aggregate is over the entity's neighbour list as published (Grid.getNeighbor), with the positions the spatial
 * worker searched with (each collider's centre, float32) on the frame it published the list: as old as the list.
 * Neighbours closer than 1 px have no direction and push nothing.
 */
export class NeighborAggregates {
  /**
   * Separation: the sum, over the neighbours within separation.radius (of separation.ofType), of the offset from
   * each neighbour to the entity over its squared distance (at least separation.floor²), times the falloff
   * (1 - d² / radius² with 'linear', else 1). A vector pointing away from the crowd; px⁻¹.
   */
  static separationX = EMPTY_F32;
  static separationY = EMPTY_F32;
  /** The neighbours the separation summed. */
  static separationCount = EMPTY_U16;
  /** Cohesion: the centroid of the neighbours at cohesion.minDistance or more (of cohesion.ofType); 0 with none. */
  static centroidX = EMPTY_F32;
  static centroidY = EMPTY_F32;
  /** The neighbours in the cohesion group. */
  static cohesionCount = EMPTY_U16;
  /** With cohesion.velocity: the cohesion group's average RigidBody velocity, px/s; 0 with none. */
  static averageVelocityX = EMPTY_F32;
  static averageVelocityY = EMPTY_F32;
  /** The nearest neighbours found (of nearest.ofType), at most nearest.count. */
  static nearestCount = EMPTY_U16;
  /** The nearest neighbours' entity indices, nearest first: nearestSlots per entity, from nearestOffset(i). */
  static nearestIndex = EMPTY_I32;
  /** Their squared distances (float32), in the same slots. */
  static nearestDistanceSq = EMPTY_F32;
  /** The nearest slots each entity has: the largest nearest.count of the scene's types (0 when none asks). */
  static nearestSlots = 0;

  /**
   * Entity i's first slot in nearestIndex and nearestDistanceSq.
   * @param {number} i - entity index
   * @returns {number}
   */
  static nearestOffset(i) {
    return i * NeighborAggregates.nearestSlots;
  }

  /**
   * Bind the columns (Grid.initialize, in every worker and on the page).
   * @param {ArrayBufferLike | null} buffer the spatial publish memory's buffer
   * @param {object | null} layout gridMetadata.aggregates (createSpatialPublishMemory's `aggregates`), null without
   */
  static _bind(buffer, layout) {
    NeighborAggregates._reset();
    if (!buffer || !layout) return;
    const n = layout.entityCount | 0;
    const f32 = (byte, len = n) => (byte ? new Float32Array(buffer, byte, len) : EMPTY_F32);
    const u16 = (byte) => (byte ? new Uint16Array(buffer, byte, n) : EMPTY_U16);
    const slots = layout.nearestSlots | 0;
    NeighborAggregates.separationX = f32(layout.separationXByte);
    NeighborAggregates.separationY = f32(layout.separationYByte);
    NeighborAggregates.separationCount = u16(layout.separationCountByte);
    NeighborAggregates.centroidX = f32(layout.centroidXByte);
    NeighborAggregates.centroidY = f32(layout.centroidYByte);
    NeighborAggregates.cohesionCount = u16(layout.cohesionCountByte);
    NeighborAggregates.averageVelocityX = f32(layout.averageVelocityXByte);
    NeighborAggregates.averageVelocityY = f32(layout.averageVelocityYByte);
    NeighborAggregates.nearestCount = u16(layout.nearestCountByte);
    NeighborAggregates.nearestIndex = layout.nearestIndexByte ? new Int32Array(buffer, layout.nearestIndexByte, n * slots) : EMPTY_I32;
    NeighborAggregates.nearestDistanceSq = f32(layout.nearestDistanceSqByte, n * slots);
    NeighborAggregates.nearestSlots = layout.nearestIndexByte ? slots : 0;
  }

  /** Every column back to an empty array (Grid.reset). */
  static _reset() {
    NeighborAggregates.separationX = EMPTY_F32;
    NeighborAggregates.separationY = EMPTY_F32;
    NeighborAggregates.separationCount = EMPTY_U16;
    NeighborAggregates.centroidX = EMPTY_F32;
    NeighborAggregates.centroidY = EMPTY_F32;
    NeighborAggregates.cohesionCount = EMPTY_U16;
    NeighborAggregates.averageVelocityX = EMPTY_F32;
    NeighborAggregates.averageVelocityY = EMPTY_F32;
    NeighborAggregates.nearestCount = EMPTY_U16;
    NeighborAggregates.nearestIndex = EMPTY_I32;
    NeighborAggregates.nearestDistanceSq = EMPTY_F32;
    NeighborAggregates.nearestSlots = 0;
  }
}
