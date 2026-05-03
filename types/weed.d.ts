/**
 * TypeScript declarations for @weed.js/engine public API.
 * Source of truth for behavior: JavaScript sources under ../src/
 */

export * from './utils';

// --- Config / enums (from ConfigDefaults.js) ---

export const ShapeType: Readonly<{ Circle: 0; Box: 1 }>;
export const BLEND_MODES: Readonly<Record<string, number>>;
export const DEFAULT_LAYERS: Readonly<Record<string, unknown>>;
export const CAMERA_TYPES: Readonly<Record<string, number>>;

export type SpawnConfig = Record<string, unknown>;

export interface GameEngineConfig {
  autoResize?: boolean;
  preventContextMenu?: boolean;
  preventDefaultKeys?: boolean;
  injectStyles?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  debug?: boolean;
  debugUpdateInterval?: number;
  debugDefaultOpen?: boolean | null;
  transitionCooldown?: number;
}

/** Mutable 2D vector used as output by several static APIs. */
export interface Vec2Mutable {
  x: number;
  y: number;
}

export interface CameraFollowTarget {
  x: number;
  y: number;
}

export interface CameraViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface RayHitInfo {
  hit: boolean;
  entityIndex: number;
  distance: number;
  hitX: number;
  hitY: number;
}

export interface RayLinecastResult {
  blocked: boolean;
  entityIndex: number;
  distance: number;
}

export interface RayMultiHitEntry {
  entityIndex: number;
  distance: number;
  hitX: number;
  hitY: number;
}

export interface NavGridSABConfig {
  maxFlowfields: number;
  maxPaths: number;
  maxPathLength: number;
  cellSize: number;
}

export interface NavGridInitMetadata {
  worldWidth?: number;
  worldHeight?: number;
}

export interface NavGridStaticFlowfieldInput {
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  vectors: Int8Array | ArrayLike<number>;
}

export interface NavGridSerializableStaticFlowfield {
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
  vectors: Int8Array;
}

export interface NavGridGridInfo {
  width: number;
  height: number;
  cellSize: number;
  totalCells: number;
}

export interface NavGridCachedFlowfieldEntry {
  slotIndex: number;
  targetCell: number;
  targetX: number;
  targetY: number;
  lastUsedFrame: number;
}

export interface NavGridCachedPathEntry {
  slotIndex: number;
  fromCell: number;
  toCell: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  length: number;
  lastUsedFrame: number;
}

export interface NavGridFlowfieldVisualization {
  targetCell: number;
  vectors: Int8Array;
  gridWidth: number;
  gridHeight: number;
  cellSize: number;
}

export interface GridInitializeBuffers {
  gridBuffer?: SharedArrayBuffer;
  neighborBuffer?: SharedArrayBuffer;
  cellSleepingBuffer?: SharedArrayBuffer;
  cellVersionBuffer?: SharedArrayBuffer;
}

export interface GridInitializeMetadata {
  cellSize?: number;
  gridWidth?: number;
  gridHeight?: number;
  gridCols?: number;
  gridRows?: number;
  maxNeighbors?: number;
  maxEntitiesPerCell?: number;
  rowsPerBlock?: number;
}

export interface GridRadiusQueryResult {
  count: number;
  entities: Uint16Array;
}

export interface GridNearestEntityResult {
  entityId: number;
  distSq: number;
}

export interface GridCellSleepingStats {
  totalCells: number;
  sleepingCells: number;
  awakeCells: number;
  sleepingPercentage: string;
  awakePercentage: string;
}

export interface TileMapTilesetInfo {
  firstgid: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
}

export interface TileMapLayerMeta {
  name: string;
  index: number;
  visible: boolean;
  opacity: number;
}

export interface TileMapSerializedMeta {
  id: number;
  name: string;
  mapWidth: number;
  mapHeight: number;
  tileWidth: number;
  tileHeight: number;
  layers: TileMapLayerMeta[];
  tilesets: TileMapTilesetInfo[];
}

export interface TileMapSerializableData {
  sabs: Record<string, SharedArrayBuffer>;
  metadata: Record<string, TileMapSerializedMeta>;
}

export interface TileMapLoadedEntry {
  data: Record<string, unknown>;
  tilesetBitmap?: ImageBitmap;
}

export interface SoundManagerMetrics {
  activeSlots: number;
  maxSlots: number;
  loadedSounds: number;
  dropped: number;
  mixGain: number;
  masterVolume: number;
  muted: boolean;
  state: AudioContextState | 'closed';
  sampleRate: number;
  baseLatency: number;
  outputLatency: number;
}

export interface SoundManagerSlotSABConfig {
  sab: SharedArrayBuffer;
  maxSlots: number;
}

export interface AdobeAnimClipBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  halfW: number;
  halfH: number;
}

export interface AdobeAnimAssetBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AdobeAnimSerializedClip {
  id?: number;
  name?: string;
  clipNames?: string[];
  clipNameToId?: Record<string, number>;
  clipFrameStart?: number[];
  clipFrameCount?: number[];
  clipFrameRate?: number[];
  assetBoundsMinX?: number;
  assetBoundsMinY?: number;
  assetBoundsMaxX?: number;
  assetBoundsMaxY?: number;
  clipBoundsMinX?: number[];
  clipBoundsMinY?: number[];
  clipBoundsMaxX?: number[];
  clipBoundsMaxY?: number[];
  clipBoundsHalfW?: number[];
  clipBoundsHalfH?: number[];
  framePieceStart?: number[];
  framePieceCount?: number[];
  pieceTextureId?: number[];
  pieceX?: number[];
  pieceY?: number[];
  pieceRotation?: number[];
  pieceScaleX?: number[];
  pieceScaleY?: number[];
  pieceAlpha?: number[];
  pieceAnchorX?: number[];
  pieceAnchorY?: number[];
  pieceInnerZ?: number[];
}

export interface AdobeAnimSerializedBundle {
  assetNames: string[];
  assets: Record<string, AdobeAnimSerializedClip>;
}

export interface SpriteSheetCreateBigAtlasOptions {
  maxAtlasWidth?: number;
  maxAtlasHeight?: number;
  atlasPadding?: number;
  trimImages?: boolean;
  trimAlphaThreshold?: number;
  heuristic?: 'best-short-side' | 'best-long-side' | 'best-area' | string;
}

export interface BigAtlasCreateResult {
  canvas: HTMLCanvasElement;
  json: Record<string, unknown>;
  proxySheets: Record<string, unknown>;
}

/** Single value or `{ min, max }` range (engine `randomRange`). */
export type WeedNumOrRange = number | { min: number; max: number };

export interface ParticleEmitConfig {
  count?: WeedNumOrRange;
  x: WeedNumOrRange;
  y: WeedNumOrRange;
  z?: WeedNumOrRange;
  angleXY?: WeedNumOrRange;
  speed?: WeedNumOrRange;
  vx?: WeedNumOrRange;
  vy?: WeedNumOrRange;
  vz?: WeedNumOrRange;
  lifespan?: WeedNumOrRange;
  gravity?: number;
  texture?: string;
  spritesheet?: string;
  animation?: string;
  frame?: number;
  tint?: WeedNumOrRange;
  scale?: WeedNumOrRange;
  scaleX?: WeedNumOrRange;
  scaleY?: WeedNumOrRange;
  alpha?: WeedNumOrRange;
  rotation?: WeedNumOrRange;
  flipX?: boolean;
  flipY?: boolean;
  fadeOnTheFloor?: number;
  stayOnTheFloor?: boolean;
  despawnOnGroundContact?: boolean;
  tweenToAlpha0?: boolean;
  blendMode?: number;
  layerId?: number;
}

export interface FlashCreateConfig {
  x: number;
  y: number;
  z?: number;
  glowHeightOffset?: number;
  lifespan?: number;
  color?: number;
  intensity?: number;
  hasGlowSprite?: number;
}

export interface DecorationSpawnConfig {
  x?: WeedNumOrRange;
  y?: WeedNumOrRange;
  texture?: string;
  scaleX?: WeedNumOrRange;
  scaleY?: WeedNumOrRange;
  rotation?: number;
  alpha?: WeedNumOrRange;
  tint?: number;
  anchorX?: number;
  anchorY?: number;
  offsetX?: number;
  offsetY?: number;
  sway?: boolean;
  swayAmplitude?: number;
  swayFrequency?: number;
  layerId?: number;
  innerZ?: number;
  zIndex?: number;
  parent?: number | null;
  localX?: number;
  localY?: number;
  inheritParentRotation?: boolean;
}

export interface DecorationSpawnManyConfig extends DecorationSpawnConfig {
  count?: number;
}

export interface BulletSpawnConfig {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  ownerId: number;
  shooterEntityType?: number;
  texture?: string;
  scale?: number;
  alpha?: number;
  tint?: number;
  rotation?: number;
  spriteRotation?: number;
  anchorX?: number;
  anchorY?: number;
  offsetY?: number;
  layerId?: number;
  trailWidth?: number;
}

