// Static flowfield files (a scene's `static assets.flowfields`): WeedJS's binary format and the JSON one.
//
// Binary, version 1, little-endian. A 24-byte header, never compressed, then the cells:
//    0  4 bytes  "WEFF"
//    4  u8       version: 1
//    5  u8       compression: 0 none, 1 gzip (DecompressionStream opens it, in browsers and in Node 18+)
//    6  u16      reserved: 0
//    8  u32      width in cells
//   12  u32      height in cells
//   16  f64      cell size in world px
//   24  cells    width × height × 2 bytes, row by row from the top: x then y as Int8 (-127..127 for -1..1;
//                0, 0 = no direction). With compression 1 they are one gzip stream that inflates to exactly that.
// The cells are the Int8Array NavGrid samples, so a loaded file is used as it comes, with no per-cell work.
//
// JSON: { metadata: { widthCells, heightCells, cellSizePx }, data: rows of [x, y] or null }. Each component
// becomes Math.round(clamp(v, -1, 1) * 127), so a JSON field and its binary copy sample the same.

export const STATIC_FLOWFIELD_MAGIC = 0x46464557; // "WEFF" read as a little-endian u32
export const STATIC_FLOWFIELD_VERSION = 1;
export const STATIC_FLOWFIELD_HEADER_BYTES = 24;
export const STATIC_FLOWFIELD_COMPRESSION = Object.freeze({ NONE: 0, GZIP: 1 });

const HEADER = STATIC_FLOWFIELD_HEADER_BYTES;

function asBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  return new Uint8Array(src);
}

const isCount = (n) => Number.isInteger(n) && n > 0;

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when the bytes start with the binary format's "WEFF". */
export function isStaticFlowfieldBinary(src) {
  const b = asBytes(src);
  return b.length >= 4 && b[0] === 0x57 && b[1] === 0x45 && b[2] === 0x46 && b[3] === 0x46;
}

/**
 * Read a binary flowfield. An uncompressed file's vectors are a view of the bytes given (no copy).
 * @param {ArrayBuffer | ArrayBufferView} src
 * @returns {Promise<{ gridWidth: number, gridHeight: number, cellSize: number, vectors: Int8Array }>}
 */
export async function decodeStaticFlowfield(src) {
  const b = asBytes(src);
  if (b.length < HEADER || !isStaticFlowfieldBinary(b)) {
    throw new Error('not a WeedJS binary flowfield: it does not start with a "WEFF" header');
  }
  const view = new DataView(b.buffer, b.byteOffset, HEADER);
  const version = view.getUint8(4);
  if (version !== STATIC_FLOWFIELD_VERSION) {
    throw new Error(
      `binary flowfield version ${version}: this WeedJS reads version ${STATIC_FLOWFIELD_VERSION}`
    );
  }
  const compression = view.getUint8(5);
  const gridWidth = view.getUint32(8, true);
  const gridHeight = view.getUint32(12, true);
  const cellSize = view.getFloat64(16, true);
  if (!isCount(gridWidth) || !isCount(gridHeight) || !(cellSize > 0)) {
    throw new Error(
      `binary flowfield header holds ${gridWidth} × ${gridHeight} cells of ${cellSize} px`
    );
  }
  const body = b.subarray(HEADER);
  let cells;
  if (compression === STATIC_FLOWFIELD_COMPRESSION.NONE) {
    cells = body;
  } else if (compression === STATIC_FLOWFIELD_COMPRESSION.GZIP) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('binary flowfield is gzipped and this browser has no DecompressionStream');
    }
    cells = await pipeBytes(body, new DecompressionStream('gzip'));
  } else {
    throw new Error(
      `binary flowfield compression ${compression}: this WeedJS reads 0 (none) and 1 (gzip)`
    );
  }
  const bytes = gridWidth * gridHeight * 2;
  if (cells.length !== bytes) {
    throw new Error(
      `binary flowfield holds ${cells.length} cell bytes; its ${gridWidth} × ${gridHeight} header needs ${bytes}`
    );
  }
  return {
    gridWidth,
    gridHeight,
    cellSize,
    vectors: new Int8Array(cells.buffer, cells.byteOffset, bytes),
  };
}

