// sceneFileJoints.js — a scene file's joints (VISUAL_EDITOR_PLAN.md ED-21): the joints a level places between its
// entities, which they name. An optional section of format 1, after the entities:
//
//   "joints": [
//     { "type": "revolute", "a": "Door", "b": "Frame", "anchorA": [0, -40], "anchorB": [12, 30], "enableLimit": true, "upperAngle": 1.5 },
//     { "name": "Rope", "type": "distance", "a": "Lamp", "b": "Ceiling", "anchorA": [0, -20], "anchorB": [0, 0], "enableSpring": true, "hertz": 4 }
//   ]
//
// - `type`: distance, revolute, prismatic or weld (Joint.addDistance and the others).
// - `a`, `b`: the names of two entities of the file.
// - `anchorA`, `anchorB`: where the joint holds each entity, relative to its position and in its own frame (Joint's
//   local anchors), in pixels; [0, 0] when left out.
// - The type's settings, under Joint's own names (JOINT_SETTINGS); Joint's defaults for those left out, except a
//   distance joint's `length`: left out, it is the distance between its two anchors where the file places them.
//   `forceThreshold` and `torqueThreshold` break the joint (left out: it never breaks). Angles are radians.
// - `name`: optional, unique among the file's joints.
// Keys this format does not know are kept. On disk, one joint per line with its keys in a fixed order.
//
// The scene creates them once the file's entities are spawned (Scene._runContentLifecycle), on the page, between
// the indices the names have. A joint whose entities are not there (no such name, a class the scene lacks, a full
// pool) is skipped, with one warning naming the file. A save brings back every joint itself, so a restore skips them.

import { Joint } from './joint.js';
import { Messages } from './messages.js';

/** The joint types a file can name, as Joint has them. */
export const JOINT_TYPES = Object.freeze(['distance', 'revolute', 'prismatic', 'weld']);

/** Each type's settings, in the order the file writes them: Joint.addDistance and the others take these names. */
export const JOINT_SETTINGS = Object.freeze({
  distance: Object.freeze(['length', 'enableSpring', 'hertz', 'dampingRatio']),
  revolute: Object.freeze(['enableLimit', 'lowerAngle', 'upperAngle', 'enableMotor', 'motorSpeed', 'maxMotorTorque']),
  prismatic: Object.freeze([
    'axisAngle',
    'enableLimit',
    'lowerTranslation',
    'upperTranslation',
    'enableMotor',
    'motorSpeed',
    'maxMotorForce',
  ]),
  weld: Object.freeze(['linearHertz', 'angularHertz', 'linearDampingRatio', 'angularDampingRatio']),
});

/** The settings every type has: the force and torque that break the joint. */
export const JOINT_BREAK_KEYS = Object.freeze(['forceThreshold', 'torqueThreshold']);

/** The settings that are true or false; every other one is a number. */
export const JOINT_BOOL_SETTINGS = Object.freeze(['enableSpring', 'enableLimit', 'enableMotor']);

const HEAD_KEYS = ['name', 'type', 'a', 'b', 'anchorA', 'anchorB'];
const KEY_ORDER = Object.freeze(
  Object.fromEntries(JOINT_TYPES.map((type) => [type, Object.freeze([...HEAD_KEYS, ...JOINT_SETTINGS[type], ...JOINT_BREAK_KEYS])])),
);

/** A joint's keys in the file's order, for its type (any other key follows them). */
export function jointKeyOrder(type) {
  return KEY_ORDER[type] || KEY_ORDER.distance;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v) => Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]);

/**
 * Check a scene file's `joints` section. Throws an Error naming the file and the joint.
 * @param {unknown} joints
 * @param {string} where - the file, for the messages
 */
export function checkSceneFileJoints(joints, where) {
  if (!Array.isArray(joints)) throw new Error(`WeedJS: ${where}: "joints" must be an array`);
  const names = new Set();
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i];
    let at = `WeedJS: ${where}: joints[${i}]`;
    if (!isPlainObject(joint)) throw new Error(`${at} must be an object`);
    if (joint.name !== undefined) {
      if (typeof joint.name !== 'string' || joint.name === '') throw new Error(`${at}: "name" must be a string`);
      if (names.has(joint.name)) throw new Error(`${at}: the joint name "${joint.name}" is used twice`);
      names.add(joint.name);
      at = `${at} (${joint.name})`;
    }
    if (!JOINT_TYPES.includes(joint.type)) {
      throw new Error(`${at}: "type" must be one of ${JOINT_TYPES.join(', ')}, not ${JSON.stringify(joint.type)}`);
    }
    if (typeof joint.a !== 'string' || joint.a === '' || typeof joint.b !== 'string' || joint.b === '') {
      throw new Error(`${at}: "a" and "b" must name two entities of the file`);
    }
    if (joint.a === joint.b) throw new Error(`${at}: "a" and "b" both name ${joint.a}: a joint holds two entities`);
    for (const key of ['anchorA', 'anchorB']) {
      if (joint[key] !== undefined && !isPoint(joint[key])) throw new Error(`${at}: "${key}" must be [x, y]`);
    }
    for (const key of [...JOINT_SETTINGS[joint.type], ...JOINT_BREAK_KEYS]) {
      const value = joint[key];
      if (value === undefined) continue;
      if (JOINT_BOOL_SETTINGS.includes(key)) {
        if (typeof value !== 'boolean') throw new Error(`${at}: "${key}" must be true or false`);
      } else if (!isFiniteNumber(value)) {
        throw new Error(`${at}: "${key}" must be a number`);
      }
    }
  }
  return joints;
}

