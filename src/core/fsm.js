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
//   }
//
// A type with FSM components and no tick() (nor a static tickAll) has its FSMs run by the logic workers through
// FSM.tickAll (E-526). A type with more to do each frame calls them from its tick() (this.enemyBehaviourFSM.tick(dt))
// or from its static tickAll (FSM.tickAll(list, count, dtRatio, this)).
//
// E-532: an FSM has no owner. Its states get the entity's index (onEnter(i, fromState), onExit(i, toState),
// onUpdate(i, dt, timeInState)) and read the entity from its components' columns; a state that wants the entity's
// instance asks GameObject.get(i). So FSMs make no instance, whichever way their type is written.

import { Component } from './component.js';
import { FSMState } from './fsmState.js';
import { reportWorkerError } from '../util/errorReport.js';

// Every FSM class whose states are linked in this realm: a hot swap reads their states' hooks again (_refreshStateHooks).
const linkedFsms = [];

// E-526: FSM.tickAll's lists of FSM classes. By entity class, its FSM components in its components order; by FSM
// subclass, itself alone (SomeFSM.tickAll runs that one). Made on the first call.
const fsmsByEntityClass = new WeakMap();
const fsmAlone = new WeakMap();
const NO_FSMS = [];

/** EntityClass's FSM components, in its components order (the list a logic worker registered it with). */
function fsmsOf(EntityClass) {
  let fsms = fsmsByEntityClass.get(EntityClass);
  if (fsms !== undefined) return fsms;
  if (!Object.prototype.hasOwnProperty.call(EntityClass, '_componentList')) return NO_FSMS; // not registered here yet
  fsms = EntityClass._componentList.filter((C) => C.isFSM === true);
  fsmsByEntityClass.set(EntityClass, fsms);
  return fsms;
}

function fsmAloneOf(FSMClass) {
  let fsms = fsmAlone.get(FSMClass);
  if (fsms === undefined) {
    fsms = [FSMClass];
    fsmAlone.set(FSMClass, fsms);
  }
  return fsms;
}

/**
 * A state's throw in FSM.tickAll: on a logic worker, reported with the entity, and the tick goes on at the next entity
 * (as the tick() loops do); elsewhere (tests, tools) it is thrown.
 */
function fsmEntityThrew(error, EntityClass, entityIndex) {
  if (typeof self === 'undefined' || !self.logicWorker) throw error;
  reportWorkerError(error, 'FSM.tickAll', EntityClass.name, entityIndex);
}

/**
 * FSM.tickAll for one FSM class: FSM#tick's steps for each listed entity, the arrays read once. A copy of tickFsms'
 * loop with the FSM hoisted (the common case: one FSM per type), so neither loop tests how many there are.
 */
function tickOneFsm(F, list, count, dt, EntityClass) {
  const state = F.state;
  const time = F.time;
  const nextState = F.nextState;
  const stateArray = F._stateArray;
  const onUpdates = F._onUpdates;
  // FSM#tick's dt × ms per tick (16.67 × the type's tickInterval), the same double, once.
  const dtMs = dt * (16.67 * (EntityClass.tickInterval || 1));
  let k = 0;
  for (;;) {
    try {
      for (; k < count; k++) {
        const i = list[k];
        const pending = nextState[i];
        if (pending >= 0) F._executeTransition(i, pending);
        const s = state[i];
        const CurrentState = stateArray[s];
        if (CurrentState) {
          time[i] += dtMs;
          onUpdates[s].call(CurrentState, i, dt, time[i] | 0);
        }
      }
      return;
    } catch (error) {
      fsmEntityThrew(error, EntityClass, list[k]);
      k++;
    }
  }
}

/**
 * FSM.tickAll for several FSM classes: for each listed entity, each FSM in turn (components order), as a tick() that
 * calls them one after the other. A throw skips the rest of that entity's FSMs, as it skipped the rest of its tick().
 */
