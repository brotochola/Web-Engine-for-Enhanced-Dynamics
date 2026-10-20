// FNV-1a, 32-bit, over a string. The save's schema fingerprints (component
// classes, shared resources) are this hash of a canonical schema string.

/**
 * @param {string} s
 * @returns {number} unsigned 32-bit hash
 */
export function fnv1a32(s) {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
