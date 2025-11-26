// GameObject.ts - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays
/**
 * Base class for all game entities using Structure of Arrays pattern
 * All entity data is stored in SharedArrayBuffers for efficient multi-threaded access
 */
class GameObject {
    /**
     * Initialize static arrays from SharedArrayBuffer
     * Called by GameEngine and by each worker
     *
     * This is a generic method that works for both GameObject and all subclasses
     * by using 'this' which refers to the class it's called on.
     *
     * @param buffer - The shared memory
     * @param count - Total number of entities
     * @param neighborBuffer - Optional neighbor data buffer
     * @param distanceBuffer - Optional distance data buffer
     */
    static initializeArrays(buffer, count, neighborBuffer = null, distanceBuffer = null) {
        this.sharedBuffer = buffer;
        this.entityCount = count;
        let offset = 0;
        // Create typed array views for each property defined in schema
        // 'this' refers to the class this method is called on (GameObject, subclass, etc.)
        for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
            const bytesPerElement = type.BYTES_PER_ELEMENT;
            // Ensure proper alignment for this typed array
            const remainder = offset % bytesPerElement;
            if (remainder !== 0) {
                offset += bytesPerElement - remainder;
            }
            this[name] = new type(buffer, offset, count);
            offset += count * bytesPerElement;
        }
        // Initialize neighbor data if provided (only for GameObject)
        if (neighborBuffer && this === GameObject) {
            this.neighborData = new Int32Array(neighborBuffer);
        }
        // Initialize distance data if provided (only for GameObject)
        if (distanceBuffer && this === GameObject) {
            this.distanceData = new Float32Array(distanceBuffer);
        }
    }
    /**
     * Calculate total buffer size needed
     * @param count - Number of entities
     * @returns Buffer size in bytes
     */
    static getBufferSize(count) {
        let offset = 0;
        for (const type of Object.values(this.ARRAY_SCHEMA)) {
            const bytesPerElement = type.BYTES_PER_ELEMENT;
            // Add alignment padding
            const remainder = offset % bytesPerElement;
            if (remainder !== 0) {
                offset += bytesPerElement - remainder;
            }
            offset += count * bytesPerElement;
        }
        return offset;
    }
    /**
     * Constructor - stores the index and initializes instance
     * Subclasses should initialize their values in their constructors
     * @param index - Position in shared arrays
     * @param config - Configuration object from GameEngine
     * @param logicWorker - Reference to logic worker (if running in worker)
     */
    constructor(index, config = {}, logicWorker = null) {
        this.neighborCount = 0;
        this.neighbors = null;
        this.neighborDistances = null;
        this.index = index;
        this.config = config; // Store config for instance access
        this.logicWorker = logicWorker;
        GameObject.active[index] = 1; // Set active in shared array (1 = true, 0 = false)
        // Take the entity type from the class
        GameObject.entityType[index] = this.constructor.entityTypeId;
        GameObject.instances.push(this);
        this.constructor.instances.push(this);
        // Neighbor properties (updated each frame before tick)
        this.neighborCount = 0;
        this.neighbors = null; // Will be a TypedArray subarray
        this.neighborDistances = null; // Will be a TypedArray subarray of squared distances
    }
    /**
     * LIFECYCLE: Called when entity is first created (one-time initialization)
     * Override in subclasses for setup that should only happen once
     */
    start() {
        // Override in subclasses
    }
    /**
     * LIFECYCLE: Called when entity becomes active (spawned from pool)
     * Override in subclasses to reset/initialize state for reuse
     */
    awake() {
        // Override in subclasses
    }
    /**
     * LIFECYCLE: Called when entity becomes inactive (returned to pool)
     * Override in subclasses for cleanup, saving state, etc.
     */
    sleep() {
        // Override in subclasses
    }
    /**
     * Despawn this entity (return it to the inactive pool)
     * This is the proper way to deactivate an entity
     */
    despawn() {
        // Prevent double-despawn which corrupts the free list
        if (GameObject.active[this.index] === 0)
            return;
        GameObject.active[this.index] = 0;
        // Return to free list if exists (O(1))
        const EntityClass = this.constructor;
        if (EntityClass.freeList) {
            EntityClass.freeList[++EntityClass.freeListTop] = this.index;
        }
        // Call lifecycle callback
        if (this.sleep) {
            this.sleep();
        }
    }
    /**
     * Update neighbor references for this entity
     * Called by logic worker before tick() each frame
     *
     * @param neighborData - Precomputed neighbors from spatial worker
     * @param distanceData - Precomputed squared distances from spatial worker
     */
    updateNeighbors(neighborData, distanceData = null) {
        // Handle both nested (main thread) and flat (worker) config structures
        const maxNeighbors = this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
        if (!neighborData || !maxNeighbors) {
            this.neighborCount = 0;
            this.neighbors = null;
            this.neighborDistances = null;
            return;
        }
        // Parse neighbor data buffer: [count, id1, id2, ..., id_MAX]
        const offset = this.index * (1 + maxNeighbors);
        this.neighborCount = neighborData[offset];
        this.neighbors = neighborData.subarray(offset + 1, offset + 1 + this.neighborCount);
        // Parse distance data buffer (same structure as neighborData)
        if (distanceData) {
            this.neighborDistances = distanceData.subarray(offset + 1, offset + 1 + this.neighborCount);
        }
        else {
            this.neighborDistances = null;
        }
    }
    /**
     * Main update method - called every frame by logic worker
     * Override this in subclasses to define entity behavior
     *
     * Note: this.neighbors and this.neighborCount are updated before this is called
     *
     * @param dtRatio - Delta time ratio (1.0 = 16.67ms frame)
     * @param inputData - Mouse and keyboard input
     */
    tick(dtRatio, inputData) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called on the first frame when this entity collides with another
     * Override in subclasses to handle collision start events
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionEnter(otherIndex) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called every frame while this entity is colliding with another
     * Override in subclasses to handle continuous collision
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionStay(otherIndex) {
        // Override in subclasses
    }
    /**
     * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
     * Override in subclasses to handle collision end events
     *
     * @param otherIndex - Index of the other entity that was in collision
     */
    onCollisionExit(otherIndex) {
        // Override in subclasses
    }
    /**
     * Helper method to dynamically create getters/setters from ARRAY_SCHEMA
     * This is called in static initialization blocks by GameObject and all subclasses
     *
     * @param targetClass - The class to create properties for
     */
    static _createSchemaProperties(targetClass) {
        Object.entries(targetClass.ARRAY_SCHEMA).forEach(([name, type]) => {
            Object.defineProperty(targetClass.prototype, name, {
                get() {
                    return targetClass[name][this.index];
                },
                // Special handling for Uint8Array to convert boolean to 0/1
                set(value) {
                    targetClass[name][this.index] =
                        type === Uint8Array ? (value ? 1 : 0) : value;
                },
                enumerable: true,
                configurable: true,
            });
            // Special handling for x and y to also update px and py (Verlet integration)
            Object.defineProperty(targetClass.prototype, 'x', {
                get() {
                    return targetClass.x[this.index];
                },
                set(value) {
                    targetClass.x[this.index] = value;
                    targetClass.px[this.index] = value;
                },
                enumerable: true,
                configurable: true,
            });
            Object.defineProperty(targetClass.prototype, 'y', {
                get() {
                    return targetClass.y[this.index];
                },
                set(value) {
                    targetClass.y[this.index] = value;
                    targetClass.py[this.index] = value;
                },
                enumerable: true,
                configurable: true,
            });
        });
    }
    /**
     * SPAWNING SYSTEM: Initialize free list for O(1) spawning
     * Must be called after registration and before any spawning
     * @param EntityClass - The entity class to initialize
     */
    static initializeFreeList(EntityClass) {
        const count = EntityClass.totalCount;
        const startIndex = EntityClass.startIndex;
        // Create free list stack
        EntityClass.freeList = new Int32Array(count);
        EntityClass.freeListTop = count - 1;
        // Fill with all indices (initially all are free)
        // We fill in reverse order so that we pop from the beginning first (optional)
        for (let i = 0; i < count; i++) {
            EntityClass.freeList[i] = startIndex + i;
        }
    }
    /**
     * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
     *
     * @param EntityClass - The entity class to spawn (e.g., Prey, Predator)
     * @param spawnConfig - Initial configuration (position, velocity, etc.)
     * @returns The spawned entity instance, or null if pool exhausted
     *
     * @example
     * const prey = GameObject.spawn(Prey, { x: 500, y: 300, vx: 2, vy: -1 });
     */
    static spawn(EntityClass, spawnConfig = {}) {
        // Validate EntityClass has required metadata
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            console.error(`Cannot spawn ${EntityClass.name}: missing startIndex/totalCount metadata. Was it registered with GameEngine?`);
            return null;
        }
        // Initialize free list if not exists (lazy init)
        if (!EntityClass.freeList) {
            GameObject.initializeFreeList(EntityClass);
        }
        // Check if pool is exhausted
        if (EntityClass.freeListTop < 0) {
            console.warn(`No inactive ${EntityClass.name} available in pool! All ${EntityClass.totalCount} entities are active.`);
            return null;
        }
        // Pop index from free list (O(1))
        const i = EntityClass.freeList[EntityClass.freeListTop--];
        // Get the instance (already created during initialization)
        const instance = EntityClass.instances[i - EntityClass.startIndex];
        if (!instance) {
            console.error(`No instance found at index ${i} for ${EntityClass.name}`);
            return null;
        }
        instance.ax = 0;
        instance.ay = 0;
        instance.vx = 0;
        instance.vy = 0;
        instance.speed = 0;
        instance.velocityAngle = 0;
        instance.x = 0;
        instance.y = 0;
        instance.px = 0;
        instance.py = 0;
        instance.rotation = 0;
        // Check if setTint and setAlpha exist (for RenderableGameObject subclasses)
        if ('setTint' in instance && typeof instance.setTint === 'function') {
            instance.setTint(0xffffff); // White when healthy
        }
        if ('setAlpha' in instance && typeof instance.setAlpha === 'function') {
            instance.setAlpha(1.0); // Fully visible
        }
        // IMPORTANT: Apply spawn config BEFORE activating to prevent race condition
        // If entity is active, it can start ticking immediately on next frame
        Object.keys(spawnConfig).forEach((key) => {
            if (instance[key] !== undefined) {
                instance[key] = spawnConfig[key];
            }
        });
        // Initialize previous positions for Verlet integration
        // Set px/py based on current velocity to give initial momentum
        instance.px = instance.x - instance.vx;
        instance.py = instance.y - instance.vy;
        // Call lifecycle method BEFORE activating
        if (instance.awake) {
            instance.awake();
        }
        // NOW activate the entity (after config and awake are done)
        GameObject.active[i] = 1;
        return instance;
    }
    /**
     * SPAWNING SYSTEM: Get pool statistics for an entity class
     *
     * @param EntityClass - The entity class to check
     * @returns { total, active, available }
     *
     * @example
     * const stats = GameObject.getPoolStats(Prey);
     * console.log(`Prey: ${stats.active}/${stats.total} active, ${stats.available} available`);
     */
    static getPoolStats(EntityClass) {
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            return { total: 0, active: 0, available: 0 };
        }
        // If free list exists, use it for O(1) stats
        if (EntityClass.freeList) {
            const available = EntityClass.freeListTop + 1;
            return {
                total: EntityClass.totalCount,
                active: EntityClass.totalCount - available,
                available: available,
            };
        }
        // Fallback to linear search if free list not initialized
        const startIndex = EntityClass.startIndex;
        const total = EntityClass.totalCount;
        let activeCount = 0;
        for (let i = startIndex; i < startIndex + total; i++) {
            if (GameObject.active[i]) {
                activeCount++;
            }
        }
        return {
            total: total,
            active: activeCount,
            available: total - activeCount,
        };
    }
    /**
     * SPAWNING SYSTEM: Despawn all entities of a specific type
     *
     * @param EntityClass - The entity class to despawn
     * @returns Number of entities despawned
     */
    static despawnAll(EntityClass) {
        if (EntityClass.startIndex === undefined ||
            EntityClass.totalCount === undefined) {
            return 0;
        }
        const startIndex = EntityClass.startIndex;
        const endIndex = startIndex + EntityClass.totalCount;
        let despawnedCount = 0;
        // Iterate all entities to find active ones
        // We could optimize this by tracking active entities, but despawnAll is rare
        for (let i = startIndex; i < endIndex; i++) {
            if (GameObject.active[i]) {
                const instance = EntityClass.instances[i - startIndex];
                if (instance && instance.despawn) {
                    instance.despawn();
                    despawnedCount++;
                }
                else {
                    // Manual despawn if instance missing (shouldn't happen)
                    GameObject.active[i] = 0;
                    // Return to free list if exists
                    if (EntityClass.freeList) {
                        EntityClass.freeList[++EntityClass.freeListTop] = i;
                    }
                    despawnedCount++;
                }
            }
        }
        return despawnedCount;
    }
}
// Shared memory buffer
GameObject.sharedBuffer = null;
GameObject.entityCount = 0;
// Entity class metadata (for spawning system)
GameObject.startIndex = 0; // Starting index in arrays for this entity type
GameObject.totalCount = 0; // Total allocated entities of this type
GameObject.entityTypeId = 0; // Numeric type identifier for this class
// Array schema - defines all shared arrays and their types
// Order matters! Arrays are laid out in this exact order in memory
// Properties are created dynamically in initializeArrays()
GameObject.ARRAY_SCHEMA = {
    // Transform
    x: Float32Array,
    y: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    rotation: Float32Array,
    velocityAngle: Float32Array,
    speed: Float32Array,
    // Verlet Integration (for alternative physics mode)
    px: Float32Array, // Previous X position
    py: Float32Array, // Previous Y position
    // Physics
    maxVel: Float32Array,
    maxAcc: Float32Array,
    minSpeed: Float32Array,
    friction: Float32Array,
    radius: Float32Array,
    collisionCount: Uint8Array, // Number of collisions this frame (for Verlet mode)
    // Perception
    visualRange: Float32Array,
    // State
    active: Uint8Array,
    entityType: Uint8Array, // 0=Boid, 1=Prey, 2=Predator
    isItOnScreen: Uint8Array,
};
// Neighbor data (from spatial worker)
GameObject.neighborData = null;
GameObject.distanceData = null; // Squared distances for each neighbor
GameObject.instances = [];
// Spawning system
GameObject.freeList = null;
GameObject.freeListTop = -1;
// Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
(() => {
    GameObject._createSchemaProperties(GameObject);
})();

