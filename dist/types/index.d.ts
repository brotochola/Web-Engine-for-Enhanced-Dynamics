/**
 * Typed array constructor types
 */
export type TypedArrayConstructor = typeof Float32Array | typeof Float64Array | typeof Int32Array | typeof Uint32Array | typeof Int16Array | typeof Uint16Array | typeof Int8Array | typeof Uint8Array | typeof Uint8ClampedArray;
/**
 * Schema definition for SharedArrayBuffer-backed properties
 */
export interface ArraySchema {
    [key: string]: TypedArrayConstructor;
}
/**
 * Game engine configuration
 */
export interface GameConfig {
    /** World dimensions */
    worldWidth: number;
    worldHeight: number;
    /** Canvas dimensions */
    canvasWidth?: number;
    canvasHeight?: number;
    /** Physics configuration */
    gravity?: {
        x: number;
        y: number;
    };
    physicsEnabled?: boolean;
    physics?: {
        gravity?: {
            x: number;
            y: number;
        };
        subStepCount?: number;
        boundaryElasticity?: number;
        collisionResponseStrength?: number;
        verletDamping?: number;
        minSpeedForRotation?: number;
        maxCollisionPairs?: number;
        [key: string]: any;
    };
    /** Rendering configuration */
    backgroundColor?: number;
    resolution?: number;
    antialias?: boolean;
    /** Performance settings */
    targetFPS?: number;
    maxEntities?: number;
    maxCollisionPairs?: number;
    /** Debug options */
    debug?: boolean;
    showFPS?: boolean;
    /** Spatial partitioning */
    spatialGridSize?: number;
    maxNeighbors?: number;
    spatial?: {
        maxNeighbors?: number;
        gridSize?: number;
        [key: string]: any;
    };
    /** Worker configuration */
    workerPaths?: {
        logic?: string;
        physics?: string;
        spatial?: string;
        pixi?: string;
    };
    /** Allow other properties */
    [key: string]: any;
}
/**
 * Entity spawn configuration
 */
export interface EntityConfig {
    /** Position */
    x?: number;
    y?: number;
    /** Velocity */
    vx?: number;
    vy?: number;
    /** Physics properties */
    mass?: number;
    radius?: number;
    restitution?: number;
    friction?: number;
    /** State flags */
    active?: boolean;
    collidable?: boolean;
    /** Custom properties can be added by extending this interface */
    [key: string]: any;
}
/**
 * Sprite animation configuration
 */
export interface AnimationConfig {
    frames: number[];
    frameRate?: number;
    loop?: boolean;
}
/**
 * Sprite configuration for renderable entities
 */
export interface SpriteConfig {
    /** Spritesheet name/URL */
    spritesheet: string;
    /** Animation definitions */
    animations: {
        [animationName: string]: AnimationConfig;
    };
    /** Initial animation state */
    defaultAnimation?: string;
    /** Visual properties */
    scale?: number;
    anchor?: {
        x: number;
        y: number;
    };
    tint?: number;
    alpha?: number;
    rotation?: number;
}
/**
 * Configuration for renderable entities
 */
export interface RenderableConfig extends EntityConfig {
    spriteConfig?: SpriteConfig;
}
/**
 * Input state from main thread
 */
export interface InputState {
    mouseX: number;
    mouseY: number;
    mouseDown: boolean;
    keys: {
        [key: string]: boolean;
    };
}
/**
 * Worker message types
 */
export type WorkerMessageType = 'init' | 'start' | 'spawn' | 'despawn' | 'despawnAll' | 'updateConfig' | 'ready' | 'fps' | 'log' | 'error';
/**
 * Base worker message
 */
export interface WorkerMessage {
    type: WorkerMessageType;
    data?: any;
}
/**
 * Initialization message to worker
 */
export interface InitMessage extends WorkerMessage {
    type: 'init';
    data: {
        sharedBuffer: SharedArrayBuffer;
        config: GameConfig;
        entityCount: number;
        startIndex: number;
        totalCount: number;
        neighborBuffer?: SharedArrayBuffer;
        distanceBuffer?: SharedArrayBuffer;
        scriptPaths?: string[];
    };
}
/**
 * Spawn entity message
 */
export interface SpawnMessage extends WorkerMessage {
    type: 'spawn';
    data: {
        className: string;
        config: EntityConfig;
    };
}
/**
 * Despawn entity message
 */
export interface DespawnMessage extends WorkerMessage {
    type: 'despawn';
    data: {
        className: string;
        index?: number;
    };
}
/**
 * Configuration update message
 */
export interface ConfigUpdateMessage extends WorkerMessage {
    type: 'updateConfig';
    data: Partial<GameConfig>;
}
/**
 * Worker ready signal
 */
export interface ReadyMessage extends WorkerMessage {
    type: 'ready';
    data: {
        workerName: string;
    };
}
/**
 * FPS update message from worker
 */
export interface FPSMessage extends WorkerMessage {
    type: 'fps';
    data: {
        workerId: string;
        fps: number;
    };
}
/**
 * Collision event data
 */
export interface CollisionEvent {
    entityIndex: number;
    otherIndex: number;
    type: 'enter' | 'stay' | 'exit';
}
/**
 * Physics configuration
 */
export interface PhysicsConfig {
    gravity: {
        x: number;
        y: number;
    };
    timeStep: number;
    substeps: number;
    enabled: boolean;
}
/**
 * Spatial grid configuration
 */
export interface SpatialConfig {
    gridSize: number;
    maxNeighbors: number;
    searchRadius: number;
}
/**
 * Entity class registration info
 */
export interface EntityClassInfo {
    name: string;
    count: number;
    startIndex: number;
    bufferSize: number;
    scriptPath?: string;
    parentClass?: string;
}
/**
 * Initialization data for workers
 */
export interface WorkerInitData {
    entityCount: number;
    config?: GameConfig;
    scriptsToLoad?: string[];
    buffers?: {
        gameObjectData?: SharedArrayBuffer;
        neighborData?: SharedArrayBuffer;
        distanceData?: SharedArrayBuffer;
        inputData?: SharedArrayBuffer;
        cameraData?: SharedArrayBuffer;
        entityData?: Record<string, SharedArrayBuffer>;
        collisionData?: SharedArrayBuffer;
    };
    registeredClasses?: EntityClassInfo[];
    workerPorts?: Record<string, MessagePort>;
    view?: OffscreenCanvas;
    textures?: Record<string, ImageBitmap>;
    spritesheets?: Record<string, {
        imageBitmap: ImageBitmap;
        json: any;
    }>;
}
/**
 * Texture/Spritesheet loading configuration
 */
export interface TextureConfig {
    url: string;
    baseTexture?: any;
}
/**
 * Camera state
 */
export interface CameraState {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
}
/**
 * Performance metrics
 */
export interface PerformanceMetrics {
    fps: number;
    frameTime: number;
    activeEntities: number;
    visibleEntities: number;
    workerFPS: {
        logic?: number;
        physics?: number;
        spatial?: number;
        pixi?: number;
    };
}
/**
 * Type guard for checking if a value is a typed array constructor
 */
export declare function isTypedArrayConstructor(value: any): value is TypedArrayConstructor;
//# sourceMappingURL=index.d.ts.map