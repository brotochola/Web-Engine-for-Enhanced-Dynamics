// Query.js — static gameplay facade over the thread's QuerySystem: the page's, built from the scene, or a worker's,
// QuerySystem.fromSerialized over the shared snapshots (N-303 CR-26: one class, one receiver on every thread).
// QuerySystem stays internal. Box2d.queryAABB is fixtures; Query.query is ECS.

import { QuerySystem } from './querySystem.js';

const EMPTY = new Uint16Array(0);

export class Query {
  static _system = null;

  static reset() {
    this._system = new QuerySystem();
    return this._system;
  }

  static ensureSystem() {
    if (!this._system) this._system = new QuerySystem();
    return this._system;
  }

  /** This thread's QuerySystem: a worker's from QuerySystem.fromSerialized (tests may pass a stand-in). */
  static bindSystem(system) {
    this._system = system;
  }

  static buildQueries(registeredClasses) {
    return this.ensureSystem().buildQueries(registeredClasses);
  }

  static definePrecomputedQueries(componentClasses, sceneQueries = []) {
    return this.ensureSystem().definePrecomputedQueries(componentClasses, sceneQueries);
  }

  static createSharedBuffers() {
    return this.ensureSystem().createSharedBuffers();
  }

  static serialize() {
    return this.ensureSystem().serialize();
  }

  static get queryResultViews() {
    return this._system?.queryResultViews;
  }

  static get queryEntityCapacity() {
    return this._system?.queryEntityCapacity || 0;
  }

  static getPrecomputedQueryCount() {
    return this._system?.getPrecomputedQueryCount?.() || 0;
  }

  static query(componentClasses) {
    return this._system ? this._system.query(componentClasses) : EMPTY;
  }

  static queryActiveEntities(componentClasses) {
    return this._system ? this._system.queryActiveEntities(componentClasses) : EMPTY;
  }

  /** Logic frame that last published this precomputed active query. -1 if unknown. */
  static queryPublishedFrame(componentClasses) {
    return this._system?.queryPublishedFrame ? this._system.queryPublishedFrame(componentClasses) : -1;
  }

  static queryActiveEntitiesSlow(componentClasses) {
    return this._system ? this._system.queryActiveEntitiesSlow(componentClasses) : EMPTY;
  }
}
