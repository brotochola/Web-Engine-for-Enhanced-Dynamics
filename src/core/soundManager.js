// SoundManager.js — Static audio mixer for WeedJS (AudioWorklet + SharedArrayBuffer)
//
// Workers + main thread write play commands to a shared SAB slot array.
// AudioWorklet reads SAB slots every process() call, mixes active sounds, outputs audio.
// Main thread decodes audio files and sends PCM to the worklet via postMessage.
//
// SAB Layout (HEADER_SIZE + maxSlots * SLOT_SIZE words × 4 bytes):
//   HEADER [0..3]: [maxSlots(i32), droppedCount(i32), mixGain(f32), masterVolume(f32)]
//   Each SLOT [+0..+7]:
//     +0 state   (Int32)   0=free 1=playing 2=claiming
//     +1 audioId (Int32)
//     +2 pitch   (Float32) playback rate
//     +3 pan     (Float32) -1..+1
//     +4 volume  (Float32) 0..1
//     +5 loop    (Int32)   0=once 1=loop
//     +6 cursor  (Float32) fractional sample position (worklet writes)
//     +7 channel (Int32)   bus in bits 0..7, per-bus list index in bits 8..23

import { AUDIO_DEFAULTS } from '../util/configDefaults.js';
import { rng } from '../util/utils.js';
import { debugWorkerLog } from '../util/debugLog.js';

export class SoundManager {
  static _enabled = true;
  static _nameToId = new Map();
  static _idToName = [];

  // SAB slot layout
  static HEADER_SIZE = 4;
  static HEADER_DROPPED = 1;
  static HEADER_MIX_GAIN = 2;
  static HEADER_MASTER_VOL = 3;
  static SLOT_SIZE = 8;
  static STATE_FREE = 0;
  static STATE_PLAYING = 1;
  static STATE_CLAIMING = 2;

  // Slot SAB views (shared between workers and main thread)
  static _sab = null;
  static _i32 = null;
  static _f32 = null;
  static _maxSlots = 0;

  // AudioWorklet (main thread only)
  static _audioCtx = null;
  static _workletNode = null;
  /** SharedArrayBuffer: Float32[1] = last process() wall ms (worklet → main). */
  static _processMsSab = null;
  static _processMsF32 = null;

  // Output level ring, separate from the slot SAB. Worklet writes one quantum
  // at a time; the debug UI folds the new entries. Header words:
  //   [0] writeIndex i32  [1] clipSticky i32  [2] reserved  [3] reserved
  // then LEVEL_RING floats of peakL, peakR, and mean square.
  static LEVEL_HEADER = 4;
  static LEVEL_RING = 256; // power of two; the reader masks with RING - 1
  static _levelsSab = null;
  static _levelsI32 = null;
  static _levelsF32 = null;
  static _levelsReadIndex = -1;
  static _levelSample = { peakL: 0, peakR: 0, rms: 0, clip: false, count: 0 };

  // Bus SAB. Header is the master compressor, then each bus.
  // Header: [threshold, ratio, attack, release, reduction, highWater, unused ×2]
  // Bus stride 8: [volume, pan, mute i32, reduction, threshold, ratio, attack, release]
  // Tail, one block per bus: [lock, count, quietSlot, quietVol, secondSlot, secondVol, unused ×2, slot ids...]
  // Slot word +7 is the bus in the low 8 bits and that bus's list index above them.
  static MAX_CHANNELS = 8;
  static CHANNEL_HEADER = 8;
  static CHANNEL_STRIDE = 8;
  static LIST_CAP = 2048;
  static TAIL_META = 8;
  /** Fallback when a bus omits maxVoices. A scene value above this is kept. */
  static get maxVoicesPerChannel() {
    const n = AUDIO_DEFAULTS.maxVoicesPerChannel | 0;
    return n > 0 ? n : 1;
  }

  /** Pick-list size for the worklet: the largest bus cap in this scene. */
  static get voiceCap() {
    let cap = this.maxVoicesPerChannel;
    const count = this._channelCount | 0;
    for (let i = 0; i < count; i++) {
      const n = this._channelMaxVoices[i] | 0;
      if (n > cap) cap = n;
    }
    return cap;
  }
  static DEFAULT_BUS_COMPRESSOR = Object.freeze({ threshold: 0.6, ratio: 4, attack: 0.01, release: 0.15 });
  static DEFAULT_MASTER_COMPRESSOR = Object.freeze({ threshold: 0.85, ratio: 12, attack: 0.005, release: 0.12 });
  static _channelMaxVoices = [0, 0, 0, 0, 0, 0, 0, 0];
  static _channelSab = null;
  static _channelI32 = null;
  static _channelF32 = null;
  static _channelNames = [];
  static _channelNameToIndex = new Map();
  static _channelHandles = new Map();
  static _channelWarned = new Set();
  static _channelCount = 1;
  static _channelRev = 0;

  // Main-thread catalog. PCM itself stays in the worklet.
  static _assetRev = 0;
  static _assets = [];
  static _assetById = new Map();

  // Volume state (main thread tracks these for mute/unmute restore)
  static _muted = false;
  static _savedMasterVolume = 1.0;

  // Spatial culling / panning
  static _spatialResult = { audible: 1, gain: 1, pan: 0 };

  // Autoplay gate
  static _audioUnlocked = false;
  static _unlockListenersAttached = false;
  static _unlockHandler = null;

  // ─── Context helpers ────────────────────────────────────────────────────────

  static _isWorkerContext() {
    return typeof window === 'undefined' && typeof self !== 'undefined';
  }

  static setEnabled(enabled) {
    this._enabled = !!enabled;
  }

  // ─── Autoplay gate ──────────────────────────────────────────────────────────

  static initializeAutoplayGate() {
    if (this._isWorkerContext()) return;
    if (this._unlockListenersAttached) return;

    if (this._hasUserActivation()) {
      this._audioUnlocked = true;
      this._tryResumeAudioContext();
      return;
    }

    this._unlockHandler = () => {
      this._audioUnlocked = true;
      this._tryResumeAudioContext();
      this._detachUnlockListeners();
    };

    const opts = { capture: true, passive: true };
    document.addEventListener('pointerdown', this._unlockHandler, opts);
    document.addEventListener('touchstart', this._unlockHandler, opts);
    document.addEventListener('keydown', this._unlockHandler, opts);
    this._unlockListenersAttached = true;
  }

  static isAudioUnlocked() {
    if (this._isWorkerContext()) return false;
    return this._audioUnlocked || this._hasUserActivation() || this._isAudioContextRunning();
  }

  // ─── AudioWorklet initialization (main thread only) ─────────────────────────

