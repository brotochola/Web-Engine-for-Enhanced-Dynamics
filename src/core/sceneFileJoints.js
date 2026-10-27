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
