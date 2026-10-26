// NetCarComponent - which replicated entity this is, and which player drives it.

import WEED from '/src/index.js';

const { Component } = WEED;

export class NetCarComponent extends Component {
  static ARRAY_SCHEMA = {
    /** 0..MAX_NET_IDS-1, the id in POSES packets; -1 = not replicated */
    netId: Int16Array,
    /** player slot driving it; -1 = nobody (a parked car) */
    slot: Int8Array,
  };
}