  static async initializeAudioWorklet(maxSlots = 64, mixGain = 0.5, masterVolume = 1.0, channels, masterCompressor) {
    if (this._isWorkerContext()) return false;

    if (this._audioCtx) {
      this._reconfigureForNewScene(maxSlots, mixGain, masterVolume, channels, masterCompressor);
      return true;
    }

    this._audioCtx = new AudioContext({ latencyHint: 'interactive' });

    let processorUrl;
    if (typeof globalThis.WEED?.ensureEmbeddedSources === 'function') {
      await globalThis.WEED.ensureEmbeddedSources();
    }
    const embedded = typeof globalThis.WEED !== 'undefined' && globalThis.WEED.AudioWorkletSource;
    if (embedded) {
      const blob = new Blob([embedded], { type: 'application/javascript' });
      processorUrl = URL.createObjectURL(blob);
    } else {
      processorUrl = new URL('../workers/audioMixerProcessor.js', import.meta.url).href;
    }
    try {
      await this._audioCtx.audioWorklet.addModule(processorUrl);
    } finally {
      // The module is compiled at this point; the blob URL is no longer needed.
      if (embedded) URL.revokeObjectURL(processorUrl);
    }

    this._maxSlots = maxSlots;
    const sabBytes = (this.HEADER_SIZE + maxSlots * this.SLOT_SIZE) * 4;
    this._sab = new SharedArrayBuffer(sabBytes);
    this._i32 = new Int32Array(this._sab);
    this._f32 = new Float32Array(this._sab);
    this._i32.fill(0);
    Atomics.store(this._i32, 0, maxSlots);

    this._f32[this.HEADER_MIX_GAIN] = Math.max(0, Math.min(1, mixGain));
    this._f32[this.HEADER_MASTER_VOL] = Math.max(0, Math.min(1, masterVolume));
    this._savedMasterVolume = this._f32[this.HEADER_MASTER_VOL];
    this._muted = false;

    this._processMsSab = new SharedArrayBuffer(4);
    this._processMsF32 = new Float32Array(this._processMsSab);
    this._processMsF32[0] = 0;
    this._ensureLevelsSab();

    this._workletNode = new AudioWorkletNode(this._audioCtx, 'weed-audio-mixer', {
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this._workletNode.connect(this._audioCtx.destination);
    this.configureChannels(channels, masterCompressor);
    this._postWorkletInit();

    debugWorkerLog(
      `[SoundManager] AudioWorklet mixer initialized (${maxSlots} slots, mixGain=${mixGain}, masterVol=${masterVolume})`
    );
    return true;
  }

  static _ensureLevelsSab() {
    if (this._levelsSab) return;
    const words = this.LEVEL_HEADER + this.LEVEL_RING * 3;
    this._levelsSab = new SharedArrayBuffer(words * 4);
    this._levelsI32 = new Int32Array(this._levelsSab);
    this._levelsF32 = new Float32Array(this._levelsSab);
    this._levelsReadIndex = -1;
  }

  static _postWorkletInit() {
    if (!this._workletNode || !this._sab) return;
    this._ensureLevelsSab();
    this._ensureChannelSab();
    this._workletNode.port.postMessage({
      type: 'init',
      sab: this._sab,
      maxSlots: this._maxSlots,
      processMsSab: this._processMsSab,
      levelsSab: this._levelsSab,
      channelSab: this._channelSab,
      channelCount: this._channelCount,
      maxVoices: this._channelMaxVoices.slice(0, this.MAX_CHANNELS),
      voiceCap: this.voiceCap,
    });
  }

  /** Drop level-ring history so a scene switch does not graph the previous mix. */
  static _snapLevelsCursor() {
    const i32 = this._levelsI32;
    if (!i32) {
      this._levelsReadIndex = -1;
      return;
    }
    Atomics.store(i32, 1, 0);
    this._levelsReadIndex = Atomics.load(i32, 0);
  }

  static getSlotSABConfig() {
    if (!this._sab) return null;
    return { sab: this._sab, maxSlots: this._maxSlots };
  }

  static _tailWords() {
    return this.MAX_CHANNELS * (this.TAIL_META + this.LIST_CAP);
  }

  static _tailBase() {
    return this.CHANNEL_HEADER + this.MAX_CHANNELS * this.CHANNEL_STRIDE;
  }

  static _tail(bus) {
    return this._tailBase() + (bus | 0) * (this.TAIL_META + this.LIST_CAP);
  }

  static _ensureChannelSab() {
    const words = this._tailBase() + this._tailWords();
    if (this._channelSab && this._channelI32 && this._channelI32.length >= words) return;
    this._channelSab = new SharedArrayBuffer(words * 4);
    this._channelI32 = new Int32Array(this._channelSab);
    this._channelF32 = new Float32Array(this._channelSab);
    this._resetBusTails();
  }

  static _resetBusTails() {
    const i32 = this._channelI32;
    const f32 = this._channelF32;
    if (!i32 || i32.length < this._tailBase() + this._tailWords()) return;
    for (let bus = 0; bus < this.MAX_CHANNELS; bus++) {
      const t = this._tail(bus);
      i32[t] = 0;
      i32[t + 1] = 0;
      i32[t + 2] = -1;
      f32[t + 3] = Infinity;
      i32[t + 4] = -1;
      f32[t + 5] = Infinity;
    }
  }

  static _postChannelCount() {
    if (!this._workletNode) return;
    this._workletNode.port.postMessage({
      type: 'channels',
      channelCount: this._channelCount,
      maxVoices: this._channelMaxVoices.slice(0, this.MAX_CHANNELS),
      voiceCap: this.voiceCap,
    });
  }

  /**
   * Replace the bus list. `channels` is `{ name: { volume, pan } }` in declaration
   * order. The first bus is the default for play() calls that omit a channel.
   * More than MAX_CHANNELS throws. Workers do not call this; they import the map.
   */
  static configureChannels(channels, masterCompressor) {
    const list = this._normalizeChannels(channels);
    if (list.length > this.MAX_CHANNELS) {
      throw new Error(`Audio channels exceed ${this.MAX_CHANNELS} (got ${list.length})`);
    }
    this._ensureChannelSab();
    this._channelNames.length = 0;
    this._channelNameToIndex.clear();
    this._channelHandles.clear();
    const f32 = this._channelF32;
    const i32 = this._channelI32;
    const stride = this.CHANNEL_STRIDE;
    const header = this.CHANNEL_HEADER;
    this._writeCompressor(0, this._clampCompressor(masterCompressor, this.DEFAULT_MASTER_COMPRESSOR), true);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      this._channelNames[i] = entry.name;
      this._channelNameToIndex.set(entry.name, i);
      this._channelMaxVoices[i] = entry.maxVoices;
      const b = header + i * stride;
      f32[b] = entry.volume;
      f32[b + 1] = entry.pan;
      i32[b + 2] = entry.maxVoices << 8;
      f32[b + 3] = 1;
      this._writeCompressor(b, entry.compressor, false);
    }
    for (let i = list.length; i < this.MAX_CHANNELS; i++) {
      const b = header + i * stride;
      this._channelMaxVoices[i] = this.maxVoicesPerChannel;
      f32[b] = 1;
      f32[b + 1] = 0;
      i32[b + 2] = this.maxVoicesPerChannel << 8;
      f32[b + 3] = 1;
      this._writeCompressor(b, this.DEFAULT_BUS_COMPRESSOR, false);
    }
    this._channelCount = list.length;
    Atomics.store(i32, 5, 0);
    this._resetBusTails();
    this._channelRev++;
  }

  /** Master words sit at 0. Bus words sit at base+4. Reduction is reset to 1. */
  static _writeCompressor(base, comp, master) {
    const f32 = this._channelF32;
    const at = master ? base : base + 4;
    f32[at] = comp.threshold;
    f32[at + 1] = comp.ratio;
    f32[at + 2] = comp.attack;
    f32[at + 3] = comp.release;
    if (master) f32[4] = 1;
  }

  static _clampCompressor(def, fallback) {
    const src = def && typeof def === 'object' ? def : fallback;
    let threshold = Number(src.threshold);
    let ratio = Number(src.ratio);
    let attack = Number(src.attack);
    let release = Number(src.release);
    if (!Number.isFinite(threshold)) threshold = fallback.threshold;
    else if (threshold < 0) threshold = 0;
    else if (threshold > 1) threshold = 1;
    if (!Number.isFinite(ratio) || ratio < 1) ratio = fallback.ratio;
    else if (ratio > 100) ratio = 100;
    if (!Number.isFinite(attack) || attack < 0) attack = fallback.attack;
    else if (attack > 2) attack = 2;
    if (!Number.isFinite(release) || release < 0) release = fallback.release;
    else if (release > 4) release = 4;
    return { threshold, ratio, attack, release };
  }

  static _normalizeChannels(channels) {
    const source = channels && typeof channels === 'object' ? channels : null;
    const names = source ? Object.keys(source) : [];
    if (names.length === 0) {
      return [{
        name: 'main',
        volume: 1,
        pan: 0,
        maxVoices: this.maxVoicesPerChannel,
        compressor: this.DEFAULT_BUS_COMPRESSOR,
      }];
    }
    const list = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const def = source[name] && typeof source[name] === 'object' ? source[name] : {};
      let volume = Number(def.volume);
      let pan = Number(def.pan);
      if (!Number.isFinite(volume)) volume = 1;
      else if (volume < 0) volume = 0;
      else if (volume > 1) volume = 1;
      if (!Number.isFinite(pan)) pan = 0;
      else if (pan < -1) pan = -1;
      else if (pan > 1) pan = 1;
      let maxVoices = def.maxVoices | 0;
      if (maxVoices < 1) maxVoices = this.maxVoicesPerChannel;
      const compressor = def.compressor === false
        ? { threshold: 1, ratio: 1, attack: 0.01, release: 0.15 }
        : this._clampCompressor(def.compressor, this.DEFAULT_BUS_COMPRESSOR);
      list.push({ name, volume, pan, maxVoices, compressor });
    }
    return list;
  }

