// LiquidFun save helpers: typed-array snapshots for SaveGame (binary codec owns wire bytes).

/**
 * Pass through a live physics snapshot as a logical liquidFun payload (typed arrays).
 * @param {object|null} snap from weedjsSnapshotLiquidFun
 */
export function packLiquidFunSnapshot(snap) {
  if (!snap || !(snap.count > 0)) {
    return null;
  }
  return {
    count: snap.count | 0,
    radius: snap.radius,
    maxCount: snap.maxCount | 0,
    x: snap.x,
    y: snap.y,
    vx: snap.vx,
    vy: snap.vy,
    flags: snap.flags,
    groupIndex: snap.groupIndex || null,
    restOffset: snap.restOffset || null,
    groups: snap.groups && snap.groups.slotCount > 0 ? snap.groups : null,
    pairs: snap.pairs && snap.pairs.count > 0 ? snap.pairs : null,
    render: snap.render || null,
    groupsLightIntensity: snap.groupsLightIntensity || null,
  };
}

/**
 * Normalize liquidFun blob for weedjsRestoreLiquidFun (already typed arrays after binary decode).
 * @param {object|null} blob
 */
export function unpackLiquidFunSnapshot(blob) {
  if (!blob || !(blob.count > 0)) {
    return {
      count: 0,
      x: new Float32Array(0),
      y: new Float32Array(0),
      vx: new Float32Array(0),
      vy: new Float32Array(0),
      flags: new Uint32Array(0),
      groupIndex: null,
      restOffset: null,
      groups: null,
      pairs: null,
      render: null,
      groupsLightIntensity: null,
    };
  }
  return blob;
}

let _lfRequestSeq = 1;

/**
 * Ask the physics worker for a LiquidFun HEAP+render snapshot.
 * @param {Worker} physicsWorker
 * @param {number} [timeoutMs]
 */
export function requestLiquidFunSnapshot(physicsWorker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!physicsWorker) {
      resolve(null);
      return;
    }
    const requestId = _lfRequestSeq++;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('LiquidFun snapshot timeout'));
    }, timeoutMs);

    function onMessage(e) {
      if (!e?.data || e.data.msg !== 'liquidFunSnapshot') return;
      if ((e.data.requestId | 0) !== requestId) return;
      cleanup();
      resolve(e.data.snapshot || null);
    }
    function cleanup() {
      clearTimeout(timer);
      physicsWorker.removeEventListener('message', onMessage);
    }
    physicsWorker.addEventListener('message', onMessage);
    physicsWorker.postMessage({ msg: 'snapshotLiquidFun', requestId });
  });
}

/**
 * Push a liquidFun typed-array blob to the physics worker for restore.
 * @param {Worker} physicsWorker
 * @param {object} payload unpacked snapshot (typed arrays)
 * @param {number} [timeoutMs]
 */
export function requestLiquidFunRestore(physicsWorker, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!physicsWorker) {
      resolve({ ok: false, reason: 'no-worker' });
      return;
    }
    const requestId = _lfRequestSeq++;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('LiquidFun restore timeout'));
    }, timeoutMs);

    function onMessage(e) {
      if (!e?.data || e.data.msg !== 'liquidFunRestoreComplete') return;
      if ((e.data.requestId | 0) !== requestId) return;
      cleanup();
      resolve(e.data.result || { ok: false });
    }
    function cleanup() {
      clearTimeout(timer);
      physicsWorker.removeEventListener('message', onMessage);
    }

    const transfer = [];
    const pushBuf = (a) => {
      if (a && a.buffer) transfer.push(a.buffer);
    };
    pushBuf(payload?.x);
    pushBuf(payload?.y);
    pushBuf(payload?.vx);
    pushBuf(payload?.vy);
    pushBuf(payload?.flags);
    pushBuf(payload?.groupIndex);
    pushBuf(payload?.restOffset);
    if (payload?.groups) {
      for (const k of Object.keys(payload.groups)) pushBuf(payload.groups[k]);
    }
    if (payload?.pairs) {
      for (const k of Object.keys(payload.pairs)) pushBuf(payload.pairs[k]);
    }
    if (payload?.render) {
      for (const k of Object.keys(payload.render)) pushBuf(payload.render[k]);
    }
    pushBuf(payload?.groupsLightIntensity);
    physicsWorker.addEventListener('message', onMessage);
    physicsWorker.postMessage({ msg: 'restoreLiquidFun', requestId, payload }, transfer);
  });
}
