/**
 * Which pre-render worker owns an entity, and how list slices / queue prefixes line up.
 * Entity blocks stay on one worker so local animation state does not reset.
 * List slices are for particles, decorations, bullets, liquidfun, and the light list.
 */

/**
 * @param {number} entityIndex
 * @param {number} workerIndex
 * @param {number} workerCount
 * @param {number} blockSize
 * @returns {boolean}
 */
export function ownsEntity(entityIndex, workerIndex, workerCount, blockSize) {
  const n = workerCount | 0;
  if (n <= 1) return true;
  const block = (blockSize | 0) > 0 ? (blockSize | 0) : 256;
  const id = entityIndex | 0;
  return (((id / block) | 0) % n) === (workerIndex | 0);
}

/**
 * Contiguous range of a packed list. N=1 is the whole list.
 * @param {number} count
 * @param {number} workerIndex
 * @param {number} workerCount
 * @returns {{ start: number, end: number }}
 */
export function listSlice(count, workerIndex, workerCount) {
  const n = workerCount | 0;
  const c = count | 0;
  if (n <= 1) return { start: 0, end: c < 0 ? 0 : c };
  const i = workerIndex | 0;
  const len = c < 0 ? 0 : c;
  const start = ((len * i) / n) | 0;
  const end = ((len * (i + 1)) / n) | 0;
  return { start, end };
}

/**
 * True when the owned-id cache was built for this published query frame.
 * @param {number} cachedStamp
 * @param {number} publishedFrame
 * @returns {boolean}
 */
export function ownedStampMatches(cachedStamp, publishedFrame) {
  return (cachedStamp | 0) === (publishedFrame | 0);
}

/**
 * Pack entity ids this worker owns into dest. Returns the packed count.
 * Caller grows dest so it is at least srcLen.
 * @param {ArrayLike<number>} src
 * @param {number} srcLen
 * @param {Uint32Array} dest
 * @param {number} workerIndex
 * @param {number} workerCount
 * @param {number} blockSize
 * @returns {number}
 */
export function fillOwnedIds(src, srcLen, dest, workerIndex, workerCount, blockSize) {
  let n = 0;
  const len = srcLen | 0;
  for (let i = 0; i < len; i++) {
    const id = src[i];
    if (!ownsEntity(id, workerIndex, workerCount, blockSize)) continue;
    dest[n++] = id;
  }
  return n;
}

/**
 * Sum of counts[0..workerIndex). Deterministic queue offset.
 * @param {ArrayLike<number>} counts
 * @param {number} workerIndex
 * @returns {number}
 */
export function prefixAt(counts, workerIndex) {
  const n = workerIndex | 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += counts[i] | 0;
  return sum;
}

/**
 * @param {ArrayLike<number>} counts
 * @param {number} workerCount
 * @returns {number}
 */
export function sumCounts(counts, workerCount) {
  const n = workerCount | 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += counts[i] | 0;
  return sum;
}

/** Int32 join SAB: two barriers + the start epoch, then per-stream counts. */
export const PR_JOIN_ARRIVED_A = 0;
export const PR_JOIN_EPOCH_A = 1;
export const PR_JOIN_ARRIVED_B = 2;
export const PR_JOIN_EPOCH_B = 3;
export const PR_JOIN_START = 4;
export const PR_JOIN_POSE = 5;
export const PR_JOIN_HEADER = 6;

export const PR_STREAM_SPRITE = 0;
export const PR_STREAM_SHADOW = 1;
export const PR_STREAM_VP = 2;
export const PR_STREAM_SELF_LIT = 3;
export const PR_STREAM_LIGHTS = 4;
export const PR_STREAM_CUSTOM0 = 5;
export const PR_CUSTOM_STREAMS = 16;

export function preRenderStreamCount() {
  return PR_STREAM_CUSTOM0 + PR_CUSTOM_STREAMS;
}

/**
 * @param {number} workerCount
 * @returns {number} Int32 slots
 */
export function preRenderJoinWords(workerCount) {
  const n = workerCount | 0;
  return PR_JOIN_HEADER + preRenderStreamCount() * (n > 0 ? n : 1);
}

/**
 * @param {number} stream
 * @param {number} workerIndex
 * @param {number} workerCount
 * @returns {number}
 */
export function preRenderCountSlot(stream, workerIndex, workerCount) {
  return PR_JOIN_HEADER + (stream | 0) * (workerCount | 0) + (workerIndex | 0);
}