  static _resolveChannel(name) {
    if (name == null || name === '') return 0;
    if (typeof name === 'number' && Number.isInteger(name)) {
      return name >= 0 && name < this._channelCount ? name : -1;
    }
    if (typeof name !== 'string') return -1;
    const id = this._channelNameToIndex.get(name);
    return typeof id === 'number' ? id : -1;
  }

  /** Bus handle. volume, pan, and muted read and write the shared bus buffer. */
  static channel(name) {
    const key = typeof name === 'string' ? name : '';
    let handle = this._channelHandles.get(key);
    if (!handle) {
      if ((this._channelRev | 0) > 0 && !this._channelNameToIndex.has(key) && !this._channelWarned.has(key)) {
        this._channelWarned.add(key);
        console.warn(`[SoundManager] channel("${key}") is not declared`);
      }
      handle = new AudioChannel(key);
      this._channelHandles.set(key, handle);
    }
    return handle;
  }

  static listChannels() {
    return this._channelNames.slice(0, this._channelCount);
  }

  static getChannelRevision() {
    return this._channelRev;
  }

  static exportChannelMap() {
    const out = {};
    for (let i = 0; i < this._channelCount; i++) {
      const name = this._channelNames[i];
      if (name) out[name] = i;
    }
    return out;
  }

  static importChannelMap(channelMap) {
    this._channelNames.length = 0;
    this._channelNameToIndex.clear();
    this._channelHandles.clear();
    let count = 0;
    if (channelMap && typeof channelMap === 'object') {
      for (const [name, idValue] of Object.entries(channelMap)) {
        const id = idValue | 0;
        if (id < 0 || id >= this.MAX_CHANNELS) continue;
        this._channelNames[id] = name;
        this._channelNameToIndex.set(name, id);
        if (id + 1 > count) count = id + 1;
      }
    }
    if (count === 0) {
      this._channelNames[0] = 'main';
      this._channelNameToIndex.set('main', 0);
      count = 1;
    }
    this._channelCount = count;
    this._channelRev++;
  }

  static getChannelSAB() {
    return this._channelSab;
  }

  static initializeChannelSAB(sab) {
    if (!sab) {
      this._channelSab = null;
      this._channelI32 = null;
      this._channelF32 = null;
      return;
    }
    this._channelSab = sab;
    this._channelI32 = new Int32Array(sab);
    this._channelF32 = new Float32Array(sab);
  }

  static _channelWord(name) {
    const id = this._channelNameToIndex.get(name);
    if (typeof id !== 'number' || !this._channelF32) return -1;
    return this.CHANNEL_HEADER + id * this.CHANNEL_STRIDE;
  }

  /** Linear master-compressor gain written by the worklet. 1 = no cut. */
  static getMasterReduction() {
    const f32 = this._channelF32;
    if (!f32) return 1;
    const gain = f32[4];
    return gain > 0 ? gain : 1;
  }

  static initializeSlotSAB(config) {
    if (!config || !config.sab) {
      this._sab = null;
      this._i32 = null;
      this._f32 = null;
      this._maxSlots = 0;
      return;
    }
    this._sab = config.sab;
    this._i32 = new Int32Array(config.sab);
    this._f32 = new Float32Array(config.sab);
    this._maxSlots = config.maxSlots || this._i32[0] || AUDIO_DEFAULTS.maxSlots;
  }

