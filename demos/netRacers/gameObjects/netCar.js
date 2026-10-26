// NetCar - a player's car on the host: the car scene's Box2D drive, fed by the
// host's own keyboard (its slot) or by the remote player's input bits (NetInput).

import WEED from '/src/index.js';
import { Car } from '/demos/carScene/gameObjects/car.js';
import { NetCarComponent } from './netCarComponent.js';
import { followCar } from './followCamera.js';
import { NetInput, NetSession, readKeyboardBits, bitsToForward, bitsToTurn } from '../netShared.js';

const { RigidBody, Transform } = WEED;

export class NetCar extends Car {
  static components = [...Car.components, NetCarComponent];

  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    NetCarComponent.netId[this.index] = spawnConfig.netId ?? -1;
    NetCarComponent.slot[this.index] = spawnConfig.slot ?? -1;
  }

  tick(dtRatio) {
    super.tick(dtRatio);
    const i = this.index;
    if (!Transform.active[i]) return;

    const local = NetCarComponent.netId[i] === NetSession.localNetId[0];
    const slot = NetCarComponent.slot[i];
    const bits = local ? readKeyboardBits() : slot >= 0 ? NetInput.bits[slot] : 0;
    const forward = bitsToForward(bits);
    const turn = bitsToTurn(bits);
    if (forward !== 0 || turn !== 0) this.applyForces(forward, turn);

    if (local) followCar(i, RigidBody.speed[i], dtRatio);
  }
}

/** A car nobody drives: pushed around by the players, simulated on the host, replicated like the others. */
export class ParkedCar extends Car {
  static components = [...Car.components, NetCarComponent];

  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    NetCarComponent.netId[this.index] = spawnConfig.netId ?? -1;
    NetCarComponent.slot[this.index] = -1;
  }
}
