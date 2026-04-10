import { binarySearchFind, binarySearchInsertPoint } from './utils.js';

export function addToActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  const insertPos = binarySearchInsertPoint(activeEntitiesData, entityIndex, count);
  if (insertPos <= count && activeEntitiesData[insertPos] === entityIndex) return;

  for (let i = count; i >= insertPos; i--) {
    activeEntitiesData[i + 1] = activeEntitiesData[i];
  }

  activeEntitiesData[insertPos] = entityIndex;
  activeEntitiesData[0] = count + 1;
}

export function removeFromActiveEntities(activeEntitiesData, entityIndex) {
  if (!activeEntitiesData) return;

  const count = activeEntitiesData[0];
  if (count === 0) return;

  const pos = binarySearchFind(activeEntitiesData, entityIndex, count);
  if (pos === -1) return;

  for (let i = pos; i < count; i++) {
    activeEntitiesData[i] = activeEntitiesData[i + 1];
  }
  activeEntitiesData[0] = count - 1;
}

export function batchRemoveFromActiveEntities(activeEntitiesData, indicesToRemove) {
  if (!activeEntitiesData || indicesToRemove.size === 0) return;

  const count = activeEntitiesData[0];
  if (count === 0) return;

  let writePos = 1;
  for (let readPos = 1; readPos <= count; readPos++) {
    const entityIndex = activeEntitiesData[readPos];
    if (!indicesToRemove.has(entityIndex)) {
      activeEntitiesData[writePos++] = entityIndex;
    }
  }
  activeEntitiesData[0] = writePos - 1;
}

export function getGameObjectWorkerContext() {
  if (typeof self === 'undefined') return null;
  return (
    self.logicWorker ||
    self.particleWorker ||
    self.pixiRenderer ||
    self.physicsWorker ||
    self.spatialWorker ||
    null
  );
}

export function bumpActiveQueryVersion(worker) {
  if (worker?.queryVersionData) {
    Atomics.add(worker.queryVersionData, 0, 1);
  }
}

function getMatchingQueryContext(worker, entityType) {
  if (!worker || !worker._queryResultViews || !worker._precomputedQueries || !worker._queryEntityMetadata) {
    return null;
  }

  const entityMeta = worker._queryEntityMetadata[entityType];
  if (!entityMeta) return null;

  return {
    entityMeta,
    precomputedQueries: worker._precomputedQueries,
    queryResultViews: worker._queryResultViews,
  };
}

export function addToMatchingQueries(entityIndex, entityType, worker) {
  const context = getMatchingQueryContext(worker, entityType);
  if (!context) return;

  const componentMask = context.entityMeta.componentMask;
  for (let q = 0; q < context.precomputedQueries.length; q++) {
    const query = context.precomputedQueries[q];
    if ((componentMask & query.queryMask) !== query.queryMask) continue;

    const resultView = context.queryResultViews[q];
    const count = resultView[0];
    const insertPos = binarySearchInsertPoint(resultView, entityIndex, count);
    if (insertPos <= count && resultView[insertPos] === entityIndex) continue;

    for (let i = count; i >= insertPos; i--) {
      resultView[i + 1] = resultView[i];
    }

    resultView[insertPos] = entityIndex;
    resultView[0] = count + 1;
  }
}

export function removeFromMatchingQueries(entityIndex, entityType, worker) {
  const context = getMatchingQueryContext(worker, entityType);
  if (!context) return;

  const componentMask = context.entityMeta.componentMask;
  for (let q = 0; q < context.precomputedQueries.length; q++) {
    const query = context.precomputedQueries[q];
    if ((componentMask & query.queryMask) !== query.queryMask) continue;

    const resultView = context.queryResultViews[q];
    const count = resultView[0];
    const pos = binarySearchFind(resultView, entityIndex, count);
    if (pos === -1) continue;

    for (let i = pos; i < count; i++) {
      resultView[i] = resultView[i + 1];
    }
    resultView[0] = count - 1;
  }
}

export function batchRemoveFromMatchingQueries(indicesToRemove, entityType, worker) {
  if (indicesToRemove.size === 0) return;

  const context = getMatchingQueryContext(worker, entityType);
  if (!context) return;

  const componentMask = context.entityMeta.componentMask;
  for (let q = 0; q < context.precomputedQueries.length; q++) {
    const query = context.precomputedQueries[q];
    if ((componentMask & query.queryMask) !== query.queryMask) continue;

    const resultView = context.queryResultViews[q];
    const count = resultView[0];
    if (count === 0) continue;

    let writePos = 1;
    for (let readPos = 1; readPos <= count; readPos++) {
      const entityIndex = resultView[readPos];
      if (!indicesToRemove.has(entityIndex)) {
        resultView[writePos++] = entityIndex;
      }
    }
    resultView[0] = writePos - 1;
  }
}

export function removeFromTypeActiveList(typeList, entityIndex) {
  if (!typeList) return;

  const count = typeList[0];
  if (count === 0) return;

  const pos = binarySearchFind(typeList, entityIndex, count);
  if (pos === -1) return;

  for (let i = pos; i < count; i++) {
    typeList[i] = typeList[i + 1];
  }
  typeList[0] = count - 1;
}

export function clearTypeActiveList(typeList) {
  if (typeList) {
    typeList[0] = 0;
  }
}

export function addToTypeActiveList(typeList, entityIndex) {
  if (!typeList) return;

  const count = typeList[0];
  const insertPos = binarySearchInsertPoint(typeList, entityIndex, count);
  if (insertPos <= count && typeList[insertPos] === entityIndex) return;

  for (let i = count; i >= insertPos; i--) {
    typeList[i + 1] = typeList[i];
  }

  typeList[insertPos] = entityIndex;
  typeList[0] = count + 1;
}