// ---- loading: the joints between the file's entities ----

const ORIGIN = Object.freeze([0, 0]);

/** How a joint reads in a message: its name, or its position, type and entities. */
export function jointLabel(joint, position) {
  return joint.name ? `joint ${joint.name}` : `joints[${position}] (${joint.type} ${joint.a}–${joint.b})`;
}

/**
 * The live index of the entity the running scene file names `name` (Scene._namedEntities, held against the slot's
 * spawn generation), or -1.
 */
export function namedEntityIndex(scene, name) {
  const packed = scene._namedEntities.get(name);
  if (packed === undefined) return -1;
  const index = Math.floor(packed / 65536);
  return Messages.spawnGen[index] === packed - index * 65536 ? index : -1;
}

/**
 * Joint's options for a file joint between entity indices `a` and `b`: its anchors and its type's settings. A
 * distance joint without a length gets the distance between its anchors where the records place the entities.
 * @param {object} joint - the file's joint record
 * @param {number} a
 * @param {number} b
 * @param {object} [recordA] - the file's records of the two entities
 * @param {object} [recordB]
 */
export function fileJointOptions(joint, a, b, recordA, recordB) {
  const anchorA = joint.anchorA || ORIGIN;
  const anchorB = joint.anchorB || ORIGIN;
  const opts = {
    entityA: a,
    entityB: b,
    localAnchorAX: anchorA[0],
    localAnchorAY: anchorA[1],
    localAnchorBX: anchorB[0],
    localAnchorBY: anchorB[1],
  };
  for (const key of JOINT_SETTINGS[joint.type]) if (joint[key] !== undefined) opts[key] = joint[key];
  for (const key of JOINT_BREAK_KEYS) if (joint[key] !== undefined) opts[key] = joint[key];
  if (joint.type === 'distance' && joint.length === undefined && recordA && recordB) {
    const dx = recordB.x + anchorB[0] - (recordA.x + anchorA[0]);
    const dy = recordB.y + anchorB[1] - (recordA.y + anchorA[1]);
    opts.length = Math.sqrt(dx * dx + dy * dy);
  }
  return opts;
}

/**
 * Make one file joint between entity indices `a` and `b`.
 * @returns {number} its joint pool index, or -1 (the pool is full: Joint warns)
 */
export function addFileJoint(joint, a, b, recordA, recordB) {
  const opts = fileJointOptions(joint, a, b, recordA, recordB);
  switch (joint.type) {
    case 'distance':
      return Joint.addDistance(opts);
    case 'revolute':
      return Joint.addRevolute(opts);
    case 'prismatic':
      return Joint.addPrismatic(opts);
    case 'weld':
      return Joint.addWeld(opts);
    default:
      return -1;
  }
}

/**
 * Make the running scene file's joints (the load, once the file's entities are spawned), each between the entities
 * its names have. Each is kept in `scene._fileJoints` (its record → { index, entityA, entityB }), which the editor
 * uses to make it again. A joint whose entities are not there is skipped, all of them with one warning naming the
 * file; a scene without a joint pool (config.physics.maxJoints) skips them all, with one warning. On a restore it
 * makes none: the save brings back every joint (logic0's restoreSave).
 * @param {object} scene
 * @returns {number} how many it made
 */
export function spawnSceneFileJoints(scene) {
  const joints = scene.sceneFile?.joints;
  if (!Array.isArray(joints) || joints.length === 0) return 0;
  if (scene._restorePayload !== null && scene._restorePayload !== undefined) return 0;
  const where = scene.sceneFileUrl || 'scene file';
  if (!Joint.active) {
    console.warn(
      `WeedJS: ${where} places ${joints.length} joint${joints.length === 1 ? '' : 's'}, and ${scene.constructor.name} ` +
        'has no joint pool: set its config.physics.maxJoints',
    );
    return 0;
  }
  const records = new Map();
  for (const record of scene.sceneFile.entities) records.set(record.name, record);
  const skipped = [];
  let made = 0;
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i];
    const a = namedEntityIndex(scene, joint.a);
    const b = namedEntityIndex(scene, joint.b);
    if (a < 0 || b < 0) {
      skipped.push(`${jointLabel(joint, i)}: no ${a < 0 ? joint.a : joint.b}`);
      continue;
    }
    const index = addFileJoint(joint, a, b, records.get(joint.a), records.get(joint.b));
    if (index < 0) continue;
    scene._fileJoints.set(joint, { index, entityA: a, entityB: b });
    made++;
  }
  if (skipped.length > 0) {
    console.warn(
      `WeedJS: ${where}: ${skipped.length} joint${skipped.length === 1 ? ' is' : 's are'} skipped, ` +
        `${skipped.length === 1 ? 'its' : 'their'} entities are not there (${skipped.join('; ')})`,
    );
  }
  return made;
}
