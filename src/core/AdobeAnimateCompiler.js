function getTimelineDurationFrames(layers) {
  let maxDuration = 0;
  for (let i = 0; i < layers.length; i++) {
    const frames = layers[i]?.Frames || [];
    let duration = 0;
    for (let j = 0; j < frames.length; j++) {
      duration += frames[j]?.duration || 1;
    }
    if (duration > maxDuration) maxDuration = duration;
  }
  return maxDuration;
}

function getFramesVisualDuration(frames, symbolsByName, cache, visiting) {
  let maxDuration = 0;
  let timelineDuration = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    timelineDuration += frame?.duration || 1;

    const elements = frame?.elements || [];
    for (let j = 0; j < elements.length; j++) {
      const symbolName = elements[j]?.SYMBOL_Instance?.SYMBOL_name;
      if (!symbolName) continue;
      const nestedDuration = getSymbolVisualDuration(symbolName, symbolsByName, cache, visiting);
      if (nestedDuration > maxDuration) maxDuration = nestedDuration;
    }
  }

  return timelineDuration > maxDuration ? timelineDuration : maxDuration;
}

function getSymbolVisualDuration(symbolName, symbolsByName, cache, visiting = new Set()) {
  if (!symbolName) return 0;
  if (cache.has(symbolName)) return cache.get(symbolName);
  if (visiting.has(symbolName)) return 0;

  visiting.add(symbolName);

  const symbol = symbolsByName.get(symbolName);
  const layers = symbol?.TIMELINE?.LAYERS || [];
  let maxDuration = getTimelineDurationFrames(layers);

  for (let i = 0; i < layers.length; i++) {
    const duration = getFramesVisualDuration(layers[i]?.Frames || [], symbolsByName, cache, visiting);
    if (duration > maxDuration) maxDuration = duration;
  }

  visiting.delete(symbolName);
  cache.set(symbolName, maxDuration);
  return maxDuration;
}

function getFrameAtIndex(frames, frameIndex) {
  if (!frames || frames.length === 0) return null;
  let cursor = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const duration = frame?.duration || 1;
    if (frameIndex >= cursor && frameIndex < cursor + duration) {
      return frame;
    }
    cursor += duration;
  }
  return frames[frames.length - 1] || null;
}

function inferRootClipName(rootLayer, layerIndex) {
  const frames = rootLayer?.Frames || [];
  let symbolName = null;

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const elements = frames[frameIndex]?.elements || [];
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      const nextSymbolName = elements[elementIndex]?.SYMBOL_Instance?.SYMBOL_name;
      if (!nextSymbolName) continue;
      if (symbolName == null) {
        symbolName = nextSymbolName;
        continue;
      }
      if (symbolName !== nextSymbolName) {
        return rootLayer?.Layer_name || symbolName || `clip_${layerIndex}`;
      }
    }
  }

  return symbolName || rootLayer?.Layer_name || `clip_${layerIndex}`;
}

function resolveInstanceFrameIndex(symbolInstance, relativeFrame, symbolDuration) {
  const firstFrame = symbolInstance?.firstFrame || 0;
  const loopMode = symbolInstance?.loop || '';
  const symbolType = symbolInstance?.symbolType || '';

  if (symbolDuration <= 0) return 0;

  if (symbolType === 'graphic' || loopMode) {
    if (loopMode === 'single frame') {
      return firstFrame;
    }
    if (loopMode === 'play once') {
      const absoluteFrame = firstFrame + relativeFrame;
      return absoluteFrame >= symbolDuration ? symbolDuration - 1 : absoluteFrame;
    }
    return (firstFrame + relativeFrame) % symbolDuration;
  }

  return relativeFrame % symbolDuration;
}

function getElementAlpha(element) {
  if (!element) return 1;
  const color = element.color;
  if (color?.mode === 'Alpha' && color.alphaMultiplier != null) return color.alphaMultiplier;
  if (color?.a != null) return color.a;
  if (element.Alpha?.a != null) return element.Alpha.a;
  if (element.ColorTransform?.alphaMultiplier != null) return element.ColorTransform.alphaMultiplier;
  if (element.ColorTransform?.a != null) return element.ColorTransform.a;
  return 1;
}

function getRotationZ(matrix) {
  return matrix?.Rotation?.z || 0;
}

function getScaleX(matrix) {
  return matrix?.Scaling?.x ?? 1;
}

function getScaleY(matrix) {
  return matrix?.Scaling?.y ?? 1;
}

