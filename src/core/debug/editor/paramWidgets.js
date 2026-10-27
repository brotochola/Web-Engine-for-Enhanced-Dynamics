// paramWidgets.js — the editor's fields for a placed entity's spawn params (VISUAL_EDITOR_PLAN.md D4, ED-7): one
// row per declared param with the widget its kind asks for, its default beside it, and a button back to the default
// when it differs; for a class that declares none, a key/value box (the config as JSON). Built when the selection
// changes, never per frame. A change is reported once per user action: a number when its field is left or its
// slider let go, a color when the picker closes, a text when its field is left. With the hooks for them, an entity
// param's row has a button to pick the entity in the view (entityPicker.js), and a points param's a + (handles.js:
// its points are dragged in the view).

import {
  KIND_NUMBER,
  KIND_COLOR,
  KIND_ENUM,
  KIND_BOOL,
  KIND_STRING,
  KIND_SPRITE,
  KIND_ANIMATION,
  KIND_ENTITY,
  KIND_POINTS,
} from '../../spawnParams.js';
import { assetPickerWidget } from './assetPicker.js';

const FIELD_STYLE =
  'font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;min-width:0;box-sizing:border-box';
const HINT_STYLE = 'font-size:10px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

/** A color number as `#rrggbb`. */
export const toHex = (color) => `#${(color >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

/** How a param's default reads beside its field. */
export function defaultText(kind, entry, value) {
  switch (kind) {
    case KIND_COLOR:
      return toHex(value);
    case KIND_ENUM: {
      for (const label of Object.keys(entry.options)) if (entry.options[label] === value) return label;
      return String(value);
    }
    case KIND_BOOL:
      return value ? 'on' : 'off';
    case KIND_ENTITY:
    case KIND_POINTS:
      return '(none)';
    case KIND_STRING:
    case KIND_SPRITE:
    case KIND_ANIMATION:
      return value === '' ? '(empty)' : value;
    default:
      return String(value);
  }
}

/**
 * Fill `container` with a field per declared param (or the key/value box).
 * @param {HTMLElement} container - emptied first
 * @param {object|null} description - describeSpawnParams of the class, or null when it declares none
 * @param {object} config - the record's config, `{}` when it has none
 * @param {{ onChange: (key: string, value: unknown) => void, onConfig: (config: object) => void,
 *   entityNames: (className?: string) => string[],
 *   pickEntity?: (key: string, className: string|undefined, button: HTMLElement) => void,
 *   addPoint?: (key: string) => void }} hooks
 */
export function buildParamFields(container, description, config, hooks) {
  container.textContent = '';
  if (description === null) {
    container.appendChild(configBox(config, hooks.onConfig));
    return;
  }
  for (let k = 0; k < description.keys.length; k++) {
    const key = description.keys[k];
    const kind = description.kinds[k];
    const entry = description.entries[k];
    const fallback = description.defaults[k];
    const set = Object.prototype.hasOwnProperty.call(config, key);
    const value = set ? config[key] : kind === KIND_ENTITY ? null : fallback;
    container.appendChild(paramRow(key, kind, entry, fallback, value, set, hooks));
  }
}

function paramRow(key, kind, entry, fallback, value, set, hooks) {
  const row = document.createElement('div');
  row.style.cssText = 'display:grid;grid-template-columns:84px 1fr auto;gap:4px 6px;align-items:center;margin:3px 0';
  row.dataset.key = key;

  const label = document.createElement('span');
  label.textContent = entry.label || key;
  label.title = entry.tip ? `${key}: ${entry.tip}` : key;
  label.style.cssText = 'font-size:11px;color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  row.appendChild(label);

  const commit = (next) => hooks.onChange(key, next);
  row.appendChild(widget(kind, entry, value, commit, hooks, key));

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'debug-ui-btn';
  reset.textContent = '↺';
  reset.title = `Back to the default, ${defaultText(kind, entry, fallback)}`;
  reset.style.visibility = set ? 'visible' : 'hidden';
  reset.onclick = () => commit(kind === KIND_ENTITY || kind === KIND_POINTS ? null : fallback);
  row.appendChild(reset);

  const hint = document.createElement('span');
  hint.style.cssText = `${HINT_STYLE};grid-column:2 / 4`;
  hint.textContent = `default ${defaultText(kind, entry, fallback)}`;
  row.appendChild(hint);
  return row;
}

/** A small button of the debug UI's. */
function button(text, title) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'debug-ui-btn';
  el.textContent = text;
  el.title = title;
  el.style.cssText = 'flex:none;padding:1px 6px';
  return el;
}

/** A field and a button side by side, in the widget's column. */
function inRow(field, side) {
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:4px;align-items:center;min-width:0';
  field.style.flex = '1';
  field.style.minWidth = '0';
  box.appendChild(field);
  box.appendChild(side);
  return box;
}

function widget(kind, entry, value, commit, hooks, key) {
  switch (kind) {
    case KIND_NUMBER:
      return numberWidget(entry, value, commit);
    case KIND_COLOR: {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = toHex(value);
      input.style.cssText = 'width:100%;height:20px;padding:0;border:none;background:none;cursor:pointer';
      input.onchange = () => commit(parseInt(input.value.slice(1), 16));
      return input;
    }
    case KIND_ENUM: {
      const select = selectOf(Object.keys(entry.options).map((label) => [String(entry.options[label]), label]), String(value));
      select.onchange = () => commit(Number(select.value));
      return select;
    }
    case KIND_BOOL: {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'debug-ui-checkbox';
      box.checked = value === true;
      box.onchange = () => commit(box.checked);
      return box;
    }
    case KIND_ENTITY: {
      const names = hooks.entityNames(entry.class);
      const choices = [['', '(none)'], ...names.map((name) => [name, name])];
      if (typeof value === 'string' && !names.includes(value)) choices.push([value, `${value} (missing)`]);
      const select = selectOf(choices, typeof value === 'string' ? value : '');
      select.onchange = () => commit(select.value === '' ? null : select.value);
      if (!hooks.pickEntity) return select;
      // Or a click on the entity in the view (entityPicker.js).
      const pick = button('⌖', `Pick ${entry.class ? `the ${entry.class}` : 'the entity'} in the view (Esc cancels)`);
      pick.dataset.pick = key;
      pick.onclick = () => hooks.pickEntity(key, entry.class, pick);
      return inRow(select, pick);
    }
    case KIND_POINTS: {
      const text = document.createElement('span');
      const pairs = value ? value.length >> 1 : 0;
      text.textContent = `${pairs} point${pairs === 1 ? '' : 's'}`;
      text.title = 'Drag its points in the view; Alt+click on its line adds one there, Del over one removes it';
      text.style.cssText = 'font-size:11px;color:#aaa;flex:1';
      if (!hooks.addPoint) return text;
      const add = button('+', 'Add a point after the last');
      add.dataset.addPoint = key;
      add.onclick = () => hooks.addPoint(key);
      return inRow(text, add);
    }
    case KIND_SPRITE:
    case KIND_ANIMATION:
      // A picker over what the scene loaded, with a thumbnail (assetPicker.js, ED-45).
      return assetPickerWidget(kind, value, commit, hooks.assets ?? null);
    default: {
      // string
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      input.style.cssText = `${FIELD_STYLE};width:100%`;
      input.onchange = () => commit(input.value);
      return input;
    }
  }
}

function numberWidget(entry, value, commit) {
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:4px;align-items:center;min-width:0';
  const field = document.createElement('input');
  field.type = 'number';
  field.value = String(value);
  if (entry.step !== undefined) field.step = String(entry.step);
  else field.step = 'any';
  field.style.cssText = `${FIELD_STYLE};width:64px;flex:none`;
  const clamp = (n) => {
    if (entry.min !== undefined && n < entry.min) return entry.min;
    if (entry.max !== undefined && n > entry.max) return entry.max;
    return n;
  };
  field.onchange = () => {
    const n = Number(field.value);
    if (field.value.trim() === '' || !Number.isFinite(n)) {
      field.value = String(value);
      return;
    }
    commit(clamp(n));
  };
  if (entry.min !== undefined && entry.max !== undefined) {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'debug-ui-range';
    slider.min = String(entry.min);
    slider.max = String(entry.max);
    slider.step = entry.step !== undefined ? String(entry.step) : 'any';
    slider.value = String(value);
    slider.style.cssText = 'flex:1;min-width:0';
    slider.oninput = () => {
      field.value = slider.value;
    };
    slider.onchange = () => commit(clamp(Number(slider.value)));
    box.appendChild(slider);
  }
  box.appendChild(field);
  return box;
}

function selectOf(choices, value) {
  const select = document.createElement('select');
  select.style.cssText = `${FIELD_STYLE};width:100%;cursor:pointer`;
  for (const [optionValue, text] of choices) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = value;
  return select;
}

/** The key/value box of a class without spawnParams: its config as JSON, applied when the box is left. */
function configBox(config, onConfig) {
  const box = document.createElement('div');
  const note = document.createElement('div');
  note.textContent = 'This class declares no spawnParams: its config, as JSON.';
  note.style.cssText = `${HINT_STYLE};white-space:normal;margin-bottom:3px`;
  const area = document.createElement('textarea');
  area.value = JSON.stringify(config, null, 2);
  area.rows = Math.min(10, Math.max(3, area.value.split('\n').length));
  area.spellcheck = false;
  area.style.cssText = `${FIELD_STYLE};width:100%;font-family:monospace;resize:vertical`;
  area.onchange = () => {
    let parsed;
    try {
      parsed = JSON.parse(area.value);
    } catch (error) {
      area.style.borderColor = '#f87171';
      area.title = error.message;
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      area.style.borderColor = '#f87171';
      area.title = 'A config is an object: { "key": value, … }';
      return;
    }
    area.style.borderColor = '';
    area.title = '';
    onConfig(parsed);
  };
  box.appendChild(note);
  box.appendChild(area);
  return box;
}
