// Query.js — static gameplay facade over QuerySystem (main) / SAB closures (workers).
// QuerySystem stays internal. Box2d.queryAABB is fixtures; Query.query is ECS.

import { QuerySystem } from './querySystem.js';

const EMPTY = new Uint16Array(0);

export class Query {
  static _system = null;
  static _query = null;
  static _queryActiveEntities = null;
  static _queryActiveEntitiesSlow = null;

  static reset() {
    this._system = new QuerySystem();
    this._query = null;
    this._queryActiveEntities = null;
    this._queryActiveEntitiesSlow = null;
    return this._system;
  }

  static ensureSystem() {
    if (!this._system) this._system = new QuerySystem();
    return this._system;
  }

  /** Main-thread tests / bootstrap: use this QuerySystem instance. */
  static bindSystem(system) {
    this._system = system;
    this._query = null;
    this._queryActiveEntities = null;
    this._queryActiveEntitiesSlow = null;
  }

  /** Worker SAB closures from createWorkerQueryFunctions. */
  static bindWorker(fns) {
    this._query = fns.query;
    this._queryActiveEntities = fns.queryActiveEntities;
    this._queryActiveEntitiesSlow = fns.queryActiveEntitiesSlow;
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
    if (this._query) return this._query(componentClasses);
    if (this._system) return this._system.query(componentClasses);
    return EMPTY;
  }

  static queryActiveEntities(componentClasses) {
    if (this._queryActiveEntities) return this._queryActiveEntities(componentClasses);
    if (this._system) return this._system.queryActiveEntities(componentClasses);
    return EMPTY;
  }

  static queryActiveEntitiesSlow(componentClasses) {
    if (this._queryActiveEntitiesSlow) return this._queryActiveEntitiesSlow(componentClasses);
    if (this._system) return this._system.queryActiveEntitiesSlow(componentClasses);
    return EMPTY;
  }
}
