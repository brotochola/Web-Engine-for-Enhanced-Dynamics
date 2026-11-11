import WEED from '/src/index.js';
import { AstarAgent, AstarMazeBuilder, AstarPlanner, AstarWall } from './astarStress/astarEntities.js';
import { buildMaze, COLS, NAV_CELL, ROWS } from './astarStress/astarMaze.js';

const { Scene, Camera } = WEED;

// A* paths under load (E-207, E-212, N-137): agents walk a maze of rooms by NavGrid.getNextAStarPosition, each to a
// random cell and then another; every cell an agent enters is a new (from, to) pair, so the particle worker runs A*
// for it. Agents wait for their paths, so a faster search raises their demand: the fixed load comes from planners,
// each asking for one new random pair a tick. PATHS_COMPUTED is the load key, the particle worker's STEP_MS the owner;
// logic pays the path-slot lookups.
//   ?agents=400  walking agents (0 for a load that is the planners' alone)
//   ?plans=60    planners: new paths asked for each frame, whatever the answers (the load knob)
//   ?speed=2     px a tick
const AGENTS = Math.max(0, Math.floor(Number(WEED.params?.get('agents') ?? 400)));
const PLANS = Math.max(0, Math.floor(Number(WEED.params?.get('plans') ?? 60)));
const MAZE = buildMaze(207);
const WORLD_W = COLS * NAV_CELL;
const WORLD_H = ROWS * NAV_CELL;

export class AstarStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 207,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, noLimitFPS: false },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { subStepCount: 1, noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    navigation: {
      enabled: true,
      cellSize: NAV_CELL,
      maxFlowfields: 1,
      // A slot for every agent's live pair and its last one, and eight frames of the planners' (never asked for again).
      // Each new path scans every slot for the one to evict (E-214), so more slots time that scan, not A*.
      maxPaths: Math.max(16, AGENTS * 2 + PLANS * 8),
      // Longer than any path across the maze, so none is cut.
      maxPathLength: 512,
      // Every request served the frame it arrives: the time is the owner's, not capped.
      maxProcessingMsPerFrame: 50,
    },
    renderer: { backend: 'webgl', noLimitFPS: false },
    lighting: { enabled: false },
  };

  static entities = [
    [AstarWall, MAZE.walls.length],
    [AstarAgent, AGENTS],
    [AstarPlanner, PLANS],
    [AstarMazeBuilder, 1],
  ];

  create() {
    for (const w of MAZE.walls) {
      // A pixel short on each side: the nav grid marks every cell the collider's bounds touch.
      AstarWall.spawn({
        x: (w.x + w.w / 2) * NAV_CELL,
        y: (w.y + w.h / 2) * NAV_CELL,
        width: w.w * NAV_CELL - 2,
        height: w.h * NAV_CELL - 2,
      });
    }
    AstarMazeBuilder.spawn({ x: 0, y: 0, walls: MAZE.walls.length });
    // Agents start on walkable cells spread over the maze.
    const walkable = [];
    for (let c = 0; c < MAZE.walkable.length; c++) if (MAZE.walkable[c]) walkable.push(c);
    for (let i = 0; i < AGENTS; i++) {
      const cell = walkable[Math.floor(((i * 7919) % walkable.length))];
      AstarAgent.spawn({
        x: ((cell % COLS) + 0.5) * NAV_CELL,
        y: (Math.floor(cell / COLS) + 0.5) * NAV_CELL,
        seed: i + 1,
      });
    }
    for (let i = 0; i < PLANS; i++) AstarPlanner.spawn({ x: 0, y: 0, seed: i + 1 });
    Camera.centerOn(WORLD_W / 2, WORLD_H / 2);
  }
}
