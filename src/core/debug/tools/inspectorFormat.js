// inspectorFormat.js — DBG-10: what the inspector's numbers mean. A formatter per component and field turns a number
// the engine packs (bits, an entity id, radians, a colour, an enum) into words; a field without one shows as the plain
// number formatComponentValue makes. DBG-12's test lists the fields that have none.

import { GBUF_FLAGS, SPRITE_NORMALS_NAMES } from '../../../render/gbufWord.js';
import { CAST_KIND, SELF_SHADOW } from '../../../components/shadowCaster.js';
import { entityIdNone } from '../../../util/entityIdWidth.js';
import { formatComponentValue } from '../../../util/utils.js';

const DEG = 180 / Math.PI;

/** An enum's names by value, lower case with spaces ({ HEIGHT_MAP: 2 } -> 'height map'). */
function namesOf(table) {
  const out = [];
  for (const [key, value] of Object.entries(table)) out[value] = key.toLowerCase().replace(/_/g, ' ');
  return out;
}

const CAST_KIND_NAMES = namesOf(CAST_KIND);
const SELF_SHADOW_NAMES = namesOf(SELF_SHADOW);
const SWAY_NAMES = ['off', 'loop', 'impulse', 'loop shear'];

function named(names, v) {
  return names[v] ?? String(v);
}

const yesNo = (v) => (v ? 'yes' : 'no');
const degrees = (v) => `${(v * DEG).toFixed(1)}°`;
const px = (v) => `${formatComponentValue('', v)} px`;
const share = (v) => `${Math.round(v * 100)} %`;
const hexColor = (v) => `#${((v >>> 0) & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}`;

/** SpriteRenderer.gbufFlags as its named bits (gbufWord.js GBUF_FLAGS): normals, surface, unshaded. */
export function gbufFlagsText(v) {
  let text = `normals ${SPRITE_NORMALS_NAMES[v & GBUF_FLAGS.NORMALS_MASK]} · ${(v & GBUF_FLAGS.FLOOR) !== 0 ? 'floor' : 'standing'}`;
  if ((v & GBUF_FLAGS.UNSHADED) !== 0) text += ' · unshaded';
  return text;
}

/**
 * An entity id as a link's text: none, the entity, or an orphan's id flagged (its parent's slot is free). `active`
 * is Transform.active, passed by the caller so this module reads no component's columns by itself.
 */
export function entityRefText(v, active) {
  if (!(v < entityIdNone)) return 'none';
  return active && active[v] ? `#${v}` : `#${v} (gone: an orphan)`;
}

/**
 * The formatters, by component name and field: (value, index, Comp) -> text. Transform.parent is drawn by the
 * inspector as a link (toolManager.js), with this text.
 */
export const INSPECTOR_FORMATTERS = Object.freeze({
  SpriteRenderer: {
    gbufFlags: (v) => gbufFlagsText(v),
  },
  Transform: {
    parent: (v, _i, Comp) => entityRefText(v, Comp.active),
    localRotation: degrees,
  },
  LightEmitter: {
    color: hexColor,
    radius: px,
    elevation: px,
    shadowRange: (v) => (v > 0 ? px(v) : 'its radius'),
    glowRadius: (v) => (v > 0 ? px(v) : '0.85 of its radius'),
    // π (or more) means no cone: the light shines all round.
    coneHalf: (v) => (v >= Math.PI - 1e-4 ? 'no cone' : `${degrees(2 * v)} aperture`),
    coneSoftness: share,
    tilt: (v) => (v === 0 ? 'level' : `${degrees(Math.abs(v))} ${v > 0 ? 'down' : 'up'}`),
    castShadows: yesNo,
    followFlip: yesNo,
  },
  ShadowCaster: {
    sunKind: (v) => named(CAST_KIND_NAMES, v),
    lampKind: (v) => named(CAST_KIND_NAMES, v),
    orient: (v) => (v ? 'along the object' : 'facing the light'),
    opacity: share,
    selfShadow: (v) => named(SELF_SHADOW_NAMES, v),
    textureId: (v) => (v ? `frame ${v - 1}` : "the sprite's"),
    baseRadius: (v) => (v > 0 ? px(v) : 'measured'),
  },
  DecorationComponent: {
    sway: (v) => named(SWAY_NAMES, v),
    swayAmplitude: degrees,
    tint: hexColor,
    parentEntityIndex: (v) => (v < entityIdNone ? `#${v}` : 'none'),
  },
});

/** One field's text in the inspector: its formatter's, else the plain number. */
export function formatInspectorField(componentName, propName, value, index, Comp) {
  const format = INSPECTOR_FORMATTERS[componentName]?.[propName];
  if (format === undefined || value === undefined || value === null) return formatComponentValue(propName, value);
  return format(value, index, Comp);
}

/** Up to `max` children of entity `index` (Transform.parent), and how many it has: the inspector's children line. */
export function childrenOf(parentColumn, active, index, max, out) {
  out.length = 0;
  let count = 0;
  if (!parentColumn || !active) return 0;
  for (let i = 0; i < parentColumn.length; i++) {
    if (parentColumn[i] !== index || !active[i]) continue;
    if (count < max) out.push(i);
    count++;
  }
  return count;
}
