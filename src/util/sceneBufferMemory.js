import {
  MAX_ENTITIES,
  QUERY_SNAPSHOT_COUNT,
  calculateQueryResultsSABSize,
  getQuerySnapshotElements,
} from './QuerySystem.js';
import { STATE_CHANNEL_COUNT } from '../box2d/box2dConstants.js';
import { PHYSICS_STATS } from '../workers/workers-utils.js';

function summarizeBufferNode(value, path, flatBreakdown) {
  if (value instanceof SharedArrayBuffer) {
    const bytes = value.byteLength;
    flatBreakdown[path] = bytes;
    return {
      totalBytes: bytes,
      totalFormatted: formatBytes(bytes),
      bufferCount: 1,
      children: null,
    };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  const children = {};
  let totalBytes = 0;
  let bufferCount = 0;

  for (const [rawKey, childValue] of entries) {
    const key = String(rawKey);
    const childPath = `${path}.${key}`;
    const childSummary = summarizeBufferNode(childValue, childPath, flatBreakdown);
    if (!childSummary) continue;

    children[key] = childSummary;
    totalBytes += childSummary.totalBytes;
    bufferCount += childSummary.bufferCount;
  }

  if (bufferCount === 0) {
    return null;
  }

  return {
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    bufferCount,
    children,
  };
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function buildMemoryUsageSummary(buffers) {
  if (!buffers) {
    return {
      totalBytes: 0,
      totalFormatted: '0 B',
      bufferCount: 0,
      categories: {},
      flatBreakdown: {},
    };
  }

  const categories = {};
  const flatBreakdown = {};

  let totalBytes = 0;
  let bufferCount = 0;

  for (const [key, value] of Object.entries(buffers)) {
    const summary = summarizeBufferNode(value, key, flatBreakdown);
    if (!summary) continue;
    categories[key] = summary;
    totalBytes += summary.totalBytes;
    bufferCount += summary.bufferCount;
  }

  return {
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    bufferCount,
    categories,
    flatBreakdown,
  };
}

export function getSharedBufferSize(buffers, includeBreakdown = false) {
  const summary = buildMemoryUsageSummary(buffers);
  if (!includeBreakdown) return summary.totalBytes;

  return {
    total: summary.totalBytes,
    totalFormatted: summary.totalFormatted,
    breakdown: summary.flatBreakdown,
    categories: summary.categories,
    bufferCount: summary.bufferCount,
  };
}

function getComponentPoolCapacity(scene, componentName) {
  if (componentName === 'ParticleComponent') return scene.config?.particle?.maxParticles || 0;
  if (componentName === 'DecorationComponent') return scene.config?.decoration?.maxDecorations || 0;
  if (componentName === 'BulletComponent') return scene.config?.bullet?.maxBullets || 0;
  return scene.totalEntityCount || 0;
}

function isDedicatedPoolComponent(componentName) {
  return (
    componentName === 'ParticleComponent' ||
    componentName === 'DecorationComponent' ||
    componentName === 'BulletComponent'
  );
}

function countEntityTypesUsingComponent(scene, componentName) {
  let count = 0;
  let totalPoolSlots = 0;

  for (const registration of scene.registeredClasses || []) {
    const usesComponent = registration.components?.some(
      (ComponentClass) => ComponentClass?.name === componentName
    );
    if (!usesComponent) continue;

    count++;
    totalPoolSlots += registration.count || 0;
  }

  return { entityTypeCount: count, entityPoolSlots: totalPoolSlots };
}

export function buildSceneMemoryUsageReport(scene) {
  const summary = buildMemoryUsageSummary(scene.buffers);
  const componentAllocations = {};
  const componentData = scene.buffers?.componentData || {};

  for (const [componentName, buffer] of Object.entries(componentData)) {
    if (!(buffer instanceof SharedArrayBuffer)) continue;

    const usage = countEntityTypesUsingComponent(scene, componentName);
    const capacity = getComponentPoolCapacity(scene, componentName);
    const bytesPerSlot = capacity > 0 ? buffer.byteLength / capacity : 0;
    const estimatedUsedSlots = isDedicatedPoolComponent(componentName)
      ? capacity
      : usage.entityPoolSlots;
    const estimatedUnusedSlots = Math.max(0, capacity - estimatedUsedSlots);
    const estimatedUnusedBytes = Math.round(estimatedUnusedSlots * bytesPerSlot);

    componentAllocations[componentName] = {
      bytes: buffer.byteLength,
      formatted: formatBytes(buffer.byteLength),
      capacity,
      entityTypeCount: usage.entityTypeCount,
      entityPoolSlots: usage.entityPoolSlots,
      bytesPerSlot,
      estimatedUsedSlots,
      estimatedUnusedSlots,
      estimatedUnusedBytes,
      estimatedUnusedFormatted: formatBytes(estimatedUnusedBytes),
      dedicatedPool: isDedicatedPoolComponent(componentName),
    };
  }

  return {
    ...summary,
    componentAllocations,
    capacityInsights: buildCapacityInsights(scene),
    box2dHeap: buildBox2dHeapInsight(scene),
  };
}

function buildBox2dHeapInsight(scene) {
  const hot = scene.box2dHotFields;
  if (!hot?.sab) {
    return {
      ready: false,
      reservedBytes: 0,
      reservedFormatted: '0 B',
      usedBytes: 0,
      usedFormatted: '0 B',
      highWaterBytes: 0,
      highWaterFormatted: '0 B',
      bodyChannelBytes: 0,
      bodyChannelFormatted: '0 B',
      bodyCapacity: 0,
    };
  }

  const reservedBytes = hot.sab.byteLength || 0;
  const bodyCapacity = hot.bodyCapacity | 0;
  // 6× f32 state channels + 1× u8 sleeping
  const bodyChannelBytes =
    bodyCapacity > 0
      ? bodyCapacity * STATE_CHANNEL_COUNT * 4 + bodyCapacity
      : 0;

  let usedBytes = 0;
  let highWaterBytes = 0;
  const physSab = scene.buffers?.physicsStats;
  if (physSab) {
    const f32 = new Float32Array(physSab);
    usedBytes = ((f32[PHYSICS_STATS.HEAP_USED_KB] || 0) * 1024) | 0;
    highWaterBytes = ((f32[PHYSICS_STATS.HEAP_HIGH_WATER_KB] || 0) * 1024) | 0;
  }

  return {
    ready: true,
    reservedBytes,
    reservedFormatted: formatBytes(reservedBytes),
    usedBytes,
    usedFormatted: formatBytes(usedBytes),
    highWaterBytes,
    highWaterFormatted: formatBytes(highWaterBytes),
    bodyChannelBytes,
    bodyChannelFormatted: formatBytes(bodyChannelBytes),
    bodyCapacity,
    note: 'used = dlmalloc uordblks; reserved = WASM SharedArrayBuffer size; body channels = pose/vel/sleep tables inside HEAP',
  };
}

function buildCapacityInsights(scene) {
  const insights = [];
  const N = scene.totalEntityCount || 0;
  const maxNeighbors = scene.config?.spatial?.maxNeighbors || 0;
  const neighborBytes = scene.buffers?.neighborData?.byteLength || 0;
  if (neighborBytes > 0 && N > 0) {
    const bytesPerEntity = neighborBytes / N;
    insights.push({
      key: 'neighborData',
      bytes: neighborBytes,
      formatted: formatBytes(neighborBytes),
      detail: `${N} entities × (1+${maxNeighbors}) u16 ≈ ${bytesPerEntity.toFixed(0)} B/entity`,
    });
  }

  const queryBytes = scene.buffers?.queryResults?.byteLength || 0;
  const querySystem = scene.querySystem;
  if (queryBytes > 0) {
    const capacity = querySystem?.queryEntityCapacity || N || MAX_ENTITIES;
    const numQueries = querySystem?.getPrecomputedQueryCount?.() || 0;
    const fullCapBytes = calculateQueryResultsSABSize(numQueries || 1, MAX_ENTITIES);
    const scaledBytes = calculateQueryResultsSABSize(numQueries || 1, capacity);
    const savedVsMax =
      numQueries > 0 ? Math.max(0, fullCapBytes - scaledBytes) : 0;
    insights.push({
      key: 'queryResults',
      bytes: queryBytes,
      formatted: formatBytes(queryBytes),
      detail: `${numQueries} queries × ${QUERY_SNAPSHOT_COUNT} snapshots × ${getQuerySnapshotElements(capacity)} u16 (cap ${capacity}); saved vs 65535-wide: ${formatBytes(savedVsMax)}`,
      savedVsMaxBytes: savedVsMax,
    });
  }

  return insights;
}