  /**
   * Reconfigure the audio worklet for a new scene without recreating the AudioContext.
   * Rebuilds the SAB if maxSlots changed, and always applies fresh gain/volume.
   */
  static _reconfigureForNewScene(maxSlots, mixGain, masterVolume, channels, masterCompressor) {
    if (maxSlots !== this._maxSlots) {
      this._maxSlots = maxSlots;
      const sabBytes = (this.HEADER_SIZE + maxSlots * this.SLOT_SIZE) * 4;
      this._sab = new SharedArrayBuffer(sabBytes);
      this._i32 = new Int32Array(this._sab);
      this._f32 = new Float32Array(this._sab);
      this._i32.fill(0);
      Atomics.store(this._i32, 0, maxSlots);

      if (this._workletNode) this._postWorkletInit();
    }

    this._f32[this.HEADER_MIX_GAIN] = Math.max(0, Math.min(1, mixGain));
    this._f32[this.HEADER_MASTER_VOL] = Math.max(0, Math.min(1, masterVolume));
    this._savedMasterVolume = this._f32[this.HEADER_MASTER_VOL];
    this._muted = false;
    this.configureChannels(channels, masterCompressor);
    this._postChannelCount();

    debugWorkerLog(
      `[SoundManager] AudioWorklet reconfigured for new scene (${maxSlots} slots, mixGain=${mixGain}, masterVol=${masterVolume})`
    );
  }

  // ─── Sound ID mapping ──────────────────────────────────────────────────────

  static importSoundIdMap(soundIdMap) {
    this._nameToId.clear();
    this._idToName.length = 0;

    if (!soundIdMap || typeof soundIdMap !== 'object') return;

    for (const [name, idValue] of Object.entries(soundIdMap)) {
      const id = idValue | 0;
      if (id < 0) continue;
      this._nameToId.set(name, id);
      this._idToName[id] = name;
    }
  }

  static exportSoundIdMap() {
    const out = {};
    for (const [name, id] of this._nameToId) {
      out[name] = id;
    }
    return out;
  }

  static getSoundId(name) {
    if (typeof name !== 'string') return -1;
    const id = this._nameToId.get(name);
    return typeof id === 'number' ? id : -1;
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  static async loadManifest(manifest) {
    const entries = this._parseManifest(manifest);
    const mainThread = !this._isWorkerContext();
    const loadPromises = [];

    for (const [name, srcUrl] of entries) {
      const id = this._assignId(name);
      if (mainThread) {
        this._beginAsset(id, name, srcUrl);
        loadPromises.push(this._decodeAndSendToWorklet(id, srcUrl));
      }
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  // ─── Playback (works from both workers and main thread) ────────────────────

  static play(
    nameOrId,
    volume = 1,
    rateMin = 1,
    rateMax = rateMin,
    loop = 0,
    mute = 0,
    worldX = Number.NaN,
    worldY = Number.NaN,
    channel
  ) {
    if (!this._enabled) return -1;

    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return -1;

    const channelIndex = this._resolveChannel(channel);
    if (channelIndex < 0) return -1;

    const spatial = this._computeSpatial(worldX, worldY);
    if (!spatial.audible) return -1;

    const finalVolume = mute ? 0 : (Number.isFinite(volume) ? volume : 1) * spatial.gain;
    if (!mute && !(finalVolume > 0)) return -1;

    const playbackRate = this._resolveRateRange(rateMin, rateMax);
    return this._writeSlot(soundDefId, finalVolume, playbackRate, spatial.pan, !!loop, channelIndex);
  }

  static stop(nameOrId) {
    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0 || !this._i32) return;

    for (let s = 0; s < this._maxSlots; s++) {
      const b = this.HEADER_SIZE + s * this.SLOT_SIZE;
      if (
        Atomics.load(this._i32, b) === this.STATE_PLAYING &&
        this._i32[b + 1] === soundDefId
      ) {
        Atomics.store(this._i32, b, this.STATE_FREE);
      }
    }
  }

  static stopAll() {
    if (!this._i32) return;
    for (let s = 0; s < this._maxSlots; s++) {
      Atomics.store(this._i32, this.HEADER_SIZE + s * this.SLOT_SIZE, this.STATE_FREE);
    }
  }

  static unload(nameOrId) {
    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return;

    this.stop(nameOrId);

    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'unload', id: soundDefId });
    }

