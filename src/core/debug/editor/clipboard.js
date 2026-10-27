// clipboard.js — copy and paste of placed entities (VISUAL_EDITOR_PLAN.md ED-59). Ctrl+C keeps the selected placed
// entities' records, with the file's joints between them; Ctrl+V adds them again where the pointer is (else a step
// off where they were), named anew, as one undo, and selects them. An entity param that named a copied entity names
// its copy; a copy looks like its original (its seed kept: sceneDocument.js keepSeed).
//
// The copy is kept in this page and in localStorage (so it pastes in another level, or another tab of this origin),
// and written to the system clipboard as JSON where the browser allows it (a text editor shows what was copied).
// Every storage access is guarded: blocked storage leaves this page's copy.
//
// Cost: a key press; nothing per frame.

import { KIND_ENTITY } from '../../spawnParams.js';
import { jointsOf } from './sceneJoints.js';
import { recordOf, paramsOf, classNamed, keepSeed } from './sceneDocument.js';
import { snapTo } from './moveTool.js';

/** What the clipboard's JSON says it holds. */
export const CLIPBOARD_KIND = 'weedjs.entities';
const STORAGE_KEY = 'weed.editor.clipboard';

/** This page's copy, as JSON, when storage is blocked. */
let pageCopy = null;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The records of `names` (placed entities of the running file), and the joints between two of them, as data.
 * @returns {{ kind: string, version: number, entities: object[], joints: object[] }|null} null: none placed
 */
export function copyEntities(scene, names) {
  const entities = [];
  const copied = new Set();
  for (const name of names) {
    const found = recordOf(scene, name);
    if (found === null || copied.has(name)) continue;
    entities.push(structuredClone(found.record));
    copied.add(name);
  }
  if (entities.length === 0) return null;
  const joints = [];
  for (const joint of jointsOf(scene)) if (copied.has(joint.a) && copied.has(joint.b)) joints.push(structuredClone(joint));
  return { kind: CLIPBOARD_KIND, version: 1, entities, joints };
}

/** Keep a copy: this page's, localStorage's, and the system clipboard's where the browser lets this page write it. */
export function writeClipboard(payload) {
  const text = JSON.stringify(payload);
  pageCopy = text;
  try {
    storage()?.setItem(STORAGE_KEY, text);
  } catch {
    // full or blocked: this page's copy
  }
  try {
    globalThis.navigator?.clipboard?.writeText(text).catch(() => {});
  } catch {
    // no system clipboard here
  }
}

/** The last copy (another tab's too, through localStorage), or null. */
export function readClipboard() {
  let text = null;
  try {
    text = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    text = null;
  }
  if (text === null) text = pageCopy;
  if (text === null) return null;
  try {
    const payload = JSON.parse(text);
    return payload && payload.kind === CLIPBOARD_KIND && Array.isArray(payload.entities) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The records and joints a paste adds to the running file: new names (a name's stem and the smallest free number,
 * as the editor names what it places), moved so that their box's center is at x, y (snapped by `step`; NaN: a step
 * down and to the right of where they were), the entity params and joints that named a copied entity naming its
 * copy. A record whose class this scene has not is left out.
 * @returns {{ records: object[], joints: object[], skipped: number }}
 */
export function pastePlan(scene, payload, x, y, step) {
  const sources = payload.entities.filter((record) => classNamed(scene, record.class) !== undefined);
  const names = new Map();
  const used = new Set(scene.sceneFile.entities.map((e) => e.name));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const record of sources) {
    const stem = String(record.name).replace(/\d+$/, '') || String(record.name);
    let n = 1;
    while (used.has(`${stem}${n}`)) n++;
    names.set(record.name, `${stem}${n}`);
    used.add(`${stem}${n}`);
    minX = Math.min(minX, record.x);
    minY = Math.min(minY, record.y);
    maxX = Math.max(maxX, record.x);
    maxY = Math.max(maxY, record.y);
  }
  const atPointer = Number.isFinite(x) && Number.isFinite(y);
  const dx = atPointer ? snapTo(x - (minX + maxX) / 2, step) : step;
  const dy = atPointer ? snapTo(y - (minY + maxY) / 2, step) : step;
  const records = [];
  for (const source of sources) {
    const record = structuredClone(source);
    record.name = names.get(source.name);
    record.x = source.x + dx;
    record.y = source.y + dy;
    keepSeed(record, source);
    const description = record.config ? paramsOf(scene, record) : null;
    if (description !== null) {
      for (let k = 0; k < description.keys.length; k++) {
        const key = description.keys[k];
        if (description.kinds[k] === KIND_ENTITY && names.has(record.config[key])) record.config[key] = names.get(record.config[key]);
      }
    }
    records.push(record);
  }
  const joints = [];
  for (const joint of payload.joints || []) {
    if (!names.has(joint.a) || !names.has(joint.b)) continue;
    const copy = structuredClone(joint);
    copy.a = names.get(joint.a);
    copy.b = names.get(joint.b);
    if (typeof copy.name === 'string') delete copy.name; // a joint's name is unique in its file
    joints.push(copy);
  }
  return { records, joints, skipped: payload.entities.length - sources.length };
}