export interface ConstraintUpdateProps {
  distance?: number;
  stiffness?: number;
}

export interface ConstraintActiveEntry {
  idx: number;
  entityA: number;
  entityB: number;
  distance: number;
  stiffness: number;
}

// --- Core ---

export declare const VERSION: string;

export declare class Component {
  static sharedBuffer: SharedArrayBuffer | null;
  static globalEntityCount: number;
  static componentId: number | null;
  static ARRAY_SCHEMA: Record<string, typeof Float32Array | typeof Int32Array | typeof Uint8Array>;
  index: number;
  owner?: GameObject;
  static initializeArrays(buffer: SharedArrayBuffer, count: number): void;
}

export declare class GameObject {
  static startIndex: number;
  static poolSize: number;
  static tickInterval: number;
  static entityType: number | null;
  static scene: Scene | null;
  static instances: GameObject[];
  index: number;
  get transform(): Transform;
  get rigidBody(): RigidBody | null;
  get collider(): Collider | null;
  get spriteRenderer(): SpriteRenderer | null;
  get adobeAnimComponent(): AdobeAnimComponent | null;
  get lightEmitter(): LightEmitter | null;
  get flashComponent(): FlashComponent | null;
  get shadowCaster(): ShadowCaster | null;
  get sceneBridge(): typeof SceneBridge;
  sendMessageToScene(data: unknown): boolean;
  get active(): number;
  set active(value: number);
  get entityType(): number;
  get x(): number;
  set x(value: number);
  get y(): number;
  set y(value: number);
  get rotation(): number;
  set rotation(value: number);
  get vx(): number;
  set vx(value: number);
  get vy(): number;
  set vy(value: number);
  get speed(): number;
  get velocityAngle(): number;
  get alpha(): number;
  set alpha(value: number);
  get tint(): number;
  set tint(value: number);
  get visible(): boolean;
  set visible(value: boolean);
  get scaleX(): number;
  set scaleX(value: number);
  get scaleY(): number;
  set scaleY(value: number);
  get isOnScreen(): boolean;
  get anchorX(): number;
  get anchorY(): number;
  get radius(): number;
  set radius(value: number);
  get width(): number;
  set width(value: number);
  get height(): number;
  set height(value: number);
  get layerName(): string;
  get neighborCount(): number;
  markDirty(): void;
  setAlpha(value: number): this;
  setTint(value: number): this;
  static spawn(
    EntityClassOrConfig: typeof GameObject | SpawnConfig,
    spawnConfig?: SpawnConfig,
    preAssignedIndex?: number,
  ): GameObject | { index: number } | null;
  static get(index: number): GameObject | null;
  static getEntityView(entityIndex: number, options?: { cache?: boolean }): GameObject;
  despawn(): void;
  tick(...args: unknown[]): void;
}

export declare class GameEngine {
  static states: Readonly<{ TRANSITIONING: 0; READY: 1 }>;
  autoResize: boolean;
  canvasWidth: number;
  canvasHeight: number;
  canvas: HTMLCanvasElement | null;
  currentScene: Scene | null;
  state: number;
  transitionCooldown: number;
  debugEnabled: boolean;
  debugUI: DebugUI | null;
  constructor(config?: GameEngineConfig);
  loadScene(SceneClass: typeof Scene): Promise<boolean>;
  pause(): void;
  resume(): void;
  spawnEntity(EntityClassOrName: unknown, data?: SpawnConfig): void;
  despawnAllEntities(className: string): void;
  getPoolStats(EntityClass: unknown): { total: number; active: number; available: number };
  readonly debug: unknown;
  readonly debugFlags: unknown;
  readonly mouse: Mouse;
  readonly camera: Camera;
  readonly config: Record<string, unknown> | undefined;
  readonly rng: unknown;
  readonly workers: unknown;
  readonly numberOfLogicWorkers: number | undefined;
  readonly isReady: boolean;
  readonly isTransitioning: boolean;
  readonly isFullscreen: boolean;
  resize(width: number, height: number): void;
  requestFullscreen(): Promise<void>;
  exitFullscreen(): void;
  destroy(): Promise<void>;
}

export declare class Scene {
  static WORKER_INDICES: Record<string, number>;
  static config: Record<string, unknown>;
  static assets: Record<string, unknown>;
  static audios: string[];
  static entities: unknown[];
  static queries: unknown[][];
  static now: number;
  game: GameEngine;
  config: Record<string, unknown>;
  log: unknown[];
  workers: Record<string, unknown>;
  camera: Camera;
  mouse: Mouse;
  debugFlags: unknown;
  rng: () => number;
  numberOfLogicWorkers: number;
  constructor(game: GameEngine);
  init(): Promise<void>;
  destroy(): Promise<void>;
  pause(): void;
  resume(): void;
  resize(width: number, height: number): void;
  spawnEntity(EntityClassOrName: unknown, spawnConfig?: SpawnConfig): void;
  despawnEntity(entityIndex: number): void;
  despawnAllEntities(className: string): void;
  getPoolStats(EntityClass: unknown): { total: number; active: number; available: number };
  registerEntityClass(EntityClass: unknown, count: number, scriptPath?: string | null): void;
  getEntityView(index: number, options?: Record<string, unknown>): GameObject;
  releaseEntityView(index: number): void;
  update(dtRatio: number, deltaTime: number, accumulatedTime: number, frameNumber: number): void;
  preload(): void | Promise<void>;
  create(): void | Promise<void>;
  onKeyDown(key: string): void;
  onKeyUp(key: string): void;
  onMouseDown(button: number): void;
  onMouseUp(button: number): void;
  onMouseMove(canvasX: number, canvasY: number): void;
  onMouseLeave(): void;
  onWheel(deltaY: number): void;
  getMemoryUsageSummary(): unknown;
  getMemoryUsageReport(): unknown;
  getSharedBufferSize(includeBreakdown?: boolean): unknown;
}

export declare class FSM extends Component {
  static readonly isFSM: true;
  static readonly ARRAY_SCHEMA: {
    state: typeof Uint8Array;
    time: typeof Float32Array;
    nextState: typeof Int16Array;
  };
  static states: Record<string, typeof FSMState>;
  static initial: typeof FSMState | null;
  static state: Uint8Array;
  static time: Float32Array;
  static nextState: Int16Array;

  tick(dt: number, owner: GameObject): void;
  changeState(StateClass: typeof FSMState): void;
  forceChangeState(StateClass: typeof FSMState): void;

  static initializeArrays(buffer: SharedArrayBuffer, count: number): void;
  static changeState(i: number, StateClass: typeof FSMState): void;
  static getStateName(i: number): string | null;
  static isInState(i: number, StateClass: typeof FSMState): boolean;
  static forceChangeState(i: number, StateClass: typeof FSMState, owner: GameObject): void;
  static initializeEntity(i: number, owner: GameObject): void;
}

export declare class FSMState {
  static fsm: typeof FSM | null;
  /** Assigned when the FSM links states at init. */
  static stateIndex: number;
  static onEnter(owner: GameObject, i: number, fromState: string | null): void;
  static onExit(owner: GameObject, i: number, toState: string): void;
  static onUpdate(owner: GameObject, i: number, dt: number, timeInState?: number): void;
}

export declare const DebugFlags: unknown;
export declare const DEBUG_FLAGS: Readonly<Record<string, number>>;
export declare const DEBUG_SELECTED_ENTITY_OFFSET: number;

export declare class DebugUI {
  constructor(options?: Record<string, unknown>);
  attach(game: GameEngine, scene: Scene): void;
  detach(): void;
  destroy(): void;
}

export declare class DebugDraw {
  static readonly TYPE_LINE: number;
  static readonly TYPE_CIRCLE: number;
  static readonly TYPE_RECT: number;
  static readonly TYPE_TEXT: number;
  static readonly TYPE_CELL: number;
  static readonly TYPE_POINT: number;
  static readonly ENTRY_STRIDE: number;

  static getBufferSize(maxEntries?: number): number;
  static initialize(sab: SharedArrayBuffer, maxEntries?: number): void;

  static drawLine(x1: number, y1: number, x2: number, y2: number, color?: number, duration?: number): void;
  static drawCircle(x: number, y: number, radius: number, color?: number, duration?: number): void;
  static drawRect(x: number, y: number, w: number, h: number, color?: number, duration?: number): void;
  static drawPoint(x: number, y: number, color?: number, duration?: number): void;
  static highlightCell(cellX: number, cellY: number, color?: number, duration?: number): void;
  static drawText(x: number, y: number, text: string, color?: number, duration?: number): void;
}

export declare class Mouse {
  static readonly BUFFER_SIZE: number;
  static isDebugToolActive: boolean;

  static initialize(buffer: SharedArrayBuffer | Float32Array): void;
  static get isInitialized(): boolean;

