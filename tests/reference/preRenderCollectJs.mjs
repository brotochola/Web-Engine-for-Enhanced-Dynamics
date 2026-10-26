// The JS sprite collect pre-render ran before preRenderCollect.wasm took every frame (E-76 W4b; close-out group B):
// collectVisibleEntities' two loops (the camera turned, E-51, and not), as they were in src/workers/preRenderWorker.js.
// The kernel's parity tests compare it with collectVisibleEntities: collectVisibleEntitiesJs(pre) collects this
// frame's sprites on a pre-render worker as the JS did, with the worker's own helpers (the camera bounds, the static
// scenery walk, the display pose, the sort line, collectRenderable for a masked sprite, the glow pass).
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';

/** collectVisibleEntities' JS loops on `pre` (a PreRenderWorker), for this frame. */
export function collectVisibleEntitiesJs(pre) {
    if (pre.globalEntityCount === 0 || !SpriteRenderer.active || !pre.cameraData) return;
    const cameraBounds = pre.calculateCameraBounds();
    if (!cameraBounds) return;

    const x = Transform.x;
    const y = Transform.y;
    const active = Transform.active;
    const spriteRendererActive = SpriteRenderer.active;
    const renderVisible = SpriteRenderer.renderVisible;
    const visualRange = Collider.visualRange;

    const camZoom = cameraBounds.zoom;
    const cameraOffsetX = cameraBounds.cameraOffsetX;
    const cameraOffsetY = cameraBounds.cameraOffsetY;
    const screenMinX = cameraBounds.minX;
    const screenMaxX = cameraBounds.maxX;
    const screenMinY = cameraBounds.minY;
    const screenMaxY = cameraBounds.maxY;

    // Iteration source: published sprite query, else full index scan (not the live SAB list).
    // Normalized to (array, base offset) instead of a per-frame closure so the
    // hot loop below stays allocation-free and the index load stays inlineable.
    let iterCount, iterSource;
    const spriteEntities = Query.queryActiveEntities(pre._querySpriteRenderer || [SpriteRenderer]);
    const walked = pre._staticSceneryWalk(spriteEntities, cameraBounds);
    if (walked >= 0) {
        // E-127: the moving sprites and the static ones in the cells in view, in the list's order.
        iterCount = walked;
        iterSource = pre._staticGrid.list;
    } else if (spriteEntities && spriteEntities.length > 0) {
        iterCount = spriteEntities.length;
        iterSource = spriteEntities;
    } else {
        // Do not walk live activeEntitiesData — logic0 may be mid-merge
        // with count=1. Empty published query falls back to a full scan
        // (inactive slots skip). create() drain publishes before start.
        iterCount = pre.globalEntityCount;
        iterSource = null;
    }

    const boundsHalfW = SpriteRenderer.boundsHalfW;
    const boundsHalfH = SpriteRenderer.boundsHalfH;
    const spritesheetId = SpriteRenderer.spritesheetId;

    // H-19. Everything hoisted out of the per-entity loop below.
    //
    // None of these can change while the loop runs: the component arrays are
    // bound once, `skipCull` is a config flag, and the truthiness of a typed
    // array is fixed at allocation. The loop was re-deriving four array
    // truthiness tests and one property read for every entity on every frame
    // - 45 568 times per frame at the deepest spritePack setting.
    //
    // The counter is the other half. `pre.visibleEntitiesCount++` is a
    // property store per VISIBLE entity, so the same setting performed 45 568
    // property writes to produce one number. It is accumulated in a local and
    // added back once.
    //
    // `+=` and not `=`: `collectVisibleAdobeAnimations` increments the same
    // field and both collectors run per frame, so assigning would discard the
    // other method's contribution.
    const skipCull = pre.skipCull;
    const hasSpriteRenderer = !!spriteRendererActive;
    const hasHalfW = !!boundsHalfW;
    const hasHalfH = !!boundsHalfH;
    const hasVisualRange = !!visualRange;
    const hasSheetId = !!spritesheetId;
    const useIterSource = iterSource !== null && iterSource !== undefined;
    let visibleCount = 0;
    // E-98c. A sprite with no layer mask goes to the entities collector: what collectRenderable's
    // type dispatch and bit scan come to for it, without them. Masked sprites take that path.
    const queueSprites = pre.renderQueueEnabled;
    const spriteLayerMask = SpriteRenderer.layerMask || null;
    const entitiesId = Layer.entitiesId;
    // E-98e. Those sprites go to the main collector, written here as _writeRenderable writes
    // them: it re-read a dozen fields per sprite. `n` is its count; collectRenderable, for
    // masked sprites, updates the field, so it is synced around that call and after the loop.
    const rY = pre._renderableY;
    const rType = pre._renderableType;
    const rIndex = pre._renderableIndex;
    const cPx = pre._collectPx;
    const cPy = pre._collectPy;
    const cRotC = pre._collectRotC;
    const cRotS = pre._collectRotS;
    const pose = pre._displayPoseOut;
    const sortY = pre._entitySortY;
    const maxItems = pre.renderQueueMaxItems;
    // The sprites' collector key as the kernel path writes it (the sort line under Y-sort, else 0, unread): the JS
    // read the worker's COLLECT_Y, the last collector's key.
    const keyY = 0;
    let n = pre._renderableCount;
    // E-98f. A sprite with no body takes _displayPose's Transform branch, read here instead of
    // in a call per sprite; a body (a published physics pose) still goes through _displayPose.
    const bodyPoses = pre._poseX && pre._rbActive ? pre._rbActive : null;
    const tRotC = Transform.rotC;
    const tRotS = Transform.rotS;

    const rot = pre._frameCameraRot || 0;
    if (rot && !skipCull) {
        // E-51. A turned camera's box (above) is ~2× the view at 45° on 16:9,
        // and everything in it was queued. Here each point turns into view
        // space and is tested against the view itself plus the same margin.
        // A copy of the loop below, so rotation 0 runs the loop it always did.
        const rc = Math.cos(rot);
        const rs = Math.sin(rot);
        const halfCw = pre.canvasWidth * 0.5;
        const halfCh = pre.canvasHeight * 0.5;
        const marginScale = camZoom < 1 ? camZoom : 1;
        const limW = halfCw + pre.canvasWidth * pre.cullingRatio * marginScale;
        const limH = halfCh + pre.canvasHeight * pre.cullingRatio * marginScale;
        for (let idx = 0; idx < iterCount; idx++) {
            const i = useIterSource ? iterSource[idx] : idx;
            if (!active[i]) continue;
            if (!hasSpriteRenderer || !spriteRendererActive[i]) continue;

            const dx = x[i] * camZoom - cameraOffsetX - halfCw;
            const dy = y[i] * camZoom - cameraOffsetY - halfCh;
            let halfExtent = 0;
            if (hasHalfW) {
                const halfW = boundsHalfW[i] || 0;
                const halfH = hasHalfH ? (boundsHalfH[i] || 0) : 0;
                if (halfW > halfH) halfExtent = halfW;
                else if (halfH > 0) halfExtent = halfH;
            }
            if (halfExtent <= 0 && hasVisualRange) halfExtent = visualRange[i] || 0;
            const extent = halfExtent * camZoom;
            const u = rc * dx - rs * dy;
            const v = rs * dx + rc * dy;
            const w = limW + extent;
            const h = limH + extent;
            if (u < -w || u > w || v < -h || v > h) continue;

            if (renderVisible[i] && hasSheetId && spritesheetId[i]) {
                if (queueSprites && (spriteLayerMask === null || spriteLayerMask[i] === 0)) {
                    if (n < maxItems) {
                        rY[n] = keyY;
                        rType[n] = 0;
                        rIndex[n] = i;
                        if (bodyPoses !== null && bodyPoses[i]) {
                            pre._displayPose(i, pose);
                        } else {
                            pose[0] = x[i];
                            pose[1] = y[i];
                            pose[2] = tRotC && tRotC[i] !== undefined ? tRotC[i] : 1;
                            pose[3] = tRotS ? (tRotS[i] || 0) : 0;
                        }
                        cPx[n] = pose[0];
                        cPy[n] = pose[1];
                        cRotC[n] = pose[2];
                        cRotS[n] = pose[3];
                        if (sortY) pre._storeEntitySortY(0, i, pose, rY, n);
                        n++;
                    } else {
                        pre._collectorFull();
                    }
                } else {
                    pre._renderableCount = n;
                    pre.collectRenderable(0, i);
                    n = pre._renderableCount;
                }
                visibleCount++;
            }
        }
        pre._renderableCount = n;
        pre.visibleEntitiesCount += visibleCount;
        pre._collectEntityGlow(x, y, visualRange, camZoom, cameraOffsetX, cameraOffsetY,
            screenMinX, screenMaxX, screenMinY, screenMaxY);
        return;
    }

    for (let idx = 0; idx < iterCount; idx++) {
        const i = useIterSource ? iterSource[idx] : idx;
        if (!active[i]) continue;
        if (!hasSpriteRenderer || !spriteRendererActive[i]) continue;

        if (!skipCull) {
            const sx = x[i] * camZoom - cameraOffsetX;
            const sy = y[i] * camZoom - cameraOffsetY;

            // Use cached bounds (updated on scale/animation change)
            let halfExtent = 0;
            if (hasHalfW) {
                const halfW = boundsHalfW[i] || 0;
                const halfH = hasHalfH ? (boundsHalfH[i] || 0) : 0;
                if (halfW > halfH) halfExtent = halfW;
                else if (halfH > 0) halfExtent = halfH;
            }
            if (halfExtent <= 0 && hasVisualRange) halfExtent = visualRange[i] || 0;
            const extent = halfExtent * camZoom;
            const onScreen = sx >= screenMinX - extent && sx <= screenMaxX + extent &&
                sy >= screenMinY - extent && sy <= screenMaxY + extent;
            if (!onScreen) continue;
        }

        // sheetId 0 = unset (spawn reset / pool recycle). Never queue.
        if (renderVisible[i] && hasSheetId && spritesheetId[i]) {
            if (queueSprites && (spriteLayerMask === null || spriteLayerMask[i] === 0)) {
                if (n < maxItems) {
                    rY[n] = keyY;
                    rType[n] = 0;
                    rIndex[n] = i;
                    if (bodyPoses !== null && bodyPoses[i]) {
                        pre._displayPose(i, pose);
                    } else {
                        pose[0] = x[i];
                        pose[1] = y[i];
                        pose[2] = tRotC && tRotC[i] !== undefined ? tRotC[i] : 1;
                        pose[3] = tRotS ? (tRotS[i] || 0) : 0;
                    }
                    cPx[n] = pose[0];
                    cPy[n] = pose[1];
                    cRotC[n] = pose[2];
                    cRotS[n] = pose[3];
                    if (sortY) pre._storeEntitySortY(0, i, pose, rY, n);
                    n++;
                } else {
                    pre._collectorFull();
                }
            } else {
                pre._renderableCount = n;
                pre.collectRenderable(0, i);
                n = pre._renderableCount;
            }
            visibleCount++;
        }
        // Sun shadows are a second draw of this sprite. No shadow-queue row.
    }

    pre._renderableCount = n;
    pre.visibleEntitiesCount += visibleCount;

    // PRE-HOT: glow collect in a separate pass over LightEmitter actives only
    pre._collectEntityGlow(x, y, visualRange, camZoom, cameraOffsetX, cameraOffsetY,
        screenMinX, screenMaxX, screenMinY, screenMaxY);
}
