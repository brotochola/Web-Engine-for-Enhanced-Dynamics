/**
 * Create-time extras sidecar and the old spawnBatch queue (kernel baseline).
 * xy-only configs stay on Transform / the SAB spawn ring. Non-xy configs ride
 * one extras clone on the drain ack. Queue helpers stay for microbench A.
 */

export function isXyOnlySpawnConfig(config) {
  if (config == null) return true;
  for (const key in config) {
    if (key === 'x' || key === 'y' || key === 'forceProcessOnLogicWorker') continue;
    return false;
  }
  return true;
}

export function createCreateSpawnQueue(initialCap = 256) {
  const cap = initialCap | 0 || 256;
  return {
    n: 0,
    cap,
    idx: new Int32Array(cap),
    worker: new Int32Array(cap),
    className: new Array(cap),
    config: new Array(cap),
  };
}

export function growCreateSpawnQueue(queue, minCap) {
  let next = queue.cap;
  const need = minCap | 0;
  if (next >= need) return queue;
  while (next < need) next *= 2;
  const idx = new Int32Array(next);
  idx.set(queue.idx.subarray(0, queue.n));
  const worker = new Int32Array(next);
  worker.set(queue.worker.subarray(0, queue.n));
  const className = new Array(next);
  const config = new Array(next);
  for (let i = 0; i < queue.n; i++) {
    className[i] = queue.className[i];
    config[i] = queue.config[i];
  }
  queue.idx = idx;
  queue.worker = worker;
  queue.className = className;
  queue.config = config;
  queue.cap = next;
  return queue;
}

export function pushCreateSpawn(queue, entityIndex, className, spawnConfig, workerIndex) {
  if (queue.n === queue.cap) growCreateSpawnQueue(queue, queue.cap * 2);
  const i = queue.n;
  queue.idx[i] = entityIndex;
  queue.worker[i] = workerIndex;
  queue.className[i] = className;
  queue.config[i] = isXyOnlySpawnConfig(spawnConfig) ? null : spawnConfig;
  queue.n = i + 1;
}

export function clearCreateSpawnQueue(queue) {
  const n = queue.n;
  for (let i = 0; i < n; i++) {
    queue.className[i] = null;
    queue.config[i] = null;
  }
  queue.n = 0;
}

/** Sidecar for create() flush. xy-only does not clone a config. */
export function pushCreateSpawnExtra(extras, entityIndex, className, spawnConfig) {
  if (isXyOnlySpawnConfig(spawnConfig)) return false;
  extras.push({ entityIndex, className, spawnConfig });
  return true;
}

/** Extras from the old index queue — kernel / tests only. */
export function collectCreateSpawnExtras(queue) {
  const extras = [];
  for (let i = 0; i < queue.n; i++) {
    if (queue.config[i] != null) {
      extras.push({
        entityIndex: queue.idx[i],
        className: queue.className[i],
        spawnConfig: queue.config[i],
      });
    }
  }
  return extras;
}

/**
 * One payload per logic worker. entityIndex buffers are transferable.
 * @returns {Array<{ workerIndex: number, groups: object[], transfers: ArrayBuffer[] }>}
 */
export function buildSpawnBatchPayloads(queue) {
  const n = queue.n;
  if (n === 0) return [];

  const byWorker = new Map();
  for (let i = 0; i < n; i++) {
    const w = queue.worker[i];
    const c = queue.className[i];
    let rec = byWorker.get(w);
    if (!rec) {
      rec = { classOrder: [], counts: new Map(), hasExtras: new Map() };
      byWorker.set(w, rec);
    }
    if (!rec.counts.has(c)) {
      rec.classOrder.push(c);
      rec.counts.set(c, 0);
      rec.hasExtras.set(c, false);
    }
    rec.counts.set(c, rec.counts.get(c) + 1);
    if (queue.config[i] != null) rec.hasExtras.set(c, true);
  }

  const payloads = [];
  for (const [workerIndex, rec] of byWorker) {
    const write = new Map();
    const groups = [];
    for (let c = 0; c < rec.classOrder.length; c++) {
      const className = rec.classOrder[c];
      const count = rec.counts.get(className);
      const group = {
        className,
        entityIndex: new Int32Array(count),
      };
      if (rec.hasExtras.get(className)) group.spawnConfigs = new Array(count);
      write.set(className, { group, n: 0 });
      groups.push(group);
    }
    for (let i = 0; i < n; i++) {
      if (queue.worker[i] !== workerIndex) continue;
      const slot = write.get(queue.className[i]);
      const k = slot.n++;
      slot.group.entityIndex[k] = queue.idx[i];
      if (slot.group.spawnConfigs) slot.group.spawnConfigs[k] = queue.config[i];
    }
    const transfers = [];
    for (let g = 0; g < groups.length; g++) {
      transfers.push(groups[g].entityIndex.buffer);
    }
    payloads.push({ workerIndex, groups, transfers });
  }
  return payloads;
}