    const name = this._idToName[soundDefId];
    if (name) this._nameToId.delete(name);
    this._idToName[soundDefId] = null;
    this._removeAsset(soundDefId);
  }

  static unloadMany(names) {
    if (!Array.isArray(names)) return;
    for (let i = 0; i < names.length; i++) {
      this.unload(names[i]);
    }
  }

  static unloadAll() {
    this.stopAll();
    if (this._workletNode) {
      for (const [, id] of this._nameToId) {
        this._workletNode.port.postMessage({ type: 'unload', id });
      }
    }
    this._idToName.length = 0;
    this._nameToId.clear();
    this._clearAssets();
  }

  static reset() {
    this.stopAll();
    if (this._workletNode) {
      for (const [, id] of this._nameToId) {
        this._workletNode.port.postMessage({ type: 'unload', id });
      }
    }
    this._idToName.length = 0;
    this._nameToId.clear();
    this._clearAssets();
    if (this._i32) {
      Atomics.store(this._i32, this.HEADER_DROPPED, 0);
    }
    this._snapLevelsCursor();
  }

  /**
   * Full teardown for engine shutdown (NOT scene switches -- scene switches use
   * reset(), which intentionally keeps the AudioContext alive so the next scene
   * doesn't need a new user gesture to unlock audio).
   * Closes the AudioContext, disconnects the worklet, and detaches DOM listeners.
   */
  static async dispose() {
    if (this._isWorkerContext()) return;

    this.reset();
    this._detachUnlockListeners();

    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    if (this._audioCtx) {
      try {
        await this._audioCtx.close();
      } catch (_) {
        // Context may already be closed (e.g. by the browser); nothing to do.
      }
      this._audioCtx = null;
    }

    this._sab = null;
    this._i32 = null;
    this._f32 = null;
    this._processMsSab = null;
    this._processMsF32 = null;
    this._levelsSab = null;
    this._levelsI32 = null;
    this._levelsF32 = null;
    this._levelsReadIndex = -1;
    this._channelSab = null;
    this._channelI32 = null;
    this._channelF32 = null;
    this._channelNames.length = 0;
    this._channelNameToIndex.clear();
    this._channelHandles.clear();
    this._channelRev = 0;
    this._channelCount = 1;
    this._maxSlots = 0;
    this._audioUnlocked = false;
  }

  static getActiveSlotCount() {
    if (!this._i32) return 0;
    let count = 0;
    for (let s = 0; s < this._maxSlots; s++) {
      if (Atomics.load(this._i32, this.HEADER_SIZE + s * this.SLOT_SIZE) === this.STATE_PLAYING) {
        count++;
      }
    }
    return count;
  }

  static getMetrics(out) {
    const ctx = this._audioCtx;
    const dst = out || this._metricsScratch || (this._metricsScratch = {
      activeSlots: 0,
      maxSlots: 0,
      loadedSounds: 0,
      dropped: 0,
      mixGain: 0,
      masterVolume: 0,
      muted: false,
      state: 'closed',
      sampleRate: 0,
      baseLatency: 0,
      outputLatency: 0,
      processMs: 0,
    });
    dst.activeSlots = this.getActiveSlotCount();
    dst.maxSlots = this._maxSlots;
    dst.loadedSounds = this._nameToId.size;
    dst.dropped = this._i32 ? Atomics.load(this._i32, this.HEADER_DROPPED) : 0;
    dst.mixGain = this._f32 ? this._f32[this.HEADER_MIX_GAIN] : 0;
    dst.masterVolume = this._muted ? this._savedMasterVolume : (this._f32 ? this._f32[this.HEADER_MASTER_VOL] : 0);
    dst.muted = this._muted;
    dst.state = ctx ? ctx.state : 'closed';
    dst.sampleRate = ctx ? ctx.sampleRate : 0;
    dst.baseLatency = ctx ? (ctx.baseLatency || 0) : 0;
    dst.outputLatency = ctx ? (ctx.outputLatency || 0) : 0;
    dst.processMs = this._processMsF32 ? this._processMsF32[0] : 0;
    return dst;
  }

  /** Asset entries in load order. Callers must not mutate the array or the entries. */
  static getAssetCatalog() {
    return this._assets;
  }

  static getAssetRevision() {
    return this._assetRev;
  }

  /**
   * Fill `out` with the voices currently in STATE_PLAYING. Reuses objects already
   * stored on `out`. `out.length` is the active count.
   */
  static readPlayingVoices(out) {
    const i32 = this._i32;
    const f32 = this._f32;
    let n = 0;
    if (i32 && f32) {
      const H = this.HEADER_SIZE;
      const S = this.SLOT_SIZE;
      const max = this._maxSlots;
      const names = this._idToName;
      for (let s = 0; s < max; s++) {
        const b = H + s * S;
        if (Atomics.load(i32, b) !== this.STATE_PLAYING) continue;
        let voice = out[n];
        if (!voice) {
          voice = {
            slot: 0,
            audioId: 0,
            name: '',
            volume: 0,
            pitch: 0,
            pan: 0,
            loop: 0,
            cursor: 0,
            channel: 0,
            channelName: '',
          };
          out[n] = voice;
        }
        const audioId = i32[b + 1];
        const channel = (i32[b + 7] | 0) & 0xff;
        voice.slot = s;
        voice.audioId = audioId;
        voice.name = names[audioId] || '#' + audioId;
        voice.pitch = f32[b + 2];
        voice.pan = f32[b + 3];
        voice.volume = f32[b + 4];
        voice.loop = i32[b + 5];
        voice.cursor = f32[b + 6];
        voice.channel = channel;
        voice.channelName = this._channelNames[channel] || '';
        n++;
      }
    }
    out.length = n;
    return out;
  }

  static stopSlot(slot) {
    const s = slot | 0;
    if (!this._i32 || s < 0 || s >= this._maxSlots) return;
    Atomics.store(this._i32, this.HEADER_SIZE + s * this.SLOT_SIZE, this.STATE_FREE);
  }

  static clearDropped() {
    if (!this._i32) return;
    Atomics.store(this._i32, this.HEADER_DROPPED, 0);
  }

  /**
   * Fold level-ring quanta written since the previous call.
   * peakL / peakR are the max post-clamp peaks in that span, rms is the
   * root-mean-square across those quanta, and clip is the sticky full-scale flag
   * (cleared here). Returns the same object every call.
   */
  static sampleOutputLevels() {
    const out = this._levelSample;
    out.peakL = 0;
    out.peakR = 0;
    out.rms = 0;
    out.clip = false;
    out.count = 0;

    const i32 = this._levelsI32;
    const f32 = this._levelsF32;
    if (!i32 || !f32) return out;

    const write = Atomics.load(i32, 0);
    out.clip = Atomics.exchange(i32, 1, 0) !== 0;

    const ring = this.LEVEL_RING;
    let read = this._levelsReadIndex;
    if (read < 0 || write - read > ring) {
      read = write > ring ? write - ring : 0;
    }
    let count = write - read;
    if (count < 0) {
      read = write;
      count = 0;
    } else if (count > ring) {
      read = write - ring;
      count = ring;
    }

    const header = this.LEVEL_HEADER;
    const baseR = header + ring;
    const baseM = header + ring * 2;
    let pkL = 0;
    let pkR = 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const slot = (read + i) & (ring - 1);
      const l = f32[header + slot];
      const r = f32[baseR + slot];
      const m = f32[baseM + slot];
      if (l > pkL) pkL = l;
      if (r > pkR) pkR = r;
      if (m > 0) sum += m;
    }
    this._levelsReadIndex = write;
    out.peakL = pkL;
    out.peakR = pkR;
    out.rms = count > 0 ? Math.sqrt(sum / count) : 0;
    out.count = count;
    return out;
  }

  static resume() {
    this._tryResumeAudioContext();
  }

  // ─── Volume controls ─────────────────────────────────────────────────────

  static setMixGain(value) {
    if (!this._f32) return;
    this._f32[this.HEADER_MIX_GAIN] = Math.max(0, Math.min(1, value));
  }

  static getMixGain() {
    return this._f32 ? this._f32[this.HEADER_MIX_GAIN] : 0;
  }

  static setMasterVolume(value) {
    const clamped = Math.max(0, Math.min(1, value));
    this._savedMasterVolume = clamped;
    if (!this._muted && this._f32) {
      this._f32[this.HEADER_MASTER_VOL] = clamped;
    }
  }

  static getMasterVolume() {
    return this._savedMasterVolume;
  }

  static setMuted(muted) {
    this._muted = !!muted;
    if (!this._f32) return;
    this._f32[this.HEADER_MASTER_VOL] = this._muted ? 0 : this._savedMasterVolume;
  }

  static isMuted() {
    return this._muted;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  static _fillSlot(b, audioId, volume, pitch, pan, loop, channelIndex) {
    const i32 = this._i32;
    const f32 = this._f32;
    i32[b + 1] = audioId;
    f32[b + 2] = pitch;
    f32[b + 3] = pan;
    f32[b + 4] = volume;
    i32[b + 5] = loop ? 1 : 0;
    f32[b + 6] = 0;
    i32[b + 7] = channelIndex | 0;
    Atomics.store(i32, b, this.STATE_PLAYING);
  }

  static _raiseHighWater(slot) {
    const chI = this._channelI32;
    if (!chI) return;
    const need = (slot | 0) + 1;
    let hw = Atomics.load(chI, 5);
    while (need > hw) {
      const prev = Atomics.compareExchange(chI, 5, hw, need);
      if (prev === hw) return;
      hw = prev;
    }
  }

  static _lockBus(chI, tail) {
    while (Atomics.compareExchange(chI, tail, 0, 1) !== 0) {}
  }

  static _unlockBus(chI, tail) {
    Atomics.store(chI, tail, 0);
  }

  static _publishQuiet(bus, tail) {
    const chI = this._channelI32;
    const f32 = this._f32;
    const H = this.HEADER_SIZE;
    const S = this.SLOT_SIZE;
    const list = tail + this.TAIL_META;
    const n = chI[tail + 1] | 0;
    let qS = -1;
    let qV = Infinity;
    let sS = -1;
    let sV = Infinity;
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const slot = chI[list + i] | 0;
      const b = H + slot * S;
      if (Atomics.load(this._i32, b) !== this.STATE_PLAYING) continue;
      chI[list + kept] = slot;
      const packed = (this._i32[b + 7] & 0xff) | (kept << 8);
      this._i32[b + 7] = packed;
      const vol = f32[b + 4];
      if (qS < 0 || vol < qV || (vol === qV && slot < qS)) {
        sS = qS;
        sV = qV;
        qS = slot;
        qV = vol;
      } else if (vol < sV || (vol === sV && (sS < 0 || slot < sS))) {
        sS = slot;
        sV = vol;
      }
      kept++;
    }
    chI[tail + 1] = kept;
    chI[tail + 2] = qS;
    this._channelF32[tail + 3] = qV;
    chI[tail + 4] = sS;
    this._channelF32[tail + 5] = sV;
  }

  static _rememberVoice(bus, tail, slot, volume) {
    const chI = this._channelI32;
    const chF = this._channelF32;
    const count = chI[tail + 1] | 0;
    const qS = chI[tail + 2] | 0;
    if (qS < 0) {
      if (count === 1) {
        chI[tail + 2] = slot;
        chF[tail + 3] = volume;
      }
      return;
    }
    const qV = chF[tail + 3];
    if (volume < qV || (volume === qV && slot < qS)) {
      chI[tail + 4] = qS;
      chF[tail + 5] = qV;
      chI[tail + 2] = slot;
      chF[tail + 3] = volume;
      return;
    }
    if (count === 2) {
      chI[tail + 4] = slot;
      chF[tail + 5] = volume;
      return;
    }
    const sS = chI[tail + 4] | 0;
    if (sS < 0) return;
    const sV = chF[tail + 5];
    if (volume < sV || (volume === sV && slot < sS)) {
      chI[tail + 4] = slot;
      chF[tail + 5] = volume;
    }
  }

  static _retuneStolen(tail, slot, volume) {
    const chI = this._channelI32;
    const chF = this._channelF32;
    const sS = chI[tail + 4] | 0;
    const sV = chF[tail + 5];
    if (sS >= 0 && volume < sV) {
      chI[tail + 2] = slot;
      chF[tail + 3] = volume;
      return;
    }
    if (sS >= 0) {
      chI[tail + 2] = sS;
      chF[tail + 3] = sV;
    } else {
      chI[tail + 2] = -1;
      chF[tail + 3] = Infinity;
    }
    chI[tail + 4] = -1;
    chF[tail + 5] = Infinity;
  }

  static _reclaimDeadVoices(bus, tail) {
    const chI = this._channelI32;
    const i32 = this._i32;
    if (!chI || !i32) return;
    const n = chI[tail + 1] | 0;
    if (n <= 0) return;
    const list = tail + this.TAIL_META;
    const base = this.HEADER_SIZE;
    const stride = this.SLOT_SIZE;
    for (let i = 0; i < n; i++) {
      const slot = chI[list + i] | 0;
      if (Atomics.load(i32, base + slot * stride) !== this.STATE_PLAYING) {
        this._publishQuiet(bus, tail);
        return;
      }
    }
  }

  static _writeSlot(audioId, volume, pitch, pan, loop, channelIndex = 0) {
    const chI = this._channelI32;
    if (!chI || chI.length < this._tailBase() + this._tailWords()) {
      return this._writeSlotScan(audioId, volume, pitch, pan, loop, channelIndex);
    }
    const bus = channelIndex | 0;
    let maxV = chI[this.CHANNEL_HEADER + bus * this.CHANNEL_STRIDE + 2] >> 8;
    if (maxV < 1) maxV = this.maxVoicesPerChannel;
    if (maxV > this.LIST_CAP) {
      return this._writeSlotScan(audioId, volume, pitch, pan, loop, channelIndex);
    }
    const tail = this._tail(bus);
    this._lockBus(chI, tail);
    try {
      return this._writeSlotListed(audioId, volume, pitch, pan, loop, bus, tail, maxV);
    } finally {
      this._unlockBus(chI, tail);
    }
  }

  static _writeSlotListed(audioId, volume, pitch, pan, loop, bus, tail, maxV) {
    const i32 = this._i32;
    const f32 = this._f32;
    const chI = this._channelI32;
    const chF = this._channelF32;
    const H = this.HEADER_SIZE;
    const S = this.SLOT_SIZE;
    const max = this._maxSlots;
    const FREE = this.STATE_FREE;
    const PLAYING = this.STATE_PLAYING;

    this._reclaimDeadVoices(bus, tail);

    const claim = (slot, from) => {
      const b = H + slot * S;
      const idx = from === FREE ? (chI[tail + 1] | 0) : ((i32[b + 7] >>> 8) | 0);
      if (Atomics.compareExchange(i32, b, from, this.STATE_CLAIMING) !== from) return -1;
      this._fillSlot(b, audioId, volume, pitch, pan, loop, bus);
      const stored = f32[b + 4];
      i32[b + 7] = bus | (idx << 8);
      if (from === FREE) {
        chI[tail + this.TAIL_META + idx] = slot;
        chI[tail + 1] = idx + 1;
        this._rememberVoice(bus, tail, slot, stored);
      } else {
        this._retuneStolen(tail, slot, stored);
      }
      this._raiseHighWater(slot);
      return slot;
    };

    const count = chI[tail + 1] | 0;
    if (count >= maxV) {
      const qS = chI[tail + 2] | 0;
      const qV = chF[tail + 3];
      const sS = chI[tail + 4] | 0;
      if (qS < 0 || (volume > qV && sS < 0)) this._publishQuiet(bus, tail);
      if (!(volume > chF[tail + 3])) {
        Atomics.add(i32, this.HEADER_DROPPED, 1);
        return -1;
      }
      let got = claim(chI[tail + 2], PLAYING);
      if (got >= 0) return got;
      this._publishQuiet(bus, tail);
      if (!(volume > chF[tail + 3])) {
        Atomics.add(i32, this.HEADER_DROPPED, 1);
        return -1;
      }
      got = claim(chI[tail + 2], PLAYING);
      if (got >= 0) return got;
      Atomics.add(i32, this.HEADER_DROPPED, 1);
      return -1;
    }

    let hw = Atomics.load(chI, 5);
    if (hw < 0) hw = 0;
    if (hw > max) hw = max;
    const scan = hw < max ? hw : max;
    let free = -1;
    for (let s = 0; s < scan; s++) {
      if (Atomics.load(i32, H + s * S) === FREE) {
        free = s;
        break;
      }
    }
    if (free >= 0) {
      const got = claim(free, FREE);
      if (got >= 0) return got;
    } else if (hw < max) {
      const got = claim(hw, FREE);
      if (got >= 0) return got;
    }
    if ((chI[tail + 2] | 0) < 0) this._publishQuiet(bus, tail);
    if ((chI[tail + 2] | 0) >= 0 && volume > chF[tail + 3]) {
      const got = claim(chI[tail + 2], PLAYING);
      if (got >= 0) return got;
    }
    Atomics.add(i32, this.HEADER_DROPPED, 1);
    return -1;
  }

  static _writeSlotScan(audioId, volume, pitch, pan, loop, channelIndex = 0) {
    const i32 = this._i32;
    const f32 = this._f32;
    if (!i32 || !f32) return -1;

    const H = this.HEADER_SIZE;
    const S = this.SLOT_SIZE;
    const max = this._maxSlots;
    const FREE = this.STATE_FREE;
    const PLAYING = this.STATE_PLAYING;
    const CLAIMING = this.STATE_CLAIMING;
    const bus = channelIndex | 0;
    const chI = this._channelI32;

    // No bus buffer: first free slot, same as before channels existed.
    if (!chI) {
      for (let s = 0; s < max; s++) {
        const b = H + s * S;
        if (Atomics.load(i32, b) === FREE && Atomics.compareExchange(i32, b, FREE, CLAIMING) === FREE) {
          this._fillSlot(b, audioId, volume, pitch, pan, loop, bus);
          return s;
        }
      }
      Atomics.add(i32, this.HEADER_DROPPED, 1);
      return -1;
    }

    let maxV = chI[this.CHANNEL_HEADER + bus * this.CHANNEL_STRIDE + 2] >> 8;
    if (maxV < 1) maxV = this.maxVoicesPerChannel;
    let hw = Atomics.load(chI, 5);
    if (hw < 0) hw = 0;
    if (hw > max) hw = max;

    let free = -1;
    let onBus = 0;
    let quietSlot = -1;
    let quietVol = Infinity;
    const scan = hw < max ? hw : max;
    for (let s = 0; s < scan; s++) {
      const b = H + s * S;
      const state = Atomics.load(i32, b);
      if (state === FREE) {
        if (free < 0) free = s;
        continue;
      }
      if (state !== PLAYING || ((i32[b + 7] | 0) & 0xff) !== bus) continue;
      onBus++;
      const v = f32[b + 4];
      if (v < quietVol) {
        quietVol = v;
        quietSlot = s;
      }
    }

    const claim = (slot, from) => {
      const b = H + slot * S;
      if (Atomics.compareExchange(i32, b, from, CLAIMING) !== from) return -1;
      this._fillSlot(b, audioId, volume, pitch, pan, loop, bus);
      this._raiseHighWater(slot);
      return slot;
    };

    if (onBus < maxV) {
      if (free >= 0) {
        const got = claim(free, FREE);
        if (got >= 0) return got;
      } else if (hw < max) {
        const got = claim(hw, FREE);
        if (got >= 0) return got;
      }
    }
    // Bus is at its mix cap. A louder shot replaces the quietest one on this bus
    // instead of piling up a silent slot that blocks every later play().
    if (quietSlot >= 0 && volume > quietVol) {
      const got = claim(quietSlot, PLAYING);
      if (got >= 0) return got;
    }
    Atomics.add(i32, this.HEADER_DROPPED, 1);
    return -1;
  }

  static async _decodeAndSendToWorklet(id, srcUrl) {
    if (!this._workletNode) {
      this._failAsset(id, 'audio worklet not initialized');
      return;
    }

    try {
      const response = await fetch(srcUrl);
      const arrayBuffer = await response.arrayBuffer();
      const decoded = await this._audioCtx.decodeAudioData(arrayBuffer);

      const channels = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        channels.push(new Float32Array(decoded.getChannelData(c)));
      }

      this._workletNode.port.postMessage({
        type: 'load',
        id,
        channels,
        length: decoded.length,
      });
      this._readyAsset(id, decoded);
    } catch (err) {
      this._failAsset(id, err);
      throw err;
    }
  }

  static _touchAssets() {
    this._assetRev++;
  }

  static _beginAsset(id, name, src) {
    let entry = this._assetById.get(id);
    if (!entry) {
      entry = {
        id,
        name,
        src,
        state: 'loading',
        channels: 0,
        sampleRate: 0,
        duration: 0,
        length: 0,
        bytes: 0,
        error: '',
      };
      this._assetById.set(id, entry);
      this._assets.push(entry);
    } else {
      entry.name = name;
      entry.src = src;
      entry.state = 'loading';
      entry.channels = 0;
      entry.sampleRate = 0;
      entry.duration = 0;
      entry.length = 0;
      entry.bytes = 0;
      entry.error = '';
    }
    this._touchAssets();
  }

  static _readyAsset(id, decoded) {
    const entry = this._assetById.get(id);
    if (!entry) return;
    const channels = decoded.numberOfChannels | 0;
    const length = decoded.length | 0;
    const sampleRate = decoded.sampleRate | 0;
    entry.state = 'ready';
    entry.channels = channels;
    entry.sampleRate = sampleRate;
    entry.length = length;
    entry.duration = decoded.duration || (sampleRate ? length / sampleRate : 0);
    entry.bytes = channels * length * 4;
    entry.error = '';
    this._touchAssets();
  }

  static _failAsset(id, err) {
    const entry = this._assetById.get(id);
    if (!entry) return;
    entry.state = 'error';
    entry.error = err && err.message ? err.message : String(err || 'decode failed');
    this._touchAssets();
  }

  static _removeAsset(id) {
    const entry = this._assetById.get(id);
    if (!entry) return;
    this._assetById.delete(id);
    const list = this._assets;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === entry) {
        list.splice(i, 1);
        break;
      }
    }
    this._touchAssets();
  }

  static _clearAssets() {
    if (this._assets.length === 0 && this._assetById.size === 0) return;
    this._assets.length = 0;
    this._assetById.clear();
    this._touchAssets();
  }

  static _resolveRateRange(rateMin, rateMax) {
    const min = Number.isFinite(rateMin) ? rateMin : 1;
    const max = Number.isFinite(rateMax) ? rateMax : min;
    const low = min <= max ? min : max;
    const high = min <= max ? max : min;
    const result = low + rng() * (high - low);
    if (!Number.isFinite(result)) return 1;
    return Math.max(0.25, Math.min(4, result));
  }

  static _resolveSoundId(nameOrId) {
    if (typeof nameOrId === 'number' && Number.isInteger(nameOrId) && nameOrId >= 0) {
      return nameOrId;
    }
    if (typeof nameOrId !== 'string') return -1;
    const id = this._nameToId.get(nameOrId);
    return typeof id === 'number' ? id : -1;
  }

  static _assignId(name) {
    let id = this._nameToId.get(name);
    if (typeof id === 'number') return id;
    id = this._idToName.length;
    this._nameToId.set(name, id);
    this._idToName[id] = name;
    return id;
  }

  static _extractSrc(definition) {
    if (typeof definition === 'string') return definition;
    if (Array.isArray(definition)) return definition[0];
    if (definition.src) {
      return Array.isArray(definition.src) ? definition.src[0] : definition.src;
    }
    return null;
  }

  static _parseManifest(manifest) {
    const result = [];
    if (!manifest) return result;

    if (Array.isArray(manifest)) {
      for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i];
        if (!entry) continue;
        if (typeof entry === 'string') {
          result.push([entry, entry]);
          continue;
        }
        const name = entry.name || entry.id;
        const src = this._extractSrc(entry);
        if (name && src) result.push([name, src]);
      }
      return result;
    }

    if (typeof manifest === 'object') {
      for (const [name, definition] of Object.entries(manifest)) {
        const src = this._extractSrc(definition);
        if (src) result.push([name, src]);
      }
    }

    return result;
  }

  static _computeSpatial(worldX, worldY) {
    const out = this._spatialResult;
    out.audible = 1;
    out.gain = 1;
    out.pan = 0;

    if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return out;

    const Camera = globalThis.Camera;
    if (!Camera || typeof Camera.getViewportBounds !== 'function') return out;

    const viewport = Camera.getViewportBounds();
    if (!viewport || !Number.isFinite(viewport.width) || viewport.width <= 0) return out;

    const zoom = Camera.zoom;
    const zoomGain = (zoom > 0 && zoom < 1) ? zoom : 1;

    const left = viewport.left;
    const right = viewport.right;
    const top = viewport.top;
    const bottom = viewport.bottom;
    const centerX = (left + right) * 0.5;
    const viewportWidth = viewport.width;

    const dxFromCenter = worldX - centerX;
    out.pan = Math.max(-1, Math.min(1, dxFromCenter / (viewportWidth * 1.5)));

    const dxOut = worldX < left ? left - worldX : worldX > right ? worldX - right : 0;
    const dyOut = worldY < top ? top - worldY : worldY > bottom ? worldY - bottom : 0;
    const outsideDistance = Math.sqrt(dxOut * dxOut + dyOut * dyOut);

    if (outsideDistance <= 0) {
      out.gain = zoomGain;
      return out;
    }

    const gain = 1 - outsideDistance / viewportWidth;
    if (gain <= 0) {
      out.audible = 0;
      out.gain = 0;
      return out;
    }

    out.gain = gain * zoomGain;
    return out;
  }

  static _hasUserActivation() {
    return !!globalThis.navigator?.userActivation?.hasBeenActive;
  }

  static _isAudioContextRunning() {
    return this._audioCtx?.state === 'running';
  }

  static _tryResumeAudioContext() {
    const ctx = this._audioCtx;
    if (!ctx || ctx.state !== 'suspended') return;
    Promise.resolve(ctx.resume()).catch(() => { });
  }

  static _detachUnlockListeners() {
    if (!this._unlockListenersAttached || !this._unlockHandler) return;
    document.removeEventListener('pointerdown', this._unlockHandler, true);
    document.removeEventListener('touchstart', this._unlockHandler, true);
    document.removeEventListener('keydown', this._unlockHandler, true);
    this._unlockListenersAttached = false;
    this._unlockHandler = null;
  }
}

