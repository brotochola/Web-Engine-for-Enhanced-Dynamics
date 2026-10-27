// jointsPanel.js — the joints of the selected placed entity, in the inspector (VISUAL_EDITOR_PLAN.md ED-21): one row
// per joint of the running scene file that names it, with its type, the other entity (chosen by name), both anchors
// as number fields (relative to each entity, in pixels) and its type's settings as JSON; a button removes it, and a
// row at the end adds one (the type from a list, the other entity by name).
//
// Every change goes through editJoints: the document's joints are changed on a copy, checked as the file format
// checks them, made again (sceneJoints.js), and the change is one entry of undo, as data: the list before and after
// (EditMode._apply's 'joints'), so a history handed over across a reload of the game page applies too (D9).
//
// Built when the selection or the document changes (Selection._show), never per frame.

import { Joint } from '../../joint.js';
import { checkSceneFileJoints, JOINT_TYPES, JOINT_SETTINGS, JOINT_BREAK_KEYS } from '../../sceneFileJoints.js';
import { recordOf, editorIdOf, nameOfEditorId, indexOfName } from './sceneDocument.js';
import { jointsOf, replaceJoints } from './sceneJoints.js';

const FIELD_STYLE =
  'font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;min-width:0;box-sizing:border-box';
const LABEL_STYLE = 'font-size:10px;color:#999;white-space:nowrap';

/** Two decimals at most: what an anchor the editor computes is written as. */
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Change the running file's joints: `write(joints)` edits a copy, which becomes the document's once it checks, and
 * every file joint is made again. Kept for undo, with the selected entity to select again.
 * @param {object} editMode
 * @param {string} label - what the change was, for the status line of an undo
 * @param {(joints: object[]) => void} write
 * @returns {boolean} whether the joints changed
 */
export function editJoints(editMode, label, write) {
  const scene = editMode.debugUI.scene;
  if (!scene?.sceneFile) return false;
  const before = structuredClone(jointsOf(scene));
  const joints = structuredClone(before);
  write(joints);
  if (JSON.stringify(joints) === JSON.stringify(before)) return false;
  try {
    checkSceneFileJoints(joints, 'the scene file');
  } catch (error) {
    editMode._setStatus(error.message.replace(/^WeedJS: the scene file: /, ''), true);
    return false;
  }
  replaceJoints(scene, joints);
  const selection = editMode.selection;
  const found = selection.authored ? recordOf(scene, selection.name) : null;
  const editorId = found === null ? 0 : editorIdOf(found.record);
  editMode.history.push({ id: 0, label, kind: 'joints', editorId, before, after: structuredClone(joints) });
  editMode._showRestored(selection.index);
  // The file has the joint either way; the world only with a pool to make it in.
  if (!Joint.active && joints.length > 0) {
    editMode._setStatus(`${scene.constructor.name} has no joint pool: set its config.physics.maxJoints`, true);
  }
  return true;
}

/** Undo or redo a change of the joints (EditMode._apply): the list as it was, made again; its entity selected. */
export function applyJointsChange(editMode, change, forward) {
  const scene = editMode.debugUI.scene;
  replaceJoints(scene, structuredClone(forward ? change.after : change.before));
  const name = change.editorId ? nameOfEditorId(scene, change.editorId) : null;
  editMode._showRestored(name === null ? -1 : indexOfName(scene, name));
}

/**
 * A new joint from `self` to `other`. A distance joint holds both centers at the distance they are placed at; the
 * others hold the two entities where they are, at the point halfway between them.
 */
export function newJoint(scene, self, other, type) {
  const a = recordOf(scene, self)?.record;
  const b = recordOf(scene, other)?.record;
  if (type === 'distance' || !a || !b) return { type, a: self, b: other, anchorA: [0, 0], anchorB: [0, 0] };
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { type, a: self, b: other, anchorA: [round2(mx - a.x), round2(my - a.y)], anchorB: [round2(mx - b.x), round2(my - b.y)] };
}

/** A joint's settings (its type's and the break thresholds) that it has, as an object. */
function settingsOf(joint) {
  const out = {};
  for (const key of [...(JOINT_SETTINGS[joint.type] || []), ...JOINT_BREAK_KEYS]) if (joint[key] !== undefined) out[key] = joint[key];
  return out;
}

