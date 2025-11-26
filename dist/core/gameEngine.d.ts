import { GameObject } from './gameObject.js';
import type { GameConfig, EntityConfig } from '../types/index.js';
/**
 * Entity class  registration info
 */
interface EntityRegistration {
    class: typeof GameObject;
    count: number;
    startIndex: number;
    scriptPath: string | null;
}
/**
 * Worker ready states
 */
interface WorkerReadyStates {
    spatial: boolean;
    logic: boolean;
    physics: boolean;
    renderer: boolean;
}
/**
 * Worker instances
 */
interface Workers {
    spatial: Worker | null;
    logic: Worker | null;
    physics: Worker | null;
    renderer: Worker | null;
}
/**
 * Shared buffers
 */
interface Buffers {
    gameObjectData: SharedArrayBuffer | null;
    entityData: Map<string, SharedArrayBuffer>;
    neighborData: SharedArrayBuffer | null;
    distanceData: SharedArrayBuffer | null;
    collisionData: SharedArrayBuffer | null;
    inputData: SharedArrayBuffer | null;
    cameraData: SharedArrayBuffer | null;
}
/**
 * Typed array views
 */
interface Views {
    input: Int32Array | null;
    camera: Float32Array | null;
    collision: Int32Array | null;
}
/**
 * Camera state
 */
interface CameraState {
    zoom: number;
    x: number;
    y: number;
}
/**
 * Image URLs configuration
 */
interface ImageUrls {
    [key: string]: string | any;
    spritesheets?: SpritesheetConfigs;
}
/**
 * Spritesheet configurations
 */
interface SpritesheetConfigs {
    [name: string]: {
        json: string;
        png: string;
    };
}
/**
 * Loaded spritesheet data
 */
interface LoadedSpritesheet {
    json: any;
    imageBitmap: ImageBitmap;
}
/**
 * Main Game Engine class
 * Orchestrates workers, manages SharedArrayBuffers, and handles game state
 */
export declare class GameEngine {
    static now: number;
    config: GameConfig;
    state: {
        pause: boolean;
    };
    log: Array<{
        worker: string;
        message: string;
        when: number;
    }>;
    keyboard: Record<string, boolean>;
    mouse: {
        x: number;
        y: number;
    } | null;
    camera: CameraState;
    physics: GameConfig['physics'];
    pendingPhysicsUpdates: Array<Partial<GameConfig['physics']>>;
    workers: Workers;
    workerReadyStates: WorkerReadyStates;
    totalWorkers: number;
    buffers: Buffers;
    views: Views;
    canvas: HTMLCanvasElement | null;
    registeredClasses: EntityRegistration[];
    gameObjects: GameObject[];
    totalEntityCount: number;
    imageUrls: ImageUrls;
    loadedTextures: Record<string, ImageBitmap> | null;
    loadedSpritesheets: Record<string, LoadedSpritesheet>;
    keyMap: Record<string, number>;
    lastFrameTime: number;
    updateRate: number;
    constructor(config: GameConfig, imageUrls?: ImageUrls);
    /**
     * Register an entity class (e.g., Boid, Enemy)
     * This calculates buffer sizes and tracks entity ranges
     * @param EntityClass - The class to register (must extend GameObject)
     * @param count - Number of entities of this type
     * @param scriptPath - Path to the script file (for worker loading)
     */
    registerEntityClass(EntityClass: typeof GameObject, count: number, scriptPath?: string | null): void;
    /**
     * Auto-detect and register parent classes in the inheritance chain
     * @private
     */
    private _autoRegisterParentClasses;
    /**
     * Initialize everything
     */
    init(): Promise<void>;
    /**
     * Create all SharedArrayBuffers
     */
    private createSharedBuffers;
    /**
     * Pre-initialize entityType values to prevent race condition
     * @private
     */
    private preInitializeEntityTypeArrays;
    /**
     * Create canvas element
     * @private
     */
    private createCanvas;
    /**
     * Preload assets (textures and spritesheets)
     * @private
     */
    private preloadAssets;
    /**
     * Setup direct MessagePort communication between workers
     * @private
     */
    private setupWorkerCommunication;
    /**
     * Create and initialize all workers
     * @private
     */
    private createWorkers;
    /**
     * Handle messages from workers
     * @private
     */
    private handleMessageFromWorker;
    /**
     * Handle worker ready signal
     * @private
     */
    private handleWorkerReady;
    /**
     * Send start signal to all workers
     * @private
     */
    private startAllWorkers;
    /**
     * Update physics configuration
     */
    updatePhysicsConfig(partialConfig?: Partial<GameConfig['physics']>): void;
    /**
     * Update FPS display
     * @private
     */
    private updateFPS;
    /**
     * Update active units display
     */
    updateActiveUnits(count: number): void;
    /**
     * Update visible units display
     */
    updateVisibleUnits(count: number): void;
    /**
     * Setup all event listeners
     * @private
     */
    private setupEventListeners;
    /**
     * Update input buffer with current input state
     * @private
     */
    private updateInputBuffer;
    /**
     * Update camera buffer
     * @private
     */
    private updateCameraBuffer;
    /**
     * Start main game loop
     * @private
     */
    private startMainLoop;
    /**
     * Main update function (60fps)
     * @private
     */
    private update;
    /**
     * Cleanup and destroy engine
     */
    destroy(): void;
    /**
     * Pause the game
     */
    pause(): void;
    /**
     * Resume the game
     */
    resume(): void;
    /**
     * Spawn an entity from the pool
     * @param className - Name of the entity class (e.g., 'Prey', 'Predator')
     * @param spawnConfig - Initial configuration (position, velocity, etc.)
     */
    spawnEntity(className: string, spawnConfig?: EntityConfig): void;
    /**
     * Despawn all entities of a specific type
     * @param className - Name of the entity class to despawn
     */
    despawnAllEntities(className: string): void;
    /**
     * Get pool statistics for an entity class
     * @param EntityClass - The entity class to check
     * @returns Pool statistics
     */
    getPoolStats(EntityClass: typeof GameObject): {
        total: number;
        active: number;
        available: number;
    };
}
export {};
//# sourceMappingURL=gameEngine.d.ts.map