function tickFsms(fsms, list, count, dt, EntityClass) {
  const fsmCount = fsms.length;
  const dtMs = dt * (16.67 * (EntityClass.tickInterval || 1));
  let k = 0;
  for (;;) {
    try {
      for (; k < count; k++) {
        const i = list[k];
        for (let f = 0; f < fsmCount; f++) {
          const F = fsms[f];
          const pending = F.nextState[i];
          if (pending >= 0) F._executeTransition(i, pending);
          const s = F.state[i];
          const CurrentState = F._stateArray[s];
          if (CurrentState) {
            F.time[i] += dtMs;
            F._onUpdates[s].call(CurrentState, i, dt, F.time[i] | 0);
          }
        }
      }
      return;
    } catch (error) {
      fsmEntityThrew(error, EntityClass, list[k]);
      k++;
    }
  }
}

/**
 * A state's hooks, stored by its number where tick and transitions read them (E-146, E-301). onExit and onEnter are
 * null where the state has none, or only FSMState's empty ones: a transition then makes no call.
 */
function storeStateHooks(FSMClass, index, StateClass) {
  FSMClass._onUpdates[index] = StateClass.onUpdate;
  const onExit = StateClass.onExit;
  FSMClass._onExits[index] = onExit && onExit !== FSMState.onExit ? onExit : null;
  const onEnter = StateClass.onEnter;
  FSMClass._onEnters[index] = onEnter && onEnter !== FSMState.onEnter ? onEnter : null;
}

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

  // Each state's onUpdate by state number: tick reads it from this one array, not from 17 state classes (E-146)
  static _onUpdates = null;

  // Each state's onExit and onEnter by state number, null where it has none: a transition reads them here, not from the
  // state classes (E-301)
  static _onExits = null;
  static _onEnters = null;

  // Map of state name -> state index (for fast lookups)
  static _stateNameToIndex = null;

  // Flag to track if states have been linked
  static _statesLinked = false;

  /**
   * Initialize FSM arrays and link states
   * Called automatically by Component.initializeArrays()
   * @override
   */
  static initializeArrays(buffer, count, byteOffset = 0) {
    // Call parent to setup SoA arrays
    super.initializeArrays(buffer, count, byteOffset);

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
    this._onUpdates = [];
    this._onExits = [];
    this._onEnters = [];
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
      storeStateHooks(this, index, StateClass);

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
    linkedFsms.push(this);
  }

  /**
   * Read every linked FSM's state hooks again, whichever class it is called on. An FSM keeps its states' hooks in
   * arrays by state number, read when it links, so a state class whose methods change in place (a hot swap:
   * core/debug/hotSwap.js) runs its new code only after this.
   * @private
   */
  static _refreshStateHooks() {
    for (const FSMClass of linkedFsms) {
      const states = FSMClass._stateArray;
      for (let index = 0; index < states.length; index++) storeStateHooks(FSMClass, index, states[index]);
    }
  }

  // ==========================================
  // INSTANCE METHODS (called on component instance)
  // ==========================================

  constructor(index) {
    super(index);
    // Its entity's ms per tick (16.67 × its class's tickInterval), read on the first tick: one FSM instance belongs to
    // one entity, and reading its class's tickInterval every tick cost (E-146). NaN until then.
    this._msPerTick = NaN;
  }

  /**
   * Process FSM for this entity - call this in entity's tick(): this.walkFSM.tick(dtRatio)
   * Handles state transitions and calls state update
   *
   * @param {number} dt - Delta time ratio (1.0 = 16.67ms frame)
   */
  tick(dt) {
    const i = this.index;
    const FSMClass = this.constructor;

    // Process pending state transition (from previous tick's changeState() call)
    const pending = FSMClass.nextState[i];
    if (pending >= 0) {
      FSMClass._executeTransition(i, pending);
    }

    // Get current state class
    const currentStateIndex = FSMClass.state[i];
    const CurrentState = FSMClass._stateArray[currentStateIndex];

    if (CurrentState) {
      // Update time in state (approximate ms based on 60fps baseline)
      // Scale by tickInterval so decimated entities track real elapsed time
      // The entity's class: the entity that made this component instance (its this.walkFSM).
      let msPerTick = this._msPerTick;
      if (msPerTick !== msPerTick) {
        const Entity = this.owner ? this.owner.constructor : null;
        msPerTick = this._msPerTick = 16.67 * ((Entity && Entity.tickInterval) || 1);
      }
      FSMClass.time[i] += dt * msPerTick;

      // Call state's onUpdate, with the state class as `this`. The time goes as whole ms: a fractional double
      // crossing this call (a different onUpdate per state, never inlined) was a heap number per tick (E-105).
      FSMClass._onUpdates[currentStateIndex].call(CurrentState, i, dt, FSMClass.time[i] | 0);
    }
  }

  /**
   * E-526: tick the FSMs of `count` entities of EntityClass, as each one's FSM#tick(dt) would: the pending transition
   * (onExit, onEnter), the time in state, the state's onUpdate(i, dt, timeInState), entity by entity in the list's
   * order. On FSM itself it ticks every FSM component of EntityClass, in its components order, for each entity before
   * the next; on an FSM subclass (WalkFSM.tickAll) that FSM alone. It makes no instance (E-532: states get the index).
   * A logic worker calls FSM.tickAll for a type with FSM components and neither a tick() nor a static tickAll; a type's
   * own tickAll can call it:
   *   static tickAll(list, count, dtRatio) { FSM.tickAll(list, count, dtRatio, this); ... }
   * @param {ArrayLike<number>} list entity indices
   * @param {number} count how many of `list` to tick
   * @param {number} dt the frame's dtRatio
   * @param {Function} EntityClass the entities' class (`this` in its static tickAll)
   */
  static tickAll(list, count, dt, EntityClass) {
    if (typeof EntityClass !== 'function') {
      throw new TypeError(
        "FSM.tickAll(list, count, dtRatio, EntityClass): pass the entities' class (this, in a static tickAll)",
      );
    }
    const fsms = this === FSM ? fsmsOf(EntityClass) : fsmAloneOf(this);
    if (fsms.length === 1) tickOneFsm(fsms[0], list, count, dt, EntityClass);
    else if (fsms.length > 1) tickFsms(fsms, list, count, dt, EntityClass);
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
  static _executeTransition(i, newStateIndex) {
    const oldStateIndex = this.state[i];

    // Get state classes
    const OldState = this._stateArray[oldStateIndex];
    const NewState = this._stateArray[newStateIndex];

    // Get state names for callbacks (O(1) lookups)
    const oldStateName = this._stateNames[oldStateIndex] || null;
    const newStateName = this._stateNames[newStateIndex] || null;

    // The hooks come from the per-state arrays, called with the state class as `this`: loaded from the state classes
    // (Predator: 17), each was a megamorphic load, twice per hook (E-301).
    // Call onExit on old state (pass next state name)
    const onExit = this._onExits[oldStateIndex];
    if (onExit) onExit.call(OldState, i, newStateName);

    // Update state
    this.state[i] = newStateIndex;
    this.time[i] = 0; // Reset time in state
    this.nextState[i] = -1; // Clear pending transition

    // Call onEnter on new state (pass previous state name)
    const onEnter = this._onEnters[newStateIndex];
    if (onEnter) onEnter.call(NewState, i, oldStateName);
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
   */
  static forceChangeState(i, StateClass) {
    this._executeTransition(i, StateClass.stateIndex);
  }

  /**
   * Force immediate state change (skips pending queue) - INSTANCE version
   * Usage: this.personAnimationFSM.forceChangeState(PersonAnimationFSM.states.SHOOTING)
   * @param {Class} StateClass - Target state class (from FSMClass.states.X)
   */
  forceChangeState(StateClass) {
    this.constructor._executeTransition(this.index, StateClass.stateIndex);
  }

  /**
   * Initialize an entity's FSM state (a spawn does it)
   * Resets to initial state and calls onEnter
   * @param {number} i - Entity index
   */
  static initializeEntity(i) {
    if (!this._stateNameToIndex) {
      this._linkStates();
    }

    const initialIndex = this.initial?.stateIndex ?? 0;

    // Reset FSM state
    this.state[i] = initialIndex;
    this.time[i] = 0;
    this.nextState[i] = -1;

    // Call onEnter for initial state (fromState = null since it's initialization)
    const onEnter = this._onEnters[initialIndex];
    if (onEnter) onEnter.call(this._stateArray[initialIndex], i, null);
  }
}