function getPositionX(matrix) {
  return matrix?.Position?.x || 0;
}

function getPositionY(matrix) {
  return matrix?.Position?.y || 0;
}

function multiplyAffine(parent, child) {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}

function buildSymbolMatrix(element) {
  const matrix = element?.DecomposedMatrix || {};
  const rotation = getRotationZ(matrix);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleX = getScaleX(matrix);
  const scaleY = getScaleY(matrix);

  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  const x = getPositionX(matrix);
  const y = getPositionY(matrix);

  return {
    a,
    b,
    c,
    d,
    // Animate symbol children are already authored in the symbol's local space.
    // Applying the transformationPoint here explodes nested rigs apart because
    // the leaf sprites also carry their own anchor/pivot information.
    tx: x,
    ty: y,
  };
}

function buildLeafMatrix(element) {
  const matrix = element?.DecomposedMatrix || {};
  const rotation = getRotationZ(matrix);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleX = getScaleX(matrix);
  const scaleY = getScaleY(matrix);

  return {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    tx: getPositionX(matrix),
    ty: getPositionY(matrix),
  };
}

function decomposeAffine(matrix) {
  const scaleX = Math.hypot(matrix.a, matrix.b) || 0;
  const scaleYAbs = Math.hypot(matrix.c, matrix.d) || 0;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const scaleY = determinant < 0 ? -scaleYAbs : scaleYAbs;
  const rotation = Math.atan2(matrix.b, matrix.a);

  return {
    x: matrix.tx,
    y: matrix.ty,
    rotation,
    scaleX,
    scaleY,
  };
}

function computePieceBounds(piece) {
  const width = piece.width;
  const height = piece.height;
  const anchorX = piece.anchorX;
  const anchorY = piece.anchorY;
  const cos = Math.cos(piece.rotation);
  const sin = Math.sin(piece.rotation);

  const left = -anchorX * width;
  const top = -anchorY * height;
  const right = left + width;
  const bottom = top + height;

  const corners = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i];
    const x = corner[0] * piece.scaleX;
    const y = corner[1] * piece.scaleY;
    const worldX = piece.x + cos * x - sin * y;
    const worldY = piece.y + sin * x + cos * y;
    if (worldX < minX) minX = worldX;
    if (worldX > maxX) maxX = worldX;
    if (worldY < minY) minY = worldY;
    if (worldY > maxY) maxY = worldY;
  }

  return { minX, minY, maxX, maxY };
}

function getAtlasSpriteMap(atlasData) {
  const map = new Map();
  const sprites = atlasData?.ATLAS?.SPRITES || [];
  for (let i = 0; i < sprites.length; i++) {
    const sprite = sprites[i]?.SPRITE;
    if (!sprite?.name) continue;
    map.set(sprite.name, sprite);
  }
  return map;
}

function flattenSymbolFrame(symbolName, frameIndex, symbolsByName, atlasSprites, parentMatrix, parentAlpha, pieces, nextOrderRef) {
  const symbol = symbolsByName.get(symbolName);
  if (!symbol?.TIMELINE?.LAYERS) return;

  const layers = symbol.TIMELINE.LAYERS;
  const symbolDurationCache = flattenSymbolFrame._durationCache || (flattenSymbolFrame._durationCache = new Map());
  const symbolDuration = getSymbolVisualDuration(symbolName, symbolsByName, symbolDurationCache);
  const localFrameIndex = symbolDuration > 0 ? frameIndex % symbolDuration : 0;

  for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex--) {
    const layer = layers[layerIndex];
    const frame = getFrameAtIndex(layer?.Frames || [], localFrameIndex);
    const elements = frame?.elements || [];
    const frameStart = frame?.index || 0;
    const relativeFrame = localFrameIndex - frameStart;

    for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
      const element = elements[elementIndex];
      const symbolInstance = element?.SYMBOL_Instance;
      const spriteInstance = element?.ATLAS_SPRITE_instance;

      if (symbolInstance?.SYMBOL_name) {
        const symbolMatrix = buildSymbolMatrix(symbolInstance);
        const childDuration = getSymbolVisualDuration(
          symbolInstance.SYMBOL_name,
          symbolsByName,
          symbolDurationCache
        );
        const childFrameIndex = resolveInstanceFrameIndex(
          symbolInstance,
          relativeFrame,
          childDuration
        );
        flattenSymbolFrame(
          symbolInstance.SYMBOL_name,
          childFrameIndex,
          symbolsByName,
          atlasSprites,
          multiplyAffine(parentMatrix, symbolMatrix),
          parentAlpha * getElementAlpha(symbolInstance),
          pieces,
          nextOrderRef
        );
        continue;
      }

      if (spriteInstance?.name) {
        const spriteMeta = atlasSprites.get(spriteInstance.name);
        if (!spriteMeta) continue;

        const combined = multiplyAffine(parentMatrix, buildLeafMatrix(spriteInstance));
        const transform = decomposeAffine(combined);
        const width = spriteMeta.w || 1;
        const height = spriteMeta.h || 1;
        const pivotX = spriteInstance.transformationPoint?.x || 0;
        const pivotY = spriteInstance.transformationPoint?.y || 0;

        pieces.push({
          spriteName: spriteInstance.name,
          x: transform.x,
          y: transform.y,
          rotation: transform.rotation,
          scaleX: transform.scaleX || 1,
          scaleY: transform.scaleY || 1,
          alpha: parentAlpha * getElementAlpha(spriteInstance),
          anchorX: width !== 0 ? pivotX / width : 0,
          anchorY: height !== 0 ? pivotY / height : 0,
          innerZ: nextOrderRef.value++,
          width,
          height,
        });
      }
    }
  }
}

