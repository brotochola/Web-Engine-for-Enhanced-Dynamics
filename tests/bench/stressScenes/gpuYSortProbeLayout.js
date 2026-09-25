/** Shared by the probe scene (browser) and the pixel runner (node). No engine import. */

export const CANVAS_W = 960;
export const CANVAS_H = 360;

const RED = 0xff0000;
const BLUE = 0x0000ff;

function spr(tint, y, extra = {}) {
  return {
    tint,
    y,
    anchorX: 0.5,
    anchorY: 1,
    scale: 8,
    zIndex: 0,
    rot: 0,
    layer: null,
    decoration: null,
    ...extra,
  };
}

export const CASES = [
  {
    id: '1px',
    x: 60,
    sampleX: 60,
    sampleY: 140,
    sprites: [spr(RED, 160), spr(BLUE, 161)],
  },
  {
    id: 'anchorY-5px',
    x: 170,
    sampleX: 170,
    sampleY: 140,
    sprites: [
      spr(RED, 160, { anchorY: 1 }),
      spr(BLUE, 160, { anchorY: 1 - 5 / 64 }),
    ],
  },
  {
    id: 'anchorY-64px',
    x: 280,
    sampleX: 280,
    sampleY: 120,
    sprites: [
      spr(RED, 180, { scale: 16, anchorY: 1 }),
      spr(BLUE, 180, { scale: 16, anchorY: 0.5 }),
    ],
  },
  {
    id: 'anchorX',
    x: 400,
    sampleX: 400,
    sampleY: 140,
    sprites: [
      spr(RED, 160, { anchorX: 0.2 }),
      spr(BLUE, 160, { anchorX: 0.8 }),
    ],
  },
  {
    id: 'anchorX-rot',
    x: 520,
    sampleX: 520,
    sampleY: 160,
    sprites: [
      spr(RED, 160, { anchorX: 0, rot: Math.PI / 2 }),
      spr(BLUE, 160, { anchorX: 1, rot: Math.PI / 2 }),
    ],
  },
  {
    id: 'zIndex',
    x: 640,
    sampleX: 640,
    sampleY: 80,
    sprites: [
      spr(RED, 180, { scale: 16, zIndex: 0 }),
      spr(BLUE, 100, { scale: 16, zIndex: 1 }),
    ],
  },
  {
    id: 'innerZ',
    x: 760,
    sampleX: 760,
    sampleY: 140,
    sprites: [
      spr(RED, 160, {
        decoration: { tint: BLUE, scale: 8, innerZ: 1, anchorX: 0.5, anchorY: 1 },
      }),
    ],
  },
  {
    id: 'customLayer-1px',
    x: 880,
    sampleX: 880,
    sampleY: 140,
    sprites: [
      spr(RED, 160, { layer: 'pile' }),
      spr(BLUE, 161, { layer: 'pile' }),
    ],
  },
];
