// FSMState.js - Base class for FSM states
// States are pure static logic (graph nodes), NOT ECS components
// Each state belongs to exactly ONE FSM (linked automatically)
//
// Usage:
//   class IdleState extends FSMState {
//     static onEnter(owner, i) { owner.setAnimation("idle"); }
//     static onUpdate(owner, i, dt) {
//       if (owner.canSeePlayer()) this.fsm.changeState(i, this.fsm.states.CHASE);
//     }
//   }

export class FSMState {
  // Reference to owning FSM (auto-linked by FSM._linkStates())
  // Access via this.fsm in static methods
  static fsm = null;

  /**
   * Called when entering this state
   * @param {GameObject} owner - The entity instance (stateless accessor)
   * @param {number} i - Entity index for direct array access
   * @param {string|null} fromState - Previous state name (null if initial)
   */
  static onEnter(owner, i, fromState) {
    // Override in subclass
  }

  /**
   * Called when exiting this state
   * @param {GameObject} owner - The entity instance (stateless accessor)
   * @param {number} i - Entity index for direct array access
   * @param {string} toState - Next state name
   */
  static onExit(owner, i, toState) {
    // Override in subclass
  }

  /**
   * Called every tick while in this state
   * @param {GameObject} owner - The entity instance (stateless accessor)
   * @param {number} i - Entity index for direct array access
   * @param {number} dt - Delta time ratio (1.0 = 16.67ms frame)
   */
  static onUpdate(owner, i, dt) {
    // Override in subclass
  }
}