  static get x(): number;
  static set x(value: number);
  static get y(): number;
  static set y(value: number);
  static get prevX(): number;
  static get prevY(): number;

  static get isButton0Down(): boolean;
  static set isButton0Down(value: boolean);
  static get isButton1Down(): boolean;
  static set isButton1Down(value: boolean);
  static get isButton2Down(): boolean;
  static set isButton2Down(value: boolean);

  static get isButton0Pressed(): boolean;
  static get isButton0Released(): boolean;
  static get isButton1Pressed(): boolean;
  static get isButton1Released(): boolean;
  static get isButton2Pressed(): boolean;
  static get isButton2Released(): boolean;

  static get isPresent(): boolean;
  static set isPresent(value: boolean);
  static get wheel(): number;
  static set wheel(value: number);
  static get prevWheel(): number;

  static get isDown(): boolean;
  static get isInWorld(): boolean;
  static get isLeftButtonDown(): boolean;
  static get isMiddleButtonDown(): boolean;
  static get isRightButtonDown(): boolean;
  static get clicked(): boolean;
  static get isLeftButtonPressed(): boolean;
  static get isLeftButtonReleased(): boolean;
  static get isMiddleButtonPressed(): boolean;
  static get isMiddleButtonReleased(): boolean;
  static get isRightButtonPressed(): boolean;
  static get isRightButtonReleased(): boolean;

  static incrementPress0(): void;
  static incrementRelease0(): void;
  static incrementPress1(): void;
  static incrementRelease1(): void;
  static incrementPress2(): void;
  static incrementRelease2(): void;

  static updateEdgeFlags(): void;
  static updateWorldPosition(camera: Vec2Mutable & { zoom: number }): void;
  static setCanvasPosition(canvasX: number, canvasY: number, camera: Vec2Mutable & { zoom: number }): void;
}

export declare class Camera {
  static readonly IDX_ZOOM: 0;
  static readonly IDX_X: 1;
  static readonly IDX_Y: 2;
  static readonly IDX_FOLLOW_X: 3;
  static readonly IDX_FOLLOW_Y: 4;
  static readonly IDX_TARGET_ZOOM: 5;

  static initialize(data: Float32Array, canvasWidth?: number, canvasHeight?: number): void;
  static get isInitialized(): boolean;

  static get zoom(): number;
  static set zoom(value: number);
  static get targetZoom(): number;
  static set targetZoom(value: number);
  static get x(): number;
  static set x(value: number);
  static get y(): number;
  static set y(value: number);

  static get minX(): number;
  static get maxX(): number;
  static get minY(): number;
  static get maxY(): number;
  static get centerX(): number;
  static get centerY(): number;

  static get canvasWidth(): number;
  static set canvasWidth(value: number);
  static get canvasHeight(): number;
  static set canvasHeight(value: number);

  static get worldWidth(): number;
  static set worldWidth(value: number);
  static get worldHeight(): number;
  static set worldHeight(value: number);

  static setWorldBounds(width: number, height: number): void;

  static get smoothing(): number;
  static set smoothing(value: number);

  static get minZoom(): number;
  static get maxZoom(): number;
  static set maxZoom(value: number);

  static follow(targetX: number, targetY: number, smoothing?: number, dtRatio?: number): void;
  static setZoom(targetZoom: number): void;
  static getFollowTarget(): CameraFollowTarget | null;
  static clearFollowTarget(): void;
  static centerOn(targetX: number, targetY: number): void;
  static setPosition(x: number, y: number): void;
  static isOnScreen(worldX: number, worldY: number, margin?: number): boolean;
  static worldToScreen(worldX: number, worldY: number): Vec2Mutable;
  static screenToWorld(screenX: number, screenY: number): Vec2Mutable;
  static getViewportBounds(): CameraViewportBounds;
}

export declare class Ray {
  static readonly SHAPE_CIRCLE: 0;
  static readonly SHAPE_BOX: 1;

  static cast(
    xFrom: number,
    yFrom: number,
    xTo: number,
    yTo: number,
    maxDist?: number,
    mask?: number,
  ): number;
  static castWithInfo(
    xFrom: number,
    yFrom: number,
    xTo: number,
    yTo: number,
    maxDist?: number,
    mask?: number,
    out?: RayHitInfo | null,
  ): RayHitInfo;
  static castAll(
    xFrom: number,
    yFrom: number,
    xTo: number,
    yTo: number,
    maxDist?: number,
    maxHits?: number,
    mask?: number,
    out?: RayMultiHitEntry[] | null,
  ): RayMultiHitEntry[];
  static linecast(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    excludeEntities?: Set<number> | number[] | null,
    mask?: number,
    out?: RayLinecastResult | null,
  ): RayLinecastResult;
  static linecastBetweenEntities(
    entityIndexA: number,
    entityIndexB: number,
    mask?: number,
    out?: RayLinecastResult | null,
  ): RayLinecastResult;
  static hasLineOfSight(entityIndexA: number, entityIndexB: number, mask?: number): boolean;
  static getLineOfSightInfo(
    entityIndexA: number,
    entityIndexB: number,
    mask?: number,
    out?: RayLinecastResult | null,
  ): RayLinecastResult;
}

export declare class NavGrid {
  static _currentFrame: number;

  static calculateSABSize(config: NavGridSABConfig, gridWidth: number, gridHeight: number): number;
  static initialize(sab: SharedArrayBuffer | null | undefined, metadata: NavGridInitMetadata): void;
  static setNavWorkerPort(port: MessagePort | null): void;

  static registerStaticFlowfield(name: string, data: NavGridStaticFlowfieldInput): void;
  static loadStaticFlowfieldsFromJSON(
    flowfieldUrls: Record<string, string>,
    sceneWorldWidth: number,
    sceneWorldHeight: number,
  ): Promise<void>;
  static serializeStaticFlowfields(): Record<string, NavGridSerializableStaticFlowfield>;

  static requestVectorFromStaticFlowfield(
    name: string,
    worldX: number,
    worldY: number,
    outVec: Vec2Mutable,
  ): void;
  static reset(): void;

  static requestVector(cx: number, cy: number, tx: number, ty: number, outVec: Vec2Mutable): void;
  static getNextAStarPosition(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    outPos: Vec2Mutable,
  ): void;
  static getPathAStar(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    outPath: Vec2Mutable[],
  ): void;

  static getCellAt(x: number, y: number): number;
  static isCellWalkable(cellId: number): boolean;
  static isPositionWalkable(x: number, y: number): boolean;
  static getCellCenter(cellId: number, outPos: Vec2Mutable): void;
  static getGridInfo(): NavGridGridInfo;

  static writeHeader(sab: SharedArrayBuffer, config: NavGridSABConfig, gridWidth: number, gridHeight: number): void;
  static setWalkability(cellId: number, walkable: number): void;
  static getWalkabilityArray(): Uint8Array | null;
  static updateNavGrid(entityIndices: number[]): void;
  static invalidate(): void;

  static allocateFlowfieldSlot(targetCell: number): number;
  static writeFlowfieldData(slotIndex: number, vectors: Int8Array): void;
  static allocatePathSlot(fromCell: number, toCell: number): number;
  static writePathData(slotIndex: number, pathCells: ArrayLike<number>, explicitLength?: number): void;

  static getCachedFlowfieldsList(): NavGridCachedFlowfieldEntry[];
  static getCachedPathsList(): NavGridCachedPathEntry[];
  static getFlowfieldForVisualization(slotIndex: number): NavGridFlowfieldVisualization | null;
  static getPathForVisualization(slotIndex: number): Vec2Mutable[] | null;
}

export declare class Grid {
  static cellSize: number;
  static invCellSize: number;
  static gridWidth: number;
  static gridHeight: number;
  static totalCells: number;
  static maxEntitiesPerCell: number;
  static maxNeighbors: number;
  static rowsPerBlock: number;
  static cellByteSize: number;
  static neighborStride: number;
  /** Used by {@link Ray}; treat as read-only in game code. */
  static _gridEntities: Uint32Array | null;

  static initialize(buffers: GridInitializeBuffers, metadata: GridInitializeMetadata): void;
  static reset(): void;

  static getCellIndex(x: number, y: number): number;
  static getCellCoords(cellIndex: number): { col: number; row: number };
  static getCellCount(cellIndex: number): number;
  static getCellEntity(cellIndex: number, k: number): number;
  static getCellByteOffset(cellIndex: number): number;
  static getCellEntityCount(cellIndex: number): number;
  static getCellBase(cellIndex: number): number;

  static clearCell(cellIndex: number): void;
  static addEntityToCell(cellIndex: number, entityId: number): boolean;

  static get neighborData(): Uint16Array | null;

  static getNeighborCount(entityId: number): number;
  static getCollisionCandidateCount(entityId: number): number;
  static getNeighbor(entityId: number, k: number): number;
  static getNeighborOffset(entityId: number): number;
  static getNeighborsOfEntityId(idx: number): Uint16Array;

