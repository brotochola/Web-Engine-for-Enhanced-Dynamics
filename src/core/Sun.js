/**
 * Sun - Singleton representing the sun/directional light
 * Backed by SharedArrayBuffer for cross-worker access
 *
 * Main thread: read/write via setters (controls day cycle)
 * Workers: read-only via getters (consume state)
 *
 * The sun provides:
 * - Directional ambient light (intensity varies with time of day)
 * - Parallel shadows (all shadows point same direction based on sun angle)
 * - Color that changes throughout the day (warm at sunrise/sunset, white at noon)
 *
 * When sun intensity is high (noon), point light shadows are suppressed
 * because they would be "drowned out" by sunlight in real life.
 */
export class Sun {
    // SAB layout (32 bytes total, 4-byte aligned)
    static BYTE_LENGTH = 32;

    // Offsets in bytes
    static OFFSETS = {
        ENABLED: 0, // Uint8 (0 or 1)
        // padding: 1-3
        ANGLE: 4, // Float32 (degrees, 0=East, 90=South, 180=West, 270=North)
        ELEVATION: 8, // Float32 (degrees, 0=horizon, 90=directly overhead)
        INTENSITY: 12, // Float32 (0-1, affects ambient light level)
        COLOR: 16, // Uint32 (0xRRGGBB)
        SHADOW_ALPHA: 20, // Float32 (0-1, base shadow darkness from sun)
        HOUR: 24, // Float32 (0-24, current time of day)
        // reserved: 28-31
    };

    // Float32 indices (offset / 4)
    static F32 = {
        ANGLE: 1,
        ELEVATION: 2,
        INTENSITY: 3,
        SHADOW_ALPHA: 5,
        HOUR: 6,
    };

    // Uint32 indices (offset / 4)
    static U32 = {
        COLOR: 4,
    };

    // Default sun colors for different times of day
    static DEFAULT_COLORS = [
        { hour: 0, color: 0x1a1a2e }, // Midnight - dark blue
        { hour: 5, color: 0x2d4a6e }, // Pre-dawn - deep blue
        { hour: 6, color: 0xff7744 }, // Dawn - orange
        { hour: 7, color: 0xffaa66 }, // Early morning - warm orange
        { hour: 8, color: 0xffeedd }, // Morning - warm white
        { hour: 12, color: 0xffffff }, // Noon - pure white
        { hour: 16, color: 0xffeedd }, // Afternoon - warm white
        { hour: 18, color: 0xffaa66 }, // Late afternoon - warm
        { hour: 19, color: 0xff6633 }, // Sunset - deep orange
        { hour: 20, color: 0xff4422 }, // Deep sunset - red-orange
        { hour: 21, color: 0x2d4a6e }, // Dusk - deep blue
        { hour: 24, color: 0x1a1a2e }, // Midnight - dark blue
    ];

    /**
     * Create a Sun instance backed by a SharedArrayBuffer
     * @param {SharedArrayBuffer} sharedArrayBuffer - SAB of at least Sun.BYTE_LENGTH bytes
     */
    constructor(sharedArrayBuffer) {
        if (!sharedArrayBuffer || sharedArrayBuffer.byteLength < Sun.BYTE_LENGTH) {
            throw new Error(`Sun requires SharedArrayBuffer of at least ${Sun.BYTE_LENGTH} bytes`);
        }

        this._sab = sharedArrayBuffer;
        this._uint8 = new Uint8Array(sharedArrayBuffer);
        this._float32 = new Float32Array(sharedArrayBuffer);
        this._uint32 = new Uint32Array(sharedArrayBuffer);
    }

    // ============ Getters/Setters ============

    /** Whether sun lighting is enabled */
    get enabled() {
        return this._uint8[Sun.OFFSETS.ENABLED] === 1;
    }
    set enabled(v) {
        this._uint8[Sun.OFFSETS.ENABLED] = v ? 1 : 0;
    }

    /** Sun angle in degrees (0=East, 90=South, 180=West, 270=North) */
    get angle() {
        return this._float32[Sun.F32.ANGLE];
    }
    set angle(v) {
        this._float32[Sun.F32.ANGLE] = v;
    }

    /** Sun elevation in degrees (0=horizon, 90=directly overhead) */
    get elevation() {
        return this._float32[Sun.F32.ELEVATION];
    }
    set elevation(v) {
        this._float32[Sun.F32.ELEVATION] = v;
    }

    /** Sun intensity (0-1), affects ambient light and point light shadow suppression */
    get intensity() {
        return this._float32[Sun.F32.INTENSITY];
    }
    set intensity(v) {
        this._float32[Sun.F32.INTENSITY] = Math.max(0, Math.min(1, v));
    }

    /** Sun color as 0xRRGGBB */
    get color() {
        return this._uint32[Sun.U32.COLOR];
    }
    set color(v) {
        this._uint32[Sun.U32.COLOR] = v;
    }

