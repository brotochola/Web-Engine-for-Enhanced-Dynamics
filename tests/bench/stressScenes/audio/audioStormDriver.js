import WEED from '/src/index.js';

const { GameObject, SoundManager } = WEED;

const ONESHOTS = ['golpe', 'pistola_disparo', 'explosion_corta', 'bala_golpea_metal'];
const BUSES = ['sfx', 'hits', 'voice'];

/**
 * One of the storm's logic objects. The first starts ACTIVE_LOOPS looping voices; each calls play() its share of
 * PLAYS_PER_TICK times every tick, so the slot table stays hot. N-161: each is counted in logic's MARK_ACTIVE, the
 * scene's load key (the drivers, one for each PLAYS_PER_DRIVER plays a tick).
 */
export class AudioStormDriver extends GameObject {
  static components = [];
  static reportMarkActive = true;

  onSpawned({ playsPerTick = 800, activeLoops = 128 } = {}) {
    this.x = 200;
    this.y = 200;
    this._playsPerTick = playsPerTick | 0;
    this._activeLoops = activeLoops | 0;
    this._loopsStarted = false;
  }

  tick() {
    if (!this._loopsStarted) {
      this._loopsStarted = true;
      const loops = this._activeLoops;
      for (let i = 0; i < loops; i++) {
        SoundManager.play('explosion_larga', 0.8, 1, 1, 1, 0, Number.NaN, Number.NaN, 'loops');
      }
    }
    const plays = this._playsPerTick;
    for (let i = 0; i < plays; i++) {
      SoundManager.play(
        ONESHOTS[i & 3],
        0.35 + (i & 3) * 0.15,
        0.9,
        1.15,
        0,
        0,
        Number.NaN,
        Number.NaN,
        BUSES[i % 3],
      );
    }
  }
}
