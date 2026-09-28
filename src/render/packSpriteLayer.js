import { fillQueueIndices } from './gpuQueueLayout.js';
import { orderPainterSlots, radixSortIndicesBySortKey } from '../util/sortIndexByKey.js';

/**
 * Pack one sprite layer: split light-glow rows when asked, order with the
 * painter when this layer owns one, then write sprites and glow.
 * The caller writes the destination (GPU queue or mesh buffer) and owns pose
 * interpolation.
 *
 * @param {object} spec
 * @param {number} spec.count
 * @param {Uint8Array|null} spec.type
 * @param {object} spec.opts upload options mutated in place
 * @param {boolean} spec.splitGlow pull type 3 into the glow destination
 * @param {Uint32Array|null} [spec.idxEntity]
 * @param {Uint32Array|null} [spec.idxGlow]
 * @param {object|null} [spec.painter]
 * @param {Uint32Array|null} [spec.keysU32]
 * @param {boolean} [spec.dense] order slots 0..count-1 (no index list)
 * @param {boolean} [spec.fillAll] copy every row into idxEntity, then order that list
 * @param {number} [spec.sortedFlag] or-ed into flags when the painter runs
 * @param {(ms: number) => void} [spec.addSortMs]
 * @param {boolean} [spec.timeGlowSort] glow radix is painter time too
 * @param {number|null} [spec.glowCapacity] 0 skips the glow write; null means the writer caps it
 * @param {boolean} [spec.writeEmptyGlow] still write glow when the split found none (hides the mesh)
 * @param {number} [spec.glowIncludeType] no-split glow filter, usually 3; negative skips
 * @param {(opts: object) => number} spec.writeSprites
 * @param {((opts: object) => number)|null} [spec.writeGlow]
 * @param {(count: number, indices: Uint32Array|null) => void} [spec.afterSprites]
 * @param {(count: number, indices: Uint32Array|null) => void} [spec.afterGlow]
 * @returns {{ sprite: number, glow: number, splitParticles: number, flags: number }}
 */
export function packSpriteLayer(spec) {
    const count = spec.count | 0;
    const opts = spec.opts;
    const typeArr = spec.type || null;
    const painter = spec.painter || null;
    const keysU32 = spec.keysU32 || null;
    const canSort = !!(painter && keysU32);
    let flags = 0;

    const timed = (fn, record) => {
        if (!record || !spec.addSortMs) return fn();
        const t0 = performance.now();
        const out = fn();
        spec.addSortMs(performance.now() - t0);
        return out;
    };

    const orderSprites = (indices, n, dense) => {
        if (!canSort || n < 2) {
            if (indices) {
                opts.indices = indices;
                opts.indexCount = n;
            } else {
                opts.indices = null;
                opts.indexCount = 0;
            }
            return;
        }
        opts.indices = timed(
            () => orderPainterSlots(painter, dense ? null : indices, n, keysU32),
            true
        );
        opts.indexCount = n;
        flags |= spec.sortedFlag | 0;
    };

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
        orderSprites(idxE, ne, false);
        const spriteN = spec.writeSprites(opts) | 0;
        if (spec.afterSprites) spec.afterSprites(spriteN, opts.indices);
        const glowOpen = spec.glowCapacity == null || spec.glowCapacity < 0 || spec.glowCapacity > 0;
        if (spec.writeGlow && glowOpen && (ng > 0 || spec.writeEmptyGlow)) {
            if (canSort && ng > 1) {
                timed(
                    () => radixSortIndicesBySortKey(idxG, ng, keysU32, painter.scratch, painter.hist),
                    !!spec.timeGlowSort
                );
            }
            opts.sortKey = null;
            opts.indices = idxG;
            opts.indexCount = ng;
            glowN = spec.writeGlow(opts) | 0;
            if (spec.afterGlow) spec.afterGlow(glowN, idxG);
        }
        return { sprite: spriteN, glow: glowN, splitParticles, flags };
    }

    if (spec.fillAll && spec.idxEntity && canSort && count >= 2) {
        const ne = fillQueueIndices(typeArr, count, -1, -1, spec.idxEntity);
        orderSprites(spec.idxEntity, ne, false);
    } else if (spec.presetIndices) {
        orderSprites(spec.presetIndices, count, false);
    } else if (spec.dense) {
        orderSprites(null, count, true);
    } else {
        opts.indices = null;
        opts.indexCount = 0;
    }
    const spriteN = spec.writeSprites(opts) | 0;
    if (spec.afterSprites) spec.afterSprites(spriteN, opts.indices);

    const glowType = spec.glowIncludeType | 0;
    if (glowType >= 0 && spec.writeGlow) {
        opts.sortKey = null;
        opts.includeType = glowType;
        glowN = spec.writeGlow(opts) | 0;
        opts.includeType = -1;
    }
    return { sprite: spriteN, glow: glowN, splitParticles, flags };
}