    /** Base shadow alpha for sun-cast shadows (0-1) */
    get shadowAlpha() {
        return this._float32[Sun.F32.SHADOW_ALPHA];
    }
    set shadowAlpha(v) {
        this._float32[Sun.F32.SHADOW_ALPHA] = Math.max(0, Math.min(1, v));
    }

    /** Current hour of day (0-24) */
    get hour() {
        return this._float32[Sun.F32.HOUR];
    }
    set hour(v) {
        this._float32[Sun.F32.HOUR] = ((v % 24) + 24) % 24; // Wrap to 0-24
    }

    // ============ Convenience Methods ============

    /**
     * Set sun position and properties based on time of day (0-24)
     * Automatically calculates angle, elevation, intensity, and color
     * @param {number} hour - Hour of day (0-24, wraps automatically)
     */
    setTimeOfDay(hour) {
        this.hour = hour;
        const h = this.hour; // Use wrapped value

        const dayProgress = h / 24; // 0-1

        // Sun angle: East (90°) at 6am, South (180°) at noon, West (270°) at 6pm
        // Offset so sunrise is at ~6am
        this.angle = ((dayProgress - 0.25) * 360 + 360) % 360;

        // Sun elevation: 0° at sunrise/sunset, peak at noon
        // Using cosine curve centered on noon (hour 12)
        const noonOffset = Math.abs(h - 12) / 12; // 0 at noon, 1 at midnight
        this.elevation = Math.max(0, Math.cos(noonOffset * Math.PI) * 90);

        // Sun intensity: smooth day/night transition using cosine curve
        // Peak at noon, zero at night
        this.intensity = Math.max(0, Math.min(1, -Math.cos(dayProgress * Math.PI * 2) * 0.5 + 0.5));

        // Sun color: interpolate from color table
        this.color = this._getColorForHour(h);
    }

    /**
     * Get interpolated sun color for a given hour
     * @param {number} hour - Hour of day (0-24)
     * @returns {number} Color as 0xRRGGBB
     * @private
     */
    _getColorForHour(hour) {
        const colors = Sun.DEFAULT_COLORS;

        // Find surrounding keyframes
        let prevIdx = 0;
        let nextIdx = 1;

        for (let i = 0; i < colors.length - 1; i++) {
            if (hour >= colors[i].hour && hour < colors[i + 1].hour) {
                prevIdx = i;
                nextIdx = i + 1;
                break;
            }
        }

        const prev = colors[prevIdx];
        const next = colors[nextIdx];

        // Calculate interpolation factor
        const range = next.hour - prev.hour;
        const t = range > 0 ? (hour - prev.hour) / range : 0;

        // Interpolate RGB components
        const prevR = (prev.color >> 16) & 0xff;
        const prevG = (prev.color >> 8) & 0xff;
        const prevB = prev.color & 0xff;

        const nextR = (next.color >> 16) & 0xff;
        const nextG = (next.color >> 8) & 0xff;
        const nextB = next.color & 0xff;

        const r = Math.round(prevR + (nextR - prevR) * t);
        const g = Math.round(prevG + (nextG - prevG) * t);
        const b = Math.round(prevB + (nextB - prevB) * t);

        return (r << 16) | (g << 8) | b;
    }

    /**
     * Initialize sun properties from a config object
     * @param {Object} config - Sun configuration from scene config
     */
    initFromConfig(config) {
        this.enabled = config.enabled ?? false;
        this.angle = config.angle ?? 180;
        this.elevation = config.elevation ?? 45;
        this.intensity = config.intensity ?? 0.7;
        this.color = config.color ?? 0xffffff;
        this.shadowAlpha = config.shadowAlpha ?? 0.4;
        this.hour = config.startHour ?? 12; // Default to noon
    }

    /**
     * Advance time by a delta (for day cycle)
     * @param {number} deltaMs - Time delta in milliseconds
     * @param {number} speed - Day cycle speed multiplier (1 = real time)
     * @param {number} dayDurationMinutes - Real-world minutes for one full day cycle
     */
    advanceTime(deltaMs, speed = 1, dayDurationMinutes = 1440) {
        // Convert: deltaMs → hours of game time
        // dayDurationMinutes real minutes = 24 game hours
        // So 1 real ms = 24 / (dayDurationMinutes * 60 * 1000) game hours
        const hoursPerMs = 24 / (dayDurationMinutes * 60 * 1000);
        const deltaHours = deltaMs * hoursPerMs * speed;

        this.setTimeOfDay(this.hour + deltaHours);
    }

    /**
     * Get the underlying SharedArrayBuffer (for passing to workers)
     * @returns {SharedArrayBuffer}
     */
    get buffer() {
        return this._sab;
    }

    /**
     * Create a new Sun with its own SharedArrayBuffer
     * @returns {Sun}
     */
    static create() {
        const sab = new SharedArrayBuffer(Sun.BYTE_LENGTH);
        return new Sun(sab);
    }
}