export class AdobeAnimateCompiler {
  static buildAtlasSpritesheetJson(atlasData) {
    const frames = {};
    const animations = {};
    const sprites = atlasData?.ATLAS?.SPRITES || [];

    for (let i = 0; i < sprites.length; i++) {
      const sprite = sprites[i]?.SPRITE;
      if (!sprite?.name) continue;
      frames[sprite.name] = {
        frame: {
          x: sprite.x,
          y: sprite.y,
          w: sprite.w,
          h: sprite.h,
        },
        rotated: !!sprite.rotated,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: sprite.w, h: sprite.h },
        sourceSize: { w: sprite.w, h: sprite.h },
      };
      animations[sprite.name] = [sprite.name];
    }

    return {
      frames,
      animations,
      meta: {
        image: atlasData?.meta?.image || 'spritemap.png',
        format: atlasData?.meta?.format || 'RGBA8888',
        size: atlasData?.meta?.size || { w: 0, h: 0 },
        scale: Number(atlasData?.meta?.resolution || 1) || 1,
      },
    };
  }

  static compile(assetName, animationData, atlasData) {
    flattenSymbolFrame._durationCache = new Map();
    const atlasSprites = getAtlasSpriteMap(atlasData);
    const symbolEntries = animationData?.SYMBOL_DICTIONARY?.Symbols || [];
    const symbolsByName = new Map();
    const symbolDurationCache = new Map();
    for (let i = 0; i < symbolEntries.length; i++) {
      const symbol = symbolEntries[i];
      if (symbol?.SYMBOL_name) {
        symbolsByName.set(symbol.SYMBOL_name, symbol);
      }
    }

    const rootLayers = animationData?.ANIMATION?.TIMELINE?.LAYERS || [];
    const frameRate = animationData?.metadata?.framerate || 24;

    const clipNames = [];
    const clipNameToId = {};
    const clipFrameStart = [];
    const clipFrameCount = [];
    const clipFrameRate = [];
    const clipBoundsMinX = [];
    const clipBoundsMinY = [];
    const clipBoundsMaxX = [];
    const clipBoundsMaxY = [];
    const clipBoundsHalfW = [];
    const clipBoundsHalfH = [];
    const framePieceStart = [];
    const framePieceCount = [];
    const pieceSpriteNames = [];
    const pieceX = [];
    const pieceY = [];
    const pieceRotation = [];
    const pieceScaleX = [];
    const pieceScaleY = [];
    const pieceAlpha = [];
    const pieceAnchorX = [];
    const pieceAnchorY = [];
    const pieceInnerZ = [];
    let assetMinX = Infinity;
    let assetMinY = Infinity;
    let assetMaxX = -Infinity;
    let assetMaxY = -Infinity;

    for (let layerIndex = 0; layerIndex < rootLayers.length; layerIndex++) {
      const rootLayer = rootLayers[layerIndex];
      const rootFrames = rootLayer?.Frames || [];
      if (rootFrames.length === 0) continue;

      const clipName = inferRootClipName(rootLayer, layerIndex);
      const discreteFrameCount = getFramesVisualDuration(rootFrames, symbolsByName, symbolDurationCache, new Set());
      if (discreteFrameCount <= 0) continue;

      clipNameToId[clipName] = clipNames.length;
      clipNames.push(clipName);
      clipFrameStart.push(framePieceStart.length);
      clipFrameCount.push(discreteFrameCount);
      clipFrameRate.push(frameRate);

      let clipMinX = Infinity;
      let clipMinY = Infinity;
      let clipMaxX = -Infinity;
      let clipMaxY = -Infinity;

      for (let localFrame = 0; localFrame < discreteFrameCount; localFrame++) {
        const rootFrame = getFrameAtIndex(rootFrames, localFrame);
        const elements = rootFrame?.elements || [];
        const rootFrameStart = rootFrame?.index || 0;
        const rootRelativeFrame = localFrame - rootFrameStart;
        const pieces = [];
        const nextOrderRef = { value: 0 };
        const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

        for (let elementIndex = 0; elementIndex < elements.length; elementIndex++) {
          const element = elements[elementIndex];
          if (element?.SYMBOL_Instance?.SYMBOL_name) {
            const symbolMatrix = buildSymbolMatrix(element.SYMBOL_Instance);
            const childDuration = getSymbolVisualDuration(
              element.SYMBOL_Instance.SYMBOL_name,
              symbolsByName,
              symbolDurationCache
            );
            const childFrameIndex = resolveInstanceFrameIndex(
              element.SYMBOL_Instance,
              rootRelativeFrame,
              childDuration
            );
            flattenSymbolFrame(
              element.SYMBOL_Instance.SYMBOL_name,
              childFrameIndex,
              symbolsByName,
              atlasSprites,
              multiplyAffine(identity, symbolMatrix),
              getElementAlpha(element.SYMBOL_Instance),
              pieces,
              nextOrderRef
            );
          } else if (element?.ATLAS_SPRITE_instance?.name) {
            const spriteMeta = atlasSprites.get(element.ATLAS_SPRITE_instance.name);
            if (!spriteMeta) continue;
            const transform = decomposeAffine(buildLeafMatrix(element.ATLAS_SPRITE_instance));
            const width = spriteMeta.w || 1;
            const height = spriteMeta.h || 1;
            const pivotX = element.ATLAS_SPRITE_instance.transformationPoint?.x || 0;
            const pivotY = element.ATLAS_SPRITE_instance.transformationPoint?.y || 0;
            pieces.push({
              spriteName: element.ATLAS_SPRITE_instance.name,
              x: transform.x,
              y: transform.y,
              rotation: transform.rotation,
              scaleX: transform.scaleX || 1,
              scaleY: transform.scaleY || 1,
              alpha: getElementAlpha(element.ATLAS_SPRITE_instance),
              anchorX: width !== 0 ? pivotX / width : 0,
              anchorY: height !== 0 ? pivotY / height : 0,
              innerZ: nextOrderRef.value++,
              width,
              height,
            });
          }
        }

        framePieceStart.push(pieceSpriteNames.length);
        framePieceCount.push(pieces.length);

        let frameMinX = Infinity;
        let frameMinY = Infinity;
        let frameMaxX = -Infinity;
        let frameMaxY = -Infinity;

        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i];
          pieceSpriteNames.push(piece.spriteName);
          pieceX.push(piece.x);
          pieceY.push(piece.y);
          pieceRotation.push(piece.rotation);
          pieceScaleX.push(piece.scaleX);
          pieceScaleY.push(piece.scaleY);
          pieceAlpha.push(piece.alpha);
          pieceAnchorX.push(piece.anchorX);
          pieceAnchorY.push(piece.anchorY);
          pieceInnerZ.push(piece.innerZ);

          const bounds = computePieceBounds(piece);
          if (bounds.minX < frameMinX) frameMinX = bounds.minX;
          if (bounds.minY < frameMinY) frameMinY = bounds.minY;
          if (bounds.maxX > frameMaxX) frameMaxX = bounds.maxX;
          if (bounds.maxY > frameMaxY) frameMaxY = bounds.maxY;
        }

        if (pieces.length === 0) {
          frameMinX = 0;
          frameMinY = 0;
          frameMaxX = 0;
          frameMaxY = 0;
        }

        if (frameMinX < clipMinX) clipMinX = frameMinX;
        if (frameMinY < clipMinY) clipMinY = frameMinY;
        if (frameMaxX > clipMaxX) clipMaxX = frameMaxX;
        if (frameMaxY > clipMaxY) clipMaxY = frameMaxY;
      }

      if (!Number.isFinite(clipMinX)) {
        clipMinX = 0;
        clipMinY = 0;
        clipMaxX = 0;
        clipMaxY = 0;
      }

      clipBoundsMinX.push(clipMinX);
      clipBoundsMinY.push(clipMinY);
      clipBoundsMaxX.push(clipMaxX);
      clipBoundsMaxY.push(clipMaxY);
      clipBoundsHalfW.push(Math.max(Math.abs(clipMinX), Math.abs(clipMaxX)));
      clipBoundsHalfH.push(Math.max(Math.abs(clipMinY), Math.abs(clipMaxY)));
      if (clipMinX < assetMinX) assetMinX = clipMinX;
      if (clipMinY < assetMinY) assetMinY = clipMinY;
      if (clipMaxX > assetMaxX) assetMaxX = clipMaxX;
      if (clipMaxY > assetMaxY) assetMaxY = clipMaxY;
    }

    if (!Number.isFinite(assetMinX)) {
      assetMinX = 0;
      assetMinY = 0;
      assetMaxX = 0;
      assetMaxY = 0;
    }

    return {
      name: assetName,
      clipNames,
      clipNameToId,
      clipFrameStart: Uint32Array.from(clipFrameStart),
      clipFrameCount: Uint16Array.from(clipFrameCount),
      clipFrameRate: Float32Array.from(clipFrameRate),
      assetBoundsMinX: assetMinX,
      assetBoundsMinY: assetMinY,
      assetBoundsMaxX: assetMaxX,
      assetBoundsMaxY: assetMaxY,
      clipBoundsMinX: Float32Array.from(clipBoundsMinX),
      clipBoundsMinY: Float32Array.from(clipBoundsMinY),
      clipBoundsMaxX: Float32Array.from(clipBoundsMaxX),
      clipBoundsMaxY: Float32Array.from(clipBoundsMaxY),
      clipBoundsHalfW: Float32Array.from(clipBoundsHalfW),
      clipBoundsHalfH: Float32Array.from(clipBoundsHalfH),
      framePieceStart: Uint32Array.from(framePieceStart),
      framePieceCount: Uint16Array.from(framePieceCount),
      pieceSpriteNames,
      pieceTextureId: new Uint16Array(pieceSpriteNames.length),
      pieceX: Float32Array.from(pieceX),
      pieceY: Float32Array.from(pieceY),
      pieceRotation: Float32Array.from(pieceRotation),
      pieceScaleX: Float32Array.from(pieceScaleX),
      pieceScaleY: Float32Array.from(pieceScaleY),
      pieceAlpha: Float32Array.from(pieceAlpha),
      pieceAnchorX: Float32Array.from(pieceAnchorX),
      pieceAnchorY: Float32Array.from(pieceAnchorY),
      pieceInnerZ: Int16Array.from(pieceInnerZ),
    };
  }

  static finalizeTextureIds(compiledAsset, sheetName, spriteSheetRegistry) {
    const result = compiledAsset;
    const bigAtlas = spriteSheetRegistry.spritesheets?.get('bigAtlas');
    const textureIds = new Uint16Array(result.pieceSpriteNames.length);

    if (!bigAtlas?.animations || !bigAtlas.indexToName) {
      result.pieceTextureId = textureIds;
      return result;
    }

    const totalAnimations = bigAtlas.totalAnimations || 0;
    const frameStartByAnimIndex = new Uint32Array(totalAnimations);
    let currentOffset = 0;
    for (let animIndex = 0; animIndex < totalAnimations; animIndex++) {
      frameStartByAnimIndex[animIndex] = currentOffset;
      const animName = bigAtlas.indexToName[animIndex];
      const animData = animName ? bigAtlas.animations[animName] : null;
      currentOffset += animData?.frameCount || 1;
    }

    for (let i = 0; i < result.pieceSpriteNames.length; i++) {
      const spriteName = result.pieceSpriteNames[i];
      const bigAtlasAnimName = spriteSheetRegistry.getBigAtlasAnimName(sheetName, spriteName);
      const bigAtlasAnim = bigAtlasAnimName ? bigAtlas.animations[bigAtlasAnimName] : null;
      const animIndex = bigAtlasAnim?.index;
      textureIds[i] = animIndex == null ? 0 : frameStartByAnimIndex[animIndex];
    }
    result.pieceTextureId = textureIds;
    return result;
  }
}
