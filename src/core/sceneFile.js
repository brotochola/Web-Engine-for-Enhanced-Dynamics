// sceneFile.js — scene files (`*.scene.json`, format 1): what a scene places where, as data the editor writes,
// next to the scene class (code) that holds the setup and the rules (VISUAL_EDITOR_PLAN.md, D0 to D2).
//
//   {
//     "format": 1,
//     "script": "../platformerGameScene.js",
//     "export": "PlatformerScene",
//     "entities": [
//       { "name": "Platform1", "class": "Platform", "x": 600, "y": 2050, "config": { "width": 1200 } },
//       { "name": "Player", "class": "BluePlatformerPlayer", "x": 300, "y": 1800 }
//     ]
//   }
//
// `script` (relative to the file) and `export` name the scene class, as loadScene's options do. Each entity has a
// `name` unique in the file, its entity `class`, `x` and `y`, and a `config` with the spawn params that differ from
// the class's defaults (an entity param holds the name of another entity in the file). Keys this format does not
// know are kept on load and written back on save. On disk: two-space JSON with one entity per line, its keys in a
// fixed order, so moving one platform is a one-line diff.

import { describeSpawnParams, KIND_ENTITY, KIND_POINTS } from './spawnParams.js';

export const SCENE_FILE_FORMAT = 1;

const ROOT_KEYS = ['format', 'script', 'export', 'entities'];
const ENTITY_KEYS = ['name', 'class', 'x', 'y', 'config'];

/** Whether a loadScene source is a scene file (by its name: `*.scene.json`). */
export function isSceneFileUrl(source) {
  return typeof source === 'string' && /\.scene\.json(?:[?#]|$)/i.test(source);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Parse and check a scene file's text. Throws an Error naming the file (and the entity) when it is not format 1.
 * @param {string} text
 * @param {string} [where] - the file's URL or path, for the messages
 * @returns {object} the document: the parsed JSON, checked
 */
export function parseSceneFile(text, where = 'scene file') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`WeedJS: ${where} is not JSON: ${error.message}`);
  }
  return checkSceneFile(doc, where);
}

/**
 * Check a parsed scene file (format 1) and return it. Throws an Error naming the file and the entity.
 * @param {object} doc
 * @param {string} [where]
 * @param {{ scriptRequired?: boolean }} [options] - scriptRequired false: the scene class is known already (a level
 *   built in code for a class), so `script` may be left out
 */
export function checkSceneFile(doc, where = 'scene file', { scriptRequired = true } = {}) {
  if (!isPlainObject(doc)) throw new Error(`WeedJS: ${where} must hold a JSON object`);
  if (doc.format !== SCENE_FILE_FORMAT) {
    throw new Error(
      `WeedJS: ${where}: scene file format ${JSON.stringify(doc.format)} is not supported (this engine reads format ${SCENE_FILE_FORMAT})`,
    );
  }
  if (doc.script === undefined ? scriptRequired : typeof doc.script !== 'string' || doc.script === '') {
    throw new Error(`WeedJS: ${where}: "script" must name the scene's module, relative to the file`);
  }
  if (doc.export !== undefined && (typeof doc.export !== 'string' || doc.export === '')) {
    throw new Error(`WeedJS: ${where}: "export" must name the scene class the module exports`);
  }
  if (doc.entities === undefined) doc.entities = [];
  if (!Array.isArray(doc.entities)) throw new Error(`WeedJS: ${where}: "entities" must be an array`);
  const names = new Set();
  for (let i = 0; i < doc.entities.length; i++) {
    const e = doc.entities[i];
    const at = `${where}: entities[${i}]`;
    if (!isPlainObject(e)) throw new Error(`${prefix(at)} must be an object`);
    if (typeof e.name !== 'string' || e.name === '') throw new Error(`${prefix(at)} needs a "name"`);
    if (names.has(e.name)) throw new Error(`${prefix(at)}: the name "${e.name}" is used twice`);
    names.add(e.name);
    if (typeof e.class !== 'string' || e.class === '') throw new Error(`${prefix(at)} (${e.name}) needs a "class"`);
    if (!isFiniteNumber(e.x) || !isFiniteNumber(e.y)) throw new Error(`${prefix(at)} (${e.name}): "x" and "y" must be numbers`);
    if (e.config !== undefined && !isPlainObject(e.config)) {
      throw new Error(`${prefix(at)} (${e.name}): "config" must be an object`);
    }
  }
  return doc;
}

const prefix = (at) => `WeedJS: ${at}`;

/**
 * A scene file's content given to loadScene in code (a level the game builds, the editor's document): copied (the
 * scene edits its own) and checked as a file is, with what a level written in code may leave out filled in: `format`
 * (this one), `script` when the scene class is given, and the name of an entity that has none (its class and the
 * smallest free number: Rock1, Rock2, as the editor names what it places).
 * @param {object} doc
 * @param {string} where - for the messages
 * @param {boolean} classKnown - the scene class is given (a class or module source), so `script` is not needed
 * @returns {object} the document the scene runs
 */
