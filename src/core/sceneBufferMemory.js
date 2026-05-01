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
    componentAllocations[componentName] = {
      bytes: buffer.byteLength,
      formatted: formatBytes(buffer.byteLength),
      capacity: getComponentPoolCapacity(scene, componentName),
      entityTypeCount: usage.entityTypeCount,
      entityPoolSlots: usage.entityPoolSlots,
    };
  }

  return {
    ...summary,
    componentAllocations,
  };
}
