//Config.js
const ENTITY_COUNT = 30000;

// World and canvas dimensions
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const WIDTH = CANVAS_WIDTH * 5;
const HEIGHT = CANVAS_HEIGHT * 5;

// Feature flags
const USE_LIGHTING = false; // Enable/disable lighting system

// Spatial hash grid configuration
const CELL_SIZE = 50; // Each cell covers the visual range
const GRID_COLS = Math.ceil(WIDTH / CELL_SIZE);
const GRID_ROWS = Math.ceil(HEIGHT / CELL_SIZE);
const TOTAL_CELLS = GRID_COLS * GRID_ROWS;
const MAX_NEIGHBORS_PER_ENTITY = 100; // Maximum neighbors to process (from spatial worker)