  static setNeighborCount(entityId: number, count: number): void;
  static setCollisionCandidateCount(entityId: number, count: number): void;
  static setNeighbor(entityId: number, k: number, neighborId: number): void;

  static getEntitiesInRadius(x: number, y: number, radius: number): GridRadiusQueryResult;
  static getEntitiesInRect(minX: number, minY: number, maxX: number, maxY: number): GridRadiusQueryResult;
  static getNearestEntity(
    x: number,
    y: number,
    radius: number,
    excludeTypes?: Set<string> | null,
  ): GridNearestEntityResult | null;

  static isRowOwnedBy(row: number, workerId: number, totalWorkers: number): boolean;
  static getOwnedRows(workerId: number, totalWorkers: number): number[];

  static get cellSleepingData(): Uint8Array | null;
  static getCellSleeping(cellIndex: number): number;
  static setCellSleeping(cellIndex: number, sleeping: number): void;
  static getCellSleepingStats(): GridCellSleepingStats;
  static getSleepingCellCount(): number;
}

/** Keyframe entry in {@link Sun.DEFAULT_COLORS}. */
export interface SunHourColorKeyframe {
  readonly hour: number;
  readonly color: number;
}

/** Byte offsets into the Sun SharedArrayBuffer (see `Sun.js`). */
export interface SunOffsets {
  readonly ENABLED: 0;
  readonly ANGLE: 4;
  readonly ELEVATION: 8;
  readonly INTENSITY: 12;
  readonly COLOR: 16;
  readonly SHADOW_ALPHA: 20;
  readonly HOUR: 24;
  readonly SHADOW_ANGLE_OFFSET: 28;
  readonly SHADOW_MIN_LENGTH_RATIO: 32;
  readonly SHADOW_MAX_LENGTH_RATIO: 36;
  readonly SHADOW_STRETCH_ALPHA_FACTOR: 40;
  readonly SHADOW_DIR_X: 44;
  readonly SHADOW_DIR_Y: 48;
  readonly SHADOW_LENGTH_RATIO: 52;
  readonly SHADOW_ANGLE: 56;
}

/** Float32 slot indices (byte offset / 4) for Sun SAB. */
export interface SunF32Indices {
  readonly ANGLE: 1;
  readonly ELEVATION: 2;
  readonly INTENSITY: 3;
  readonly SHADOW_ALPHA: 5;
  readonly HOUR: 6;
  readonly SHADOW_ANGLE_OFFSET: 7;
  readonly SHADOW_MIN_LENGTH_RATIO: 8;
  readonly SHADOW_MAX_LENGTH_RATIO: 9;
  readonly SHADOW_STRETCH_ALPHA_FACTOR: 10;
  readonly SHADOW_DIR_X: 11;
  readonly SHADOW_DIR_Y: 12;
  readonly SHADOW_LENGTH_RATIO: 13;
  readonly SHADOW_ANGLE: 14;
}

/** Uint32 slot indices (byte offset / 4) for Sun SAB. */
export interface SunU32Indices {
  readonly COLOR: 4;
}

/** Merged scene sun config (after `SUN_DEFAULTS`); passed to {@link Sun.initFromConfig}. */
export interface SunInitConfig {
  enabled?: boolean;
  angle?: number;
  elevation?: number;
  intensity?: number;
  color?: number;
  shadowAlpha?: number;
  startHour?: number;
  shadowAngleOffset?: number;
  shadowMinLengthRatio?: number;
  shadowMaxLengthRatio?: number;
  shadowStretchAlphaFactor?: number;
}

/**
 * Static sun / directional light + day cycle state, backed by a SharedArrayBuffer.
 * All members are static; there are no instances.
 */
export declare class Sun {
  static readonly BYTE_LENGTH: 64;
  static readonly OFFSETS: SunOffsets;
  static readonly F32: SunF32Indices;
  static readonly U32: SunU32Indices;
  static readonly DEFAULT_COLORS: readonly SunHourColorKeyframe[];

  static initialize(sharedArrayBuffer: SharedArrayBuffer): void;
  static get isInitialized(): boolean;

  static get enabled(): boolean;
  static set enabled(value: boolean);
  static get angle(): number;
  static set angle(value: number);
  static get elevation(): number;
  static set elevation(value: number);
  static get intensity(): number;
  static set intensity(value: number);
  static get color(): number;
  static set color(value: number);
  static get shadowAlpha(): number;
  static set shadowAlpha(value: number);
  static get hour(): number;
  static set hour(value: number);

  static get shadowAngleOffset(): number;
  static set shadowAngleOffset(value: number);
  static get shadowMinLengthRatio(): number;
  static set shadowMinLengthRatio(value: number);
  static get shadowMaxLengthRatio(): number;
  static set shadowMaxLengthRatio(value: number);
  static get shadowStretchAlphaFactor(): number;
  static set shadowStretchAlphaFactor(value: number);

  static get shadowDirX(): number;
  static get shadowDirY(): number;
  static get shadowLengthRatio(): number;
  static get shadowAngle(): number;

  static setTimeOfDay(hour: number): void;
  static initFromConfig(config: SunInitConfig): void;
  static advanceTime(deltaMs: number, speed?: number, dayDurationMinutes?: number): void;
  static get buffer(): SharedArrayBuffer | null;
}

/** Uniform definition in scene `config.layers.<name>.shader.uniforms`. */
export interface LayerUniformDef {
  type?: 'f32' | 'i32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>' | string;
  value?: number | number[];
}

/** Per-layer entry in scene `config.layers` (custom layers). */
export interface LayerSceneConfigEntry {
  zIndex?: number;
  blendMode?: number;
  ySorting?: boolean;
  resolution?: number;
  alpha?: number;
  layerType?: string;
  maxItems?: number;
  dynamicResolution?: unknown;
  shader?: {
    fragment?: string;
    containerBlend?: number;
    uniforms?: Record<string, LayerUniformDef>;
  };
}

/** Built-in layer config shape (same keys as `DEFAULT_LAYERS` entries). */
export interface LayerBuiltInConfigEntry {
  zIndex?: number;
  blendMode?: number;
  ySorting?: boolean;
  layerType?: string;
  resolution?: number;
  alpha?: number;
  shader?: LayerSceneConfigEntry['shader'];
}

export interface LayerUniformMapEntry {
  offset: number;
  size: number;
}

/** One layer row in metadata sent to workers. */
export interface LayerSerializableLayerMeta {
  id: number;
  name: string;
  builtIn: boolean;
  layerType: string;
  zIndex: number;
  blendMode: string;
  containerBlendMode: string;
  hasShader: boolean;
  ySorting: boolean;
  resolution: number;
  alpha: number;
  hasRenderQueue: boolean;
  maxItems: number;
  uniformMap: Record<string, LayerUniformMapEntry> | null;
  shaderFragment: string | null;
  shaderName: string | null;
  dynamicResolution: unknown;
  uniformTypes: Record<string, string> | null;
}

export interface LayerSerializableMetadata {
  count: number;
  entitiesId: number;
  layers: (LayerSerializableLayerMeta | undefined)[];
}

/** Return value of {@link Layer.getSerializableData}. */
export interface LayerSerializableData {
  configSAB: SharedArrayBuffer;
  uniformSABs: Record<number, SharedArrayBuffer>;
  metadata: LayerSerializableMetadata;
}

/** Argument to {@link Layer.initializeFromBuffers} (worker init). */
export type LayerWorkerInitBuffers = LayerSerializableData;

/**
 * Rendering layer facade (per-layer id + name) with SAB-backed properties.
 * Use static methods for registry; built-in layers are exposed as static getters.
 */
export declare class Layer {
  readonly id: number;
  readonly name: string;
  /** Set during `_register`; built-in layers are `true`. */
  readonly _builtIn: boolean;
  /** e.g. `background`, `world`, `screenRT`. */
  readonly _layerType: string;

  constructor(id: number, name: string);

  get zIndex(): number;
  get resolution(): number;
  get alpha(): number;
  set alpha(value: number);
  get hasShader(): boolean;
  get ySorting(): boolean;
  get available(): boolean;
  get blendMode(): string;
  get blendModeId(): number;
  get containerBlendMode(): string;
  get containerBlendModeId(): number;
  get hasRenderQueue(): boolean;
  get builtIn(): boolean;
  get layerType(): string;

  setUniform(name: string, value: number | number[]): this;
  getUniform(name: string): number | Float32Array | undefined;

  setStaticBackground(textureId: string): void;
  setTilingBackground(textureId: string, tileScale?: number): void;
  setTilemapBackground(tilemapId: string, options?: Record<string, unknown>): Promise<void>;
  clearBackground(): void;

  static readonly MAX_LAYERS: 16;
  static ENTITIES_ID: number;
  static count: number;
  static initialized: boolean;

