// The A* stress scene's maze, the same in every thread (a seed, no randomness at run time): rooms ROOM cells a side,
// walls one cell thick on the room lines, a door DOOR cells wide in each wall between two rooms, and pillars inside the
// rooms. Walls come out as boxes in cells (one per run of wall cells), for the wall entities the nav grid reads.
export const NAV_CELL = 32;
export const COLS = 96;
export const ROWS = 96;
export const ROOM = 12;
const DOOR = 2;
const PILLARS_PER_ROOM = 4;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** { walls: [{ x, y, w, h }] in cells, walkable: Uint8Array(COLS * ROWS) } */
export function buildMaze(seed = 207) {
  const rnd = lcg(seed);
  const wall = new Uint8Array(COLS * ROWS);
  const set = (x, y) => {
    if (x >= 0 && y >= 0 && x < COLS && y < ROWS) wall[y * COLS + x] = 1;
  };
  // Room lines with a door in each room-long stretch.
  for (let line = ROOM; line < COLS; line += ROOM) {
    for (let from = 0; from < ROWS; from += ROOM) {
      const door = from + 1 + Math.floor(rnd() * (ROOM - DOOR - 1));
      for (let y = from; y < Math.min(ROWS, from + ROOM); y++) if (y < door || y >= door + DOOR) set(line, y);
    }
  }
  for (let line = ROOM; line < ROWS; line += ROOM) {
    for (let from = 0; from < COLS; from += ROOM) {
      const door = from + 1 + Math.floor(rnd() * (ROOM - DOOR - 1));
      for (let x = from; x < Math.min(COLS, from + ROOM); x++) if (x < door || x >= door + DOOR) set(x, line);
    }
  }
  // Pillars, 2 by 2, inside each room, away from its walls.
  for (let ry = 0; ry < ROWS; ry += ROOM) {
    for (let rx = 0; rx < COLS; rx += ROOM) {
      for (let k = 0; k < PILLARS_PER_ROOM; k++) {
        const x = rx + 2 + Math.floor(rnd() * (ROOM - 5));
        const y = ry + 2 + Math.floor(rnd() * (ROOM - 5));
        set(x, y);
        set(x + 1, y);
        set(x, y + 1);
        set(x + 1, y + 1);
      }
    }
  }
  // Boxes: horizontal runs of wall cells, merged down while the run below is the same.
  const used = new Uint8Array(COLS * ROWS);
  const walls = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = y * COLS + x;
      if (!wall[c] || used[c]) continue;
      let w = 1;
      while (x + w < COLS && wall[c + w] && !used[c + w]) w++;
      let h = 1;
      for (;;) {
        if (y + h >= ROWS) break;
        let full = true;
        for (let i = 0; i < w && full; i++) {
          const b = (y + h) * COLS + x + i;
          if (!wall[b] || used[b]) full = false;
        }
        if (!full) break;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used[(y + j) * COLS + x + i] = 1;
      walls.push({ x, y, w, h });
    }
  }
  const walkable = new Uint8Array(COLS * ROWS);
  for (let i = 0; i < walkable.length; i++) walkable[i] = wall[i] ? 0 : 1;
  return { walls, walkable };
}
