/**
 * Publish load counts (BODY_COUNT, ACTIVE_PARTICLES, ENTITIES_PROCESSED,
 * NEIGHBORS_REUSED, …) on an old tree that only wrote them with detailed stats on.
 * Always-on counts shipped after main 6d404db; 0695a8d-era revs still need this.
 *
 * Only ever applied inside a throwaway worktree (revWorktree.mjs). Never call
 * it on the working tree.
 */
import fs from 'node:fs';
import path from 'node:path';

function replaceOnce(src, from, to, rel) {
  if (!src.includes(from)) throw new Error(`workload counts: anchor missing in ${rel}: ${from.slice(0, 100)}`);
  return src.replace(from, to);
}

function patchRel(root, rel, fn) {
  const file = path.join(root, rel);
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const src = raw.replace(/\r\n/g, '\n');
  const next = fn(src, rel);
  if (next !== src) fs.writeFileSync(file, next.replace(/\n/g, eol));
}

export function treeHasWorkloadCounts(root) {
  const particle = fs.readFileSync(path.join(root, 'src/workers/particleWorker.js'), 'utf8');
  return (
    particle.includes('this.stats[PARTICLE_STATS.ACTIVE_DECORATIONS]') &&
    particle.includes('this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;')
  );
}

export function applyWorkloadCounts(root) {
  if (treeHasWorkloadCounts(root)) return false;
  patchRel(root, 'src/box2d/weedjsPost.js', (src, rel) => {
    if (src.includes('if (!statsF32) return;\n    statsF32[PS.BODY_COUNT] = denseCount;')) return src;
    let out = src;
    if (!out.includes('writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);')) {
      out = replaceOnce(
        out,
        `      maybePublishPose(entityCount);
      afterStep();
      return;
    }
    const t0 = performance.now();`,
        `      maybePublishPose(entityCount);
      afterStep();
      writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
    }
    const t0 = performance.now();`,
        rel
      );
    }
    return replaceOnce(
      out,
      `    if (!statsF32 || !collectDetailedStats) return;
    statsF32[PS.BODY_COUNT] = denseCount;`,
      `    if (!statsF32) return;
    statsF32[PS.BODY_COUNT] = denseCount;
    const movedViewsEarly =
      typeof Box2dMovedBodies !== 'undefined' && Box2dMovedBodies.getMovedBodiesViews
        ? Box2dMovedBodies.getMovedBodiesViews()
        : null;
    statsF32[PS.BODY_MOVED_COUNT] = movedViewsEarly ? movedViewsEarly.count | 0 : 0;
    if (world && typeof world._getAwakeBodyCount === 'function') {
      statsF32[PS.AWAKE_COUNT] = world._getAwakeBodyCount(world.worldId) | 0;
    } else {
      statsF32[PS.AWAKE_COUNT] = 0;
    }
    if (typeof weedjsHeapBytesUsed === 'function') {
      const usedKbEarly = ((weedjsHeapBytesUsed() | 0) / 1024) | 0;
      if (usedKbEarly > heapHighWaterKb) heapHighWaterKb = usedKbEarly;
      statsF32[PS.HEAP_USED_KB] = usedKbEarly;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    } else {
      statsF32[PS.HEAP_USED_KB] = 0;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    }
    if (!collectDetailedStats) return;`,
      rel
    );
  });
  patchRel(root, 'src/workers/particleWorker.js', (src, rel) => {
    if (
      src.includes(
        'this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;\n    if (!this.collectDetailedStats) return;'
      )
    ) {
      return src;
    }
    const activeFirst =
      'this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;\n    if (!this.collectDetailedStats) return;';
    if (src.includes(activeFirst)) {
      return src.replace(
        `    ${activeFirst}`,
        `    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    if (!this.collectDetailedStats) return;`
      );
    }
    return replaceOnce(
      src,
      `    this.stats[PARTICLE_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;`,
      `    this.stats[PARTICLE_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    if (!this.collectDetailedStats) return;`,
      rel
    );
  });
  patchRel(root, 'src/workers/logicWorker.js', (src, rel) => {
    if (
      src.includes(
        'this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;\n    if (!this.collectDetailedStats) return;'
      )
    ) {
      return src;
    }
    return replaceOnce(
      src,
      `    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;`,
      `    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
    if (!this.collectDetailedStats) return;`,
      rel
    );
  });
  patchRel(root, 'src/workers/spatialWorker.js', (src, rel) => {
    if (
      src.includes(
        'this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;\n    if (!this.collectDetailedStats) return;'
      )
    ) {
      return src;
    }
    let out = replaceOnce(
      src,
      `    this.stats[SPATIAL_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;`,
      `    this.stats[SPATIAL_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    if (!this.collectDetailedStats) return;`,
      rel
    );
    const dup = `    this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    this.stats[SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS] = this.sleepNeighborSkipsThisFrame;`;
    if (out.includes(dup)) {
      out = out.replace(
        dup,
        `    this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS] = this.sleepNeighborSkipsThisFrame;`
      );
    }
    return out;
  });
  return true;
}
