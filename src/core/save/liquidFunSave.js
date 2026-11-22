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
    userData: snap.userData || null,
    color: snap.color || null,
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
      userData: null,
      color: null,
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
  if (!physicsWorker) return Promise.resolve(null);
  return askPhysicsWorker(physicsWorker, { msg: 'snapshotLiquidFun' }, 'liquidFunSnapshot', timeoutMs, 'LiquidFun snapshot timeout')
    .then((data) => data.snapshot || null);
}

/**
 * Post `message` (with a new requestId) to the physics worker and resolve with the data of its `replyMsg` for that id,
 * or reject with `timeoutText` after timeoutMs (N-303 CR-24: one skeleton for the snapshot and the restore).
 */
function askPhysicsWorker(physicsWorker, message, replyMsg, timeoutMs, timeoutText, transfer = []) {
  return new Promise((resolve, reject) => {
    const requestId = _lfRequestSeq++;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutText));
    }, timeoutMs);
    function onMessage(e) {
      if (!e?.data || e.data.msg !== replyMsg) return;
      if ((e.data.requestId | 0) !== requestId) return;
      cleanup();
      resolve(e.data);
    }
    function cleanup() {
      clearTimeout(timer);
      physicsWorker.removeEventListener('message', onMessage);
    }
    physicsWorker.addEventListener('message', onMessage);
    physicsWorker.postMessage({ ...message, requestId }, transfer);
  });
}

/**
 * Push a liquidFun typed-array blob to the physics worker for restore.
 * @param {Worker} physicsWorker
 * @param {object} payload unpacked snapshot (typed arrays)
 * @param {number} [timeoutMs]
 */
export function requestLiquidFunRestore(physicsWorker, payload, timeoutMs = 5000) {
  if (!physicsWorker) return Promise.resolve({ ok: false, reason: 'no-worker' });
  const transfer = [];
  const pushBuf = (a) => {
    if (a && a.buffer) transfer.push(a.buffer);
  };
  pushBuf(payload?.x);
  pushBuf(payload?.y);
  pushBuf(payload?.vx);
  pushBuf(payload?.vy);
  pushBuf(payload?.flags);
  pushBuf(payload?.userData);
  pushBuf(payload?.color);
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
  return askPhysicsWorker(physicsWorker, { msg: 'restoreLiquidFun', payload }, 'liquidFunRestoreComplete', timeoutMs,
    'LiquidFun restore timeout', transfer).then((data) => data.result || { ok: false });
}
