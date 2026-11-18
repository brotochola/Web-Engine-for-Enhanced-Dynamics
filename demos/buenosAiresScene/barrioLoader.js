// barrioLoader.js: the only file that knows the Editor de Barrios' package (docs/internal/DX_BARRIOS_DESIGN.md, "The
// package"): meta.js's packageFormat, the scene file and the gzipped binaries. It spawns through the functions the scene
// hands it and holds no engine code, so it runs in Node tests. When the visual editor's loadScene reaches main, the demo
// moves to loadScene('…/parquechas.scene.json') and this file goes.
//
// The scene file is format 1 of the visual editor's sceneFile.js (format, script, export, entities with name, class, x, y,
// rotation, config; decorations as records of flat arrays, one value per decoration; keys it does not know are kept),
// with four extensions:
//
//   1. A decoration record may also hold scaleX, scaleY, skewX, skewY, sortOffsetY, innerZ, faceNormalX, faceNormalY,
//      faceNormalZ, faceHeight, anchorX, anchorY and sway (0 or 1): one value per decoration each, as x and y.
//   2. `textures`: the record's own palette of texture names; its `frame` array indexes it. A name is the atlas's
//      (caras0_t0_0_0, _white), a frame of the sheet its decoration class names (`sheet`), or a name the class resolves
//      itself (`perTexture`: the standard objects).
//   3. `prefabs`: name → { class, config, children, decorations }, everything relative to the entity's position. An entity
//      with "prefab" takes its class (unless it names one), its config (its own keys win), its children and decorations
//      (its own are added). A record with "attached": true hangs from the entity (its x, y are localX, localY); any other
//      is a world decoration, placed once at load at the entity's position plus its x, y (not turned).
//   4. `parent` on an entity: another entity's name in the file. A prefab's `children` are entity records placed
//      relative to their entity (turned by its rotation) and linked to it.
//
// A record's scaleX and scaleY, when it has them, are the decoration's scale (a flipped one is negative); a class's own
// scale (an object's) is the scale of the records that give none.
//
// What the scene gives loadBarrio (options):
//   classes            name → (config, context) => entity index. It spawns one entity record (or makes it a decoration,
//                      or keeps it for later) and returns the entity's index, -1 for none. config holds x, y, the record's
//                      rotation, scaleX and scaleY when it has them, its config keys, `parent`, `localX` and `localY` for
//                      a linked entity, and `decor` (its attached decorations, for attachDecorations in its onSpawned).
//   decorations        decoration class → its settings: what Decoration.spawn takes, shared by the class (anchorX,
//                      layer, sway…; a { min, max } range is drawn per decoration), and the loader's own keys: `sheet`,
//                      `texture` (for records without a palette), `perTexture` (name → the settings of the decorations
//                      with that name, `texture` included), `hidden` (alpha 0 at spawn whatever the record says) and
//                      `keep` (their pool indices are listed in the result, by class).
//   spawnDecorations   (config) => count: Decoration.spawnMany.
//   spawnDecoration    (config) => pool index or -1: Decoration.spawn, for records spawnMany cannot take whole.
//   random             () => [0, 1), for the ranges.
//   warn               (message) => void; each kind of problem is told once.
//   onProgress, pause, sliceMs: progress (done, total) and a yield (a 0 ms timeout) every sliceMs ms of work, so the
//                      page can draw its loading bar.

export const PACKAGE_FORMAT = 1;
export const SCENE_FORMAT = 1;

