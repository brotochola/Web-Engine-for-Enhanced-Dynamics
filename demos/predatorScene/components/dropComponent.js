import WEED from '/src/index.js';
const { Component } = WEED;

export class DropComponent extends Component {
  static ARRAY_SCHEMA = {
    type: Uint8Array, // DROP_TYPES (drop.js)
    amount: Uint8Array,
    // When the drop turns into a trigger, on the scene's clock (Time.simNowMs, ms): its spawn writes it, Drop.tickAll
    // reads it.
    triggerAtMs: Float64Array,
  };
}