export function prepareSceneFile(doc, where, classKnown) {
  if (!isPlainObject(doc)) throw new Error(`WeedJS: ${where} must be an object`);
  const copy = structuredClone(doc);
  if (copy.format === undefined) copy.format = SCENE_FILE_FORMAT;
  if (Array.isArray(copy.entities)) {
    const used = new Set();
    for (const e of copy.entities) if (isPlainObject(e) && typeof e.name === 'string' && e.name !== '') used.add(e.name);
    for (const e of copy.entities) {
      if (!isPlainObject(e) || (typeof e.name === 'string' && e.name !== '') || typeof e.class !== 'string') continue;
      let n = 1;
      while (used.has(`${e.class}${n}`)) n++;
      e.name = `${e.class}${n}`;
      used.add(e.name);
    }
  }
  return checkSceneFile(copy, where, { scriptRequired: !classKnown });
}

/**
 * A scene file's text: two-space JSON, one entity per line, keys in a fixed order (format, script, export,
 * entities, then any others; per entity name, class, x, y, config, then any others). An empty config is left out.
 * @param {object} doc
 * @returns {string}
 */
export function serializeSceneFile(doc) {
  const lines = ['{'];
  const fields = [];
  for (const key of ROOT_KEYS) {
    if (doc[key] === undefined) continue;
    if (key === 'entities') {
      const entities = doc.entities;
      if (entities.length === 0) {
        fields.push('  "entities": []');
      } else {
        const rows = entities.map((e) => `    ${inlineJson(orderedEntity(e))}`);
        fields.push(`  "entities": [\n${rows.join(',\n')}\n  ]`);
      }
    } else {
      fields.push(`  ${JSON.stringify(key)}: ${JSON.stringify(doc[key])}`);
    }
  }
  for (const key of Object.keys(doc)) {
    if (ROOT_KEYS.includes(key) || doc[key] === undefined) continue;
    fields.push(`  ${JSON.stringify(key)}: ${JSON.stringify(doc[key], null, 2).replace(/\n/g, '\n  ')}`);
  }
  lines.push(fields.join(',\n'));
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** An entity record with its keys in the file's order; an empty config is dropped. */
function orderedEntity(e) {
  const out = {};
  for (const key of ENTITY_KEYS) {
    if (e[key] === undefined) continue;
    if (key === 'config' && isPlainObject(e.config) && Object.keys(e.config).length === 0) continue;
    out[key] = e[key];
  }
  for (const key of Object.keys(e)) {
    if (!ENTITY_KEYS.includes(key) && e[key] !== undefined) out[key] = e[key];
  }
  return out;
}

/** JSON on one line, with a space after each colon and comma: `{ "a": 1, "b": [1, 2] }`. */
export function inlineJson(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const items = Array.from(value, inlineJson);
    return items.length ? `[${items.join(', ')}]` : '[]';
  }
  if (isPlainObject(value)) {
    const items = [];
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) items.push(`${JSON.stringify(key)}: ${inlineJson(value[key])}`);
    }
    return items.length ? `{ ${items.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

/**
 * The absolute URL of a scene file's scene module: its "script", relative to the file.
 * @param {object} doc - a checked scene file
 * @param {string} fileUrl - the file's URL (absolute, or from the site root)
 * @param {string} [origin] - the page's origin, for a fileUrl from the site root
 */
export function sceneFileScriptUrl(doc, fileUrl, origin = '') {
  return new URL(doc.script, new URL(fileUrl, origin || 'http://localhost')).href;
}

/**
 * The URL of a scene class's `static defaultSceneFile` (relative to its module), or null when it names none.
 * @param {Function} SceneClass
 * @param {string|null} sceneScriptUrl - the class's module URL, if known
 * @param {string} [origin]
 */
export function defaultSceneFileUrl(SceneClass, sceneScriptUrl, origin = '') {
  const file = SceneClass.defaultSceneFile;
  if (typeof file !== 'string' || file === '') return null;
  return new URL(file, new URL(sceneScriptUrl || '/', origin || 'http://localhost')).href;
}

/** Scene files a game carries in its code, by absolute URL (registerSceneFile): checked once, copied on each load. */
const bundledSceneFiles = new Map();

/** A scene file URL as a key: absolute (against the page when there is one), without its fragment. */
function sceneFileKey(url) {
  const base = typeof location !== 'undefined' ? location.href : undefined;
  const absolute = new URL(url, base);
  absolute.hash = '';
  return absolute.href;
}

/**
 * Carry a scene file in the game's code: a load of its URL (`loadScene`, a scene class's `defaultSceneFile`, a save
 * that recorded the file) takes this document and fetches nothing. An exported game (the editor's Export,
 * game.min.js) registers every level it bundles. Checked now (it throws on a malformed one, naming the URL); each
 * load gets its own copy.
 * @param {string} url - the file's URL: absolute, or relative to the page
 * @param {object} doc - the scene file (format 1)
 */
export function registerSceneFile(url, doc) {
  const key = sceneFileKey(url);
  bundledSceneFiles.set(key, checkSceneFile(structuredClone(doc), key));
}

/**
 * Fetch, parse and check a scene file; a file the game carries (registerSceneFile) is a copy of that, fetched from
 * nowhere.
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function fetchSceneFile(url) {
  if (bundledSceneFiles.size > 0) {
    let key = null;
    try {
      key = sceneFileKey(url);
    } catch {
      // not a URL: the fetch below says so
    }
    const bundled = key === null ? undefined : bundledSceneFiles.get(key);
    if (bundled !== undefined) return structuredClone(bundled);
  }
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`WeedJS: scene file ${url}: HTTP ${response.status}`);
  return parseSceneFile(await response.text(), url);
}

/**
 * The order to spawn a file's entities in: file order, except that an entity another entity names in an entity param
 * comes before it, so the reference can be resolved to its index. A reference into a cycle cannot be: it is listed
 * in `backRefs` (`"<entity position>:<param>"`), and gets no entity.
 * @param {object[]} entities - the file's entity records
 * @param {(className: string) => Function | undefined} classOf - the entity class registered under a name
 * @returns {{ order: number[], backRefs: Set<string>, cycles: string[][] }}
 */
export function sceneFileSpawnOrder(entities, classOf) {
  const position = new Map();
  for (let i = 0; i < entities.length; i++) position.set(entities[i].name, i);
  // Per entity, its references: [param, position of the entity it names].
  const refs = entities.map((e) => {
    const EntityClass = classOf(e.class);
    const description = EntityClass ? describeSpawnParams(EntityClass) : null;
    const out = [];
    if (description === null || !isPlainObject(e.config)) return out;
    for (let k = 0; k < description.keys.length; k++) {
      if (description.kinds[k] !== KIND_ENTITY) continue;
      const key = description.keys[k];
      const target = position.get(e.config[key]);
      if (target !== undefined) out.push([key, target]);
    }
    return out;
  });
  const order = [];
  const backRefs = new Set();
  const cycles = [];
  const state = new Uint8Array(entities.length); // 0 new, 1 on the path, 2 placed
  const path = [];
  const visit = (i) => {
    state[i] = 1;
    path.push(i);
    for (const [key, target] of refs[i]) {
      if (state[target] === 0) {
        visit(target);
      } else if (state[target] === 1) {
        backRefs.add(`${i}:${key}`);
        cycles.push(path.slice(path.indexOf(target)).map((p) => entities[p].name));
      }
    }
    path.pop();
    state[i] = 2;
    order.push(i);
  };
  for (let i = 0; i < entities.length; i++) if (state[i] === 0) visit(i);
  return { order, backRefs, cycles };
}

/**
 * The spawn config for one entity of a file: x, y and its config, with each entity param's name turned into the
 * index `indexOf(name)` gives (−1 when the file has no such entity, or the reference is in `backRefs`), and each
 * points param into a Float64Array. Called on the page at load: it allocates.
 * @param {object} record - the file's entity record
 * @param {number} position - its position in the file
 * @param {Function} EntityClass
 * @param {(name: string) => number} indexOf
 * @param {Set<string>} backRefs - sceneFileSpawnOrder's
 * @param {(key: string, target: unknown) => void} [onMissing] - a reference to a name the file does not have
 */
export function sceneFileSpawnConfig(record, position, EntityClass, indexOf, backRefs, onMissing) {
  const spawnConfig = { x: record.x, y: record.y };
  const config = record.config;
  if (!isPlainObject(config)) return spawnConfig;
  const description = describeSpawnParams(EntityClass);
  for (const key of Object.keys(config)) {
    let value = config[key];
    const k = description !== null ? description.indexOf[key] : undefined;
    if (k !== undefined && description.kinds[k] === KIND_ENTITY) {
      if (value === null) {
        value = -1;
      } else if (backRefs.has(`${position}:${key}`)) {
        value = -1;
      } else {
        const index = typeof value === 'string' ? indexOf(value) : -1;
        if (index < 0 && onMissing) onMissing(key, value);
        value = index;
      }
    } else if (k !== undefined && description.kinds[k] === KIND_POINTS && Array.isArray(value)) {
      value = Float64Array.from(value);
    }
    spawnConfig[key] = value;
  }
  return spawnConfig;
}