/** The arrays DecorationPool.spawnMany takes, one value per decoration (innerZ: DX-FACEDEPTH). */
const SPAWN_MANY_KEYS = Object.freeze([
  'scaleX', 'scaleY', 'rotation', 'alpha', 'tint', 'sortOffsetY', 'skewX', 'skewY',
  'faceNormalX', 'faceNormalY', 'faceNormalZ', 'faceHeight', 'innerZ',
]);
/** Arrays spawnMany does not take: a record with one spawns one decoration at a time. */
const ONE_AT_A_TIME_KEYS = Object.freeze(['anchorX', 'anchorY', 'swayAmplitude', 'swayFrequency']);
/** Every per-decoration array a record may hold besides x, y and frame (`scale` is format 1's: both axes). */
const VALUE_KEYS = Object.freeze([...SPAWN_MANY_KEYS, 'anchorX', 'anchorY', 'sway', 'scale']);
/** A decoration class's keys that are the loader's, not Decoration.spawn's. */
const LOADER_KEYS = new Set(['sheet', 'texture', 'perTexture', 'hidden', 'keep']);
/** Settings whose { min, max } range the loader draws per decoration (spawn draws none of these itself). */
const DRAWN_KEYS = Object.freeze(['rotation', 'tint', 'swayAmplitude', 'swayFrequency', 'scaleX', 'scaleY', 'alpha']);
/** Keys attachDecorations passes as addDecoration's own arguments, so never in its `extra`. */
const ADD_DECORATION_ARGUMENTS = new Set(['texture', 'scaleX', 'scaleY', 'innerZ', 'x', 'y', 'parent', 'localX', 'localY']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isRange = (value) => isObject(value) && isNumber(value.min) && isNumber(value.max);
const isList = (value) => Array.isArray(value) || ArrayBuffer.isView(value);

// ---- the package ----

/** meta.js's META, checked: the package format this demo reads. Throws an Error that names the file. */
export function checkPackageMeta(meta, where = 'meta.js') {
  const format = isObject(meta) ? meta.packageFormat : undefined;
  if (format !== PACKAGE_FORMAT) {
    throw new Error(
      `${where}: package format ${JSON.stringify(format)}: this demo reads the Editor de Barrios' package format ` +
        `${PACKAGE_FORMAT} (export the barrio again)`,
    );
  }
  return meta;
}

/** Whether bytes start a gzip stream (its magic number, 1f 8b). */
export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * A package binary's bytes, inflated (DecompressionStream, as the engine opens a gzipped flowfield). Bytes that are not
 * gzip come back as they are: a server that sends a .gz with Content-Encoding: gzip has opened it already.
 * @param {ArrayBuffer|ArrayBufferView} source
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(source) {
  const bytes = source instanceof Uint8Array
    ? source
    : ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('the package is gzipped and this browser has no DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fetch a package binary (piso.bin.gz, transito.bin.gz) and inflate it. */
export async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return gunzip(await response.arrayBuffer());
}

/** Fetch, parse and check the package's scene file. */
export async function fetchBarrioScene(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return parseBarrioScene(await response.text(), url);
}

// ---- the scene file ----

/** Parse and check a scene file's text (format 1 and the extensions). Throws an Error naming the file and the place. */
export function parseBarrioScene(text, where = 'scene file') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${error.message}`);
  }
  return checkBarrioScene(doc, where);
}

/** Check a parsed scene file and return it, with `entities`, `prefabs` and `decorations` filled in when left out. */
export function checkBarrioScene(doc, where = 'scene file') {
  if (!isObject(doc)) throw new Error(`${where} must hold a JSON object`);
  if (doc.format !== SCENE_FORMAT) {
    throw new Error(`${where}: scene file format ${JSON.stringify(doc.format)}: this demo reads format ${SCENE_FORMAT}`);
  }
  if (doc.entities === undefined) doc.entities = [];
  if (doc.prefabs === undefined) doc.prefabs = {};
  if (doc.decorations === undefined) doc.decorations = [];
  if (!Array.isArray(doc.entities)) throw new Error(`${where}: "entities" must be an array`);
  if (!isObject(doc.prefabs)) throw new Error(`${where}: "prefabs" must be an object (name → prefab)`);
  if (!Array.isArray(doc.decorations)) throw new Error(`${where}: "decorations" must be an array`);
  for (const [name, prefab] of Object.entries(doc.prefabs)) checkPrefab(prefab, `${where}: prefabs.${name}`, doc.prefabs);
  const names = new Set();
  doc.entities.forEach((entity, position) => {
    const at = `${where}: entities[${position}]`;
    checkEntity(entity, at, doc.prefabs, true);
    if (names.has(entity.name)) throw new Error(`${at}: the name "${entity.name}" is used twice`);
    names.add(entity.name);
  });
  doc.entities.forEach((entity, position) => {
    if (typeof entity.parent === 'string' && !names.has(entity.parent)) {
      throw new Error(`${where}: entities[${position}] (${entity.name}): its parent "${entity.parent}" is no entity of the file`);
    }
  });
  checkDecorations(doc.decorations, where, false);
  return doc;
}

function checkPrefab(prefab, at, prefabs) {
  if (!isObject(prefab)) throw new Error(`${at} must be an object`);
  if (prefab.class !== undefined && (typeof prefab.class !== 'string' || prefab.class === '')) {
    throw new Error(`${at}: "class" must be a name`);
  }
  if (prefab.config !== undefined && !isObject(prefab.config)) throw new Error(`${at}: "config" must be an object`);
  checkDecorations(prefab.decorations, at, true);
  if (prefab.children === undefined) return;
  if (!Array.isArray(prefab.children)) throw new Error(`${at}: "children" must be an array`);
  prefab.children.forEach((child, position) => checkEntity(child, `${at}.children[${position}]`, prefabs, false));
}

function checkEntity(entity, at, prefabs, mustHaveName) {
  if (!isObject(entity)) throw new Error(`${at} must be an object`);
  if (mustHaveName && (typeof entity.name !== 'string' || entity.name === '')) throw new Error(`${at} needs a "name"`);
  const label = entity.name ? `${at} (${entity.name})` : at;
  if (entity.prefab !== undefined && !Object.prototype.hasOwnProperty.call(prefabs, entity.prefab)) {
    throw new Error(`${label}: there is no prefab "${entity.prefab}"`);
  }
  const className = entity.class ?? (entity.prefab !== undefined ? prefabs[entity.prefab].class : undefined);
  if (typeof className !== 'string' || className === '') throw new Error(`${label} needs a "class" (its own or its prefab's)`);
  if (!isNumber(entity.x) || !isNumber(entity.y)) throw new Error(`${label}: "x" and "y" must be numbers`);
  for (const key of ['rotation', 'scaleX', 'scaleY']) {
    if (entity[key] !== undefined && !isNumber(entity[key])) throw new Error(`${label}: "${key}" must be a number`);
  }
  if (entity.config !== undefined && !isObject(entity.config)) throw new Error(`${label}: "config" must be an object`);
  if (entity.parent !== undefined && entity.parent !== null && typeof entity.parent !== 'string') {
    throw new Error(`${label}: "parent" must be another entity's name`);
  }
  checkDecorations(entity.decorations, label, true);
}

function checkDecorations(records, at, mayAttach) {
  if (records === undefined) return;
  if (!Array.isArray(records)) throw new Error(`${at}: "decorations" must be an array`);
  records.forEach((record, position) => checkDecorationRecord(record, `${at}: decorations[${position}]`, mayAttach));
}

function checkDecorationRecord(record, at, mayAttach) {
  if (!isObject(record)) throw new Error(`${at} must be an object`);
  if (typeof record.class !== 'string' || record.class === '') throw new Error(`${at} needs a "class"`);
  const where = `${at} (${record.class})`;
  if (record.attached === true && !mayAttach) throw new Error(`${where}: "attached" needs an entity to hang from`);
  if (!Array.isArray(record.x) || !Array.isArray(record.y)) throw new Error(`${where}: "x" and "y" must be arrays of numbers`);
  const count = record.x.length;
  if (record.y.length !== count) throw new Error(`${where}: "x" has ${count} values and "y" ${record.y.length}`);
  for (const key of ['x', 'y', 'frame', ...VALUE_KEYS]) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${where}: "${key}" must be an array, one value per decoration`);
    if (list.length !== count) throw new Error(`${where}: "${key}" has ${list.length} values and the record ${count} decorations`);
    const bad = list.findIndex((value) => !isNumber(value));
    if (bad >= 0) throw new Error(`${where}: ${key}[${bad}] is ${JSON.stringify(list[bad])}, not a number`);
  }
  const palette = record.textures;
  if (palette !== undefined && (!Array.isArray(palette) || palette.some((name) => typeof name !== 'string' || name === ''))) {
    throw new Error(`${where}: "textures" must be an array of texture names`);
  }
  if (!Array.isArray(record.frame)) return;
  const size = Array.isArray(palette) ? palette.length : Infinity;
  const bad = record.frame.findIndex((frame) => frame < 0 || Math.floor(frame) !== frame || frame >= size);
  if (bad >= 0) throw new Error(`${where}: frame[${bad}] is ${record.frame[bad]}, not an index into its ${size} textures`);
}

/**
 * An entity record with its prefab folded in: its class (its own, else the prefab's), its config (the prefab's, its own
 * keys winning), the prefab's children and decorations (its own decorations after the prefab's).
 */
export function expandEntity(record, prefabs) {
  const prefab = record.prefab !== undefined ? prefabs[record.prefab] : null;
  const config = { ...(prefab && prefab.config ? prefab.config : {}), ...(record.config || {}) };
  const ownDecorations = Array.isArray(record.decorations) ? record.decorations : [];
  const prefabDecorations = prefab && Array.isArray(prefab.decorations) ? prefab.decorations : [];
  const prefabChildren = prefab && Array.isArray(prefab.children) ? prefab.children : [];
  return {
    name: record.name ?? null,
    class: record.class ?? (prefab ? prefab.class : undefined),
    x: record.x,
    y: record.y,
    rotation: isNumber(record.rotation) ? record.rotation : 0,
    scaleX: record.scaleX,
    scaleY: record.scaleY,
    parent: typeof record.parent === 'string' ? record.parent : null,
    config,
    decorations: prefabDecorations.concat(ownDecorations),
    children: prefabChildren.concat(Array.isArray(record.children) ? record.children : []),
  };
}

/**
 * The order to spawn a file's entities in: file order, except that a parent comes before the entities that name it,
 * so a child can be given its parent's index. A link that would close a loop is dropped (`cut`: the child's position).
 * @returns {{ order: number[], cut: Set<number> }}
 */
export function spawnOrder(entities) {
  const positionOf = new Map();
  entities.forEach((entity, position) => positionOf.set(entity.name, position));
  const order = [];
  const cut = new Set();
  const NEW = 0;
  const ON_PATH = 1;
  const PLACED = 2;
  const state = new Uint8Array(entities.length);
  const visit = (position) => {
    state[position] = ON_PATH;
    const parentName = entities[position].parent;
    const parentPosition = typeof parentName === 'string' ? positionOf.get(parentName) : undefined;
    if (parentPosition !== undefined) {
      if (state[parentPosition] === NEW) visit(parentPosition);
      else if (state[parentPosition] === ON_PATH) cut.add(position);
    }
    state[position] = PLACED;
    order.push(position);
  };
  for (let position = 0; position < entities.length; position++) if (state[position] === NEW) visit(position);
  return { order, cut };
}

// ---- decorations ----

/** The atlas name of palette entry `name` for a decoration class: `<sheet>_<name>` when the class names its sheet. */
export function textureName(settings, name) {
  const sheet = settings.sheet;
  if (typeof sheet !== 'string' || sheet === '' || name.startsWith('_') || name.startsWith(`${sheet}_`)) return name;
  return `${sheet}_${name}`;
}

/** A record's palette: its `textures`, else its class's `texture` (a name or a list). */
function paletteOf(record, settings) {
  if (Array.isArray(record.textures)) return record.textures;
  const texture = settings.texture;
  if (typeof texture === 'string') return [texture];
  return Array.isArray(texture) ? texture : [];
}

/** A setting's value: its number, or a draw from its { min, max } (a tint's between its two colours, channel by channel). */
function drawSetting(value, random, key) {
  if (!isRange(value)) return value;
  const t = random();
  if (key !== 'tint') return value.min + t * (value.max - value.min);
  let color = 0;
  for (let shift = 16; shift >= 0; shift -= 8) {
    const from = (value.min >> shift) & 0xff;
    const to = (value.max >> shift) & 0xff;
    color |= Math.round(from + t * (to - from)) << shift;
  }
  return color >>> 0;
}

/**
 * What a decoration class gives each of its decorations, a palette entry's own settings over it: Decoration.spawn's keys
 * (the loader's left out, a `scale` turned into both axes; `texture` kept from the entry's own settings).
 */
function spawnSettings(classSettings, ownSettings = null) {
  const out = {};
  for (const source of ownSettings ? [classSettings, ownSettings] : [classSettings]) {
    for (const key of Object.keys(source)) {
      const keepTexture = source === ownSettings && key === 'texture';
      if (LOADER_KEYS.has(key) && !keepTexture) continue;
      if (key === 'scale') {
        out.scaleX = source.scale;
        out.scaleY = source.scale;
      } else {
        out[key] = source[key];
      }
    }
  }
  return out;
}

/**
 * A record's world decorations, (offsetX, offsetY) added to their positions: one spawnMany call; or one a palette entry,
 * for a class that resolves its names itself (perTexture: each object has its own anchor and scale); or one spawn a
 * decoration when the record holds what spawnMany cannot take as arrays (anchors, sway). Returns how many were spawned.
 */
function spawnWorldRecord(record, classSettings, offsetX, offsetY, load, owner = -1) {
  if (record.x.length === 0) return 0;
  const palette = paletteOf(record, classSettings);
  if (palette.length === 0) {
    load.warnOnce(`decoration class ${record.class}: no texture (no "textures" in the record, no "texture" in the class)`);
    return 0;
  }
  if (isObject(classSettings.perTexture)) {
    let spawned = 0;
    for (const [paletteIndex, positions] of groupsByPaletteEntry(record, load)) {
      const name = palette[paletteIndex];
      const ownSettings = classSettings.perTexture[name];
      if (!isObject(ownSettings) || typeof ownSettings.texture !== 'string') {
        load.warnOnce(`decoration class ${record.class}: "${name}" is not one it knows; those decorations are skipped`);
        continue;
      }
      spawned += spawnGroup(record, spawnSettings(classSettings, ownSettings), positions, offsetX, offsetY, load, classSettings, owner);
    }
    return spawned;
  }
  const settings = spawnSettings(classSettings);
  settings.texture = textureNamesOf(record, classSettings, palette, load);
  return spawnGroup(record, settings, null, offsetX, offsetY, load, classSettings, owner);
}

/** Each decoration's atlas name (computed once a record: a prefab's records serve every entity of the prefab). */
function textureNamesOf(record, classSettings, palette, load) {
  let names = load.textureNames.get(record);
  if (names !== undefined) return names;
  const resolved = palette.map((name) => textureName(classSettings, name));
  names = record.x.map((_, position) => resolved[Array.isArray(record.frame) ? record.frame[position] : 0]);
  load.textureNames.set(record, names);
  return names;
}

/** The record's decorations grouped by palette entry: entry → their positions in the record (computed once a record). */
function groupsByPaletteEntry(record, load) {
  let groups = load.paletteGroups.get(record);
  if (groups !== undefined) return groups;
  groups = new Map();
  for (let position = 0; position < record.x.length; position++) {
    const entry = Array.isArray(record.frame) ? record.frame[position] : 0;
    if (!groups.has(entry)) groups.set(entry, []);
    groups.get(entry).push(position);
  }
  load.paletteGroups.set(record, groups);
  return groups;
}

/** The decorations at `positions` of a record (null: all of them), spawned with `settings` (their texture included). */
function spawnGroup(record, settings, positions, offsetX, offsetY, load, classSettings, owner) {
  const count = positions === null ? record.x.length : positions.length;
  const select = (list) => (positions === null ? list : positions.map((position) => list[position]));
  const config = { ...settings, count };
  // The entity these decorations are part of (a house's walls and roofs): the light pass then takes their pixels as the
  // house's, so its own shadow volume does not fall on them (DecorationPool owner).
  if (owner >= 0) config.owner = owner;
  config.x = new Float64Array(count);
  config.y = new Float64Array(count);
  for (let n = 0; n < count; n++) {
    const position = positions === null ? n : positions[n];
    config.x[n] = record.x[position] + offsetX;
    config.y[n] = record.y[position] + offsetY;
  }
  if (Array.isArray(config.texture)) config.texture = select(config.texture);
  for (const key of SPAWN_MANY_KEYS) if (Array.isArray(record[key])) config[key] = select(record[key]);
  if (Array.isArray(record.scale)) {
    if (!Array.isArray(record.scaleX)) config.scaleX = select(record.scale);
    if (!Array.isArray(record.scaleY)) config.scaleY = select(record.scale);
  }
  if (classSettings.hidden) config.alpha = 0;
  let oneAtATime = false;
  for (const key of DRAWN_KEYS) {
    if (!isRange(config[key])) continue;
    const values = new Float64Array(count);
    for (let n = 0; n < count; n++) values[n] = drawSetting(config[key], load.random, key);
    config[key] = values;
    if (ONE_AT_A_TIME_KEYS.includes(key)) oneAtATime = true;
  }
  for (const key of ONE_AT_A_TIME_KEYS) {
    if (!Array.isArray(record[key])) continue;
    config[key] = select(record[key]);
    oneAtATime = true;
  }
  const swayOn = Array.isArray(record.sway) ? select(record.sway) : null;
  const poolIndices = classSettings.keep ? new Int32Array(count).fill(-1) : null;
  let spawned;
  if (oneAtATime || swayOn) {
    spawned = spawnOneAtATime(config, count, swayOn, poolIndices, load);
  } else {
    if (poolIndices) config.out = poolIndices;
    spawned = load.spawnDecorations(config);
  }
  if (poolIndices) keepPoolIndices(load, record.class, poolIndices);
  if (spawned < count) load.warnOnce(`the decoration pool is full: raise decoration.maxDecorations (${record.class} and more are not drawn)`);
  return spawned;
}

function keepPoolIndices(load, className, poolIndices) {
  if (!load.kept[className]) load.kept[className] = [];
  const list = load.kept[className];
  for (const index of poolIndices) if (index >= 0) list.push(index);
}

/** A group spawnMany cannot take whole: one spawn a decoration, with one config object for them all (no garbage each). */
function spawnOneAtATime(config, count, swayOn, poolIndices, load) {
  const listKeys = Object.keys(config).filter((key) => isList(config[key]));
  const lists = listKeys.map((key) => config[key]);
  const one = { ...config };
  delete one.count;
  const classSway = one.sway;
  const classSwaySkew = one.swaySkew;
  let spawned = 0;
  for (let n = 0; n < count; n++) {
    for (let key = 0; key < listKeys.length; key++) one[listKeys[key]] = lists[key][n];
    if (swayOn) {
      // A record's sway array says which of its decorations sway; those take the class's way of swaying.
      const sways = swayOn[n] !== 0;
      one.swaySkew = sways ? classSwaySkew : false;
      one.sway = sways ? (classSway ?? !classSwaySkew) : false;
    }
    const index = load.spawnDecoration(one);
    if (index < 0) break;
    if (poolIndices) poolIndices[n] = index;
    spawned++;
  }
  return spawned;
}

/** A record's attached decorations, for the entity's onSpawned (attachDecorations), with its textures resolved here. */
function attachedSpec(record, classSettings, load) {
  const count = record.x.length;
  const palette = paletteOf(record, classSettings);
  const resolvesItself = isObject(classSettings.perTexture);
  const texture = new Array(count).fill('');
  const own = resolvesItself ? new Array(count).fill(null) : null;
  for (let position = 0; position < count; position++) {
    const name = palette[Array.isArray(record.frame) ? record.frame[position] : 0];
    if (name === undefined) continue;
    if (!resolvesItself) {
      texture[position] = textureName(classSettings, name);
      continue;
    }
    const ownSettings = classSettings.perTexture[name];
    if (!isObject(ownSettings) || typeof ownSettings.texture !== 'string') {
      load.warnOnce(`decoration class ${record.class}: "${name}" is not one it knows; that decoration is skipped`);
      continue;
    }
    texture[position] = ownSettings.texture;
    own[position] = spawnSettings({}, ownSettings);
  }
  const spec = { texture, x: record.x, y: record.y, settings: spawnSettings(classSettings) };
  if (own) spec.own = own;
  for (const key of VALUE_KEYS) if (Array.isArray(record[key])) spec[key] = record[key];
  if (classSettings.hidden) spec.settings.alpha = 0;
  return spec;
}

/**
 * Hang the decorations a scene file attaches to an entity (its spawn config's `decor`) from it: called in the entity's
 * onSpawned, on its logic worker (it allocates: once a spawn). `mirror` -1 hangs them mirrored about the entity (a
 * flipped tree): their x, scaleX and rotation change sign. Returns how many hang.
 * @param {{ addDecoration: Function }} entity
 * @param {object[]} specs
 * @param {() => number} [random]
 * @param {number} [mirror]
 */
export function attachDecorations(entity, specs, random = Math.random, mirror = 1) {
  if (!Array.isArray(specs)) return 0;
  let hung = 0;
  for (const spec of specs) {
    for (let position = 0; position < spec.texture.length; position++) {
      if (spec.texture[position] && attachOne(entity, spec, position, random, mirror)) hung++;
    }
  }
  return hung;
}

/** One attached decoration: the record's own value of each key first, then its palette entry's, then its class's. */
function attachOne(entity, spec, position, random, mirror) {
  const classSettings = spec.settings || {};
  const ownSettings = spec.own ? spec.own[position] : null;
  const fromRecord = (key) => (Array.isArray(spec[key]) ? spec[key][position] : undefined);
  const fromSettings = (key) => {
    if (ownSettings && ownSettings[key] !== undefined) return drawSetting(ownSettings[key], random, key);
    if (classSettings[key] !== undefined) return drawSetting(classSettings[key], random, key);
    return undefined;
  };
  const recordScale = fromRecord('scale');
  const scaleX = (fromRecord('scaleX') ?? recordScale ?? fromSettings('scaleX') ?? 1) * mirror;
  const scaleY = fromRecord('scaleY') ?? recordScale ?? fromSettings('scaleY') ?? 1;
  const innerZ = fromRecord('innerZ') ?? fromSettings('innerZ') ?? 0;
  const extra = {};
  for (const source of ownSettings ? [classSettings, ownSettings] : [classSettings]) {
    for (const key of Object.keys(source)) if (!ADD_DECORATION_ARGUMENTS.has(key)) extra[key] = drawSetting(source[key], random, key);
  }
  for (const key of ['anchorX', 'anchorY', 'alpha', 'tint', 'sortOffsetY', 'skewX', 'skewY']) {
    const value = fromRecord(key);
    if (value !== undefined) extra[key] = value;
  }
  extra.rotation = (fromRecord('rotation') ?? fromSettings('rotation') ?? 0) * mirror;
  if (fromRecord('sway') === 0) {
    extra.sway = false;
    extra.swaySkew = false;
  }
  const localX = spec.x[position] * mirror;
  const localY = spec.y[position];
  return entity.addDecoration(spec.texture[position], localX, localY, scaleX, scaleY, innerZ, extra) >= 0;
}

// ---- the load ----

/**
 * Spawn a checked scene file: its entities (parents first, each with its prefab, its world decorations and its
 * children) and its top-level decorations.
 * @returns {Promise<{ entities: number, decorations: number, byName: Map<string, number>, kept: Object<string, number[]> }>}
 */
export async function loadBarrio(doc, options) {
  const where = options.where || 'scene file';
  const toldAlready = new Set();
  const warn = options.warn || ((message) => console.warn(message));
  const load = {
    random: options.random || Math.random,
    spawnDecorations: options.spawnDecorations,
    spawnDecoration: options.spawnDecoration,
    textureNames: new WeakMap(),
    paletteGroups: new WeakMap(),
    kept: {},
    classes: options.classes || {},
    decorationClasses: options.decorations || {},
    prefabs: doc.prefabs,
    byName: new Map(),
    entities: 0,
    decorations: 0,
    warnOnce(message) {
      if (toldAlready.has(message)) return;
      toldAlready.add(message);
      warn(`${where}: ${message}`);
    },
  };
  load.context = {
    spawnDecorations: load.spawnDecorations,
    spawnDecoration: load.spawnDecoration,
    warnOnce: load.warnOnce,
    byName: load.byName,
  };
  await spawnEntities(doc.entities, load, options);
  for (const record of doc.decorations) {
    const classSettings = load.decorationClasses[record.class];
    if (!isObject(classSettings)) {
      load.warnOnce(`"${record.class}" is not a decoration class of this scene: its decorations are skipped`);
      continue;
    }
    load.decorations += spawnWorldRecord(record, classSettings, 0, 0, load);
  }
  if (options.onProgress) options.onProgress(doc.entities.length, doc.entities.length);
  return { entities: load.entities, decorations: load.decorations, byName: load.byName, kept: load.kept };
}

/** The file's entities, parents before their children, yielding now and then so the page can draw. */
async function spawnEntities(records, load, options) {
  const positionOf = new Map();
  records.forEach((record, position) => positionOf.set(record.name, position));
  const { order, cut } = spawnOrder(records);
  if (cut.size) load.warnOnce(`${cut.size} parent links close a loop: those entities are spawned unlinked`);
  const expanded = new Array(records.length);
  const sliceMs = options.sliceMs ?? 40;
  const pause = options.pause || (() => new Promise((resolve) => setTimeout(resolve, 0)));
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let sliceStart = clock();
  for (let done = 0; done < order.length; done++) {
    const position = order[done];
    const entity = expandEntity(records[position], load.prefabs);
    expanded[position] = entity;
    const link = cut.has(position) ? null : linkToNamedParent(entity, expanded[positionOf.get(entity.parent)], load);
    spawnEntityRecord(entity, entity.x, entity.y, link, load);
    if ((done & 63) === 63 && clock() - sliceStart > sliceMs) {
      if (options.onProgress) options.onProgress(done + 1, order.length);
      await pause();
      sliceStart = clock();
    }
  }
}

/** The link of an entity to the parent its record names: the parent's index and its place in the parent's frame. */
function linkToNamedParent(entity, parent, load) {
  if (entity.parent === null || !parent) return null;
  const parentIndex = load.byName.get(entity.parent);
  if (parentIndex === undefined || parentIndex < 0) return null;
  // Its offset from the parent, with the parent's rotation undone (DX-PARENT turns it back every frame).
  const dx = entity.x - parent.x;
  const dy = entity.y - parent.y;
  const cos = Math.cos(parent.rotation);
  const sin = Math.sin(parent.rotation);
  return { parent: parentIndex, localX: cos * dx + sin * dy, localY: -sin * dx + cos * dy };
}

/** One expanded entity at (x, y), its world decorations and its children; returns its index, -1 for none. */
function spawnEntityRecord(entity, x, y, link, load) {
  const spawn = load.classes[entity.class];
  if (typeof spawn !== 'function') {
    load.warnOnce(`"${entity.class}" is not a class this scene spawns: its entities are skipped`);
    if (entity.name) load.byName.set(entity.name, -1);
    return -1;
  }
  const attached = [];
  const world = [];
  for (const record of entity.decorations) {
    const classSettings = load.decorationClasses[record.class];
    if (!isObject(classSettings)) {
      load.warnOnce(`"${record.class}" is not a decoration class of this scene: its decorations are skipped`);
    } else if (record.attached === true) {
      attached.push(attachedSpec(record, classSettings, load));
    } else {
      world.push({ record, classSettings });
    }
  }
  const config = { x, y, ...entity.config };
  if (entity.rotation) config.rotation = entity.rotation;
  if (isNumber(entity.scaleX)) config.scaleX = entity.scaleX;
  if (isNumber(entity.scaleY)) config.scaleY = entity.scaleY;
  if (link) Object.assign(config, link);
  if (attached.length) config.decor = attached;
  const returned = spawn(config, load.context);
  const index = typeof returned === 'number' && returned >= 0 ? returned : -1;
  if (index >= 0) load.entities++;
  if (entity.name) load.byName.set(entity.name, index);
  for (const { record, classSettings } of world) load.decorations += spawnWorldRecord(record, classSettings, x, y, load, index);
  spawnChildren(entity, x, y, index, load);
  return index;
}

/** A prefab's children: placed relative to their entity, turned by its rotation, and linked to it. */
function spawnChildren(entity, x, y, parentIndex, load) {
  if (entity.children.length === 0) return;
  const cos = Math.cos(entity.rotation);
  const sin = Math.sin(entity.rotation);
  for (const record of entity.children) {
    const child = expandEntity(record, load.prefabs);
    const childX = x + cos * child.x - sin * child.y;
    const childY = y + sin * child.x + cos * child.y;
    const link = parentIndex >= 0 ? { parent: parentIndex, localX: child.x, localY: child.y } : null;
    spawnEntityRecord(child, childX, childY, link, load);
  }
}
