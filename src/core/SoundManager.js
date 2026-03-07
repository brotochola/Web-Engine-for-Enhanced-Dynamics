// SoundManager.js - Static audio system facade for WeedJS
// Worker usage: SoundManager.play() writes audio events into SAB ring queue.
// Main thread usage: Scene drains SAB queues and executes Howler playback.

export class SoundManager {
  static _enabled = true;
  static _nameToId = new Map(); // name -> id
  static _idToName = []; // id -> name
  static _defsById = []; // id -> normalized definition
  static _soundsById = []; // id -> Howl instance

  // Audio event queue constants (SAB ring buffer)
  static EVENT_PLAY = 1;
  static FLAG_LOOP = 1 << 0;
  static FLAG_MUTE = 1 << 1;
  static EVENT_STRIDE_WORDS = 8;
  static HEADER_WRITE = 0;
  static HEADER_READ = 1;
  static HEADER_DROPPED = 2;
  static HEADER_PUSHED = 3;

  static _queueHeader = null; // Int32Array
  static _queueI32 = null; // Int32Array view over event data SAB
  static _queueF32 = null; // Float32Array view over event data SAB
  static _queueCapacity = 0;
  static _queueMask = 0;
  static _audioUnlocked = false;
  static _unlockListenersAttached = false;
  static _unlockHandler = null;

  static _isWorkerContext() {
    return typeof window === 'undefined' && typeof self !== 'undefined';
  }

  static _getHowlCtor() {
    return globalThis.Howl || null;
  }

  static setEnabled(enabled) {
    this._enabled = !!enabled;
  }

  static initializeAutoplayGate() {
    if (this._isWorkerContext()) return;
    if (this._unlockListenersAttached) return;

    // If browser already has user activation, mark unlocked immediately.
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

  static initializeAudioQueue(queueConfig) {
    if (!queueConfig) {
      this._queueHeader = null;
      this._queueI32 = null;
      this._queueF32 = null;
      this._queueCapacity = 0;
      this._queueMask = 0;
      return;
    }

    const capacity = queueConfig.capacity | 0;
    if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
      throw new Error('SoundManager: audio queue capacity must be power of two');
    }

    this._queueHeader = new Int32Array(queueConfig.header);
    this._queueI32 = new Int32Array(queueConfig.data);
    this._queueF32 = new Float32Array(queueConfig.data);
    this._queueCapacity = capacity;
    this._queueMask = capacity - 1;
  }

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

  static register(name, definition) {
    if (!name || !definition) return;
    const normalized = this._normalizeDefinition(name, definition);
    if (!normalized) return;
    this._setDefinition(name, normalized);
  }

  static async loadManifest(manifest) {
    const entries = this._normalizeManifest(manifest);
    const mainThread = !this._isWorkerContext();
    const loadPromises = [];

    for (const [name, definition] of entries) {
      const id = this._setDefinition(name, definition);

      if (!mainThread) continue;

      const howl = this._createHowl(definition);
      if (!howl) continue;
      this._soundsById[id] = howl;

      // Optionally wait for preload if requested.
      if (definition.preload !== false) {
        loadPromises.push(
          new Promise((resolve) => {
            howl.once('load', resolve);
            howl.once('loaderror', resolve);
          })
        );
      }
    }

    if (loadPromises.length > 0) {
      await Promise.all(loadPromises);
    }
  }

  static play(nameOrId, volume = 1, rateMin = 1, rateMax = rateMin, loop = 0, mute = 0) {
    if (!this._enabled) return null;

    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return null;

    const playbackRate = this._resolveRateRange(rateMin, rateMax);
    const flags = (loop ? this.FLAG_LOOP : 0) | (mute ? this.FLAG_MUTE : 0);

    if (this._isWorkerContext()) {
      return this._enqueuePlay(soundDefId, volume, playbackRate, flags);
    }

    return this.playFromMainThreadById(soundDefId, volume, playbackRate, loop, mute);
  }

  static playFromMainThreadById(soundDefId, volume = 1, rate = 1, loop = 0, mute = 0) {
    if (!this._enabled) return null;
    if (!this.isAudioUnlocked()) return null;

    const howl = this._ensureHowlById(soundDefId);
    if (!howl) return null;

    const soundId = howl.play();
    if (soundId == null) return null;

    howl.volume(Number.isFinite(volume) ? volume : 1, soundId);
    howl.loop(!!loop, soundId);
    howl.mute(!!mute, soundId);
    howl.rate(Number.isFinite(rate) ? rate : 1, soundId);

    return soundId;
  }

  static drainAudioQueueFromMainThread(queueView, maxEvents = Number.POSITIVE_INFINITY) {
    if (!queueView) return 0;

    const { header, i32, f32, mask } = queueView;
    let read = Atomics.load(header, this.HEADER_READ);
    const write = Atomics.load(header, this.HEADER_WRITE);
    let consumed = 0;

    while (read < write && consumed < maxEvents) {
      const slot = read & mask;
      const base = slot * this.EVENT_STRIDE_WORDS;
      const eventType = i32[base + 0];

      if (eventType === this.EVENT_PLAY) {
        const soundDefId = i32[base + 1];
        const flags = i32[base + 2];
        const volume = f32[base + 3];
        const rate = f32[base + 4];
        this.playFromMainThreadById(
          soundDefId,
          volume,
          rate,
          (flags & this.FLAG_LOOP) !== 0,
          (flags & this.FLAG_MUTE) !== 0
        );
      }

      read++;
      consumed++;
    }

    if (consumed > 0) {
      Atomics.store(header, this.HEADER_READ, read);
    }

    return consumed;
  }

