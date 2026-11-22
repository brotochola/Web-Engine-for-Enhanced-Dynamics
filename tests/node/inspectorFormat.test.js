/**
 * DBG-10: the inspector says what the numbers mean: G-buffer flags as named bits, the parent as an entity (an orphan
 * flagged), the children found, light cones in degrees, caster kinds by name; a field without a formatter stays the
 * plain number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GBUF_FLAGS, SPRITE_NORMALS } from '../../src/render/gbufWord.js';
import { CAST_KIND, SELF_SHADOW } from '../../src/components/shadowCaster.js';
import { entityIdNone } from '../../src/util/entityIdWidth.js';
import {
  INSPECTOR_FORMATTERS,
  childrenOf,
  entityRefText,
  formatInspectorField,
  gbufFlagsText,
} from '../../src/core/debug/tools/inspectorFormat.js';

test('gbufFlags reads as its bits: normals, surface, unshaded', () => {
  assert.equal(gbufFlagsText(0), 'normals auto · standing');
  assert.equal(gbufFlagsText(SPRITE_NORMALS.HEIGHT | GBUF_FLAGS.FLOOR), 'normals height · floor');
  assert.equal(gbufFlagsText(SPRITE_NORMALS.FLAT | GBUF_FLAGS.UNSHADED), 'normals flat · standing · unshaded');
  assert.equal(formatInspectorField('SpriteRenderer', 'gbufFlags', SPRITE_NORMALS.MAP, 0, {}), 'normals map · standing');
});

test('the parent is an entity, none, or an orphan whose parent slot is free', () => {
  const active = new Uint8Array([1, 0, 1]);
  assert.equal(entityRefText(entityIdNone, active), 'none');
  assert.equal(entityRefText(2, active), '#2');
  assert.equal(entityRefText(1, active), '#1 (gone: an orphan)');
  assert.equal(formatInspectorField('Transform', 'parent', 2, 0, { active }), '#2');
});

test('children: every live entity whose parent is the one inspected, the first few named', () => {
  const parent = new Uint16Array([entityIdNone, 0, 0, 0, 1, 0]);
  const active = new Uint8Array([1, 1, 1, 0, 1, 1]);
  const out = [];
  assert.equal(childrenOf(parent, active, 0, 2, out), 3, 'entity 3 is not alive');
  assert.deepEqual(out, [1, 2]);
  assert.equal(childrenOf(parent, active, 4, 8, out), 0);
  assert.deepEqual(out, []);
});

test('lights, casters and decorations in their units and names', () => {
  const f = (c, p, v) => formatInspectorField(c, p, v, 0, {});
  assert.equal(f('LightEmitter', 'coneHalf', Math.PI), 'no cone');
  assert.equal(f('LightEmitter', 'coneHalf', Math.PI / 4), '90.0° aperture');
  assert.equal(f('LightEmitter', 'color', 0xffaa00), '#FFAA00');
  assert.equal(f('LightEmitter', 'shadowRange', 0), 'its radius');
  assert.equal(f('LightEmitter', 'elevation', 40), '40 px');
  assert.equal(f('ShadowCaster', 'sunKind', CAST_KIND.HEIGHT_MAP), 'height map');
  assert.equal(f('ShadowCaster', 'selfShadow', SELF_SHADOW.OFF), 'off');
  assert.equal(f('ShadowCaster', 'opacity', 0.5), '50 %');
  assert.equal(f('ShadowCaster', 'textureId', 0), "the sprite's");
  assert.equal(f('DecorationComponent', 'sway', 3), 'loop shear');
  assert.equal(f('DecorationComponent', 'parentEntityIndex', entityIdNone), 'none');
});

test('a field without a formatter shows the plain number, and every formatter names a real field', async () => {
  assert.equal(formatInspectorField('LightEmitter', 'offsetX', 2.5, 0, {}), '2.50');
  assert.equal(formatInspectorField('Unknown', 'x', 3, 0, {}), '3');
  const modules = {
    SpriteRenderer: '../../src/components/spriteRenderer.js',
    Transform: '../../src/components/transform.js',
    LightEmitter: '../../src/components/lightEmitter.js',
    ShadowCaster: '../../src/components/shadowCaster.js',
    DecorationComponent: '../../src/components/decorationComponent.js',
  };
  for (const [name, file] of Object.entries(modules)) {
    const Comp = (await import(file))[name];
    for (const field of Object.keys(INSPECTOR_FORMATTERS[name])) {
      assert.ok(field in Comp.ARRAY_SCHEMA, `${name}.${field} is a column`);
    }
  }
});
