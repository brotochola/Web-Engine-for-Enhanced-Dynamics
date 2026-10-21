// A saved tween slot: [field, codec type], in saved order. The field names are
// Tween's own arrays. worldBufferSave copies slot <-> record with it and the
// TWEENS2 writer/reader in binarySaveCodec walk it, so a field is added in one
// place (plus a TWEENS2_LAYOUT bump for old saves). No imports.

export const TWEEN_RECORD_FIELDS = Object.freeze([
  Object.freeze(['kind', 'u8']),
  Object.freeze(['ease', 'u8']),
  Object.freeze(['mask', 'u8']),
  Object.freeze(['entity', 'u32']),
  Object.freeze(['duration', 'f32']),
  Object.freeze(['elapsed', 'f32']),
  Object.freeze(['from0', 'f32']),
  Object.freeze(['to0', 'f32']),
  Object.freeze(['from1', 'f32']),
  Object.freeze(['to1', 'f32']),
  Object.freeze(['from2', 'f32']),
  Object.freeze(['to2', 'f32']),
  Object.freeze(['from3', 'f32']),
  Object.freeze(['to3', 'f32']),
  Object.freeze(['tintFrom', 'u32']),
  Object.freeze(['tintTo', 'u32']),
]);

/**
 * A record value as its codec type stores it: f32 NaN or missing is 0, u32 is
 * unsigned, u8 is an integer.
 * @param {string} type
 * @param {*} value
 * @returns {number}
 */
export function tweenFieldValue(type, value) {
  if (type === 'f32') return +value || 0;
  if (type === 'u32') return value >>> 0;
  return value | 0;
}
