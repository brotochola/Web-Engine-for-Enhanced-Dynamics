// SharedResource — one SAB of world data per class (not SoA × entityCount).
// Scene declares the schema; this class is the name + optional helpers.
// Unmarked fields: raw TypedArray, one writer. Pin with forceProcessOnLogicWorker.
// atomic: true / mailbox: true: integer mailbox object (add/load/store/exchange/
// compareExchange). Raw TypedArray on mailbox.view. No FieldView. No [] intercept.
// Workers bind after the scene module import.

const TYPED_ARRAYS = Object.freeze({
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
});

const ATOMIC_TYPES = new Set([
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  BigInt64Array,
  BigUint64Array,
]);

/** @type {Function[]} */
const live = [];

/** Integer SAB mailbox. Index last; default 0. */
export class SharedResourceMailbox {
  /**
   * @param {Int8Array|Uint8Array|Int16Array|Uint16Array|Int32Array|Uint32Array|BigInt64Array|BigUint64Array} view
   */
  constructor(view) {
    this.view = view;
    this.length = view.length;
  }

  add(delta, index = 0) {
    return Atomics.add(this.view, index | 0, delta);
  }

  load(index = 0) {
    return Atomics.load(this.view, index | 0);
  }

  store(value, index = 0) {
    return Atomics.store(this.view, index | 0, value);
  }

  exchange(value, index = 0) {
    return Atomics.exchange(this.view, index | 0, value);
  }

  compareExchange(expected, replacement, index = 0) {
    return Atomics.compareExchange(this.view, index | 0, expected, replacement);
  }
}

export class SharedResource {
  static sharedBuffer = null;
  static _fieldNames = null;
  static _schema = null;

  /**
   * Resolve a schema entry: TypedArray ctor, ctor name, or `{ type, length, atomic|mailbox }`.
   * Bare ctor / name → length 1, not a mailbox.
   * @returns {{ type: Function, length: number, atomic: boolean }}
   */
  static _schemaEntry(typeOrSpec) {
    if (typeOrSpec && typeof typeOrSpec === 'object' && typeOrSpec.type) {
      return {
        type: SharedResource._resolveType(typeOrSpec.type),
        length: Math.max(0, typeOrSpec.length | 0) || 1,
        atomic: typeOrSpec.atomic === true || typeOrSpec.mailbox === true,
      };
    }
    return { type: SharedResource._resolveType(typeOrSpec), length: 1, atomic: false };
  }

  static _resolveType(typeOrName) {
    if (typeof typeOrName === 'function' && typeOrName.BYTES_PER_ELEMENT) {
      return typeOrName;
    }
    if (typeof typeOrName === 'string' && TYPED_ARRAYS[typeOrName]) {
      return TYPED_ARRAYS[typeOrName];
    }
    throw new TypeError(
      `SharedResource: unknown typed array ${typeOrName && typeOrName.name ? typeOrName.name : typeOrName}`,
    );
  }

  static _assertAtomicType(name, type, atomic) {
    if (!atomic) return;
    if (!ATOMIC_TYPES.has(type)) {
      throw new TypeError(
        `SharedResource: field "${name}" atomic:true needs an integer TypedArray (Atomics), got ${type.name}`,
      );
    }
  }

  static _validateSchema(schema) {
    for (const [name, spec] of Object.entries(schema)) {
      const { type, atomic } = SharedResource._schemaEntry(spec);
      SharedResource._assertAtomicType(name, type, atomic);
    }
  }

  /**
   * Structured-cloneable schema (type names, not ctors) for worker init.
   * @param {Object} schema
   */
  static serializeSchema(schema) {
    SharedResource._validateSchema(schema);
    const out = {};
    for (const [name, spec] of Object.entries(schema)) {
      const { type, length, atomic } = SharedResource._schemaEntry(spec);
      out[name] = atomic
        ? { type: type.name, length, atomic: true }
        : { type: type.name, length };
    }
    return out;
  }

  /**
   * @param {Object} schema
   * @returns {number} bytes, aligned per field
   */
  static getBufferSize(schema) {
    SharedResource._validateSchema(schema);
    let offset = 0;
    for (const spec of Object.values(schema)) {
      const { type, length } = SharedResource._schemaEntry(spec);
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) offset += bytesPerElement - remainder;
      offset += length * bytesPerElement;
    }
    return offset > 0 ? offset : 1;
  }

  /**
   * Bind this class's fields to a SAB. Same schema on every thread.
   * Unmarked fields are TypedArrays. Mailbox fields are SharedResourceMailbox.
   * @param {SharedArrayBuffer} buffer
   * @param {Object} schema
   */
  static initialize(buffer, schema) {
    this.reset();
    if (!buffer || !schema) return;
    SharedResource._validateSchema(schema);
    this.sharedBuffer = buffer;
    this._schema = schema;
    this._fieldNames = [];

    let offset = 0;
    for (const [name, spec] of Object.entries(schema)) {
      const { type, length, atomic } = SharedResource._schemaEntry(spec);
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) offset += bytesPerElement - remainder;
      const view = new type(buffer, offset, length);
      this[name] = atomic ? new SharedResourceMailbox(view) : view;
      this._fieldNames.push(name);
      offset += length * bytesPerElement;
    }

    if (live.indexOf(this) < 0) live.push(this);
  }

  /** Drop views so a later scene cannot read stale arrays. */
  static reset() {
    const names = this._fieldNames;
    if (names) {
      for (let i = 0; i < names.length; i++) this[names[i]] = null;
    }
    this._fieldNames = null;
    this._schema = null;
    this.sharedBuffer = null;
  }

  static resetAll() {
    for (let i = 0; i < live.length; i++) live[i].reset();
    live.length = 0;
  }

  /**
   * Scene.static.sharedResources rows → `{ class, name, schema, scriptUrl }[]`.
   * Each row is `[Class, schema]`.
   */
  static parseRows(rows) {
    const out = [];
    if (!rows || !rows.length) return out;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length < 2) {
        throw new TypeError(
          'Scene.sharedResources rows must be [SharedResourceClass, schema]',
        );
      }
      const ResourceClass = row[0];
      const schema = row[1];
      if (typeof ResourceClass !== 'function') {
        throw new TypeError('Scene.sharedResources: first slot must be a class');
      }
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new TypeError(`SharedResource ${ResourceClass.name}: schema must be an object`);
      }
      SharedResource.getBufferSize(schema);
      out.push({
        class: ResourceClass,
        name: ResourceClass.name,
        schema,
        scriptUrl: ResourceClass.scriptUrl || null,
      });
    }
    return out;
  }

  /**
   * Worker: bind `{ name, sab, schema, scriptUrl }` onto `globalRef[name]` after scene import.
   * Missing class is a hard fail: one writer per field only works if the class loaded.
   */
  static bindFromInit(recs, globalRef = globalThis) {
    if (!recs) return;
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const C = globalRef[rec.name];
      if (!C || typeof C.initialize !== 'function') {
        if (rec.scriptUrl) {
          throw new Error(
            `SharedResource: class ${rec.name} not loaded after scriptUrl ${rec.scriptUrl}`,
          );
        }
        throw new Error(`SharedResource: class ${rec.name} not loaded`);
      }
      C.initialize(rec.sab, rec.schema);
    }
  }
}