  static get BACKGROUND(): Layer;
  static get DECALS(): Layer;
  static get CASTED_SHADOWS(): Layer;
  static get ENTITIES(): Layer;
  static get LIGHTING(): Layer;

  static get(name: string): Layer | null;
  static getById(id: number): Layer | null;
  static getAll(): Layer[];
  static getId(name: string): number;
  static getName(id: number): string | null;
  static getCustomLayers(): Layer[];

  static initializeFromConfig(
    layersConfig?: Record<string, LayerSceneConfigEntry>,
    builtInLayers?: Record<string, LayerBuiltInConfigEntry>,
    defaultYSorting?: boolean,
  ): typeof Layer;

  static getSerializableData(): LayerSerializableData;
  static initializeFromBuffers(data: LayerWorkerInitBuffers | null | undefined): void;
  static reset(): void;
  static resolveBackgroundReady(layerId: number, requestId: number | null | undefined): void;
}

export declare class TileMapLayer {
  readonly name: string;
  readonly data: Int32Array;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly visible: boolean;
  readonly opacity: number;

  getTileId(worldX: number, worldY: number): number;
  getTileIdAt(tileX: number, tileY: number): number;
  hasTile(worldX: number, worldY: number): boolean;
  hasTileAt(tileX: number, tileY: number): boolean;
}

export declare class TileMap {
  readonly id: number;
  readonly name: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly tilesets: TileMapTilesetInfo[];

  getLayer(name: string): TileMapLayer | null;
  getLayerNames(): string[];
  getLayers(): TileMapLayer[];
  getTileId(worldX: number, worldY: number, layerName?: string): number;
  /** Reused object; copy fields if you need to retain across calls. */
  getAllTileIds(worldX: number, worldY: number): Record<string, number>;
  worldToTile(worldX: number, worldY: number, out: { tileX: number; tileY: number }): { tileX: number; tileY: number };
  tileToWorld(tileX: number, tileY: number, out: Vec2Mutable): Vec2Mutable;
  buildCompositeTilemap(compositeTilemap: unknown, options?: { layers?: string[] | null }): void;

  static count: number;
  static initialized: boolean;
  static get(name: string): TileMap | null;
  static getById(id: number): TileMap | null;
  static getAll(): TileMap[];
  static initializeFromLoaded(loadedTilemaps: Record<string, TileMapLoadedEntry>): void;
  static getSerializableData(): TileMapSerializableData | null;
  static initializeFromBuffers(data: TileMapSerializableData | null | undefined): void;
  static reset(): void;
}

export declare class SpriteSheetRegistry {
  static spritesheets: Map<string, unknown>;
  static frameDimensions: Map<string, unknown>;
  static spritesheetNames: string[];
  static spritesheetNameToId: Map<string, number>;
  static decalFrameNameToId: Map<string, number> | null;
  static MaxRectsPacker: new (width: number, height: number, padding?: number) => unknown;

  static register(name: string, jsonData: Record<string, unknown>): void;
  static getAnimationIndex(sheetName: string, animName: string): number;
  static getAnimationName(sheetName: string, index: number): string | null;
  static getAnimationData(sheetName: string, animName: string): unknown;
  static getAnimationNames(sheetName: string): string[];
  static hasAnimation(sheetName: string, animName: string): boolean;
  static getFrameDimensions(sheetName: string, animName: string): unknown;
  static buildFrameDimensionArrays(): void;
  static getFrameDimensionsById(spritesheetId: number, animIndex: number): unknown;
  static serialize(): Record<string, unknown>;
  static deserialize(serialized: Record<string, unknown> | null | undefined): void;
  static clearForSceneUnload(): void;
  static getSpritesheetNames(): string[];
  static validateSpriteConfig(entityName: string, spriteConfig: unknown): void;
  static registerSpritesheetId(name: string): number;
  static getSpritesheetId(name: string): number;
  static getSpritesheetName(id: number): string;
  static createBigAtlas(
    assetsConfig: Record<string, unknown>,
    options?: SpriteSheetCreateBigAtlasOptions,
  ): Promise<BigAtlasCreateResult>;
  static registerProxy(sheetName: string, proxyData: unknown): void;
  static getFrameName(sheetName: string, animName: string, frameIndex?: number): string | null;
  static getBigAtlasAnimName(sheetName: string, animName: string): string;
  static getAnimationFrameCount(sheetName: string, animName: string): number;
  static setDecalFrameMapping(mapping: Record<string, unknown> | null | undefined): void;
  static getTextureId(textureName: string): number;
}

export declare class AdobeAnimRegistry {
  static assets: Map<string, AdobeAnimSerializedClip & Record<string, unknown>>;
  static assetNames: string[];
  static assetNameToId: Map<string, number>;

  static clearForSceneUnload(): void;
  static register(name: string, asset: AdobeAnimSerializedClip & Record<string, unknown>): number;
  static getAssetId(name: string): number;
  static getAsset(assetOrId: string | number): (AdobeAnimSerializedClip & Record<string, unknown>) | null;
  static getClipId(assetOrId: string | number, clipName: string): number;
  static getClipName(assetOrId: string | number, clipId: number): string | null;
  static getClipFrameCount(assetOrId: string | number, clipId: number): number;
  static getClipFrameRate(assetOrId: string | number, clipId: number): number;
  static getClipBounds(assetOrId: string | number, clipId: number): AdobeAnimClipBounds | null;
  static getAssetBounds(assetOrId: string | number): AdobeAnimAssetBounds | null;
  static serialize(): AdobeAnimSerializedBundle;
  static deserialize(serialized: AdobeAnimSerializedBundle | null | undefined): void;
}

export declare class BigAtlasInspector {
  static panel: HTMLDivElement | null;
  static show(atlasCanvas: HTMLCanvasElement, atlasJson: Record<string, unknown>): void;
  static hide(): void;
  static toggle(atlasCanvas: HTMLCanvasElement, atlasJson: Record<string, unknown>): void;
}

export declare class SoundManager {
  static readonly HEADER_SIZE: 4;
  static readonly HEADER_DROPPED: 1;
  static readonly HEADER_MIX_GAIN: 2;
  static readonly HEADER_MASTER_VOL: 3;
  static readonly SLOT_SIZE: 8;
  static readonly STATE_FREE: 0;
  static readonly STATE_PLAYING: 1;
  static readonly STATE_CLAIMING: 2;

  static setEnabled(enabled: boolean): void;
  static initializeAutoplayGate(): void;
  static isAudioUnlocked(): boolean;
  static initializeAudioWorklet(
    maxSlots?: number,
    mixGain?: number,
    masterVolume?: number,
  ): Promise<boolean>;
  static getSlotSABConfig(): SoundManagerSlotSABConfig | null;
  static initializeSlotSAB(config: SoundManagerSlotSABConfig | null | undefined): void;
  static importSoundIdMap(soundIdMap: Record<string, number> | null | undefined): void;
  static exportSoundIdMap(): Record<string, number>;
  static getSoundId(name: string): number;
  static loadManifest(manifest: unknown): Promise<void>;
  static play(
    nameOrId: string | number,
    volume?: number,
    rateMin?: number,
    rateMax?: number,
    loop?: number,
    mute?: number,
    worldX?: number,
    worldY?: number,
  ): number;
  static stop(nameOrId: string | number): void;
  static stopAll(): void;
  static unload(nameOrId: string | number): void;
  static unloadMany(names: string[]): void;
  static unloadAll(): void;
  static reset(): void;
  static getActiveSlotCount(): number;
  static getMetrics(): SoundManagerMetrics;
  static setMixGain(value: number): void;
  static getMixGain(): number;
  static setMasterVolume(value: number): void;
  static getMasterVolume(): number;
  static setMuted(muted: boolean): void;
  static isMuted(): boolean;
}

/**
 * Keyboard state (including `Keyboard.a`-style access) comes from a Proxy in the JS bundle.
 * Prefer {@link Keyboard.isDown} / {@link Keyboard.isPressed} for strict typing.
 */
export declare class Keyboard {
  static initialize(inputData: Int32Array | null, keyIndexMap: Record<string, number> | null): void;
  static isDown(key: string): boolean;
  static isPressed(key: string): boolean;
  static updateEdgeFlags(): void;
}

export declare class SceneBridge {
  static sendMessageToScene(data: unknown, sender?: GameObject | null): boolean;
}

// --- Components ---

export declare class Transform extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    entityType: typeof Uint8Array;
    isItOnScreen: typeof Uint8Array;
    x: typeof Float32Array;
    y: typeof Float32Array;
    rotation: typeof Float32Array;
  };
  static active: Uint8Array;
  static entityType: Uint8Array;
  static isItOnScreen: Uint8Array;
  static x: Float32Array;
  static y: Float32Array;
  static rotation: Float32Array;
}

