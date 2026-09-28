import { fillQueueIndices } from './gpuQueueLayout.js';
import { orderPainterSlots, radixSortIndicesBySortKey } from '../util/sortIndexByKey.js';

const packResult = { sprite: 0, glow: 0, splitParticles: 0, flags: 0 };

function orderSpriteIndices(opts, painter, keysU32, indices, n, dense, addSortMs, sortedFlag) {
    if (!painter || !keysU32 || n < 2) {
        if (indices) {
            opts.indices = indices;
            opts.indexCount = n;
        } else {
            opts.indices = null;
            opts.indexCount = 0;
        }
        return 0;
    }
    if (addSortMs) {
        const t0 = performance.now();
        opts.indices = orderPainterSlots(painter, dense ? null : indices, n, keysU32);
        addSortMs(performance.now() - t0);
    } else {
        opts.indices = orderPainterSlots(painter, dense ? null : indices, n, keysU32);
    }
    opts.indexCount = n;
    return sortedFlag | 0;
}

/**
 * Pack one sprite layer: split light-glow rows when asked, order with the
 * painter when this layer owns one, then write sprites and glow.
 * The caller writes the destination (GPU queue or mesh buffer) and owns pose
 * interpolation. The returned object is reused; read it before the next call.
 *
 * @param {object} spec
 * @returns {{ sprite: number, glow: number, splitParticles: number, flags: number }}
 */
export function packSpriteLayer(spec) {
    const count = spec.count | 0;
    const opts = spec.opts;
    const typeArr = spec.type || null;
    const painter = spec.painter || null;
    const keysU32 = spec.keysU32 || null;
    const canSort = !!(painter && keysU32);
    const addSortMs = spec.addSortMs || null;
    const sortedFlag = spec.sortedFlag | 0;
    let flags = 0;

    opts.sortKey = null;
    if (spec.depthMode != null) opts.depthMode = spec.depthMode;
    let splitParticles = 0;
    let glowN = 0;

    if (spec.splitGlow && spec.idxEntity) {
        const idxE = spec.idxEntity;
        const idxG = spec.idxGlow;
        const ne = fillQueueIndices(typeArr, count, -1, 3, idxE);
        const ng = idxG ? fillQueueIndices(typeArr, count, 3, -1, idxG) : 0;
        for (let k = 0; k < ne; k++) {
            if (typeArr && typeArr[idxE[k]] === 1) splitParticles++;
        }
        flags |= orderSpriteIndices(opts, painter, keysU32, idxE, ne, false, addSortMs, sortedFlag);
        const spriteN = spec.writeSprites(opts) | 0;
        if (spec.afterSprites) spec.afterSprites(spriteN, opts.indices);
        const glowOpen = spec.glowCapacity == null || spec.glowCapacity < 0 || spec.glowCapacity > 0;
        if (spec.writeGlow && glowOpen && (ng > 0 || spec.writeEmptyGlow)) {
            if (canSort && ng > 1) {
                if (spec.timeGlowSort && addSortMs) {
                    const t0 = performance.now();
                    radixSortIndicesBySortKey(idxG, ng, keysU32, painter.scratch, painter.hist);
                    addSortMs(performance.now() - t0);
                } else {
                    radixSortIndicesBySortKey(idxG, ng, keysU32, painter.scratch, painter.hist);
                }
            }
            opts.sortKey = null;
            opts.indices = idxG;
            opts.indexCount = ng;
            glowN = spec.writeGlow(opts) | 0;
            if (spec.afterGlow) spec.afterGlow(glowN, idxG);
        }
        packResult.sprite = spriteN;
        packResult.glow = glowN;
        packResult.splitParticles = splitParticles;
        packResult.flags = flags;
        return packResult;
    }

    let spriteN = 0;
    if (spec.fillAll && spec.idxEntity && canSort && count >= 2) {
        const ne = fillQueueIndices(typeArr, count, -1, -1, spec.idxEntity);
        flags |= orderSpriteIndices(opts, painter, keysU32, spec.idxEntity, ne, false, addSortMs, sortedFlag);
    } else if (spec.presetIndices) {
        flags |= orderSpriteIndices(opts, painter, keysU32, spec.presetIndices, count, false, addSortMs, sortedFlag);
    } else if (spec.dense) {
        flags |= orderSpriteIndices(opts, painter, keysU32, null, count, true, addSortMs, sortedFlag);
    } else {
        opts.indices = null;
        opts.indexCount = 0;
    }
    spriteN = spec.writeSprites(opts) | 0;
    if (spec.afterSprites) spec.afterSprites(spriteN, opts.indices);

    const glowType = spec.glowIncludeType | 0;
    if (glowType >= 0 && spec.writeGlow) {
        opts.sortKey = null;
        opts.includeType = glowType;
        glowN = spec.writeGlow(opts) | 0;
        opts.includeType = -1;
    }
    packResult.sprite = spriteN;
    packResult.glow = glowN;
    packResult.splitParticles = splitParticles;
    packResult.flags = flags;
    return packResult;
}
