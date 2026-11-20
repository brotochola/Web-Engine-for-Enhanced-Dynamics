// FSMState.js - Base class for FSM states
// States are pure static logic (graph nodes), NOT ECS components
// Each state belongs to exactly ONE FSM (linked automatically)
//
// A state's hooks get the entity's index, not its instance (E-532): they read and write its components' columns, and
// code that wants the instance asks GameObject.get(i). `this` is the state class, `this.fsm` its FSM.
//
// Usage:
//   class IdleState extends FSMState {
//     static onEnter(i) { GameObject.get(i).setAnimation('idle'); }
//     static onUpdate(i, dt) {
//       if (Grid.getNeighborCount(i) > 0) this.fsm.changeState(i, this.fsm.states.CHASE);
//     }
//   }

export class FSMState {
  // Reference to owning FSM (auto-linked by FSM._linkStates())
  // Access via this.fsm in static methods
  static fsm = null;

  /**
   * Called when entering this state
   * @param {number} i - The entity's index
   * @param {string|null} fromState - Previous state name (null if initial)
   */
  static onEnter(i, fromState) {
    // Override in subclass
  }

  /**
   * Called when exiting this state
   * @param {number} i - The entity's index
   * @param {string} toState - Next state name
   */
  static onExit(i, toState) {
    // Override in subclass
  }

  /**
   * Called every tick while in this state
   * @param {number} i - The entity's index
   * @param {number} dt - Delta time ratio (1.0 = 16.67ms frame)
   * @param {number} [timeInState] - Time in this state, in whole milliseconds
   */
  static onUpdate(i, dt, timeInState) {
    // Override in subclass
  }
}