export declare class RigidBody extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    static: typeof Uint8Array;
    vx: typeof Float32Array;
    vy: typeof Float32Array;
    ax: typeof Float32Array;
    ay: typeof Float32Array;
    px: typeof Float32Array;
    py: typeof Float32Array;
    angularVelocity: typeof Float32Array;
    angularAccel: typeof Float32Array;
    mass: typeof Float32Array;
    invMass: typeof Float32Array;
    drag: typeof Float32Array;
    angularDrag: typeof Float32Array;
    maxVel: typeof Float32Array;
    minSpeed: typeof Float32Array;
    friction: typeof Float32Array;
    velocityAngle: typeof Float32Array;
    speed: typeof Float32Array;
    collisionCount: typeof Uint8Array;
    sleeping: typeof Uint8Array;
    stillnessTime: typeof Float32Array;
  };
  static active: Uint8Array;
  /** SoA column: `RigidBody.static[index]` — `0` dynamic, `1` static. */
  static static: Uint8Array;
  static vx: Float32Array;
  static vy: Float32Array;
  static ax: Float32Array;
  static ay: Float32Array;
  static px: Float32Array;
  static py: Float32Array;
  static angularVelocity: Float32Array;
  static angularAccel: Float32Array;
  static mass: Float32Array;
  static invMass: Float32Array;
  static drag: Float32Array;
  static angularDrag: Float32Array;
  static maxVel: Float32Array;
  static minSpeed: Float32Array;
  static friction: Float32Array;
  static velocityAngle: Float32Array;
  static speed: Float32Array;
  static collisionCount: Uint8Array;
  static sleeping: Uint8Array;
  static stillnessTime: Float32Array;
  static syncMassFromCollider(index: number): boolean;
  syncMassFromCollider(): boolean;
  get static(): number;
  set static(value: number | boolean);
}

export declare class Collider extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    shapeType: typeof Uint8Array;
    offsetX: typeof Float32Array;
    offsetY: typeof Float32Array;
    radius: typeof Float32Array;
    width: typeof Float32Array;
    height: typeof Float32Array;
    isTrigger: typeof Uint8Array;
    collisionLayer: typeof Uint8Array;
    collisionMask: typeof Uint32Array;
    visualRange: typeof Float32Array;
  };
  static active: Uint8Array;
  static shapeType: Uint8Array;
  static offsetX: Float32Array;
  static offsetY: Float32Array;
  static radius: Float32Array;
  static width: Float32Array;
  static height: Float32Array;
  static isTrigger: Uint8Array;
  static collisionLayer: Uint8Array;
  static collisionMask: Uint32Array;
  static visualRange: Float32Array;
  get radius(): number;
  set radius(value: number);
  get width(): number;
  set width(value: number);
  get height(): number;
  set height(value: number);
  get collisionLayer(): number;
  set collisionLayer(value: number);
  get collisionMask(): number;
  set collisionMask(value: number);
  addLayerToMask(layer: number): void;
  removeLayerFromMask(layer: number): void;
  collidesWithLayer(layer: number): boolean;
}

export declare class SpriteRenderer extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    isAnimated: typeof Uint8Array;
    spritesheetId: typeof Uint8Array;
    animationState: typeof Uint8Array;
    animationFrame: typeof Uint16Array;
    animationSpeed: typeof Float32Array;
    loop: typeof Uint8Array;
    tint: typeof Uint32Array;
    baseTint: typeof Uint32Array;
    alpha: typeof Float32Array;
    scaleX: typeof Float32Array;
    scaleY: typeof Float32Array;
    boundsHalfW: typeof Float32Array;
    boundsHalfH: typeof Float32Array;
    anchorX: typeof Float32Array;
    anchorY: typeof Float32Array;
    layerId: typeof Uint8Array;
    renderVisible: typeof Uint8Array;
    isItOnScreen: typeof Uint8Array;
    renderDirty: typeof Uint8Array;
    screenX: typeof Float32Array;
    screenY: typeof Float32Array;
  };
  static active: Uint8Array;
  static isAnimated: Uint8Array;
  static spritesheetId: Uint8Array;
  static animationState: Uint8Array;
  static animationFrame: Uint16Array;
  static animationSpeed: Float32Array;
  static loop: Uint8Array;
  static tint: Uint32Array;
  static baseTint: Uint32Array;
  static alpha: Float32Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static boundsHalfW: Float32Array;
  static boundsHalfH: Float32Array;
  static anchorX: Float32Array;
  static anchorY: Float32Array;
  static layerId: Uint8Array;
  static renderVisible: Uint8Array;
  static isItOnScreen: Uint8Array;
  static renderDirty: Uint8Array;
  static screenX: Float32Array;
  static screenY: Float32Array;
  static getOriginalWidth(entityIndex: number): number;
  static getOriginalHeight(entityIndex: number): number;
  static updateBounds(entityIndex: number): void;
  get originalWidth(): number;
  get originalHeight(): number;
}

export interface AdobeAnimSetAssetOptions {
  playbackRate?: number;
  loop?: boolean;
  playing?: boolean;
  scaleX?: number;
  scaleY?: number;
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  alpha?: number;
  tint?: number;
  visible?: boolean;
  layerId?: number;
}

export declare class AdobeAnimComponent extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    assetId: typeof Uint16Array;
    clipId: typeof Uint16Array;
    time: typeof Float32Array;
    playbackRate: typeof Float32Array;
    loop: typeof Uint8Array;
    playing: typeof Uint8Array;
    scaleX: typeof Float32Array;
    scaleY: typeof Float32Array;
    anchorX: typeof Float32Array;
    anchorY: typeof Float32Array;
    rotation: typeof Float32Array;
    alpha: typeof Float32Array;
    tint: typeof Uint32Array;
    layerId: typeof Uint8Array;
    renderVisible: typeof Uint8Array;
    isItOnScreen: typeof Uint8Array;
    boundsHalfW: typeof Float32Array;
    boundsHalfH: typeof Float32Array;
    screenX: typeof Float32Array;
    screenY: typeof Float32Array;
  };
  static active: Uint8Array;
  static assetId: Uint16Array;
  static clipId: Uint16Array;
  static time: Float32Array;
  static playbackRate: Float32Array;
  static loop: Uint8Array;
  static playing: Uint8Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static anchorX: Float32Array;
  static anchorY: Float32Array;
  static rotation: Float32Array;
  static alpha: Float32Array;
  static tint: Uint32Array;
  static layerId: Uint8Array;
  static renderVisible: Uint8Array;
  static isItOnScreen: Uint8Array;
  static boundsHalfW: Float32Array;
  static boundsHalfH: Float32Array;
  static screenX: Float32Array;
  static screenY: Float32Array;
  static applyClipBounds(entityIndex: number): void;
  get assetName(): string;
  get clipName(): string;
  get frameCount(): number;
  get currentFrame(): number;
  get anchorX(): number;
  set anchorX(value: number);
  get anchorY(): number;
  set anchorY(value: number);
  setAsset(assetName: string, clipName?: string | null, options?: AdobeAnimSetAssetOptions): this;
  play(clipName: string, loop?: boolean): this;
  gotoAndStop(frameNum: number): this;
  gotoAndPlay(frameNum: number): this;
  pause(): this;
  resume(): this;
}

export declare class ParticleComponent extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    x: typeof Float32Array;
    y: typeof Float32Array;
    z: typeof Float32Array;
    vx: typeof Float32Array;
    vy: typeof Float32Array;
    vz: typeof Float32Array;
    lifespan: typeof Uint16Array;
    currentLife: typeof Uint16Array;
    gravity: typeof Float32Array;
    scaleX: typeof Float32Array;
    scaleY: typeof Float32Array;
    alpha: typeof Float32Array;
    tint: typeof Uint32Array;
    baseTint: typeof Uint32Array;
    textureId: typeof Uint16Array;
    rotation: typeof Float32Array;
    flipX: typeof Uint8Array;
    flipY: typeof Uint8Array;
    fadeOnTheFloor: typeof Uint16Array;
    timeOnFloor: typeof Uint16Array;
    initialAlpha: typeof Float32Array;
    stayOnTheFloor: typeof Uint8Array;
    despawnOnGroundContact: typeof Uint8Array;
    tweenToAlpha0: typeof Uint8Array;
    isItOnScreen: typeof Uint8Array;
    blendMode: typeof Uint8Array;
    layerId: typeof Uint8Array;
  };
  static active: Uint8Array;
  static x: Float32Array;
  static y: Float32Array;
  static z: Float32Array;
  static vx: Float32Array;
  static vy: Float32Array;
  static vz: Float32Array;
  static lifespan: Uint16Array;
  static currentLife: Uint16Array;
  static gravity: Float32Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static alpha: Float32Array;
  static tint: Uint32Array;
  static baseTint: Uint32Array;
  static textureId: Uint16Array;
  static rotation: Float32Array;
  static flipX: Uint8Array;
  static flipY: Uint8Array;
  static fadeOnTheFloor: Uint16Array;
  static timeOnFloor: Uint16Array;
  static initialAlpha: Float32Array;
  static stayOnTheFloor: Uint8Array;
  static despawnOnGroundContact: Uint8Array;
  static tweenToAlpha0: Uint8Array;
  static isItOnScreen: Uint8Array;
  static blendMode: Uint8Array;
  static layerId: Uint8Array;
  static particleCount: number;
}

