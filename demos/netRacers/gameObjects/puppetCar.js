// PuppetCar - a replicated car on a client. No body: the host simulates it. Each
// tick it reads the latest pose the main thread wrote into NetPose, projects it to
// now with its velocity (dead reckoning), and eases toward that (exponential
// smoothing), snapping when it is too far off. The sprite frame follows the angle
// like the car scene's Car does.

import WEED from '/src/index.js';
import { NetCarComponent } from './netCarComponent.js';
import { followCar } from './followCamera.js';
import { updateCarFrame } from './carFrames.js';
import { NetPose, NetSession } from '../netShared.js';

const { GameObject, SpriteRenderer, Transform, netNow } = WEED;

/** Velocity is trusted for this long past the last packet; after that the car holds. */
const MAX_EXTRAPOLATION_MS = 250;
/** Smoothing time constant: the gap to the target halves every ~τ·ln2. */
const SMOOTH_TAU_MS = 60;
/** A gap bigger than this is a teleport (respawn, a lost burst): jump. */
const SNAP_DISTANCE = 400;
const TWO_PI = Math.PI * 2;
const DEFAULT_SCALE = 1.5;

function shortestAngle(from, to) {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}

export class PuppetCar extends GameObject {
  static components = [SpriteRenderer, NetCarComponent];

  onSpawned(spawnConfig = {}) {
    const scale = spawnConfig.scale ?? DEFAULT_SCALE;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.spriteRenderer.inheritTransformRotation = 0;
    this.spriteRenderer.spriteRotation = 0;
    this.setSpritesheet(spawnConfig.sprite || 'car_police');
    this.setAnimation('0');
    this.setScale(scale, scale);
    this.x = spawnConfig.x || 0;
    this.y = spawnConfig.y || 0;
    this.rotation = spawnConfig.rotation ?? 0;
    NetCarComponent.netId[this.index] = spawnConfig.netId ?? -1;
    NetCarComponent.slot[this.index] = spawnConfig.slot ?? -1;
    this._lastAngleKey = updateCarFrame(this, null);
  }

  onDespawned() {
    this._lastAngleKey = null;
  }

  tick(dtRatio, deltaTime) {
    const i = this.index;
    if (!Transform.active[i]) return;
    const id = NetCarComponent.netId[i];
    if (id < 0) return;
    const stamp = NetPose.time[id];
    if (stamp > 0) {
      let age = netNow() - stamp;
      if (age < 0) age = 0;
      else if (age > MAX_EXTRAPOLATION_MS) age = MAX_EXTRAPOLATION_MS;
      const ageSec = age * 0.001;
      const vx = NetPose.vx[id];
      const vy = NetPose.vy[id];
      const tx = NetPose.x[id] + vx * ageSec;
      const ty = NetPose.y[id] + vy * ageSec;
      const tr = NetPose.rotation[id] + NetPose.angularVelocity[id] * ageSec;

      const cx = Transform.x[i];
      const cy = Transform.y[i];
      const dx = tx - cx;
      const dy = ty - cy;
      if (dx * dx + dy * dy > SNAP_DISTANCE * SNAP_DISTANCE) {
        this.x = tx;
        this.y = ty;
        this.rotation = tr;
      } else {
        const dt = deltaTime > 0 ? deltaTime : dtRatio * 16.667;
        const k = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
        this.x = cx + dx * k;
        this.y = cy + dy * k;
        const cr = Transform.rotation ? Transform.rotation[i] : 0;
        this.rotation = cr + shortestAngle(cr, tr) * k;
      }

      if (id === NetSession.localNetId[0]) followCar(i, Math.sqrt(vx * vx + vy * vy), dtRatio);
    }
    this._lastAngleKey = updateCarFrame(this, this._lastAngleKey);
  }
}
