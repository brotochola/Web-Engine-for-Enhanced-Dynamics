import WEED from '/src/index.js';
import { Branch, SEASON_WINTER } from './branch.js';
import { Leaf } from './leaf.js';
import { applyGenome, TreeComponent } from '../components/treeComponent.js';

const { GameObject, Keyboard, SharedResource, Transform, RigidBody, Collider, Noise2D, seededRandom } = WEED;

const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];
const ROOT_SLOTS = 6;

export class TreeClock extends SharedResource {}

export const TUNE = {
  yearSec: { label: 'Year (s)', min: 8, max: 60, step: 1, value: 20 },
  wind: { label: 'Wind', min: 0, max: 20000, step: 100, value: 4000 },
  gust: { label: 'Gusts', min: 0.02, max: 1.5, step: 0.01, value: 0.2 },
  damp: { label: 'Damping', min: 0, max: 12, step: 0.1, value: 2.5 },
};

export function writeTuneDefaults() {
  for (const key in TUNE) {
    const arr = TreeClock[key];
    if (arr) arr[0] = TUNE[key].value;
  }
}

export function readTune(key) {
  const arr = TreeClock[key];
  return arr ? arr[0] : TUNE[key].value;
}

export function writeTune(key, value) {
  const arr = TreeClock[key];
  if (arr) arr[0] = value;
}

export function clampTimeScale(scale) {
  if (scale < 0.25) return 0.25;
  if (scale > 8) return 8;
  return scale;
}

export function readTimeScale() {
  const box = TreeClock.speedBits;
  if (!box) return 1;
  const bits = box.load();
  return bits > 0 ? bits / 100 : 1;
}

function winterStarted(from, to, yearMs) {
  if (to <= from) return false;
  const first = Math.floor(from / yearMs);
  const last = Math.floor(to / yearMs);
  const seasonMs = yearMs * 0.25;
  for (let year = first; year <= last; year++) {
    const at = year * yearMs + SEASON_WINTER * seasonMs;
    if (at > from && at <= to) return true;
  }
  return false;
}

export function writeTimeScale(scale) {
  const box = TreeClock.speedBits;
  if (!box) return clampTimeScale(scale);
  const next = clampTimeScale(scale);
  box.store(Math.round(next * 100));
  return next;
}

export class ProceduralTree extends GameObject {
  static components = [RigidBody, Collider, TreeComponent];

  onSpawned(cfg = {}) {
    applyGenome(this, cfg.preset || 'tree', cfg.seed ?? 1);
    this._rand = seededRandom(this.treeComponent.seed | 0, 'plant');
    this.yearTime = 0;
    this.season = 0;
    this.seasonT = 0;
    this._yearIndex = 0;
    this.timeScale = readTimeScale();
    this.windX = 0;
    this.shedPending = 0;
    this._rootCount = 0;
    if (!this._roots) this._roots = [-1, -1, -1, -1, -1, -1];
    if (!this._noise) this._noise = new Noise2D(this.treeComponent.seed | 0 || 1);

    this.rigidBody.static = 1;
    this.collider.width = 8;
    this.collider.height = 8;
    this.collider.collisionMask = 0;
    this.collider.collisionGroupIndex = -1;

    const gene = this.treeComponent;
    const shoots = Math.max(1, Math.min(ROOT_SLOTS, gene.rootShoots | 0));
    const fan = (gene.spreadDeg * Math.PI) / 180;
    for (let i = 0; i < shoots; i++) {
      const t = shoots === 1 ? 0 : i / (shoots - 1) - 0.5;
      const root = Branch.spawn({
        x: this.x,
        y: this.y,
        generation: 0,
        parentIndex: -1,
        treeIndex: this.index,
        localAngle: t * fan,
        birthParentLength: 0,
      });
      if (root) this._roots[this._rootCount++] = root.index;
    }

    this._postClock();
  }

  rand() {
    return this._rand ? this._rand() : 0;
  }

  onDespawned() {
    const roots = this._roots;
    if (roots) {
      for (let i = 0; i < this._rootCount; i++) {
        const id = roots[i];
        roots[i] = -1;
        if (id >= 0 && Transform.active[id]) {
          const root = GameObject.get(id);
          if (root) root.despawn();
        }
      }
    }
    this._rootCount = 0;
  }

  dropLeaf(opts) {
    Leaf.spawn({
      x: opts.x,
      y: opts.y,
      rotation: opts.rotation,
      scale: opts.scale,
      tint: opts.tint,
      vx: this.windX * 0.004,
    });
  }

  tick(dtRatio, deltaTime) {
    let scale = readTimeScale();
    if (Keyboard.isPressed('=') || Keyboard.isPressed('+')) scale *= 2;
    if (Keyboard.isPressed('-')) scale *= 0.5;
    scale = clampTimeScale(scale);
    const speedChanged = scale !== this.timeScale;
    if (speedChanged) this.timeScale = writeTimeScale(scale);

    const yearMs = Math.max(4000, readTune('yearSec') * 1000);
    const seasonMs = yearMs * 0.25;
    const dt = deltaTime * (this.timeScale || 1);
    const prevTime = this.yearTime;
    this.yearTime += dt;
    const crossedWinter = winterStarted(prevTime, this.yearTime, yearMs);
    const yearIndex = Math.floor(this.yearTime / yearMs);
    const into = this.yearTime - yearIndex * yearMs;
    const season = (into / seasonMs) | 0;
    this.windX = this._noise.sample(this.yearTime * 0.001 * readTune('gust'), 0) * readTune('wind');
    const seasonChanged = season !== this.season || yearIndex !== this._yearIndex;
    this.season = season > 3 ? 3 : season;
    this.seasonT = (into - this.season * seasonMs) / seasonMs;
    this._yearIndex = yearIndex;
    if (crossedWinter || this.season === SEASON_WINTER) this.shedPending = 2;
    else if (this.shedPending > 0) this.shedPending--;
    if (seasonChanged || speedChanged) this._postClock();
  }

  _postClock() {
    this.sendMessageToScene({
      msg: 'clock',
      year: this._yearIndex + 1,
      season: SEASON_NAMES[this.season] || '',
      timeScale: this.timeScale,
    });
  }
}