  static stop(nameOrId) {
    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return;
    const howl = this._soundsById[soundDefId];
    if (howl) howl.stop();
  }

  static stopAll() {
    for (let i = 0; i < this._soundsById.length; i++) {
      const howl = this._soundsById[i];
      if (howl) howl.stop();
    }
  }

  static unload(nameOrId) {
    const soundDefId = this._resolveSoundId(nameOrId);
    if (soundDefId < 0) return;

    const howl = this._soundsById[soundDefId];
    if (howl) {
      howl.unload();
      this._soundsById[soundDefId] = null;
    }

    const name = this._idToName[soundDefId];
    if (name) this._nameToId.delete(name);
    this._idToName[soundDefId] = null;
    this._defsById[soundDefId] = null;
  }

  static unloadMany(names) {
    if (!Array.isArray(names)) return;
    for (let i = 0; i < names.length; i++) {
      this.unload(names[i]);
    }
  }

  static unloadAll() {
    for (let i = 0; i < this._soundsById.length; i++) {
      const howl = this._soundsById[i];
      if (howl) howl.unload();
    }
    this._soundsById.length = 0;
    this._defsById.length = 0;
    this._idToName.length = 0;
    this._nameToId.clear();
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

  static _setDefinition(name, definition) {
    let id = this._nameToId.get(name);
    if (typeof id !== 'number') {
      id = this._idToName.length;
      this._nameToId.set(name, id);
      this._idToName[id] = name;
    }
    this._defsById[id] = definition;
    return id;
  }

  static _ensureHowlById(soundDefId) {
    let howl = this._soundsById[soundDefId];
    if (howl) return howl;

    const def = this._defsById[soundDefId];
    if (!def) {
      const name = this._idToName[soundDefId] || `#${soundDefId}`;
      console.warn(`SoundManager: Sound "${name}" is not registered`);
      return null;
    }

    howl = this._createHowl(def);
    if (!howl) return null;
    this._soundsById[soundDefId] = howl;
    return howl;
  }

  static _enqueuePlay(soundDefId, volume, rate, flags) {
    const header = this._queueHeader;
    if (!header || !this._queueI32 || !this._queueF32) return null;

    const write = Atomics.load(header, this.HEADER_WRITE);
    const read = Atomics.load(header, this.HEADER_READ);
    const pending = write - read;

    if (pending >= this._queueCapacity) {
      Atomics.add(header, this.HEADER_DROPPED, 1);
      return null;
    }

    const slot = write & this._queueMask;
    const base = slot * this.EVENT_STRIDE_WORDS;

    this._queueI32[base + 0] = this.EVENT_PLAY;
    this._queueI32[base + 1] = soundDefId;
    this._queueI32[base + 2] = flags | 0;
    this._queueF32[base + 3] = Number.isFinite(volume) ? volume : 1;
    this._queueF32[base + 4] = Number.isFinite(rate) ? rate : 1;
    this._queueI32[base + 5] = 0;
    this._queueI32[base + 6] = 0;
    this._queueI32[base + 7] = 0;

    Atomics.store(header, this.HEADER_WRITE, write + 1);
    Atomics.add(header, this.HEADER_PUSHED, 1);
    return 1;
  }

  static _createHowl(definition) {
    const HowlCtor = this._getHowlCtor();
    if (!HowlCtor) {
      console.warn('SoundManager: Howler is not available in main thread');
      return null;
    }

    return new HowlCtor({
      src: definition.src,
      volume: definition.volume ?? 1,
      loop: !!definition.loop,
      preload: definition.preload ?? true,
      html5: !!definition.html5,
      sprite: definition.sprite,
    });
  }

  static _hasUserActivation() {
    return !!globalThis.navigator?.userActivation?.hasBeenActive;
  }

  static _isAudioContextRunning() {
    return globalThis.Howler?.ctx?.state === 'running';
  }

  static _tryResumeAudioContext() {
    const ctx = globalThis.Howler?.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    // Best-effort: resume may reject if browser still blocks.
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

  static _normalizeManifest(manifest) {
    const result = [];
    if (!manifest) return result;

    // Format A: [{ name, src, ... }, ...]
    if (Array.isArray(manifest)) {
      for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i];
        if (!entry) continue;
        if (typeof entry === 'string') {
          result.push([entry, this._normalizeDefinition(entry, entry)]);
          continue;
        }
        const name = entry.name || entry.id;
        const normalized = this._normalizeDefinition(name, entry);
        if (name && normalized) result.push([name, normalized]);
      }
      return result;
    }

    // Format B: { crash: "/audio/crash.ogg", skid: { src: ... } }
    if (typeof manifest === 'object') {
      for (const [name, definition] of Object.entries(manifest)) {
        const normalized = this._normalizeDefinition(name, definition);
        if (normalized) result.push([name, normalized]);
      }
    }

    return result;
  }

  static _normalizeDefinition(name, definition) {
    if (!name || !definition) return null;
    if (typeof definition === 'string') {
      return { src: [definition], preload: true };
    }

    if (Array.isArray(definition)) {
      return { src: definition, preload: true };
    }

    const src = Array.isArray(definition.src) ? definition.src : [definition.src];
    if (!src[0]) {
      console.warn(`SoundManager: "${name}" has no valid src`);
      return null;
    }

    return {
      src,
      volume: definition.volume,
      loop: definition.loop,
      preload: definition.preload,
      html5: definition.html5,
      sprite: definition.sprite,
    };
  }
}
