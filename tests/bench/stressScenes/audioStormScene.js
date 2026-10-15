/**
 * Audio pipeline stress. One logic driver calls SoundManager.play every tick
 * across several compressed buses. Primary: logic0_STEP_MS. Load: BODY_COUNT.
 *
 * Raise PLAYS_PER_TICK if logic0 stays under 3 ms. Freeze the knobs after that.
 */
import WEED from '/src/index.js';
import { AudioStormDriver } from './audio/audioStormDriver.js';

const { Scene, Camera } = WEED;

export const PLAYS_PER_TICK = 1200;
export const ACTIVE_LOOPS = 128;

export class AudioStormScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    seed: 0xa11d10,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 128,
      maxNeighbors: 8,
      maxEntitiesPerCell: 8,
      noLimitFPS: false,
    },
    logic: {
      noLimitFPS: false,
      numberOfLogicWorkers: 1,
      staggeredUpdates: false,
    },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      sleeping: true,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxVisibleRenderables: 64,
    },
    lighting: { enabled: false },
    audio: {
      maxSlots: 2048,
      mixGain: 0.5,
      masterVolume: 1,
      channels: {
        loops: {
          volume: 1,
          pan: 0,
          maxVoices: 128,
          compressor: { threshold: 0.6, ratio: 4, attack: 0.01, release: 0.12 },
        },
        sfx: {
          volume: 0.8,
          pan: 0,
          maxVoices: 256,
          compressor: { threshold: 0.45, ratio: 8, attack: 0.005, release: 0.1 },
        },
        hits: {
          volume: 0.6,
          pan: 0,
          maxVoices: 128,
          compressor: { threshold: 0.5, ratio: 4, attack: 0.005, release: 0.12 },
        },
        voice: {
          volume: 0.7,
          pan: 0,
          maxVoices: 64,
          compressor: { threshold: 0.6, ratio: 6, attack: 0.01, release: 0.15 },
        },
      },
      compressor: { threshold: 0.85, ratio: 12, attack: 0.005, release: 0.12 },
    },
  };

  static assets = { textures: {} };

  static audios = {
    golpe: '/demos/audios/golpe.mp3',
    pistola_disparo: '/demos/audios/pistola_disparo.mp3',
    explosion_corta: '/demos/audios/explosion_corta.mp3',
    bala_golpea_metal: '/demos/audios/bala_golpea_metal.mp3',
    explosion_larga: '/demos/audios/explosion_larga.mp3',
  };

  static entities = [[AudioStormDriver, 1]];

  create() {
    this.spawnEntity(AudioStormDriver, {
      playsPerTick: PLAYS_PER_TICK,
      activeLoops: ACTIVE_LOOPS,
    });
    Camera.centerOn(1000, 1000);
    Camera.setZoom(1);
  }
}
