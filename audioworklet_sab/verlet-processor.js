// verlet-processor.js
// AudioWorklet Processor para física Verlet con Spatial Hashing

class VerletProcessor extends AudioWorkletProcessor {
    lastTime = 0
    constructor(options) {
        super();

        // Obtener opciones
        const { sharedBuffer, numEntities, canvasWidth, canvasHeight } = options.processorOptions;

        this.numEntities = numEntities;
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;

        // Estructura: [x, y, prevX, prevY, accelX, accelY] por entidad
        this.FLOATS_PER_ENTITY = 6;

        // Acceder al SharedArrayBuffer
        this.data = new Float32Array(sharedBuffer);

        // Index where mouse data starts (after all entity data)
        this.mouseDataIndex = numEntities * this.FLOATS_PER_ENTITY;

        // Configuración de física
        this.dt = 1 / 60; // Delta time (60 FPS equivalente)
        this.damping = 0.999; // Factor de amortiguamiento

        // Mouse attraction settings
        this.attractionStrength = 0.8;

        // Radio de las partículas para colisiones
        this.radius = 5;

        // ============ SPATIAL HASHING (Zero Allocation) ============
        // Cell size should be >= 2*radius (collision diameter)
        this.cellSize = this.radius * 2.5;
        this.invCellSize = 1 / this.cellSize;

        // Grid dimensions
        this.numCellsX = Math.ceil(canvasWidth / this.cellSize) + 1;
        this.numCellsY = Math.ceil(canvasHeight / this.cellSize) + 1;
        this.totalCells = this.numCellsX * this.numCellsY;

        // Pre-allocate spatial hash structures (linked list approach)
        // cellHead[cellIndex] = first particle in cell, or -1 if empty
        this.cellHead = new Int32Array(this.totalCells);
        // nextInCell[particleIndex] = next particle in same cell, or -1
        this.nextInCell = new Int32Array(numEntities);

        // Contador de frames para debug
        this.frameCount = 0;

        console.log('VerletProcessor inicializado con Spatial Hashing:', {
            numEntities,
            canvasWidth,
            canvasHeight,
            cellSize: this.cellSize,
            gridSize: `${this.numCellsX}x${this.numCellsY}`,
            totalCells: this.totalCells,
            bufferSize: this.data.length
        });
    }

    process(inputs, outputs, parameters) {
        this.frameCount++;
        this.updatePhysics();

        // Track FPS over 200 frames instead of per-frame
        if (this.frameCount % 200 === 0) {
            const now = Date.now();
            if (this.lastTime > 0) {
                const elapsed = now - this.lastTime;
                this.fps = (200 * 1000) / elapsed;  // 200 frames / elapsed seconds
                console.log('FPS:', this.fps.toFixed(1));
            }
            this.lastTime = now;
        }

        return true;
    }

    updatePhysics() {
        // Read mouse state from shared buffer
        const mouseX = this.data[this.mouseDataIndex];
        const mouseY = this.data[this.mouseDataIndex + 1];
        const mouseDown = this.data[this.mouseDataIndex + 2];

        // // Build spatial hash and resolve collisions
        // this.buildSpatialHash();
        // this.resolveCollisionsSpatial();

        // Integración Verlet para cada entidad
        // const step = 2;
        const data = this.data;
        const FLOATS = this.FLOATS_PER_ENTITY;
        const dt2 = this.dt * this.dt;
        const damping = this.damping;
        const radius = this.radius;
        const canvasW = this.canvasWidth;
        const canvasH = this.canvasHeight;
        const attractionStrength = this.attractionStrength;
        // const doubleDt = this.dt * 2;

        for (let i = 0; i < this.numEntities; i++) {
            // if (i % step == this.frameCount % step) continue;
            const idx = i * FLOATS;

            // Leer estado actual
            const x = data[idx];
            const y = data[idx + 1];
            const prevX = data[idx + 2];
            const prevY = data[idx + 3];
            let accelX = data[idx + 4];
            let accelY = data[idx + 5];

            // Calcular velocidad (diferencia entre posición actual y anterior)
            const velX = (x - prevX) * damping;
            const velY = (y - prevY) * damping;

            // Mouse attraction when mouse is down
            if (mouseDown > 0) {
                const dx = mouseX - x;
                const dy = mouseY - y;
                const distSq = dx * dx + dy * dy;
                if (distSq > 1) {
                    const invDist = 1 / Math.sqrt(distSq);
                    const force = (attractionStrength * invDist * 10000) / (100 + distSq * 0.01);
                    accelX += dx * invDist * force;
                    accelY += dy * invDist * force;
                }
            }

            // Integración Verlet: new_pos = pos + vel + accel * dt^2
            let newX = x + velX + accelX * dt2;
            let newY = y + velY + accelY * dt2;

            // Colisiones con bordes del canvas
            if (newX < radius) {
                newX = radius;
                data[idx + 2] = newX + velX * 0.8;
            } else if (newX > canvasW - radius) {
                newX = canvasW - radius;
                data[idx + 2] = newX + velX * 0.8;
            } else {
                data[idx + 2] = x;
            }

            if (newY < radius) {
                newY = radius;
                data[idx + 3] = newY + velY * 0.8;
            } else if (newY > canvasH - radius) {
                newY = canvasH - radius;
                data[idx + 3] = newY + velY * 0.8;
            } else {
                data[idx + 3] = y;
            }

            // Escribir nueva posición
            data[idx] = newX;
            data[idx + 1] = newY;

            // Actualizar aceleración (decay)
            data[idx + 4] = accelX * 0.95;
            data[idx + 5] = accelY * 0.95;
        }

        // Second collision pass for stability
        this.buildSpatialHash();
        this.resolveCollisionsSpatial();
    }

