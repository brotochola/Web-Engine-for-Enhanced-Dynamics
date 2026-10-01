import WEED from '/src/index.js';
import { Branch, SEASON_WINTER } from './branch.js';

const { GameObject, Keyboard, Decoration, SharedResource, Transform, RigidBody, Collider, Noise2D } = WEED;

const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'];
const MAX_FALLING = 1600;
const FALL_SPEED = 90;

export class TreeClock extends SharedResource {}

export const TUNE = {
  yearSec: { label: 'Year (s)', min: 8, max: 60, step: 1, value: 20 },
  wind: { label: 'Wind', min: 0, max: 20000, step: 100, value: 4000 },
  gust: { label: 'Gusts', min: 0.02, max: 1.5, step: 0.01, value: 0.2 },
  flex: { label: 'Bend (°)', min: 0, max: 40, step: 1, value: 12 },
  damp: { label: 'Damping', min: 0, max: 12, step: 0.1, value: 2.5 },
  grow: { label: 'Growth', min: 0, max: 3, step: 0.05, value: 1 },
  spread: { label: 'Spread (°)', min: 20, max: 140, step: 1, value: 90 },
  maxGen: { label: 'Generations', min: 2, max: 8, step: 1, value: 5 },
  maxKids: { label: 'Children', min: 1, max: 5, step: 1, value: 3 },
  maxLeaves: { label: 'Leaves per tip', min: 0, max: 8, step: 1, value: 4 },
  lengthScale: { label: 'Length', min: 0.4, max: 2, step: 0.05, value: 1 },
  leafScale: { label: 'Leaf size', min: 0.4, max: 2.5, step: 0.05, value: 1 },
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
  static components = [RigidBody, Collider];

  onSpawned() {
    this.yearTime = 0;
    this.season = 0;
    this.seasonT = 0;
    this._yearIndex = 0;
    this.timeScale = readTimeScale();
    this.windX = 0;
    this.shedPending = 0;
    this._rootIndex = -1;
    if (!this._noise) this._noise = new Noise2D(1);

    this.rigidBody.static = 1;
    this.collider.width = 12;
    this.collider.height = 12;
    this.collider.collisionGroupIndex = -1;
    this._fallCount = 0;
    if (!this._fallIds) this._fallIds = new Array(MAX_FALLING);

    const root = Branch.spawn({
      x: this.x,
      y: this.y,
      generation: 0,
      parentIndex: -1,
      treeIndex: this.index,
      localAngle: 0,
      birthParentLength: 0,
    });
    if (root) this._rootIndex = root.index;

    Decoration.spawn({
      x: this.x,
      y: this.y,
      texture: '_white',
      scaleX: 90,
      scaleY: 2.5,
      tint: 0x2f6b32,
      anchorX: 0.5,
      anchorY: 0,
    });

    this._postClock();
  }

  onDespawned() {
    const rootIndex = this._rootIndex;
    this._rootIndex = -1;
    if (rootIndex >= 0 && Transform.active[rootIndex]) {
      const root = GameObject.get(rootIndex);
      if (root) root.despawn();
    }
    const ids = this._fallIds;
    if (!ids) return;
    for (let i = 0; i < this._fallCount; i++) Decoration.despawn(ids[i]);
    this._fallCount = 0;
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

    this._stepFalling(dt * 0.001);
  }

  adoptFallingLeaf(opts) {
    if (this._fallCount >= MAX_FALLING) return;
    const id = Decoration.spawn({
      x: opts.x,
      y: opts.y,
      texture: 'leaf',
      scaleX: opts.scale,
      scaleY: opts.scale,
      tint: opts.tint,
      rotation: opts.rotation,
      anchorX: 0.5,
      anchorY: 1,
      sway: true,
      swayAmplitude: opts.swayAmplitude,
      swayFrequency: opts.swayFrequency,
    });
    if (id < 0) return;
    this._fallIds[this._fallCount++] = id;
  }

  _stepFalling(dtSec) {
    const ground = this.y + 2;
    let i = 0;
    while (i < this._fallCount) {
      const id = this._fallIds[i];
      const deco = Decoration.get(id);
      if (!deco || !deco.active) {
        this._fallIds[i] = this._fallIds[--this._fallCount];
        continue;
      }
      deco.x += Math.sin(this.yearTime * 0.002 + id) * 22 * dtSec;
      deco.y += FALL_SPEED * dtSec;
      if (deco.y >= ground) {
        Decoration.despawn(id);
        this._fallIds[i] = this._fallIds[--this._fallCount];
        continue;
      }
      i++;
    }
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