export declare class DecorationComponent extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    generation: typeof Uint32Array;
    x: typeof Float32Array;
    y: typeof Float32Array;
    offsetX: typeof Float32Array;
    offsetY: typeof Float32Array;
    textureId: typeof Uint16Array;
    scaleX: typeof Float32Array;
    scaleY: typeof Float32Array;
    baseRotation: typeof Float32Array;
    rotation: typeof Float32Array;
    alpha: typeof Float32Array;
    tint: typeof Uint32Array;
    anchorX: typeof Float32Array;
    anchorY: typeof Float32Array;
    isItOnScreen: typeof Uint8Array;
    sway: typeof Uint8Array;
    swayAmplitude: typeof Float32Array;
    swayFrequency: typeof Float32Array;
    layerId: typeof Uint8Array;
    parentEntityIndex: typeof Uint16Array;
    localX: typeof Float32Array;
    localY: typeof Float32Array;
    inheritParentRotation: typeof Uint8Array;
    innerZ: typeof Int8Array;
  };
  static active: Uint8Array;
  static generation: Uint32Array;
  static x: Float32Array;
  static y: Float32Array;
  static offsetX: Float32Array;
  static offsetY: Float32Array;
  static textureId: Uint16Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static baseRotation: Float32Array;
  static rotation: Float32Array;
  static alpha: Float32Array;
  static tint: Uint32Array;
  static anchorX: Float32Array;
  static anchorY: Float32Array;
  static isItOnScreen: Uint8Array;
  static sway: Uint8Array;
  static swayAmplitude: Float32Array;
  static swayFrequency: Float32Array;
  static layerId: Uint8Array;
  static parentEntityIndex: Uint16Array;
  static localX: Float32Array;
  static localY: Float32Array;
  static inheritParentRotation: Uint8Array;
  static innerZ: Int8Array;
  static decorationCount: number;
  static initializeArrays(buffer: SharedArrayBuffer, count: number): void;
}

export declare class LightEmitter extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    lightColor: typeof Uint32Array;
    lightIntensity: typeof Float32Array;
    sqrtLightIntensity: typeof Float32Array;
    height: typeof Float32Array;
    glowHeightOffset: typeof Float32Array;
    hasGlowSprite: typeof Uint8Array;
    layerIdOfGlowSprite: typeof Uint8Array;
  };
  static active: Uint8Array;
  static lightColor: Uint32Array;
  static lightIntensity: Float32Array;
  static sqrtLightIntensity: Float32Array;
  static height: Float32Array;
  static glowHeightOffset: Float32Array;
  static hasGlowSprite: Uint8Array;
  static layerIdOfGlowSprite: Uint8Array;
  get lightIntensity(): number;
  set lightIntensity(value: number);
  get lightColor(): number;
  set lightColor(value: number);
}

export declare class ShadowCaster extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    heightMultiplier: typeof Float32Array;
    x: typeof Float32Array;
    y: typeof Float32Array;
    rotation: typeof Float32Array;
    scaleX: typeof Float32Array;
    scaleY: typeof Float32Array;
    alpha: typeof Float32Array;
    entityIdx: typeof Int32Array;
    lightIdx: typeof Int32Array;
    anchorOffsetX: typeof Float32Array;
    anchorOffsetY: typeof Float32Array;
  };
  static active: Uint8Array;
  static heightMultiplier: Float32Array;
  static x: Float32Array;
  static y: Float32Array;
  static rotation: Float32Array;
  static scaleX: Float32Array;
  static scaleY: Float32Array;
  static alpha: Float32Array;
  static entityIdx: Int32Array;
  static lightIdx: Int32Array;
  static anchorOffsetX: Float32Array;
  static anchorOffsetY: Float32Array;
  static shadowCount: number;
}

export declare class LightOccluder extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    radius: typeof Float32Array;
  };
  static active: Uint8Array;
  static radius: Float32Array;
}

export declare class FlashComponent extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    lifespan: typeof Float32Array;
    currentLife: typeof Float32Array;
    initialIntensity: typeof Float32Array;
  };
  static active: Uint8Array;
  static lifespan: Float32Array;
  static currentLife: Float32Array;
  static initialIntensity: Float32Array;
}

/** Marker: enables `onScreenEnter` / `onScreenExit` on the entity class. No SoA schema. */
export declare class CameraInOutListener extends Component {}

/** Marker: enables collision callbacks on the entity class. No SoA schema. */
export declare class CollisionListener extends Component {}

export declare class BulletComponent extends Component {
  static readonly ARRAY_SCHEMA: {
    active: typeof Uint8Array;
    startX: typeof Float32Array;
    startY: typeof Float32Array;
    trailWidth: typeof Float32Array;
    x: typeof Float32Array;
    y: typeof Float32Array;
    prevX: typeof Float32Array;
    prevY: typeof Float32Array;
    vx: typeof Float32Array;
    vy: typeof Float32Array;
    bulletAngle: typeof Float32Array;
    damage: typeof Float32Array;
    ownerId: typeof Uint16Array;
    shooterEntityType: typeof Uint8Array;
    textureId: typeof Uint16Array;
    scale: typeof Float32Array;
    alpha: typeof Float32Array;
    tint: typeof Uint32Array;
    spriteRotation: typeof Float32Array;
    anchorX: typeof Float32Array;
    anchorY: typeof Float32Array;
    offsetY: typeof Float32Array;
    isItOnScreen: typeof Uint8Array;
    layerId: typeof Uint8Array;
  };
  static active: Uint8Array;
  static startX: Float32Array;
  static startY: Float32Array;
  static trailWidth: Float32Array;
  static x: Float32Array;
  static y: Float32Array;
  static prevX: Float32Array;
  static prevY: Float32Array;
  static vx: Float32Array;
  static vy: Float32Array;
  static bulletAngle: Float32Array;
  static damage: Float32Array;
  static ownerId: Uint16Array;
  static shooterEntityType: Uint8Array;
  static textureId: Uint16Array;
  static scale: Float32Array;
  static alpha: Float32Array;
  static tint: Uint32Array;
  static spriteRotation: Float32Array;
  static anchorX: Float32Array;
  static anchorY: Float32Array;
  static offsetY: Float32Array;
  static isItOnScreen: Uint8Array;
  static layerId: Uint8Array;
  static bulletCount: number;
}

export declare class SharedAtomicPool {
  static maxCount: number;
  static initialized: boolean;
  static freeList: Uint16Array | null;
  static freeListTop: Int32Array | null;
  static poolName: string;
  static initialize(maxCount: number): void;
  static initializeFreeList(freeListBuffer: SharedArrayBuffer, freeListTopBuffer: SharedArrayBuffer): void;
  static acquireIndex(): number;
  static returnToPool(index: number): void;
  static acquireSpinLock(lockView: Int32Array | null): void;
  static releaseSpinLock(lockView: Int32Array | null): void;
  static getActiveCount(): number;
  static getFreeCount(): number;
  static isExhausted(): boolean;
  static hasCapacity(): boolean;
  static reset(): void;
}

// --- Particles / decorations / bullets ---

export declare const DECAL_STAMPS_BLEND_MODE: Readonly<{ normal: 0; multiply: 1 }>;

export declare class ParticleEmitter extends SharedAtomicPool {
  static poolName: string;
  static get maxParticles(): number;
  static _warnedPoolExhausted: boolean;
  static initialize(maxParticles: number): void;
  static emit(config: ParticleEmitConfig): number;
  static stampDecal(config: ParticleEmitConfig): number;
  static reset(): void;
}

export declare const DECORATION_Y_SORT_SCALE: number;
export declare const DECORATION_INNER_Z_MIN: number;
export declare const DECORATION_INNER_Z_MAX: number;
export declare const ENTITY_GLOW_SORT_BIAS: number;
export declare const DECORATION_NO_PARENT: number;