export class JointsPanel {
  /** @param {object} selection - the editor's Selection: its scene, the entity, and the editor its changes go through */
  constructor(selection) {
    this.selection = selection;
    /** The type the add row offers first: the last one added. */
    this.addType = 'revolute';
    this.el = document.createElement('div');
    this.el.dataset.joints = '';
    this.el.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.1);display:none';
  }

  get _editMode() {
    return this.selection.editor;
  }

  /** The joints of the placed entity `name`, or nothing (null: no placed entity selected). */
  show(name) {
    const el = this.el;
    el.textContent = '';
    const scene = this.selection.debugUI.scene;
    if (name === null || !scene?.sceneFile) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const title = document.createElement('div');
    title.textContent = 'Joints';
    title.title = 'The scene file’s joints that name this entity. In the view, Alt+drag a handle to move its anchor.';
    title.style.cssText = 'font-size:11px;color:#ccc;font-weight:bold;margin-bottom:3px';
    el.appendChild(title);
    const others = scene.sceneFile.entities.filter((e) => e.name !== name).map((e) => e.name);
    const joints = jointsOf(scene);
    for (let p = 0; p < joints.length; p++) {
      if (joints[p].a === name || joints[p].b === name) el.appendChild(this._row(name, joints[p], p, others));
    }
    el.appendChild(this._addRow(name, others));
  }

  _row(name, joint, position, others) {
    const self = joint.a === name ? 'a' : 'b';
    const otherKey = self === 'a' ? 'b' : 'a';
    const hereKey = self === 'a' ? 'anchorA' : 'anchorB';
    const thereKey = self === 'a' ? 'anchorB' : 'anchorA';
    const edit = (what, write) => editJoints(this._editMode, `${name} joint ${what}`, (js) => write(js[position]));

    const row = document.createElement('div');
    row.dataset.joint = String(position);
    row.style.cssText = 'margin:3px 0 6px;padding:3px 4px;background:rgba(255,255,255,0.04);border-radius:3px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:4px;align-items:center';
    const type = select(JOINT_TYPES.map((t) => [t, t]), joint.type);
    type.dataset.jointType = '';
    type.onchange = () =>
      edit('type', (j) => {
        for (const key of JOINT_SETTINGS[j.type]) delete j[key];
        j.type = type.value;
      });
    const arrow = document.createElement('span');
    arrow.textContent = self === 'a' ? '→' : '←';
    arrow.style.cssText = LABEL_STYLE;
    const choices = others.map((n) => [n, n]);
    if (!others.includes(joint[otherKey])) choices.push([joint[otherKey], `${joint[otherKey]} (missing)`]);
    const other = select(choices, joint[otherKey]);
    other.dataset.jointOther = '';
    other.onchange = () =>
      edit('entity', (j) => {
        j[otherKey] = other.value;
      });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'debug-ui-btn';
    remove.textContent = '✕';
    remove.title = 'Remove this joint';
    remove.dataset.jointRemove = '';
    remove.onclick = () => editJoints(this._editMode, `remove ${name}’s ${joint.type} joint`, (js) => js.splice(position, 1));
    head.append(type, arrow, other, remove);
    row.appendChild(head);

    const anchors = document.createElement('div');
    anchors.style.cssText = 'display:grid;grid-template-columns:auto 1fr 1fr;gap:3px 4px;align-items:center;margin-top:3px';
    for (const [label, key] of [
      ['here', hereKey],
      [joint[otherKey], thereKey],
    ]) {
      const text = document.createElement('span');
      text.textContent = label;
      text.title = `${key}: where the joint holds ${key === hereKey ? name : joint[otherKey]}, from its position (px)`;
      text.style.cssText = `${LABEL_STYLE};max-width:70px;overflow:hidden;text-overflow:ellipsis`;
      const point = joint[key] || [0, 0];
      const fields = [0, 1].map((axis) => {
        const field = document.createElement('input');
        field.type = 'number';
        field.step = 'any';
        field.value = String(point[axis]);
        field.dataset.anchor = `${key}.${axis === 0 ? 'x' : 'y'}`;
        field.style.cssText = `${FIELD_STYLE};width:100%`;
        field.onchange = () => {
          const n = Number(field.value);
          if (field.value.trim() === '' || !Number.isFinite(n)) {
            field.value = String(point[axis]);
            return;
          }
          edit('anchor', (j) => {
            const next = (j[key] || [0, 0]).slice();
            next[axis] = n;
            j[key] = next;
          });
        };
        return field;
      });
      anchors.append(text, fields[0], fields[1]);
    }
    row.appendChild(anchors);

    // The type's settings, as JSON: { "length": 120, "enableSpring": true }.
    const settings = document.createElement('input');
    settings.type = 'text';
    settings.spellcheck = false;
    settings.dataset.jointSettings = '';
    const current = settingsOf(joint);
    settings.value = Object.keys(current).length === 0 ? '' : JSON.stringify(current);
    settings.placeholder = `{ ${[...JOINT_SETTINGS[joint.type], ...JOINT_BREAK_KEYS].map((k) => `"${k}"`).join(', ')} }`;
    settings.title = `${joint.type} settings (Joint's names; angles in radians), as JSON. Empty: the defaults`;
    settings.style.cssText = `${FIELD_STYLE};width:100%;margin-top:3px;font-family:monospace`;
    settings.onchange = () => {
      let parsed = {};
      if (settings.value.trim() !== '') {
        try {
          parsed = JSON.parse(settings.value);
        } catch (error) {
          settings.style.borderColor = '#f87171';
          settings.title = error.message;
          return;
        }
      }
      const allowed = [...JOINT_SETTINGS[joint.type], ...JOINT_BREAK_KEYS];
      const stray = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).find((k) => !allowed.includes(k))
        : '(not an object)';
      if (stray !== undefined) {
        settings.style.borderColor = '#f87171';
        settings.title = `${stray}: a ${joint.type} joint takes ${allowed.join(', ')}`;
        return;
      }
      edit('settings', (j) => {
        for (const key of allowed) delete j[key];
        Object.assign(j, parsed);
      });
    };
    row.appendChild(settings);
    return row;
  }

  _addRow(name, others) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:4px';
    const type = select(JOINT_TYPES.map((t) => [t, t]), this.addType);
    type.dataset.jointAddType = '';
    const other = select(others.map((n) => [n, n]), others[0] ?? '');
    other.dataset.jointAddOther = '';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'debug-ui-btn';
    add.textContent = '+ Joint';
    add.title = 'Add a joint from this entity to the chosen one';
    add.dataset.jointAdd = '';
    add.disabled = others.length === 0;
    add.onclick = () => {
      if (other.value === '') return;
      this.addType = type.value;
      const scene = this.selection.debugUI.scene;
      editJoints(this._editMode, `add a ${type.value} joint ${name}–${other.value}`, (js) =>
        js.push(newJoint(scene, name, other.value, type.value)),
      );
    };
    row.append(type, other, add);
    return row;
  }
}

function select(choices, value) {
  const el = document.createElement('select');
  el.style.cssText = `${FIELD_STYLE};flex:1;cursor:pointer`;
  for (const [optionValue, text] of choices) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = text;
    el.appendChild(option);
  }
  el.value = value;
  return el;
}
