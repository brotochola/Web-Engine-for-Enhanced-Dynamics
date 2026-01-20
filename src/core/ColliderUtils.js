// ColliderUtils.js - Worker-only utilities for collider cell calculations
// Requires Transform and Collider components to be initialized globally (worker context)
//
// PERFORMANCE NOTES:
// - Zero allocations: Uses pre-allocated result objects (safe in single-threaded workers)
// - Caller should pre-compute invariants (invCellSize, maxCol, maxRow) outside loops
// - For ultra-hot paths (every frame, thousands of entities), inline the math instead

/**
 * Shape type constants (matches Collider.shapeType values)
 */
export const SHAPE_CIRCLE = 0;
export const SHAPE_BOX = 1;

/**
 * Pre-allocated result objects for zero-GC operations
 * Safe to reuse since workers are single-threaded
 */
export const _boundsResult = { posX: 0, posY: 0, halfW: 0, halfH: 0 };
export const _cellRangeResult = { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 };

/**
 * Get collider bounds (position and half-extents) for an entity
 * ZERO ALLOCATION - mutates result object
 * 
 * Handles both circle and box colliders, includes collider offset
 * 
 * @param {number} idx - Entity index
 * @param {Object} result - Result object to mutate {posX, posY, halfW, halfH}
 * @returns {Object} The result object
 */
export function getColliderBounds(idx, result) {
    // Position = transform + collider offset
    result.posX = Transform.x[idx] + (Collider.offsetX[idx] || 0);
    result.posY = Transform.y[idx] + (Collider.offsetY[idx] || 0);

    // Half-extents based on shape type
    if (Collider.shapeType[idx] === SHAPE_CIRCLE) {
        const r = Collider.radius[idx] || 0;
        result.halfW = r;
        result.halfH = r;
    } else {
        // Box or other - use width/height
        result.halfW = (Collider.width[idx] || 0) * 0.5;
        result.halfH = (Collider.height[idx] || 0) * 0.5;
    }

    return result;
}

/**
 * Calculate cell range from position and half-extents
 * ZERO ALLOCATION - mutates result object
 * 
 * Pure math function - no component dependencies
 * Can be inlined in hot paths if function call overhead matters
 * 
 * @param {number} posX - Center X position
 * @param {number} posY - Center Y position
 * @param {number} halfW - Half width (or radius for circles)
 * @param {number} halfH - Half height (or radius for circles)
 * @param {number} invCellSize - 1/cellSize (pre-compute outside loops!)
 * @param {number} maxCol - gridCols - 1 (pre-compute outside loops!)
 * @param {number} maxRow - gridRows - 1 (pre-compute outside loops!)
 * @param {Object} result - Result object {minCol, maxCol, minRow, maxRow}
 * @returns {Object} The result object
 */
export function getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, result) {
    // Fast floor using bitwise OR (only works for positive numbers, which grid coords are)
    let minCol = ((posX - halfW) * invCellSize) | 0;
    let maxColVal = ((posX + halfW) * invCellSize) | 0;
    let minRow = ((posY - halfH) * invCellSize) | 0;
    let maxRowVal = ((posY + halfH) * invCellSize) | 0;

    // Clamp to grid bounds (branchless using ternary)
    result.minCol = minCol < 0 ? 0 : minCol > maxCol ? maxCol : minCol;
    result.maxCol = maxColVal < 0 ? 0 : maxColVal > maxCol ? maxCol : maxColVal;
    result.minRow = minRow < 0 ? 0 : minRow > maxRow ? maxRow : minRow;
    result.maxRow = maxRowVal < 0 ? 0 : maxRowVal > maxRow ? maxRow : maxRowVal;

    return result;
}

/**
 * Combined: Get cell range for an entity's collider
 * Convenience function for non-hot paths
 * ZERO ALLOCATION - mutates both result objects
 * 
 * @param {number} idx - Entity index
 * @param {number} invCellSize - 1/cellSize
 * @param {number} maxCol - gridCols - 1
 * @param {number} maxRow - gridRows - 1
 * @param {Object} boundsResult - Bounds result object {posX, posY, halfW, halfH}
 * @param {Object} rangeResult - Range result object {minCol, maxCol, minRow, maxRow}
 * @returns {Object} The rangeResult object
 */
export function getEntityCellRange(idx, invCellSize, maxCol, maxRow, boundsResult, rangeResult) {
    getColliderBounds(idx, boundsResult);
    return getCellRange(
        boundsResult.posX, boundsResult.posY,
        boundsResult.halfW, boundsResult.halfH,
        invCellSize, maxCol, maxRow, rangeResult
    );
}
