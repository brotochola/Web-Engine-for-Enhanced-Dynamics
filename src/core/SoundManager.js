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
//     +7 reserved

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

  static async initializeAudioWorklet(maxSlots = 64, mixGain = 0.5, masterVolume = 1.0) {
    if (this._isWorkerContext()) return false;
    if (this._audioCtx) return true;

    this._audioCtx = new AudioContext({ latencyHint: 'interactive' });

    const processorUrl = new URL('../workers/AudioMixerProcessor.js', import.meta.url).href;
    await this._audioCtx.audioWorklet.addModule(processorUrl);

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

    this._workletNode = new AudioWorkletNode(this._audioCtx, 'weed-audio-mixer', {
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this._workletNode.connect(this._audioCtx.destination);

    this._workletNode.port.postMessage({ type: 'init', sab: this._sab, maxSlots });

    console.log(
      `[SoundManager] AudioWorklet mixer initialized (${maxSlots} slots, mixGain=${mixGain}, masterVol=${masterVolume})`
    );
    return true;
  }

  static getSlotSABConfig() {
    if (!this._sab) return null;
    return { sab: this._sab, maxSlots: this._maxSlots };
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
    this._maxSlots = config.maxSlots || this._i32[0] || 64;
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
    worldY = Number.NaN
  ) {
    if (!this._enabled) return -1;

    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return -1;

    const spatial = this._computeSpatial(worldX, worldY);
    if (!spatial.audible) return -1;

    const finalVolume = mute ? 0 : (Number.isFinite(volume) ? volume : 1) * spatial.gain;
    if (!mute && !(finalVolume > 0)) return -1;

    const playbackRate = this._resolveRateRange(rateMin, rateMax);
    return this._writeSlot(soundDefId, finalVolume, playbackRate, spatial.pan, !!loop);
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
    if (this._i32) {
      Atomics.store(this._i32, this.HEADER_DROPPED, 0);
    }
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

  static getMetrics() {
    const ctx = this._audioCtx;
    return {
      activeSlots: this.getActiveSlotCount(),
      maxSlots: this._maxSlots,
      loadedSounds: this._nameToId.size,
      dropped: this._i32 ? Atomics.load(this._i32, this.HEADER_DROPPED) : 0,
      mixGain: this._f32 ? this._f32[this.HEADER_MIX_GAIN] : 0,
      masterVolume: this._muted ? this._savedMasterVolume : (this._f32 ? this._f32[this.HEADER_MASTER_VOL] : 0),
      muted: this._muted,
      state: ctx ? ctx.state : 'closed',
      sampleRate: ctx ? ctx.sampleRate : 0,
      baseLatency: ctx ? (ctx.baseLatency || 0) : 0,
      outputLatency: ctx ? (ctx.outputLatency || 0) : 0,
    };
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

  static _writeSlot(audioId, volume, pitch, pan, loop) {
    if (!this._i32) return -1;

    const H = this.HEADER_SIZE;
    const S = this.SLOT_SIZE;

    for (let s = 0; s < this._maxSlots; s++) {
      const b = H + s * S;
      if (Atomics.compareExchange(this._i32, b, this.STATE_FREE, this.STATE_CLAIMING) === this.STATE_FREE) {
        this._i32[b + 1] = audioId;
        this._f32[b + 2] = pitch;
        this._f32[b + 3] = pan;
        this._f32[b + 4] = volume;
        this._i32[b + 5] = loop ? 1 : 0;
        this._f32[b + 6] = 0;
        this._i32[b + 7] = 0;
        Atomics.store(this._i32, b, this.STATE_PLAYING);
        return s;
      }
    }
    Atomics.add(this._i32, this.HEADER_DROPPED, 1);
    return -1;
  }

  static async _decodeAndSendToWorklet(id, srcUrl) {
    if (!this._workletNode) return;

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
  }

  static _resolveRateRange(rateMin, rateMax) {
    const min = Number.isFinite(rateMin) ? rateMin : 1;
    const max = Number.isFinite(rateMax) ? rateMax : min;
    const low = min <= max ? min : max;
    const high = min <= max ? max : min;
    const result = low + Math.random() * (high - low);
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

    if (outsideDistance <= 0) return out;

    const gain = 1 - outsideDistance / viewportWidth;
    if (gain <= 0) {
      out.audible = 0;
      out.gain = 0;
      return out;
    }

    out.gain = gain;
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
