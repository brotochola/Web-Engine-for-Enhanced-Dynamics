//Config.js
const ENTITY_COUNT = 20000;

// World and canvas dimensions
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const WIDTH = 2200;
const HEIGHT = 1500;

// Spatial hash grid configuration
const CELL_SIZE = 50; // Each cell covers the visual range
const GRID_COLS = Math.ceil(WIDTH / CELL_SIZE);
const GRID_ROWS = Math.ceil(HEIGHT / CELL_SIZE);
const TOTAL_CELLS = GRID_COLS * GRID_ROWS;
const MAX_NEIGHBORS_PER_ENTITY = 100; // Maximum neighbors to process (from spatial worker)
