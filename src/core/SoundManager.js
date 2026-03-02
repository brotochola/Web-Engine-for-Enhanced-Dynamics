// SoundManager.js - Static audio system facade for WeedJS
// Worker usage: SoundManager.play() posts an audio command to main thread.
// Main thread usage: SoundManager.playFromMainThread() executes Howler playback.

export class SoundManager {
  static _enabled = true;
  static _sounds = new Map(); // name -> Howl instance
  static _defs = new Map(); // name -> normalized sound definition

  static _isWorkerContext() {
    return typeof window === 'undefined' && typeof self !== 'undefined';
  }

  static _getHowlCtor() {
    return globalThis.Howl || null;
  }

  static setEnabled(enabled) {
    this._enabled = !!enabled;
  }

  static register(name, definition) {
    if (!name || !definition) return;
    const normalized = this._normalizeDefinition(name, definition);
    if (!normalized) return;
    this._defs.set(name, normalized);
  }

  static async loadManifest(manifest) {
    const entries = this._normalizeManifest(manifest);
    const mainThread = !this._isWorkerContext();
    const loadPromises = [];

    for (const [name, definition] of entries) {
      this._defs.set(name, definition);

      if (!mainThread) continue;

      const howl = this._createHowl(definition);
      if (!howl) continue;
      this._sounds.set(name, howl);

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

  static play(name, options = {}) {
    if (!this._enabled || !name) return null;

    if (this._isWorkerContext()) {
      // Workers cannot own audio playback. Forward command to main thread.
      if (typeof self?.postMessage === 'function') {
        self.postMessage({
          msg: 'playSound',
          name,
          options,
        });
      }
      return null;
    }

    return this.playFromMainThread(name, options);
  }

  static playFromMainThread(name, options = {}) {
    if (!this._enabled || !name) return null;

    const howl = this._ensureHowl(name);
    if (!howl) return null;

    const playbackRate = this._resolveRate(options);
    const soundId = howl.play(options.sprite);

    if (soundId == null) return null;

    if (options.volume != null) howl.volume(options.volume, soundId);
    if (options.loop != null) howl.loop(!!options.loop, soundId);
    if (options.mute != null) howl.mute(!!options.mute, soundId);
    if (playbackRate != null) howl.rate(playbackRate, soundId);

    return soundId;
  }

  static stop(name) {
    const howl = this._sounds.get(name);
    if (howl) howl.stop();
  }

  static unload(name) {
    const howl = this._sounds.get(name);
    if (howl) {
      howl.unload();
      this._sounds.delete(name);
    }
    this._defs.delete(name);
  }

  static unloadMany(names) {
    if (!Array.isArray(names)) return;
    for (let i = 0; i < names.length; i++) {
      this.unload(names[i]);
    }
  }

  static unloadAll() {
    for (const howl of this._sounds.values()) {
      howl.unload();
    }
    this._sounds.clear();
    this._defs.clear();
  }

  static _resolveRate(options) {
    const tempo = options.tempo ?? options.rate ?? options.pitch ?? 1;

    // randomPitch can be:
    // - number (interpreted as +- range around 1.0)
    // - [min, max]
    // - { min, max }
    let randomPitchFactor = 1;
    const rp = options.randomPitch;

    if (typeof rp === 'number') {
      const min = 1 - rp;
      const max = 1 + rp;
      randomPitchFactor = min + Math.random() * (max - min);
    } else if (Array.isArray(rp) && rp.length >= 2) {
      const min = Number(rp[0]);
      const max = Number(rp[1]);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        randomPitchFactor = min + Math.random() * (max - min);
      }
    } else if (rp && typeof rp === 'object') {
      const min = Number(rp.min);
      const max = Number(rp.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        randomPitchFactor = min + Math.random() * (max - min);
      }
    }

    const result = Number(tempo) * randomPitchFactor;
    if (!Number.isFinite(result)) return 1;
    return Math.max(0.25, Math.min(4, result));
  }

  static _ensureHowl(name) {
    let howl = this._sounds.get(name);
    if (howl) return howl;

    const def = this._defs.get(name);
    if (!def) {
      console.warn(`SoundManager: Sound "${name}" is not registered`);
      return null;
    }

    howl = this._createHowl(def);
    if (!howl) return null;
    this._sounds.set(name, howl);
    return howl;
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
