// sceneJoints.js — the running scene file's joints in the editor (VISUAL_EDITOR_PLAN.md ED-21): the document's
// `joints` section and the joints the scene made from it (Scene._fileJoints), kept in step.
//
// A joint holds two entity indices, so it is made again whenever one of its entities is: the editor respawns an
// entity on each change (sceneDocument.js), and a despawn removes no joint. Before the editor despawns an entity, the
// joints on its slot go (dropJointsAt: the file's and any code made, which would otherwise join whatever spawns
// there next); after it spawns again, the file's joints that name it are made between the indices live now
// (remakeJointsOf). A rename renames them; a delete takes them out of the document (the delete's undo puts them
// back: EditMode keeps a copy of the list in its change). A change to the list itself makes every file joint again
// (replaceJoints): there are few.
//
// No DOM here: the inspector's joints are jointsPanel.js. Page only; once per user action.

import { Joint } from '../../joint.js';
import { addFileJoint, namedEntityIndex } from '../../sceneFileJoints.js';

const NO_JOINTS = Object.freeze([]);

/** The running file's joints: its `joints` section, or an empty list. */
export function jointsOf(scene) {
  const joints = scene?.sceneFile?.joints;
  return Array.isArray(joints) ? joints : NO_JOINTS;
}

/** Whether a joint of the running file names `name`. */
export function jointsName(scene, name) {
  for (const joint of jointsOf(scene)) if (joint.a === name || joint.b === name) return true;
  return false;
}

/** Remove a joint the file made, unless it is gone already (broken, or its entity's joints dropped) or its slot holds another. */
function removeMade(made) {
  const i = made.index;
  if (Joint.isActive(i) && Joint.getEntityA(i) === made.entityA && Joint.getEntityB(i) === made.entityB) Joint.remove(i);
}

function recordsByName(scene) {
  const records = new Map();
  for (const record of scene.sceneFile.entities) records.set(record.name, record);
  return records;
}

/** Make one of the file's joints between the entities its names have now; skipped while one of them is not live. */
function make(scene, joint, records) {
  if (!Joint.active) return;
  const a = namedEntityIndex(scene, joint.a);
  const b = namedEntityIndex(scene, joint.b);
  if (a < 0 || b < 0) return;
  const index = addFileJoint(joint, a, b, records.get(joint.a), records.get(joint.b));
  if (index >= 0) scene._fileJoints.set(joint, { index, entityA: a, entityB: b });
}

/** Forget (and remove) the joint the file made from `joint`, if any. */
function unmake(scene, joint) {
  const made = scene._fileJoints.get(joint);
  if (made === undefined) return;
  removeMade(made);
  scene._fileJoints.delete(joint);
}

/** Before the editor despawns the entity at `index` (a respawn, a delete): the joints on its slot go with it. */
export function dropJointsAt(index) {
  if (Joint.active && index >= 0) Joint.removeAllForEntity(index);
}

/** After the entity named `name` spawned again (or could not): the file's joints that name it, made again. */
export function remakeJointsOf(scene, name) {
  if (!jointsName(scene, name)) return;
  const joints = jointsOf(scene).filter((joint) => joint.a === name || joint.b === name);
  for (const joint of joints) unmake(scene, joint);
  const records = recordsByName(scene);
  for (const joint of joints) make(scene, joint, records);
}

/**
 * The document's joints become `joints` (a copy the caller gives away; empty: the file has no joints section), and
 * every file joint is made again from them.
 * @param {object} scene
 * @param {object[]} joints
 */
export function replaceJoints(scene, joints) {
  for (const made of scene._fileJoints.values()) removeMade(made);
  scene._fileJoints.clear();
  if (joints.length === 0) delete scene.sceneFile.joints;
  else scene.sceneFile.joints = joints;
  const records = recordsByName(scene);
  for (const joint of joints) make(scene, joint, records);
}

/** A rename: the joints that name `from` name `to` (the joints themselves do not change). */
export function renameInJoints(scene, from, to) {
  for (const joint of jointsOf(scene)) {
    if (joint.a === from) joint.a = to;
    if (joint.b === from) joint.b = to;
  }
}

/** A delete: the joints that name `name` leave the document, and the world. */
export function removeJointsNaming(scene, name) {
  if (!jointsName(scene, name)) return;
  const kept = [];
  for (const joint of jointsOf(scene)) {
    if (joint.a === name || joint.b === name) unmake(scene, joint);
    else kept.push(joint);
  }
  if (kept.length === 0) delete scene.sceneFile.joints;
  else scene.sceneFile.joints = kept;
}

/** A copy of the file's joints when one names `name`: what undoing its delete puts back. Otherwise undefined. */
export function jointsBeforeDelete(scene, name) {
  return jointsName(scene, name) ? structuredClone(jointsOf(scene)) : undefined;
}
