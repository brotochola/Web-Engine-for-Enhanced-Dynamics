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

export class SceneBridge {
  /** gameObject.emit(name, data) → scene.on(name, fn). */
  static emitToScene(name, data, sender = null) {
    const payload = {
      msg: 'gameObjectEvent',
      name,
      data,
      entityIndex: Number.isInteger(sender?.index) ? sender.index : -1,
      className: sender?.constructor?.name || null,
    };
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
      self.postMessage(payload);
      return true;
    }
    console.warn('gameObject.emit() is only available from worker context');
    return false;
  }

  static sendMessageToScene(data, sender = null) {
    const worker = resolveWorkerContext();
    const payload = {
      msg: 'messageFromGameObject',
      data,
      entityIndex: Number.isInteger(sender?.index) ? sender.index : -1,
      className: sender?.constructor?.name || null,
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
