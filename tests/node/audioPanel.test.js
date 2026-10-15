import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundManager } from '../../src/core/soundManager.js';
import { AudioPanel } from '../../src/core/debug/panels/audioPanel.js';

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

const ctx2d = {
  setTransform() {},
  clearRect() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  stroke() {},
  fill() {},
  closePath() {},
  fillText() {},
};

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.classList = new ClassList();
    this.children = [];
    this.style = {
      setProperty(name, value) { this[name] = value; },
    };
    this.textContent = '';
    this.listeners = {};
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.placeholder = '';
    this.title = '';
    this.width = 0;
    this.height = 0;
  }
  get clientWidth() { return 240; }
  get clientHeight() { return 72; }
  append(...nodes) {
    for (let i = 0; i < nodes.length; i++) this.appendChild(nodes[i]);
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  addEventListener(type, fn) {
    const list = this.listeners[type] || (this.listeners[type] = []);
    list.push(fn);
  }
  setPointerCapture() {}
  getContext() { return ctx2d; }
}

function installDocument() {
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = {
    createElement(tag) { return new El(tag); },
  };
}

function walk(el, out = []) {
  out.push(el);
  const children = el.children || [];
  for (let i = 0; i < children.length; i++) walk(children[i], out);
  return out;
}

function bootAudio() {
  SoundManager.setEnabled(true);
  SoundManager._nameToId.clear();
  SoundManager._idToName.length = 0;
  SoundManager._clearAssets();
  SoundManager._muted = false;
  SoundManager._savedMasterVolume = 1;
  const slots = 8;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 0.5;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager.configureChannels({
    sfx: { volume: 0.5, pan: 0, maxVoices: slots },
  });
  SoundManager._ensureLevelsSab();
  SoundManager._levelsI32.fill(0);
  SoundManager._levelsReadIndex = -1;
  for (const name of ['boom', 'quiet']) {
    const id = SoundManager._assignId(name);
    SoundManager._beginAsset(id, name, '/' + name + '.mp3');
    SoundManager._readyAsset(id, {
      numberOfChannels: 1,
      length: 480,
      sampleRate: 48000,
      duration: 0.01,
    });
  }
}

function metrics() {
  return {
    state: 'running',
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    processMs: 0.1,
    activeSlots: SoundManager.getActiveSlotCount(),
    maxSlots: SoundManager._maxSlots,
    dropped: 0,
    masterVolume: 1,
    mixGain: 0.5,
    muted: false,
  };
}

test('the audio panel pools voice rows, filters assets, and keeps a dragged fader', { concurrency: false }, () => {
  installDocument();
  bootAudio();
  const panel = new AudioPanel({ scene: { audioMetrics: metrics() } });
  panel.create();
  for (let i = 0; i < 3; i++) {
    SoundManager.play('boom', 0.8, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  }
  panel.update();
  panel.update();
  const visibleVoices = panel._voiceRows.filter((row) => row.root.style.display !== 'none');
  assert.equal(visibleVoices.length, 3);
  assert.equal(panel._voiceRows.length, 3);

  const nodes = walk(panel.panel);
  const filter = nodes.find((el) => el.placeholder === 'Filter');
  assert.ok(filter, 'asset filter input');
  filter.value = 'zzz';
  for (const fn of filter.listeners.input) fn();
  panel.update();
  const visibleAssets = panel._assetRows.filter((row) => row.root.style.display !== 'none');
  assert.equal(visibleAssets.length, 0);
  assert.equal(panel.elements.assetEmpty.textContent, 'No assets match');

  const fader = nodes.find((el) => String(el.className).includes('debug-ui-audio-fader'));
  assert.ok(fader, 'bus fader');
  fader.value = '20';
  fader._drag = true;
  SoundManager.channel('sfx').volume = 0.9;
  panel.update();
  assert.equal(fader.value, '20');
});
