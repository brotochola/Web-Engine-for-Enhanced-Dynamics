/**
 * CR-19: an ARRAY_SCHEMA laid out in a buffer, the walk Component and SharedResource each wrote twice (once to size the
 * buffer, once to bind it). Each column starts at the next multiple of its element size and holds count * length
 * elements; with a buffer, bind(name, view, entry) receives each column's view.
 * @param {Object} schema field name -> a TypedArray constructor or a spec entryOf resolves
 * @param {(spec: any) => { type: Function, length: number }} entryOf
 * @param {number} count elements per unit length (a component's instances; 1 for a shared resource)
 * @param {number} offset the first column's earliest byte
 * @param {ArrayBufferLike | null} buffer null to size only
 * @param {((name: string, view: ArrayBufferView, entry: object) => void) | null} bind
 * @returns {number} the byte past the last column
 */
export function laySchema(schema, entryOf, count, offset, buffer, bind) {
  for (const name of Object.keys(schema)) {
    const entry = entryOf(schema[name]);
    const type = entry.type;
    const bytes = type.BYTES_PER_ELEMENT;
    const remainder = offset % bytes;
    if (remainder !== 0) offset += bytes - remainder;
    const elements = count * entry.length;
    if (buffer !== null) bind(name, new type(buffer, offset, elements), entry);
    offset += elements * bytes;
  }
  return offset;
}
