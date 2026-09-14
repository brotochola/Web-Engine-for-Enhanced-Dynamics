// RenderQueueLayout.js - Single source of truth for render queue SAB memory layout
//
// RENDER QUEUE PIPELINE:
//   Scene.js       allocates SABs using computeBufferSize()
//   pre_render_worker  creates write-views using createViews()
//   pixi_worker        creates read-views using createViews()
//
// SHADER LAYER (two-RT) PIPELINE:
//   1. pre_render_worker collects visible entities assigned to the layer
//   2. Resolves textures/animation, writes composite sortKey + pose to layer SAB
//   3. pixi_worker uploads InstancedSpriteBatch (GPU depth when layer.ySorting)
//   4. Shader layers: instanced Mesh → raw density RT → fullscreen threshold → output RT
//   5. Output RT (or mesh) displayed on stage at the layer's zIndex
//
// Adding a new field: add it to FIELDS, bump version. All consumers update automatically.

const FIELDS = [
    // name,        TypedArray constructor, bytes-per-element
    ['count',       Int32Array,             4,   1],  // always exactly 1 element
    ['x',           Float32Array,           4,   0],
    ['y',           Float32Array,           4,   0],
    ['scaleX',      Float32Array,           4,   0],
    ['scaleY',      Float32Array,           4,   0],
    ['rotC',        Float32Array,           4,   0],
    ['rotS',        Float32Array,           4,   0],
    ['alpha',       Float32Array,           4,   0],
    ['tint',        Uint32Array,            4,   0],
    ['textureId',   Uint16Array,            2,   0],
    ['anchorX',     Float32Array,           4,   0],
    ['anchorY',     Float32Array,           4,   0],
    ['type',        Uint8Array,             1,   0],
    ['entityIndex', Uint16Array,            2,   0],
    // Composite collector key (worldY*K+innerZ / -z / glow bias) — GPU depth when CPU sort skipped
    ['sortKey',     Float32Array,           4,   0],
    // World-space tile period in px; 0 = stretch. Packed u16 pair, then align4.
    ['repeatX',     Uint16Array,            2,   0],
    ['repeatY',     Uint16Array,            2,   0],
    // SPRITE_TILE_MODE; offset 0..65535 = UV 0..1; signed mul written by pre_render.
    ['tileMode',    Uint8Array,             1,   0],
    ['tileOffsetU', Uint16Array,            2,   0],
    ['tileOffsetV', Uint16Array,            2,   0],
    ['tileMulX',    Float32Array,           4,   0],
    ['tileMulY',    Float32Array,           4,   0],
];

/** Sibling SAB: Float32 zoom/x/y + Int32 poseReady (not stuffed in a float). */
export const RENDER_QUEUE_CAMERA_BYTES = 16;
export const RENDER_QUEUE_POSE_READY_OFFSET = 12;

/**
 * @param {SharedArrayBuffer|null|undefined} sab
 * @returns {{ camera: Float32Array, poseReady: Int32Array }|null}
 */
export function createRenderQueueCameraViews(sab) {
    if (!sab) return null;
    return {
        camera: new Float32Array(sab, 0, 3),
        poseReady: new Int32Array(sab, RENDER_QUEUE_POSE_READY_OFFSET, 1),
    };
}

function align4(n) { return (n + 3) & ~3; }

export function computeBufferSize(maxItems) {
    let offset = 0;
    for (let i = 0; i < FIELDS.length; i++) {
        const [, , bpe, fixed] = FIELDS[i];
        const count = fixed || maxItems;
        offset += count * bpe;
        if (bpe < 4) offset = align4(offset);
    }
    return offset;
}

export function createViews(sab, maxItems) {
    const views = {};
    let offset = 0;
    for (let i = 0; i < FIELDS.length; i++) {
        const [name, TypedArrayCtor, bpe, fixed] = FIELDS[i];
        const count = fixed || maxItems;
        views[name] = new TypedArrayCtor(sab, offset, count);
        offset += count * bpe;
        if (bpe < 4) offset = align4(offset);
    }
    return views;
}
