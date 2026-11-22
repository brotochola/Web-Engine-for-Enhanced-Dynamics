/**
 * DBG-12: every lighting, sun and camera config key, and every layer kind, has a place in the debug UI or a line in
 * NOT_SHOWN with its reason (src/core/debug/debugUiCoverage.js), so a new option cannot land without either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMERA_DEFAULTS, LAYER_KIND, LIGHTING_DEFAULTS, SUN_DEFAULTS } from '../../src/util/configDefaults.js';
import { NOT_SHOWN, SUN_SHOWN } from '../../src/core/debug/debugUiCoverage.js';
import { LIGHT_OPTIONS_NOT_SHOWN, lightingOptionRows } from '../../src/core/debug/panels/lightPanel.js';
import { cameraProjectionText } from '../../src/core/debug/panels/cameraSection.js';
import { layerDetailsText } from '../../src/core/debug/panels/layersPanel.js';
import { Sun } from '../../src/core/sun.js';

test('every LIGHTING_DEFAULTS key is in the Light tab\'s options table or NOT_SHOWN, never both', () => {
  const listed = new Set(lightingOptionRows({}).map(([key]) => key));
  for (const key of Object.keys(LIGHTING_DEFAULTS)) {
    const reason = NOT_SHOWN.lighting[key];
    assert.ok(listed.has(key) !== Boolean(reason), `lighting.${key}: shown or a reason, one of them`);
  }
  assert.deepEqual(Object.keys(LIGHT_OPTIONS_NOT_SHOWN).sort(), Object.keys(NOT_SHOWN.lighting).sort());
});

test('every SUN_DEFAULTS key drives a Sun control in the Light tab or has a reason', () => {
  for (const key of Object.keys(SUN_DEFAULTS)) {
    const shown = SUN_SHOWN[key];
    const reason = NOT_SHOWN.sun[key];
    assert.ok(Boolean(shown) !== Boolean(reason), `sun.${key}: shown or a reason, one of them`);
    if (!shown || shown === 'dayCycle') continue;
    const d = Object.getOwnPropertyDescriptor(Sun, shown);
    assert.ok(d && typeof d.set === 'function', `Sun.${shown} has a setter for sun.${key}`);
  }
  assert.equal(typeof Sun.setTimeOfDay, 'function');
});

test('every CAMERA_DEFAULTS key shows in the camera section\'s projection line', () => {
  const text = cameraProjectionText({ pitch: 30, yaw: 45, floorScaleY: 0.5, heightScaleY: 0.75 });
  for (const key of Object.keys(CAMERA_DEFAULTS)) {
    assert.ok(text.includes(key) || NOT_SHOWN.camera[key], `camera.${key}`);
  }
});

test('every LAYER_KIND reads by name in the Layers panel\'s details line', () => {
  for (const kind of Object.values(LAYER_KIND)) {
    const layer = { kind, builtIn: false, resolution: 1, scaleMode: 0, hasShader: false };
    assert.ok(layerDetailsText(layer, null).startsWith(kind) || NOT_SHOWN.layerKinds[kind], kind);
  }
});
