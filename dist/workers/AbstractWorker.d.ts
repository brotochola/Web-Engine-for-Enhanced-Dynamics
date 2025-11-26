import type { GameConfig, EntityClassInfo } from '../types/index.js';
/**
 * Frame timing data
 */
interface FrameTiming {
    deltaTime: number;
    dtRatio: number;
}
/**
 * Initialization data from main thread
 */
interface WorkerInitData {
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
    };
    registeredClasses?: EntityClassInfo[];
    workerPorts?: Record<string, MessagePort>;
}
/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
export declare abstract class AbstractWorker {
    protected self: DedicatedWorkerGlobalScope;
    protected frameNumber: number;
    protected lastFrameTime: number;
    protected currentFPS: number;
    protected fpsReportInterval: number;
    protected fpsFrameCount: number;
    protected frameTimes: number[];
    protected frameTimeIndex: number;
    protected frameTimesSum: number;
    protected isPaused: boolean;
    protected entityCount: number;
    protected config: GameConfig;
    protected usesCustomScheduler: boolean;
    protected noLimitFPS: boolean;
    protected timeoutId: number | null;
    protected needsGameScripts: boolean;
    protected inputData: Int32Array | null;
    protected cameraData: Float32Array | null;
    protected neighborData: Int32Array | null;
    protected distanceData: Float32Array | null;
    protected registeredClasses: EntityClassInfo[];
    protected workerPorts: Map<string, MessagePort>;
    constructor(selfRef: DedicatedWorkerGlobalScope);
    /**
     * Calculate delta time and update FPS using moving average
     * @returns Frame timing data
     */
    protected updateFrameTiming(): FrameTiming;
    /**
     * Report FPS to main thread
     */
    protected reportFPS(): void;
    protected reportLog(message: string): void;
    /**
     * Main game loop - calls update() method each frame
     * @param resuming - Whether we're resuming from pause
     */
    protected gameLoop(resuming?: boolean): void;
    /**
     * Schedule the next frame (can be overridden for custom scheduling)
     * Uses setTimeout(0ms) if noLimitFPS is true to yield to event loop but run ASAP
     * Otherwise uses requestAnimationFrame for standard 60fps
     */
    protected scheduleNextFrame(): void;
    /**
     * Start the game loop (call this from initialize())
     */
    protected startGameLoop(): void;
    /**
     * Override this if using custom scheduler (like PIXI ticker)
     */
    protected onCustomSchedulerStart(): void;
    /**
     * Initialize common buffers
     * @param data - Initialization data from main thread
     */
    protected initializeCommonBuffers(data: WorkerInitData): Promise<void>;
    /**
     * Initialize entity-specific arrays from entityBuffers
     * @param entityBuffers - Map of entity class name to SharedArrayBuffer
     * @param entityCounts - Array of class info objects
     */
    protected initializeEntityArrays(entityBuffers: Record<string, SharedArrayBuffer>, entityCounts: EntityClassInfo[]): void;
    /**
     * Handle incoming messages from main thread
     * @param e - Message event
     */
    protected handleMessage(e: MessageEvent): Promise<void>;
    /**
     * Report to main thread that this worker is ready
     * Called automatically after initialization completes
     */
    protected reportReady(): void;
    /**
     * Initialize MessagePorts for direct worker-to-worker communication
     * Called during init with ports object from main thread
     * @param ports - Object mapping worker names to MessagePorts
     */
    protected initializeWorkerPorts(ports?: Record<string, MessagePort>): void;
    /**
     * Send data directly to another worker via MessagePort
     * This bypasses the main thread for faster communication
     * @param workerName - Target worker name ('renderer', 'logic', 'physics', etc.)
     * @param data - Data to send
     */
    sendDataToWorker(workerName: string, data: any): void;
    /**
     * Handle messages from other workers (via MessagePort)
     * Override in subclass for custom handling, or handle in handleCustomMessage
     * @param fromWorker - Name of sender worker
     * @param data - Message data
     */
    protected handleWorkerMessage(fromWorker: string, data: any): void;
    /**
     * Pause the worker
     */
    pause(): void;
    /**
     * Resume the worker
     */
    resume(): void;
    /**
     * Initialize the worker with data from main thread
     * @abstract
     * @param data - Initialization data
     */
    protected abstract initialize(data: WorkerInitData): void;
    /**
     * Update logic called each frame
     * @abstract
     * @param deltaTime - Time since last frame in milliseconds
     * @param dtRatio - Delta time ratio normalized to 60fps
     * @param resuming - Whether we're resuming from pause
     */
    protected abstract update(deltaTime: number, dtRatio: number, resuming: boolean): void;
    /**
     * Handle custom messages not covered by standard messages
     * @param data - Message data
     */
    protected handleCustomMessage(data: any): void;
}
export {};
//# sourceMappingURL=AbstractWorker.d.ts.map