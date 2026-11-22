/**
 * DBG-8: the Light tab. Each sun slider calls the Sun setter with its value; the options table lists every key of
 * LIGHTING_DEFAULTS but those it says it leaves out; the lamps list reads LightEmitter's columns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Sun } from '../../src/core/sun.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LIGHTING_DEFAULTS } from '../../src/util/configDefaults.js';
import {
  LIGHT_OPTIONS_NOT_SHOWN,
  LightPanel,
  SUN_SLIDERS,
  activeLamps,
  lampText,
  lightingOptionRows,
  sliderText,
} from '../../src/core/debug/panels/lightPanel.js';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.title = '';
    this.checked = false;
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  set innerHTML(_html) {
    this.children = [];
  }
  getContext() {
    return null;
  }
}

function withDom(fn) {
  globalThis.document = { activeElement: null, createElement: (tag) => new El(tag) };
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

test('every sun slider is a Sun property with a setter, and moving one sets it', () => {
  for (const s of SUN_SLIDERS) {
    const d = Object.getOwnPropertyDescriptor(Sun, s.key);
    assert.ok(d && typeof d.set === 'function', `Sun.${s.key} has a setter`);
  }
  Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  try {
    withDom(() => {
      const panel = new LightPanel({ scene: { config: { lighting: { enabled: true, sun: { dayCycle: { enabled: false, speed: 1 } } } } } });
      panel.create();
      const angle = panel.sliders.find((s) => s.spec.key === 'angle');
      angle.input.value = '135';
      angle.input.oninput();
      assert.equal(Sun.angle, 135);
      assert.equal(angle.val.textContent, '135');
      const night = panel.sliders.find((s) => s.spec.key === 'nightIntensity');
      night.input.value = '0.25';
      night.input.oninput();
      assert.ok(Math.abs(Sun.nightIntensity - 0.25) < 1e-6);
      panel.hour.value = '12';
      panel.hour.oninput();
      assert.equal(Sun.hour, 12);
      panel.dayCycle.checked = true;
      panel.dayCycle.onchange();
      assert.equal(panel.debugUI.scene.config.lighting.sun.dayCycle.enabled, true);
      panel.update();
      assert.equal(panel.status.textContent, 'Sun off (lighting.sun.enabled)');
    });
  } finally {
    Sun.unbind();
  }
});

test('the options table lists every LIGHTING_DEFAULTS key it does not say it leaves out', () => {
  const rows = lightingOptionRows({ sunShadows: 'map', maxLights: 32 });
  const keys = rows.map(([k]) => k);
  for (const key of Object.keys(LIGHTING_DEFAULTS)) {
    assert.ok(keys.includes(key) || key in LIGHT_OPTIONS_NOT_SHOWN, key);
  }
  assert.deepEqual(rows.find(([k]) => k === 'sunShadows'), ['sunShadows', 'map']);
  assert.deepEqual(rows.find(([k]) => k === 'lampShadows'), ['lampShadows', String(LIGHTING_DEFAULTS.lampShadows)]);
  assert.equal(sliderText(0.456, 0.01), '0.46');
  assert.equal(sliderText(45.5, 0.5), '45.5');
});

test('the lamps: the active LightEmitters, each line its radius, brightness, elevation, cone and shadows', () => {
  const keys = ['active', 'radius', 'brightness', 'elevation', 'coneHalf', 'castShadows'];
  const saved = Object.fromEntries(keys.map((k) => [k, LightEmitter[k]]));
  try {
    LightEmitter.active = new Uint8Array([0, 1, 0, 1]);
    LightEmitter.radius = new Float32Array([0, 240, 0, 80]);
    LightEmitter.brightness = new Float32Array([0, 1, 0, 0.5]);
    LightEmitter.elevation = new Float32Array([0, 40, 0, 0]);
    LightEmitter.coneHalf = new Float32Array([0, Math.PI, 0, Math.PI / 4]);
    LightEmitter.castShadows = new Uint8Array([0, 1, 0, 0]);
    const out = [];
    assert.equal(activeLamps(8, out), 2);
    assert.deepEqual(out, [1, 3]);
    assert.equal(lampText(1), '#1 · r 240 · bright 1.00 · elev 40 px · no cone · shadows');
    assert.equal(lampText(3), '#3 · r 80 · bright 0.50 · elev 0 px · cone 90°');
  } finally {
    Object.assign(LightEmitter, saved);
  }
});
