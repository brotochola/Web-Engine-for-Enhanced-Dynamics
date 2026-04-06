// FSM.js - Base class for Finite State Machines in WeedJS
// FSM is a Component with its own SoA storage (state, time, nextState)
// Each FSM subclass defines its own states and initial state
//
// Usage:
//   class EnemyBehaviourFSM extends FSM {
//     static states = { IDLE: IdleState, CHASE: ChaseState };
//     static initial = this.states.IDLE;
//   }
//
//   class Enemy extends GameObject {
//     static components = [EnemyBehaviourFSM, RigidBody, Collider];
//     tick(dt) { this.enemyBehaviourFSM.tick(dt, this); }
//   }

import { Component } from './Component.js';

export class FSM extends Component {
  static isFSM = true;
  // ==========================================
  // SoA STORAGE (per-entity arrays)
  // ==========================================

  static ARRAY_SCHEMA = {
    state: Uint8Array, // Current state index (0-255 states max)
    time: Float32Array, // Time in current state (ms)
    nextState: Int16Array, // Pending state transition (-1 = none)
  };

  // ==========================================
  // FSM DEFINITION (override in subclasses)
  // ==========================================

  // Map of state names to state classes
  // Example: { IDLE: IdleState, CHASE: ChaseState, FLEE: FleeState }
  static states = {};

  // Initial state class (must exist in states): static initial = this.states.IDLE;
  static initial = null;

  // ==========================================
  // INTERNAL STATE MANAGEMENT
  // ==========================================

  // Array of state classes indexed by state number (built from states map)
  static _stateArray = null;

  // Array of state names indexed by state number (built from states map)
  static _stateNames = null;

  // Map of state name -> state index (for fast lookups)
  static _stateNameToIndex = null;

  // Flag to track if states have been linked
  static _statesLinked = false;

  /**
   * Initialize FSM arrays and link states
   * Called automatically by Component.initializeArrays()
   * @override
   */
  static initializeArrays(buffer, count) {
    // Call parent to setup SoA arrays
    super.initializeArrays(buffer, count);

    // Link states to this FSM (only once per FSM class)
    this._linkStates();

    // Initialize all entities to initial state with nextState = -1 (no pending)
    const initialIndex = this.initial?.stateIndex ?? 0;
    for (let i = 0; i < count; i++) {
      this.state[i] = initialIndex;
      this.time[i] = 0;
      this.nextState[i] = -1;
    }
  }

  /**
   * Link all state classes to this FSM
   * Sets StateClass.fsm = this for each state
   * Builds _stateArray and _stateNameToIndex for fast access
   * @private
   */
  static _linkStates() {
    // Skip if already linked for this specific class
    if (this.hasOwnProperty('_statesLinked') && this._statesLinked) {
      return;
    }

    const stateEntries = Object.entries(this.states);

    // Build state array and name->index map
    this._stateArray = [];
    this._stateNames = [];
    this._stateNameToIndex = new Map();

    for (let index = 0; index < stateEntries.length; index++) {
      const [name, StateClass] = stateEntries[index];

      // Link state to this FSM
      StateClass.fsm = this;

      // Store state index on the class for O(1) lookup in changeState()
      StateClass.stateIndex = index;

      // Store in array for index-based access
      this._stateArray[index] = StateClass;
      this._stateNames[index] = name;

      // Store name->index mapping
      this._stateNameToIndex.set(name, index);
    }

    // Validate initial state exists
    if (this.initial && this.initial.stateIndex === undefined) {
      console.error(
        `FSM ${this.name}: initial state not found in states. Make sure to use this.states.X`,
        Object.keys(this.states)
      );
    }

    this._statesLinked = true;
  }

  // ==========================================
  // INSTANCE METHODS (called on component instance)
  // ==========================================

  /**
   * Process FSM for this entity - call this in entity's tick()
   * Handles state transitions and calls state update
   *
   * @param {number} dt - Delta time ratio (1.0 = 16.67ms frame)
   * @param {GameObject} owner - The entity instance (stateless accessor)
   */
  tick(dt, owner) {
    if (!owner) return console.warn("FSM.tick called without owner", this.constructor.name);
    const i = this.index;
    const FSMClass = this.constructor;

    // Process pending state transition (from previous tick's changeState() call)
    const pending = FSMClass.nextState[i];
    if (pending >= 0) {
      FSMClass._executeTransition(i, pending, owner);
    }

    // Get current state class
    const currentStateIndex = FSMClass.state[i];
    const CurrentState = FSMClass._stateArray[currentStateIndex];

    if (CurrentState) {
      // Update time in state (approximate ms based on 60fps baseline)
      // Scale by tickInterval so decimated entities track real elapsed time
      const tickInterval = owner?.constructor?.tickInterval || 1;
      FSMClass.time[i] += dt * 16.67 * tickInterval;

      // Call state's onUpdate
      CurrentState.onUpdate(owner, i, dt, FSMClass.time[i]);
    }
  }

