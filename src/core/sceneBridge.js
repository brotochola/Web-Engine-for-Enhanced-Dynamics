function resolveWorkerContext() {
  if (typeof self === 'undefined') return null;

  return (
    self.logicWorker ||
    self.particleWorker ||
    self.pixiRenderer ||
    self.physicsWorker ||
    self.spatialWorker ||
    self.preRenderWorker ||
    null
  );
}

/**
 * Worker → page messages of an entity. E-537: they take the entity's index and its class's name, not an instance, so an
 * entity written ECS-style (GameObject.emit(i, name, data)) sends them with none made; an entity's method passes its own.
 */
export class SceneBridge {
  /**
   * gameObject.emit(name, data) and GameObject.emit(i, name, data) → scene.on(name, fn) gets fn(data, entityIndex,
   * className).
   * @param {string} name
   * @param {*} data
   * @param {number} [entityIndex=-1] the sender's index, -1 for none
   * @param {string|null} [className=null] the sender's class's name
   */
  static emitToScene(name, data, entityIndex = -1, className = null) {
    const index = Number.isInteger(entityIndex) ? entityIndex : -1;
    const who = typeof className === 'string' ? className : null;
    // A page instance is already where the listeners are.
    if (typeof window !== 'undefined' && window.scene && typeof self.logicWorker === 'undefined') {
      window.scene._dispatchEntityEvent(name, data, index, who);
      return true;
    }
    const payload = { msg: 'gameObjectEvent', name, data, entityIndex: index, className: who };
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
      self.postMessage(payload);
      return true;
    }
    console.warn('gameObject.emit() is only available from worker context');
    return false;
  }

  /**
   * gameObject.sendMessageToScene(data) and GameObject.sendMessageToScene(i, data) → Scene.onMessageFromGameObject.
   * @param {*} data
   * @param {number} [entityIndex=-1] the sender's index, -1 for none
   * @param {string|null} [className=null] the sender's class's name
   */
  static sendMessageToScene(data, entityIndex = -1, className = null) {
    const worker = resolveWorkerContext();
    const payload = {
      msg: 'messageFromGameObject',
      data,
      entityIndex: Number.isInteger(entityIndex) ? entityIndex : -1,
      className: typeof className === 'string' ? className : null,
      workerIndex: Number.isInteger(worker?.workerIndex) ? worker.workerIndex : -1,
    };

    if (worker && typeof worker.postMessageToScene === 'function') {
      return worker.postMessageToScene(payload);
    }

    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
      self.postMessage(payload);
      return true;
    }

    console.warn('SceneBridge.sendMessageToScene() is only available from worker context');
    return false;
  }
}
