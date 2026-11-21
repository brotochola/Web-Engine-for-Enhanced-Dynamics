// A save's entity table (E-539) from plain values, for tests that build a payload by hand:
//
//   entityTable('Crate', [7, 9], { Health: { fingerprint: 3, fields: { hp: Float32Array.of(1, 2) } } })
//
// Each field's values hold every listed entity's, in the indices' order; its length (elements per entity) is
// values.length / indices.length. `entityId` names the fields that hold entity ids.

/**
 * @param {string} typeName
 * @param {ArrayLike<number>} indices
 * @param {Record<string, { fingerprint?: number, entityId?: string[], fields?: Record<string, ArrayBufferView> }>} [components]
 */
export function entityTable(typeName, indices, components = {}) {
  const idx = Uint32Array.from(indices);
  return {
    typeName,
    indices: idx,
    components: Object.entries(components).map(([name, c]) => ({
      name,
      fingerprint: c.fingerprint ?? null,
      fields: Object.entries(c.fields || {}).map(([field, values]) => ({
        name: field,
        length: idx.length ? values.length / idx.length : 1,
        entityId: (c.entityId || []).includes(field),
        values,
      })),
    })),
  };
}

/** The values of `field` of component `component` in table `table`, or undefined. */
export function tableField(table, component, field) {
  const c = table.components.find((x) => x.name === component);
  const f = c && c.fields.find((x) => x.name === field);
  return f ? f.values : undefined;
}