    // Build spatial hash - O(n)
    buildSpatialHash() {
        const cellHead = this.cellHead;
        const nextInCell = this.nextInCell;
        const data = this.data;
        const FLOATS = this.FLOATS_PER_ENTITY;
        const invCellSize = this.invCellSize;
        const numCellsX = this.numCellsX;
        const totalCells = this.totalCells;

        // Clear cell heads (fill with -1)
        for (let c = 0; c < totalCells; c++) {
            cellHead[c] = -1;
        }

        // Insert each particle into its cell's linked list
        for (let i = 0; i < this.numEntities; i++) {
            const idx = i * FLOATS;
            const x = data[idx];
            const y = data[idx + 1];

            // Compute cell coordinates (clamp to grid bounds)
            let cellX = (x * invCellSize) | 0;
            let cellY = (y * invCellSize) | 0;

            // Clamp to valid range
            if (cellX < 0) cellX = 0;
            else if (cellX >= numCellsX) cellX = numCellsX - 1;
            if (cellY < 0) cellY = 0;
            else if (cellY >= this.numCellsY) cellY = this.numCellsY - 1;

            const cellIndex = cellY * numCellsX + cellX;

            // Insert at head of cell's list
            nextInCell[i] = cellHead[cellIndex];
            cellHead[cellIndex] = i;
        }
    }

    // Resolve collisions using spatial hash - O(n) average case
    resolveCollisionsSpatial() {
        const cellHead = this.cellHead;
        const nextInCell = this.nextInCell;
        const data = this.data;
        const FLOATS = this.FLOATS_PER_ENTITY;
        const numCellsX = this.numCellsX;
        const numCellsY = this.numCellsY;
        const minDist = this.radius * 2;
        const minDistSq = minDist * minDist;

        // Iterate through all cells
        for (let cy = 0; cy < numCellsY; cy++) {
            for (let cx = 0; cx < numCellsX; cx++) {
                const cellIndex = cy * numCellsX + cx;
                let i = cellHead[cellIndex];

                // For each particle in this cell
                while (i !== -1) {
                    const idx1 = i * FLOATS;
                    const x1 = data[idx1];
                    const y1 = data[idx1 + 1];

                    // Check against other particles in same cell
                    let j = nextInCell[i];
                    while (j !== -1) {
                        this.checkCollision(i, j, idx1, x1, y1, minDist, minDistSq);
                        j = nextInCell[j];
                    }

                    // Check against particles in neighboring cells (right, bottom-left, bottom, bottom-right)
                    // This avoids double-checking pairs

                    // Right neighbor
                    if (cx + 1 < numCellsX) {
                        let k = cellHead[cellIndex + 1];
                        while (k !== -1) {
                            this.checkCollision(i, k, idx1, x1, y1, minDist, minDistSq);
                            k = nextInCell[k];
                        }
                    }

                    // Bottom-left neighbor
                    if (cy + 1 < numCellsY && cx > 0) {
                        let k = cellHead[cellIndex + numCellsX - 1];
                        while (k !== -1) {
                            this.checkCollision(i, k, idx1, x1, y1, minDist, minDistSq);
                            k = nextInCell[k];
                        }
                    }

                    // Bottom neighbor
                    if (cy + 1 < numCellsY) {
                        let k = cellHead[cellIndex + numCellsX];
                        while (k !== -1) {
                            this.checkCollision(i, k, idx1, x1, y1, minDist, minDistSq);
                            k = nextInCell[k];
                        }
                    }

                    // Bottom-right neighbor
                    if (cy + 1 < numCellsY && cx + 1 < numCellsX) {
                        let k = cellHead[cellIndex + numCellsX + 1];
                        while (k !== -1) {
                            this.checkCollision(i, k, idx1, x1, y1, minDist, minDistSq);
                            k = nextInCell[k];
                        }
                    }

                    i = nextInCell[i];
                }
            }
        }
    }

    // Inline collision check and resolution
    checkCollision(i, j, idx1, x1, y1, minDist, minDistSq) {
        const data = this.data;
        const FLOATS = this.FLOATS_PER_ENTITY;
        const idx2 = j * FLOATS;
        const x2 = data[idx2];
        const y2 = data[idx2 + 1];

        const dx = x2 - x1;
        const dy = y2 - y1;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDistSq && distSq > 0.0001) {
            const dist = Math.sqrt(distSq);
            const overlap = minDist - dist;
            const invDist = 1 / dist;
            const nx = dx * invDist;
            const ny = dy * invDist;

            // Separate particles equally
            const separation = overlap * 0.5;
            data[idx1] -= nx * separation;
            data[idx1 + 1] -= ny * separation;
            data[idx2] += nx * separation;
            data[idx2 + 1] += ny * separation;
        }
    }
}

registerProcessor('verlet-processor', VerletProcessor);
