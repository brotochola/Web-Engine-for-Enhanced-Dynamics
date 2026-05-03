/**
 * Declarations for {@link ../src/core/utils.js} (re-exported from package entry).
 */

export type Vec2Like = { x: number; y: number };
export type RectLike = { x: number; y: number; width: number; height: number };

export function layerMask(layers: unknown): number;
export function countTrailingZeros(n: number): number;
export function binarySearchRange(
  data: ArrayLike<number>,
  start: number,
  end: number,
): number;
export function binarySearchInsertPoint(
  data: ArrayLike<number>,
  value: number,
  count: number,
): number;
export function binarySearchFind(
  data: ArrayLike<number>,
  value: number,
  count: number,
): number;
export function formatNumber(num: number, fallback?: string): string;
export function clamp01(value: number, fallback?: number): number;
export function clamp01Fast(value: number): number;
export function clamp(value: number, min: number, max: number): number;
export function lerp(a: number, b: number, t: number): number;
export function calculateCameraScreenBounds(
  cameraX: number,
  cameraY: number,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
  result?: Vec2Like,
): Vec2Like;
export function screenBoundsToWorldBounds(
  screenBounds: RectLike,
  worldMarginX?: number,
  worldMarginY?: number,
  result?: RectLike,
): RectLike;
export function rayCircleIntersect(
  rayX: number,
  rayY: number,
  dirX: number,
  dirY: number,
  circleX: number,
  circleY: number,
  radius: number,
  maxDist: number,
): number;
export function rayCircleHit(
  rayX: number,
  rayY: number,
  dirX: number,
  dirY: number,
  circleX: number,
  circleY: number,
  radius: number,
  maxDist: number,
): boolean;
export function rayBoxIntersect(
  rayX: number,
  rayY: number,
  dirX: number,
  dirY: number,
  boxX: number,
  boxY: number,
  width: number,
  height: number,
  maxDist: number,
): number;
export function rayBoxHit(
  rayX: number,
  rayY: number,
  dirX: number,
  dirY: number,
  boxX: number,
  boxY: number,
  width: number,
  height: number,
  maxDist: number,
): boolean;
export function randomRange(value: unknown, defaultVal?: number): number;
export function randomColor(value: unknown, defaultVal?: number): number;
export function distanceSq2D(x1: number, y1: number, x2: number, y2: number): number;
export function normalizeDirection(dx: number, dy: number, result?: Vec2Like): Vec2Like;
export function normalizeDirectionFast(dx: number, dy: number, result?: Vec2Like): Vec2Like;
export function normalizeDirectionFromDistSq(
  dx: number,
  dy: number,
  distSq: number,
  result?: Vec2Like,
): Vec2Like;
export function directionTo(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  result?: Vec2Like,
): Vec2Like;
export function cantorPair(a: number, b: number): number;
export function cantorUnpair(z: number, result?: { a: number; b: number }): { a: number; b: number };
export const _cantorResult: { a: number; b: number };
export function distance2D(x1: number, y1: number, x2: number, y2: number): number;
export function isWithinRange(x1: number, y1: number, x2: number, y2: number, range: number): boolean;
export function isWithinRangeSq(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rangeSq: number,
): boolean;
export function applyBrightnessToColor(color: number, brightness: number): number;
export const _collisionResult: {
  collided: boolean;
  depth: number;
  nx: number;
  ny: number;
};
export const _directionResult: { x: number; y: number; length: number };
export const _velocityResult: { vx: number; vy: number };
export const _cellResult: { col: number; row: number };
export const _pointResult: { x: number; y: number };
export const _rgbResult: { r: number; g: number; b: number };
export function closestPointOnAABB(
  pointX: number,
  pointY: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
): Vec2Like;
export function closestPointOnAABBMut(
  pointX: number,
  pointY: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  result: Vec2Like,
): Vec2Like;
export function clampVelocity(vx: number, vy: number, maxSpeed: number): Vec2Like;
export function clampVelocityMut(
  vx: number,
  vy: number,
  maxSpeed: number,
  result: Vec2Like,
): Vec2Like;
export function computeCircleMass(radius: number): number;
export function computeBoxMass(width: number, height: number): number;
export function updateMassFromCircle(index: number, radius: number, RigidBody: unknown): void;
export function updateMassFromBox(
  index: number,
  width: number,
  height: number,
  RigidBody: unknown,
): void;
export function mixTint(a: number, b: number, t: number): number;
export function testCircleCircleCollision(
  x1: number,
  y1: number,
  r1: number,
  x2: number,
  y2: number,
  r2: number,
  result?: typeof _collisionResult,
): boolean;
export function testCircleAABBCollision(
  circleX: number,
  circleY: number,
  circleR: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  result?: typeof _collisionResult,
): boolean;
export function testAABBAABBCollision(
  x1: number,
  y1: number,
  w1: number,
  h1: number,
  x2: number,
  y2: number,
  w2: number,
  h2: number,
  result?: typeof _collisionResult,
): boolean;
export function getCellIndex(
  x: number,
  y: number,
  cellSize: number,
  gridCols: number,
  gridRows: number,
): number;
export function getCellCoords(
  x: number,
  y: number,
  cellSize: number,
  gridCols: number,
  gridRows: number,
): { col: number; row: number };
export function getCellCoordsMut(
  x: number,
  y: number,
  cellSize: number,
  gridCols: number,
  gridRows: number,
  result: { col: number; row: number },
): { col: number; row: number };
export function getParentClasses(childClass: unknown): unknown[];
export function collectComponents(
  EntityClass: unknown,
  BaseClass?: unknown,
  DefaultComponent?: unknown,
): unknown[];
export function setupWorkerCommunication(connections: unknown): void;
export function getPortTransferables(portGroup: unknown): Transferable[];
export function postWorkerInitMessage(...args: unknown[]): void;
export function validatePhysicsConfig(currentConfig: unknown, newConfig: unknown): unknown;
export function normalizeAngle(angle: number): number;
export function normalizeAngleDifference(angle1: number, angle2: number): number;
export function lerpAngle(a: number, b: number, t: number): number;
export function getDirectionFromAngle(angle: number): Vec2Like;
export function seededRandom(seed: number): () => number;
export function rng(): number;
export function query(componentClasses: unknown[]): number[];
export function queryActiveEntities(componentClasses: unknown[]): number[];
export function queryActiveEntitiesSlow(componentClasses: unknown[]): number[];
export function calculateLightAttenuation(intensity: number, distanceSquared: number): number;
export function calculateTotalLightAtPosition(...args: unknown[]): unknown;
export function calculateLightFromNeighbors(...args: unknown[]): unknown;
export function brightnessToTint(brightness: number): number;
export function brightnessToColoredTint(brightness: number, baseColor?: number): number;
export function createCircularGradientCanvas(radius?: number, color?: number): HTMLCanvasElement;
export function createBulletTrailCanvas(
  width?: number,
  height?: number,
  color?: number,
): HTMLCanvasElement;
export function extractRGB(color: number): { r: number; g: number; b: number };
export function extractRGBMut(color: number, result: { r: number; g: number; b: number }): void;
export function extractRGBNormalized(color: number): { r: number; g: number; b: number };
export function extractRGBNormalizedMut(
  color: number,
  result: { r: number; g: number; b: number },
): void;
export function calculateSpeed(vx: number, vy: number): number;
export function calculateVelocityAngle(vx: number, vy: number): number;
export function loadEntityScripts(
  scriptsToLoad: string[],
  globalContext?: unknown,
  verbose?: boolean | null,
): Promise<Record<string, unknown>>;
export function collectAllComponentsFromClasses(
  registeredClasses: unknown[],
  globalRef: unknown,
): unknown;
export function initializeComponentViews(...args: unknown[]): unknown;
export function exposeComponentsGlobally(componentMap: unknown, globalRef: unknown): void;
export function exposeEntityClassesGlobally(registeredClasses: unknown[], globalRef: unknown): void;
export function urlToPath(url: string): string;
export function drawLine(graphics: unknown, options: Record<string, unknown>): void;
export function drawCircle(graphics: unknown, options: Record<string, unknown>): void;
export function drawCross(graphics: unknown, options: Record<string, unknown>): void;
export function printLogo(): void;
export function sortByY(a: unknown, b: unknown): number;
export function stringToHash(str: string): number;
export function hashToPastelColorCSS(hash: number): string;
export function hashToPastelColorHex(hash: number): number;
export function hslToHex(h: number, s: number, l: number): number;
export const COMPONENT_COLORS: Readonly<Record<string, string>>;
export function getComponentColor(componentName: string): string;
export function getComponentPropertyNames(ComponentClass: unknown): string[];
export function calculateDecalTileBounds(...args: unknown[]): unknown;
export function calculateTileClipRegion(...args: unknown[]): unknown;
export const _decalTileBounds: {
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
  valid: boolean;
};
export const _tileClipRegion: {
  dstStartX: number;
  dstStartY: number;
  dstEndX: number;
  dstEndY: number;
  srcOffsetX: number;
  srcOffsetY: number;
  clipWidth: number;
  clipHeight: number;
  uvScaleX: number;
  uvScaleY: number;
  valid: boolean;
};
export function formatComponentValue(propName: string, value: unknown): string;
export function containerRadius(N: number, R: number, margin?: number): number;
export function generateSymmetricalCirclePattern(cellRadius: number, cellSize: number): Int32Array;