export declare class DecorationPool extends SharedAtomicPool {
  static poolName: string;
  static activeDecorationsData: Uint16Array | null;
  static _activeListLock: Int32Array | null;
  static _attachedDecorationCount: Uint8Array | null;
  static _attachedDecorationIndices: Uint16Array | null;
  static _attachmentEntityCount: number;
  static _maxAttachedPerEntity: number;
  static get maxDecorations(): number;
  static getActiveCount(): number;
  static copyActiveSnapshot(out: Uint16Array): number;
  static initialize(maxDecorations: number): void;
  static initializeAttachmentSlots(
    sabCount: SharedArrayBuffer,
    sabIndices: SharedArrayBuffer,
    entityCount: number,
    maxAttachedPerEntity: number,
  ): void;
  static getAttachedCount(entityIdx: number): number;
  static getAttachedDecorationIndex(entityIdx: number, slot: number): number;
  static pushAttached(entityIdx: number, decoIdx: number): boolean;
  static removeAttached(entityIdx: number, decoIdx: number): boolean;
  static clearAttachedAndDespawnAll(entityIdx: number): void;
  static spawn(config: DecorationSpawnConfig): number;
  static spawnMany(config: DecorationSpawnManyConfig): number;
  static despawn(index: number): boolean;
  static despawnAll(): void;
  static initializeActiveList(buffer: SharedArrayBuffer, lockBuffer?: SharedArrayBuffer | null): void;
  static reset(): void;
}

export declare class Decoration {
  index: number;
  constructor(index: number);
  static get(id: number): Decoration;
  static ensureForParented(id: number): Decoration;
  static evictFacade(id: number): void;
  get active(): boolean;
  get scaleX(): number;
  set scaleX(v: number);
  get scaleY(): number;
  set scaleY(v: number);
  get alpha(): number;
  set alpha(v: number);
  get tint(): number;
  set tint(v: number);
  get localX(): number;
  set localX(v: number);
  get localY(): number;
  set localY(v: number);
  get anchorX(): number;
  set anchorX(v: number);
  get innerZ(): number;
  set innerZ(v: number);
  get textureId(): number;
  set textureId(v: number);
  get offsetX(): number;
  set offsetX(v: number);
  get offsetY(): number;
  set offsetY(v: number);
  get baseRotation(): number;
  set baseRotation(v: number);
}

export declare class BulletPool extends SharedAtomicPool {
  static poolName: string;
  static get maxBullets(): number;
  static initialize(maxBullets: number): void;
  static spawn(config: BulletSpawnConfig): number;
  static despawn(i: number): void;
  static reset(): void;
}

export declare class Constraint extends SharedAtomicPool {
  static readonly INVALID_INDEX: 0xffff;
  static poolName: string;
  static pairs: Uint32Array | null;
  static restLength: Float32Array | null;
  static stiffness: Float32Array | null;
  static active: Uint8Array | null;
  static activeIndices: Uint16Array | null;
  static activeIndexPositions: Uint16Array | null;
  static activeMeta: Int32Array | null;
  static activeCount: Int32Array | null;
  static activeListLock: Int32Array | null;
  static getBufferSize(maxConstraints: number): number;
  static initializeArrays(buffer: SharedArrayBuffer, maxConstraints: number): void;
  static add(entityA: number, entityB: number, distance: number, stiff?: number): number;
  static remove(idx: number): void;
  static getEntities(idx: number): { entityA: number; entityB: number };
  static update(idx: number, props: ConstraintUpdateProps): void;
  static isActive(idx: number): boolean;
  static removeAllForEntity(entityIdx: number): void;
  static getDenseActiveCount(): number;
  static getAllActive(): ConstraintActiveEntry[];
  static reset(): void;
}

export declare class Flash extends GameObject {
  static scriptUrl: null;
  static readonly components: ReadonlyArray<typeof LightEmitter | typeof FlashComponent>;
  static maxFlashes: number;
  static initialized: boolean;
  get lightEmitter(): LightEmitter;
  get flashComponent(): FlashComponent;
  static initialize(maxFlashes: number): void;
  static isOnScreen(worldX: number, worldY: number): boolean;
  static create(config: FlashCreateConfig): Flash | null;
  setup(): void;
  onSpawned(spawnConfig?: FlashCreateConfig): void;
  onDespawned(): void;
  tick(dtRatio: number, deltaTime: number): void;
}

export declare class AbstractWorker {
  self: DedicatedWorkerGlobalScope;
  constructor(selfRef: DedicatedWorkerGlobalScope);
  frameNumber: number;
  lastFrameTime: number;
  accumulatedTime: number;
  currentFPS: number;
  stats: Float32Array | null;
  isPaused: boolean;
  globalEntityCount: number;
  config: Record<string, unknown>;
  usesCustomScheduler: boolean;
  noLimitFPS: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
  needsGameScripts: boolean;
  updateFrameTiming(): void;
  reportFPS(): void;
  reportLog(message: unknown): void;
  postMessageToScene(data: unknown): void;
  reportError(title: string, error: unknown): void;
  gameLoop(resuming?: boolean): void;
  scheduleNextFrame(): void;
  startGameLoop(): void;
  onCustomSchedulerStart(): void;
  initializeCommonBuffers(data: unknown): Promise<void>;
  registerCoreClasses(): void;
  initializeAllComponents(data: unknown): void;
  initSeededRandom(seed: number): void;
  handleMessage(e: MessageEvent): Promise<void> | void;
  reportReady(): void;
  initializeWorkerPorts(ports: unknown): void;
  sendDataToWorker(workerName: string, data: unknown): void;
  handleWorkerMessage(fromWorker: string, data: unknown): void;
  pause(): void;
  resume(): void;
  getActiveEntityCount(): number;
  getActiveEntityIndex(activeIndex: number): number;
  query(componentClasses: unknown): unknown;
  queryActiveEntities(componentClasses: unknown): unknown;
  queryActiveEntitiesSlow(componentClasses: unknown): unknown;
  initialize(data: unknown): Promise<void>;
  update(deltaTime: number, dtRatio: number, resuming: boolean): void;
  onResize(width: number, height: number): void;
  handleCustomMessage(data: unknown): void;
}

// --- Default namespace export ---

export interface WeedEnums {
  ShapeType: typeof ShapeType;
  BLEND_MODES: typeof BLEND_MODES;
  DEFAULT_LAYERS: typeof DEFAULT_LAYERS;
  CAMERA_TYPES: typeof CAMERA_TYPES;
  DECAL_STAMPS_BLEND_MODE: typeof DECAL_STAMPS_BLEND_MODE;
  DEBUG_FLAGS: typeof DEBUG_FLAGS;
  DEBUG_SELECTED_ENTITY_OFFSET: typeof DEBUG_SELECTED_ENTITY_OFFSET;
}

export interface WeedNamespace {
  GameEngine: typeof GameEngine;
  Scene: typeof Scene;
  GameObject: typeof GameObject;
  Component: typeof Component;
  FSM: typeof FSM;
  FSMState: typeof FSMState;
  DebugFlags: typeof DebugFlags;
  DebugUI: typeof DebugUI;
  DebugDraw: typeof DebugDraw;
  Mouse: typeof Mouse;
  Camera: typeof Camera;
  Ray: typeof Ray;
  NavGrid: typeof NavGrid;
  Grid: typeof Grid;
  Sun: typeof Sun;
  Layer: typeof Layer;
  TileMap: typeof TileMap;
  Keyboard: typeof Keyboard;
  SceneBridge: typeof SceneBridge;
  SpriteSheetRegistry: typeof SpriteSheetRegistry;
  AdobeAnimRegistry: typeof AdobeAnimRegistry;
  BigAtlasInspector: typeof BigAtlasInspector;
  SoundManager: typeof SoundManager;
  Transform: typeof Transform;
  RigidBody: typeof RigidBody;
  Collider: typeof Collider;
  SpriteRenderer: typeof SpriteRenderer;
  AdobeAnimComponent: typeof AdobeAnimComponent;
  ParticleComponent: typeof ParticleComponent;
  LightEmitter: typeof LightEmitter;
  ShadowCaster: typeof ShadowCaster;
  LightOccluder: typeof LightOccluder;
  FlashComponent: typeof FlashComponent;
  CameraInOutListener: typeof CameraInOutListener;
  CollisionListener: typeof CollisionListener;
  ParticleEmitter: typeof ParticleEmitter;
  DecorationPool: typeof DecorationPool;
  Decoration: typeof Decoration;
  DecorationComponent: typeof DecorationComponent;
  BulletPool: typeof BulletPool;
  BulletComponent: typeof BulletComponent;
  Constraint: typeof Constraint;
  SharedAtomicPool: typeof SharedAtomicPool;
  Flash: typeof Flash;
  AbstractWorker: typeof AbstractWorker;
  containerRadius: typeof import('./utils').containerRadius;
  distanceSq2D: typeof import('./utils').distanceSq2D;
  getDirectionFromAngle: typeof import('./utils').getDirectionFromAngle;
  mixTint: typeof import('./utils').mixTint;
  randomColor: typeof import('./utils').randomColor;
  rng: typeof import('./utils').rng;
  enums: WeedEnums;
  VERSION: typeof VERSION;
}

declare const WEED: Readonly<WeedNamespace>;
export default WEED;

declare global {
  interface Window {
    /** Populated when the UMD/global build assigns `window.WEED`. */
    WEED?: Readonly<WeedNamespace>;
  }
}
