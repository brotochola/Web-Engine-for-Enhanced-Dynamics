#!/usr/bin/env node
/**
 * Kernel: AudioPanel.update on a document stub. Not a worker step.
 * Cases: 0 voices and 200 voices. Checksum is the pooled voice-row count.
 *
 *   node tests/bench/audioPanelMicrobench.mjs
 *   node tests/bench/audioPanelMicrobench.mjs --output out.json
 */
import { SoundManager } from '../../src/core/soundManager.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

class ClassList {
  constructor() { this.set = new Set(); }
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
  setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {},
  moveTo() {}, lineTo() {}, stroke() {}, fill() {}, closePath() {}, fillText() {},
};

class El {
  constructor() {
    this.className = '';
    this.classList = new ClassList();
    this.children = [];
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.textContent = '';
    this.listeners = {};
    this.value = '';
    this.type = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.placeholder = '';
    this.title = '';
    this.disabled = false;
    this.width = 0;
    this.height = 0;
  }
  get clientWidth() { return 240; }
  get clientHeight() { return 72; }
  append(...nodes) { for (let i = 0; i < nodes.length; i++) this.appendChild(nodes[i]); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) {
    const list = this.listeners[type] || (this.listeners[type] = []);
    list.push(fn);
  }
  setPointerCapture() {}
  getContext() { return ctx2d; }
}

function installDocument() {
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement() { return new El(); } };
}

function boot(slots) {
  SoundManager.setEnabled(true);
  SoundManager._nameToId.clear();
  SoundManager._idToName.length = 0;
  SoundManager._clearAssets();
  SoundManager._muted = false;
  SoundManager._savedMasterVolume = 1;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 0.5;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager.configureChannels({ sfx: { volume: 1, pan: 0, maxVoices: slots } });
  SoundManager._ensureLevelsSab();
  SoundManager._levelsI32.fill(0);
  SoundManager._levelsReadIndex = -1;
  const id = SoundManager._assignId('tone');
  SoundManager._beginAsset(id, 'tone', '/tone.mp3');
  SoundManager._readyAsset(id, { numberOfChannels: 1, length: 480, sampleRate: 48000, duration: 0.01 });
}

function metrics() {
  return {
    state: 'running',
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    processMs: 0,
    activeSlots: 0,
    maxSlots: SoundManager._maxSlots,
    dropped: 0,
    masterVolume: 1,
    mixGain: 0.5,
    muted: false,
  };
}

async function main() {
  const args = parseArgs();
  installDocument();
  const { AudioPanel } = await import('../../src/core/debug/panels/audioPanel.js');
  boot(256);
  const scene = { audioMetrics: metrics() };
  const idle = new AudioPanel({ scene });
  idle.create();
  idle.update();
  const playing = new AudioPanel({ scene });
  playing.create();
  for (let i = 0; i < 200; i++) {
    SoundManager.play('tone', 0.5, 1, 1, 1, 0, Number.NaN, Number.NaN, 'sfx');
  }
  playing.update();
  const checksum = playing._voiceRows.length;
  if (checksum !== 200 || idle._voiceRows.length !== 0) {
    throw new Error(`panel rows idle ${idle._voiceRows.length} playing ${checksum}`);
  }
  const cases = {
    voices0: timeIt('AudioPanel.update 0 voices', (iters) => {
      for (let i = 0; i < iters; i++) idle.update();
    }, { iterations: 20 }),
    voices200: timeIt('AudioPanel.update 200 voices', (iters) => {
      for (let i = 0; i < iters; i++) playing.update();
    }, { iterations: 10 }),
  };
  const report = {
    feature: 'audio-panel-update',
    functions: ['AudioPanel.update'],
    n: 200,
    seed: 0xa11d10,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify({
    checksum,
    voices0: cases.voices0.opsPerSec,
    voices200: cases.voices200.opsPerSec,
  }));
}

if (isCli(import.meta.url)) await main();
