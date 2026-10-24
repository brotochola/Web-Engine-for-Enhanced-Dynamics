// Particle states for the pool-width tests (E-129): random columns that send the integrate down each of its
// branches (lifetimes that end, flat and heighted, airborne and landing with despawn, stay-and-stamp and floor
// fade, every tween bit and ease, angular velocity, cycling frames, render-only), written straight into
// ParticleComponent's columns: no emitter, so a pool of any size can be filled.
import { ParticleComponent } from '../../src/components/particleComponent.js';

const COLUMNS = Object.keys(ParticleComponent.ARRAY_SCHEMA);

/** One particle's random state at slot i (live with probability `live`). */
export function randomParticle(r, i, live = 0.7) {
  const pc = ParticleComponent;
  pc.active[i] = r() < live ? 1 : 0;
  pc.x[i] = r() * 4000;
  pc.y[i] = r() * 3000;
  pc.z[i] = r() < 0.5 ? -r() * 300 : r() < 0.5 ? 0 : -r() * 2;
  pc.vx[i] = r() * 30 - 15;
  pc.vy[i] = r() * 30 - 15;
  pc.vz[i] = r() * 4 - 1;
  pc.lifespan[i] = r() < 0.1 ? 0 : 200 + Math.floor(r() * 20000);
  pc.currentLife[i] = Math.floor(r() * 500);
  pc.gravity[i] = r() < 0.5 ? 0.08 : 0;
  pc.flat[i] = r() < 0.3 ? 1 : 0;
  const landing = r();
  pc.despawnOnGroundContact[i] = landing < 0.3 ? 1 : 0;
  pc.stayOnTheFloor[i] = landing >= 0.3 && landing < 0.5 ? 1 : 0;
  pc.fadeOnTheFloor[i] = landing >= 0.5 && landing < 0.8 ? 100 + Math.floor(r() * 300) : 0;
  pc.timeOnFloor[i] = r() < 0.2 ? Math.floor(r() * 200) : 0;
  pc.alpha[i] = r();
  pc.initialAlpha[i] = r();
  pc.scaleX[i] = r() + 0.2;
  pc.scaleY[i] = r() + 0.2;
  pc.tweenMask[i] = r() < 0.6 ? Math.floor(r() * 32) : 0;
  pc.easeId[i] = Math.floor(r() * 14);
  pc.alphaFrom[i] = r();
  pc.alphaTo[i] = r();
  pc.scaleXFrom[i] = r();
  pc.scaleXTo[i] = r() * 2;
  pc.scaleYFrom[i] = r();
  pc.scaleYTo[i] = r() * 2;
  pc.tintFrom[i] = Math.floor(r() * 0xffffff);
  pc.tintTo[i] = Math.floor(r() * 0xffffff);
  pc.rotFrom[i] = r() * 6;
  pc.rotTo[i] = r() * 12 - 6;
  pc.hasAngularVel[i] = r() < 0.3 ? 1 : 0;
  pc.angularVelFrom[i] = r() * 0.02 - 0.01;
  pc.angularVelTo[i] = r() * 0.02 - 0.01;
  pc.animMode[i] = r() < 0.2 ? 1 : 0;
  pc.animCount[i] = 1 + Math.floor(r() * 7);
  for (let f = 0; f < 8; f++) pc.animFrames[i * 8 + f] = 100 + f;
  pc.renderOnly[i] = r() < 0.05 ? 1 : 0;
}

/** Copy every column of slot `from` to slot `to`. */
export function copyParticle(from, to) {
  const pc = ParticleComponent;
  for (const name of COLUMNS) {
    const col = pc[name];
    const per = col.length / pc.active.length;
    for (let k = 0; k < per; k++) col[to * per + k] = col[from * per + k];
  }
}

/** Every column of slot a equal to slot b's (NaN for NaN); the first difference, or null. */
export function sameParticle(a, b) {
  const pc = ParticleComponent;
  for (const name of COLUMNS) {
    const col = pc[name];
    const per = col.length / pc.active.length;
    for (let k = 0; k < per; k++) {
      const x = col[a * per + k];
      const y = col[b * per + k];
      if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return `${name}[${a}] ${x}, [${b}] ${y}`;
    }
  }
  return null;
}

/** The live slots of [0, n) in slot order, into `list` from `offset`; returns the count. */
export function liveSlots(n, list, offset = 0) {
  let c = 0;
  for (let i = 0; i < n; i++) if (ParticleComponent.active[i]) list[offset + c++] = i;
  return c;
}

/** All of ParticleComponent's bytes for slots [0, n), column by column (a state to compare). */
export function particleBytes(n) {
  const pc = ParticleComponent;
  const out = [];
  for (const name of COLUMNS) {
    const col = pc[name];
    const per = col.length / pc.active.length;
    out.push(new Uint8Array(col.buffer, col.byteOffset, n * per * col.BYTES_PER_ELEMENT).slice());
  }
  return out;
}