  /**
   * Request a state transition (applied once per tick) - STATIC version
   * Call this from state's onUpdate: this.fsm.changeState(i, this.fsm.states.CHASE)
   *
   * @param {number} i - Entity index
   * @param {Class} StateClass - Target state class (from this.fsm.states.X)
   */
  static changeState(i, StateClass) {
    // Queue the transition (will be processed at start of next tick)
    this.nextState[i] = StateClass.stateIndex;
  }

  /**
   * Request a state transition (applied once per tick) - INSTANCE version
   * Usage: this.personAnimationFSM.changeState(PersonAnimationFSM.states.IDLE)
   * @param {Class} StateClass - Target state class (from FSMClass.states.X)
   */
  changeState(StateClass) {
    // Queue the transition (will be processed at start of next tick)
    this.constructor.nextState[this.index] = StateClass.stateIndex;
  }

  /**
   * Execute a state transition
   * @static
   * @private
   */
  static _executeTransition(i, newStateIndex, owner) {
    if (!owner) {
      console.trace("whattt")
      debugger;
      return //console.warn("FSM._executeTransition called without owner", this.constructor.name);
    }
    const oldStateIndex = this.state[i];

    // Get state classes
    const OldState = this._stateArray[oldStateIndex];
    const NewState = this._stateArray[newStateIndex];

    // Get state names for callbacks (O(1) lookups)
    const oldStateName = this._stateNames[oldStateIndex] || null;
    const newStateName = this._stateNames[newStateIndex] || null;

    // Call onExit on old state (pass next state name)
    if (OldState && OldState.onExit) {
      OldState.onExit(owner, i, newStateName);
    }

    // Update state
    this.state[i] = newStateIndex;
    this.time[i] = 0; // Reset time in state
    this.nextState[i] = -1; // Clear pending transition

    // Call onEnter on new state (pass previous state name)
    if (NewState && NewState.onEnter) {
      NewState.onEnter(owner, i, oldStateName);
    }
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Get current state name for an entity
   * @param {number} i - Entity index
   * @returns {string|null} Current state name
   */
  static getStateName(i) {
    if (!this._stateNames) return null;
    return this._stateNames[this.state[i]] || null;
  }

  /**
   * Get state name by index (internal helper)
   * @private
   * @param {number} stateIndex - State index
   * @returns {string|null} State name
   */
  static _getStateNameByIndex(stateIndex) {
    if (!this._stateNames) return null;
    return this._stateNames[stateIndex] || null;
  }

  /**
   * Check if entity is in a specific state
   * @param {number} i - Entity index
   * @param {Class} StateClass - State class to check (from this.fsm.states.X)
   * @returns {boolean} True if in that state
   */
  static isInState(i, StateClass) {
    return this.state[i] === StateClass.stateIndex;
  }

  /**
   * Force immediate state change (skips pending queue) - STATIC version
   * Use sparingly - prefer changeState() for controlled transitions
   * @param {number} i - Entity index
   * @param {Class} StateClass - Target state class (from this.fsm.states.X)
   * @param {GameObject} owner - The entity instance
   */
  static forceChangeState(i, StateClass, owner) {
    this._executeTransition(i, StateClass.stateIndex, owner);
  }

  /**
   * Force immediate state change (skips pending queue) - INSTANCE version
   * Usage: this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.SHOOTING)
   * @param {Class} StateClass - Target state class (from FSMClass.states.X)
   */
  forceChangeState(StateClass) {
    this.constructor._executeTransition(this.index, StateClass.stateIndex, this.owner);
  }

  /**
   * Initialize an entity's FSM state (call in onSpawned)
   * Resets to initial state and calls onEnter
   * @param {number} i - Entity index
   * @param {GameObject} owner - The entity instance
   */
  static initializeEntity(i, owner) {
    if (!this._stateNameToIndex) {
      this._linkStates();
    }

    const initialIndex = this.initial?.stateIndex ?? 0;

    // Reset FSM state
    this.state[i] = initialIndex;
    this.time[i] = 0;
    this.nextState[i] = -1;

    // Call onEnter for initial state (fromState = null since it's initialization)
    const InitialState = this._stateArray[initialIndex];
    if (InitialState && InitialState.onEnter) {
      InitialState.onEnter(owner, i, null);
    }
  }
}
