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
