// RenderQueueLayout.js - Single source of truth for render queue SAB memory layout
//
// RENDER QUEUE PIPELINE:
//   Scene.js       allocates SABs using computeBufferSize()
//   pre_render_worker  creates write-views using createViews()
//   pixi_worker        creates read-views using createViews()
//
// SHADER LAYER (two-RT) PIPELINE:
//   1. pre_render_worker collects visible entities assigned to the layer
//   2. Y-sorts them, resolves textures/animation, writes to layer's render queue SAB
//   3. pixi_worker reads the queue, updates ParticleContainer sprites
//   4. Renders ParticleContainer (additive blend) → raw density RenderTexture
//   5. Renders fullscreen Mesh (custom fragment shader reads density RT) → output RenderTexture
//   6. Output RT displayed on stage via Sprite at the layer's zIndex
//
// Adding a new field: add it to FIELDS, bump version. All consumers update automatically.

const FIELDS = [
    // name,        TypedArray constructor, bytes-per-element
    ['count',       Int32Array,             4,   1],  // always exactly 1 element
    ['x',           Float32Array,           4,   0],
    ['y',           Float32Array,           4,   0],
    ['scaleX',      Float32Array,           4,   0],
    ['scaleY',      Float32Array,           4,   0],
    ['rotation',    Float32Array,           4,   0],
    ['alpha',       Float32Array,           4,   0],
    ['tint',        Uint32Array,            4,   0],
    ['textureId',   Uint16Array,            2,   0],
    ['anchorX',     Float32Array,           4,   0],
    ['anchorY',     Float32Array,           4,   0],
    ['type',        Uint8Array,             1,   0],
    ['entityIndex', Int32Array,             4,   0],
];

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