// AbstractWorker.ts - Base class for all game engine workers
// Provides common functionality: frame timing, FPS tracking, pause state, message handling
/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
class AbstractWorker {
    constructor(selfRef) {
        // Frame timing and FPS tracking
        this.frameNumber = 0;
        this.lastFrameTime = 0;
        this.currentFPS = 0;
        this.fpsReportInterval = 30; // Report FPS every N frames
        // Moving average FPS calculation
        this.fpsFrameCount = 60; // Average over last 60 frames
        this.frameTimeIndex = 0;
        // State
        this.isPaused = true;
        this.entityCount = 0;
        this.config = {};
        // Scheduling
        this.usesCustomScheduler = false; // Override in subclass if using custom scheduler
        this.noLimitFPS = false; // Set to true to run as fast as possible (no RAF limiting)
        this.timeoutId = null; // Store timeout ID for clearing
        // Script loading
        this.needsGameScripts = true; // Override to false in generic workers (spatial, physics)
        // Shared buffers (common to most workers)
        this.inputData = null;
        this.cameraData = null;
        this.neighborData = null;
        this.distanceData = null; // Squared distances for each neighbor
        // Registered entity classes information
        this.registeredClasses = [];
        // MessagePorts for direct worker-to-worker communication
        this.workerPorts = new Map();
        this.self = selfRef;
        this.self.onmessage = (e) => {
            this.handleMessage(e);
        };
        // Initialize frame timing
        this.lastFrameTime = performance.now();
        // Initialize moving average FPS calculation
        this.frameTimes = new Array(this.fpsFrameCount).fill(16.67); // Pre-fill with 60fps baseline
        this.frameTimesSum = 16.67 * this.fpsFrameCount;
        // Bind methods
        this.gameLoop = this.gameLoop.bind(this);
        this.handleMessage = this.handleMessage.bind(this);
        this.reportLog('finished constructor');
    }
    /**
     * Calculate delta time and update FPS using moving average
     * @returns Frame timing data
     */
    updateFrameTiming() {
        const now = performance.now();
        const deltaTime = now - this.lastFrameTime;
        this.lastFrameTime = now;
        // Update moving average FPS calculation
        // Remove oldest frame time from sum
        this.frameTimesSum -= this.frameTimes[this.frameTimeIndex];
        // Add new frame time
        this.frameTimes[this.frameTimeIndex] = deltaTime;
        this.frameTimesSum += deltaTime;
        // Move to next index (circular buffer)
        this.frameTimeIndex = (this.frameTimeIndex + 1) % this.fpsFrameCount;
        // Calculate FPS from average frame time over last N frames
        const averageFrameTime = this.frameTimesSum / this.fpsFrameCount;
        this.currentFPS = 1000 / averageFrameTime;
        // Normalize delta time to 60fps (16.67ms per frame)
        const dtRatio = deltaTime / 16.67;
        return { deltaTime, dtRatio };
    }
    /**
     * Report FPS to main thread
     */
    reportFPS() {
        if (this.frameNumber % this.fpsReportInterval === 0) {
            self.postMessage({ msg: 'fps', fps: this.currentFPS.toFixed(2) });
        }
    }
    reportLog(message) {
        self.postMessage({ msg: 'log', message, when: Date.now() });
    }
    /**
     * Main game loop - calls update() method each frame
     * @param resuming - Whether we're resuming from pause
     */
    gameLoop(resuming = false) {
        if (this.isPaused)
            return;
        this.frameNumber++;
        const timing = this.updateFrameTiming();
        // Call the worker-specific update logic
        this.update(timing.deltaTime, timing.dtRatio, resuming);
        // Report FPS
        this.reportFPS();
        // Schedule next frame (only if not using custom scheduler)
        if (!this.usesCustomScheduler) {
            this.scheduleNextFrame();
        }
    }
    /**
     * Schedule the next frame (can be overridden for custom scheduling)
     * Uses setTimeout(0ms) if noLimitFPS is true to yield to event loop but run ASAP
     * Otherwise uses requestAnimationFrame for standard 60fps
     */
    scheduleNextFrame() {
        if (this.noLimitFPS) {
            // Run as fast as possible while still yielding to event loop
            // setTimeout(0) runs after current event loop but doesn't wait for next frame
            this.timeoutId = self.setTimeout(() => this.gameLoop(), 2);
        }
        else {
            // Standard 60fps using requestAnimationFrame
            requestAnimationFrame(() => this.gameLoop());
        }
    }
    /**
     * Start the game loop (call this from initialize())
     */
    startGameLoop() {
        this.reportLog('starting game loop');
        this.isPaused = false;
        this.lastFrameTime = performance.now(); // Reset timing
        if (this.usesCustomScheduler) {
            // Custom scheduler will call gameLoop manually
            this.onCustomSchedulerStart();
        }
        else {
            // Use requestAnimationFrame
            this.gameLoop();
        }
    }
    /**
     * Override this if using custom scheduler (like PIXI ticker)
     */
    onCustomSchedulerStart() {
        // Override in subclass
    }
    /**
     * Initialize common buffers
     * @param data - Initialization data from main thread
     */
    async initializeCommonBuffers(data) {
        this.reportLog('initializing common buffers');
        this.entityCount = data.entityCount;
        // Store config for worker access
        this.config = data.config || {};
        // Check if this worker should run with unlimited FPS (no RAF limiting)
        // Each worker type can have its own noLimitFPS setting in its nested config
        const workerType = this.constructor.name
            .replace('Worker', '')
            .toLowerCase();
        // Check nested config first, then fall back to root level
        const workerConfig = this.config[workerType] || {};
        if (workerConfig.noLimitFPS === true) {
            this.noLimitFPS = true;
            console.log(`${this.constructor.name}: Running in unlimited FPS mode (noLimitFPS)`);
        }
        // Load game-specific scripts dynamically (if this worker needs them)
        // Some workers (spatial, physics) are generic and don't need game classes
        if (this.needsGameScripts &&
            data.scriptsToLoad &&
            data.scriptsToLoad.length > 0) {
            console.log(`${this.constructor.name}: Loading ${data.scriptsToLoad.length} game scripts...`);
            // Use dynamic import() for ES6 modules (async/await)
            for (const scriptPath of data.scriptsToLoad) {
                try {
                    const module = await import(scriptPath);
                    // Make the exported class(es) available globally in worker
                    Object.keys(module).forEach((key) => {
                        self[key] = module[key];
                    });
                    console.log(`${this.constructor.name}: ✓ Loaded ${scriptPath}`);
                }
                catch (error) {
                    console.error(`${this.constructor.name}: ✗ Failed to load ${scriptPath}:`, error);
                }
            }
        }
        else if (!this.needsGameScripts) {
            console.log(`${this.constructor.name}: Skipping game scripts (generic worker)`);
        }
        // Initialize GameObject arrays if buffer provided
        if (data.buffers?.gameObjectData) {
            GameObject.initializeArrays(data.buffers.gameObjectData, this.entityCount, data.buffers.neighborData || null, // Automatically initialize neighbor data
            data.buffers.distanceData || null // Automatically initialize distance data
            );
        }
        // Initialize common shared buffers using Buffer->Data naming pattern
        if (data.buffers?.inputData) {
            this.inputData = new Int32Array(data.buffers.inputData);
        }
        if (data.buffers?.cameraData) {
            this.cameraData = new Float32Array(data.buffers.cameraData);
        }
        // Initialize neighbor data reference (redundant with GameObject but kept for clarity)
        if (data.buffers?.neighborData) {
            this.neighborData = new Int32Array(data.buffers.neighborData);
        }
        // Initialize distance data reference
        if (data.buffers?.distanceData) {
            this.distanceData = new Float32Array(data.buffers.distanceData);
        }
        // Store registered classes (used by logic worker and potentially others)
        this.registeredClasses = data.registeredClasses || [];
        this.reportLog('finished initializing common buffers');
        // Initialize all entity arrays using standardized method
        if (data.buffers?.entityData && this.registeredClasses.length > 0) {
            this.initializeEntityArrays(data.buffers.entityData, this.registeredClasses);
        }
        // Keep a reference to neighbor data for easy access (already set above, but also from GameObject)
        if (GameObject.neighborData) {
            this.neighborData = GameObject.neighborData;
        }
        // Keep a reference to distance data for easy access
        if (GameObject.distanceData) {
            this.distanceData = GameObject.distanceData;
        }
    }
    /**
     * Initialize entity-specific arrays from entityBuffers
     * @param entityBuffers - Map of entity class name to SharedArrayBuffer
     * @param entityCounts - Array of class info objects
     */
    initializeEntityArrays(entityBuffers, entityCounts) {
        this.reportLog('initializing entity arrays');
        if (!entityBuffers)
            return;
        for (const classInfo of entityCounts) {
            const { name, count } = classInfo;
            const EntityClass = self[name];
            const buffer = entityBuffers[name];
            if (EntityClass && EntityClass.initializeArrays && buffer) {
                // IMPORTANT: Use entityCount (total) not count (class-specific)
                // Entity arrays must be sized for all entities because subclasses use global indices
                EntityClass.initializeArrays(buffer, this.entityCount);
                console.log(`${this.constructor.name}: Initialized ${name} arrays for ${this.entityCount} total entities (${count} of this type)`);
                // AUTOMATIC PROPERTY CREATION: Create getters/setters for this class's ARRAY_SCHEMA
                // This makes properties accessible as instance properties (e.g., this.x instead of GameObject.x[this.index])
                // Only create properties if the class has an ARRAY_SCHEMA and we have GameObject._createSchemaProperties
                if (EntityClass.ARRAY_SCHEMA &&
                    GameObject &&
                    GameObject._createSchemaProperties) {
                    GameObject._createSchemaProperties(EntityClass);
                    console.log(`${this.constructor.name}: Auto-created ${Object.keys(EntityClass.ARRAY_SCHEMA).length} properties for ${name}`);
                }
            }
        }
        this.reportLog('finished initializing entity arrays');
    }
    /**
     * Handle incoming messages from main thread
     * @param e - Message event
     */
    async handleMessage(e) {
        const { msg } = e.data;
        switch (msg) {
            case 'init':
                this.isPaused = true; // Keep paused until "start" message
                await this.initializeCommonBuffers(e.data);
                this.initializeWorkerPorts(e.data.workerPorts); // Initialize direct worker communication
                this.initialize(e.data);
                // After initialization, signal ready to main thread
                this.reportReady();
                break;
            case 'start':
                // All workers are ready, start the game loop
                this.reportLog('received start signal, beginning game loop');
                this.startGameLoop();
                break;
            case 'pause':
                this.pause();
                break;
            case 'resume':
                this.resume();
                break;
            default:
                this.handleCustomMessage(e.data);
                break;
        }
    }
    /**
     * Report to main thread that this worker is ready
     * Called automatically after initialization completes
     */
    reportReady() {
        this.reportLog('initialization complete, signaling ready');
        self.postMessage({ msg: 'workerReady', worker: this.constructor.name });
    }
    /**
     * Initialize MessagePorts for direct worker-to-worker communication
     * Called during init with ports object from main thread
     * @param ports - Object mapping worker names to MessagePorts
     */
    initializeWorkerPorts(ports) {
        this.reportLog('initializing worker ports');
        if (!ports)
            return;
        Object.entries(ports).forEach(([workerName, port]) => {
            this.workerPorts.set(workerName, port);
            // Setup message handler for this port
            port.onmessage = (e) => {
                this.handleWorkerMessage(workerName, e.data);
            };
        });
        console.log(`${this.constructor.name}: Connected to workers:`, Array.from(this.workerPorts.keys()));
    }
    /**
     * Send data directly to another worker via MessagePort
     * This bypasses the main thread for faster communication
     * @param workerName - Target worker name ('renderer', 'logic', 'physics', etc.)
     * @param data - Data to send
     */
    sendDataToWorker(workerName, data) {
        const port = this.workerPorts.get(workerName);
        if (!port) {
            console.warn(`${this.constructor.name}: No port to worker "${workerName}". Available:`, Array.from(this.workerPorts.keys()));
            return;
        }
        port.postMessage(data);
    }
    /**
     * Handle messages from other workers (via MessagePort)
     * Override in subclass for custom handling, or handle in handleCustomMessage
     * @param fromWorker - Name of sender worker
     * @param data - Message data
     */
    handleWorkerMessage(fromWorker, data) {
        // Default implementation - subclasses can override
        // Or just pass to handleCustomMessage for unified handling
        this.handleCustomMessage({ ...data, _fromWorker: fromWorker });
    }
    /**
     * Pause the worker
     */
    pause() {
        this.isPaused = true;
        // Clear timeout if we're using noLimitFPS mode
        if (this.timeoutId !== null) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
    /**
     * Resume the worker
     */
    resume() {
        this.isPaused = false;
        this.lastFrameTime = performance.now(); // Reset timing to avoid large delta
        // Reset moving average to avoid pause spike affecting FPS
        this.frameTimes.fill(16.67);
        this.frameTimesSum = 16.67 * this.fpsFrameCount;
        this.frameTimeIndex = 0;
        if (!this.usesCustomScheduler) {
            this.gameLoop(true);
        }
        // If using custom scheduler, it will continue calling gameLoop automatically
    }
    /**
     * Handle custom messages not covered by standard messages
     * @param data - Message data
     */
    handleCustomMessage(data) {
        // Override in subclass if needed
    }
}

export { AbstractWorker as A, GameObject as G };
//# sourceMappingURL=AbstractWorker.js.map