class AudioChannel {
  constructor(name) {
    this.name = name;
  }

  get volume() {
    const word = SoundManager._channelWord(this.name);
    if (word < 0) return 1;
    return SoundManager._channelF32[word];
  }

  set volume(value) {
    const word = SoundManager._channelWord(this.name);
    if (word < 0) return;
    let v = Number(value);
    if (!Number.isFinite(v)) v = 1;
    else if (v < 0) v = 0;
    else if (v > 1) v = 1;
    SoundManager._channelF32[word] = v;
  }

  get pan() {
    const word = SoundManager._channelWord(this.name);
    if (word < 0) return 0;
    return SoundManager._channelF32[word + 1];
  }

  set pan(value) {
    const word = SoundManager._channelWord(this.name);
    if (word < 0) return;
    let p = Number(value);
    if (!Number.isFinite(p)) p = 0;
    else if (p < -1) p = -1;
    else if (p > 1) p = 1;
    SoundManager._channelF32[word + 1] = p;
  }

  get muted() {
    const word = SoundManager._channelWord(this.name);
    if (word < 0 || !SoundManager._channelI32) return false;
    return (SoundManager._channelI32[word + 2] & 1) !== 0;
  }

  set muted(value) {
    const word = SoundManager._channelWord(this.name);
    const i32 = SoundManager._channelI32;
    if (word < 0 || !i32) return;
    if (value) Atomics.or(i32, word + 2, 1);
    else Atomics.and(i32, word + 2, ~1);
  }

  /** Linear compressor gain for this bus. 1 = the envelope is not cutting. */
  get reduction() {
    const word = SoundManager._channelWord(this.name);
    if (word < 0) return 1;
    const gain = SoundManager._channelF32[word + 3];
    return gain > 0 ? gain : 1;
  }
}