/**
 * Write a binary flowfield (for tools: editors, converters, tests).
 * @param {{ gridWidth: number, gridHeight: number, cellSize: number, vectors: Int8Array }} field
 * @param {{ compress?: boolean }} [options] gzip the cells (default true)
 * @returns {Promise<Uint8Array>}
 */
export async function encodeStaticFlowfield(
  { gridWidth, gridHeight, cellSize, vectors },
  { compress = true } = {}
) {
  if (!isCount(gridWidth) || !isCount(gridHeight) || !(cellSize > 0)) {
    throw new Error(
      `a flowfield needs whole positive sizes and a positive cell size, got ${gridWidth} × ${gridHeight}, ${cellSize} px`
    );
  }
  const bytes = gridWidth * gridHeight * 2;
  if (!(vectors instanceof Int8Array) || vectors.length !== bytes) {
    throw new Error(
      `a ${gridWidth} × ${gridHeight} flowfield needs an Int8Array of ${bytes} (x, y per cell)`
    );
  }
  let body = new Uint8Array(vectors.buffer, vectors.byteOffset, bytes);
  if (compress) body = await pipeBytes(body, new CompressionStream('gzip'));
  const out = new Uint8Array(HEADER + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, STATIC_FLOWFIELD_MAGIC, true);
  view.setUint8(4, STATIC_FLOWFIELD_VERSION);
  view.setUint8(
    5,
    compress ? STATIC_FLOWFIELD_COMPRESSION.GZIP : STATIC_FLOWFIELD_COMPRESSION.NONE
  );
  view.setUint32(8, gridWidth, true);
  view.setUint32(12, gridHeight, true);
  view.setFloat64(16, cellSize, true);
  out.set(body, HEADER);
  return out;
}

/**
 * The cells of a JSON flowfield, at most maxWidth × maxHeight of them (from the top left).
 * @returns {{ gridWidth: number, gridHeight: number, cellSize: number, vectors: Int8Array }}
 */
export function staticFlowfieldFromJSON(json, maxWidth = Infinity, maxHeight = Infinity) {
  const { metadata, data } = json;
  const cellSize = metadata.cellSizePx;
  const gridWidth = Math.min(metadata.widthCells, maxWidth);
  const gridHeight = Math.min(metadata.heightCells, maxHeight);
  const vectors = new Int8Array(gridWidth * gridHeight * 2);
  for (let row = 0; row < gridHeight; row++) {
    const rowData = data[row];
    for (let col = 0; col < gridWidth; col++) {
      const cell = rowData[col];
      if (cell) {
        const idx = (row * gridWidth + col) * 2;
        vectors[idx] = Math.round(Math.max(-1, Math.min(1, cell[0])) * 127);
        vectors[idx + 1] = Math.round(Math.max(-1, Math.min(1, cell[1])) * 127);
      }
    }
  }
  return { gridWidth, gridHeight, cellSize, vectors };
}

/**
 * The top-left maxWidth × maxHeight cells of a field: the same object when it already fits, a view when only rows go,
 * a copy when columns go too.
 */
export function clipStaticFlowfield(field, maxWidth, maxHeight) {
  const gridWidth = Math.min(field.gridWidth, maxWidth);
  const gridHeight = Math.min(field.gridHeight, maxHeight);
  if (gridWidth === field.gridWidth && gridHeight === field.gridHeight) return field;
  let vectors;
  if (gridWidth === field.gridWidth) {
    vectors = field.vectors.subarray(0, gridWidth * gridHeight * 2);
  } else {
    vectors = new Int8Array(gridWidth * gridHeight * 2);
    const srcRow = field.gridWidth * 2;
    const dstRow = gridWidth * 2;
    for (let row = 0; row < gridHeight; row++) {
      vectors.set(field.vectors.subarray(row * srcRow, row * srcRow + dstRow), row * dstRow);
    }
  }
  return { gridWidth, gridHeight, cellSize: field.cellSize, vectors };
}
