/**
 * Sun - Static class representing the sun/directional light
 * Backed by SharedArrayBuffer for cross-worker access
 * Pattern follows Camera, Mouse, Keyboard static classes
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
    // SAB layout (64 bytes total, 4-byte aligned)
    static BYTE_LENGTH = 64;

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
        // Shadow config (set once from config)
        SHADOW_ANGLE_OFFSET: 28, // Float32 (radians, π for southern hemisphere)
        SHADOW_MIN_LENGTH_RATIO: 32, // Float32 (shadow multiplier at zenith)
        SHADOW_MAX_LENGTH_RATIO: 36, // Float32 (shadow multiplier at horizon)
        SHADOW_STRETCH_ALPHA_FACTOR: 40, // Float32 (alpha fade when stretched)
        // Shadow computed (updated in setTimeOfDay)
        SHADOW_DIR_X: 44, // Float32 (cos of shadow angle)
        SHADOW_DIR_Y: 48, // Float32 (sin of shadow angle)
        SHADOW_LENGTH_RATIO: 52, // Float32 (current length ratio based on elevation)
        SHADOW_ANGLE: 56, // Float32 (radians, for sprite rotation)
        // reserved: 60-63
    };

    // Float32 indices (offset / 4)
    static F32 = {
        ANGLE: 1,
        ELEVATION: 2,
        INTENSITY: 3,
        SHADOW_ALPHA: 5,
        HOUR: 6,
        SHADOW_ANGLE_OFFSET: 7,
        SHADOW_MIN_LENGTH_RATIO: 8,
        SHADOW_MAX_LENGTH_RATIO: 9,
        SHADOW_STRETCH_ALPHA_FACTOR: 10,
        SHADOW_DIR_X: 11,
        SHADOW_DIR_Y: 12,
        SHADOW_LENGTH_RATIO: 13,
        SHADOW_ANGLE: 14,
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

    // SharedArrayBuffer views (set during initialization)
    static _sab = null;
    static _uint8 = null;
    static _float32 = null;
    static _uint32 = null;

    // ============ Initialization ============

    /**
     * Initialize Sun with shared data buffer
     * @param {SharedArrayBuffer} sharedArrayBuffer - SAB of at least Sun.BYTE_LENGTH bytes
     */
    static initialize(sharedArrayBuffer) {
        if (!sharedArrayBuffer || sharedArrayBuffer.byteLength < Sun.BYTE_LENGTH) {
            throw new Error(`Sun requires SharedArrayBuffer of at least ${Sun.BYTE_LENGTH} bytes`);
        }

        this._sab = sharedArrayBuffer;
        this._uint8 = new Uint8Array(sharedArrayBuffer);
        this._float32 = new Float32Array(sharedArrayBuffer);
        this._uint32 = new Uint32Array(sharedArrayBuffer);
    }

    /**
     * Check if Sun is initialized
     * @returns {boolean}
     */
    static get isInitialized() {
        return this._sab !== null;
    }

    // ============ Getters/Setters ============

    /** Whether sun lighting is enabled */
    static get enabled() {
        return this._uint8 ? this._uint8[Sun.OFFSETS.ENABLED] === 1 : false;
    }
    static set enabled(v) {
        if (this._uint8) this._uint8[Sun.OFFSETS.ENABLED] = v ? 1 : 0;
    }

    /** Sun angle in degrees (0=East, 90=South, 180=West, 270=North) */
    static get angle() {
        return this._float32 ? this._float32[Sun.F32.ANGLE] : 0;
    }
    static set angle(v) {
        if (this._float32) this._float32[Sun.F32.ANGLE] = v;
    }

    /** Sun elevation in degrees (0=horizon, 90=directly overhead) */
    static get elevation() {
        return this._float32 ? this._float32[Sun.F32.ELEVATION] : 0;
    }
    static set elevation(v) {
        if (this._float32) this._float32[Sun.F32.ELEVATION] = v;
    }

    /** Sun intensity (0-1), affects ambient light and point light shadow suppression */
    static get intensity() {
        return this._float32 ? this._float32[Sun.F32.INTENSITY] : 0;
    }
    static set intensity(v) {
        if (this._float32) this._float32[Sun.F32.INTENSITY] = Math.max(0, Math.min(1, v));
    }

    /** Sun color as 0xRRGGBB */
    static get color() {
        return this._uint32 ? this._uint32[Sun.U32.COLOR] : 0xffffff;
    }
    static set color(v) {
        if (this._uint32) this._uint32[Sun.U32.COLOR] = v;
    }

    /** Base shadow alpha for sun-cast shadows (0-1) */
    static get shadowAlpha() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_ALPHA] : 0;
    }
    static set shadowAlpha(v) {
        if (this._float32) this._float32[Sun.F32.SHADOW_ALPHA] = Math.max(0, Math.min(1, v));
    }

    /** Current hour of day (0-24) */
    static get hour() {
        return this._float32 ? this._float32[Sun.F32.HOUR] : 12;
    }
    static set hour(v) {
        if (this._float32) this._float32[Sun.F32.HOUR] = ((v % 24) + 24) % 24; // Wrap to 0-24
    }

    // ============ Shadow Config (set once from config) ============

    /** Shadow angle offset in radians (π for southern hemisphere, 0 for northern) */
    static get shadowAngleOffset() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_ANGLE_OFFSET] : Math.PI;
    }
    static set shadowAngleOffset(v) {
        if (this._float32) this._float32[Sun.F32.SHADOW_ANGLE_OFFSET] = v;
    }

    /** Shadow length multiplier at zenith (noon) - shortest shadows */
    static get shadowMinLengthRatio() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_MIN_LENGTH_RATIO] : 0.1;
    }
    static set shadowMinLengthRatio(v) {
        if (this._float32) this._float32[Sun.F32.SHADOW_MIN_LENGTH_RATIO] = v;
    }

    /** Shadow length multiplier at horizon (sunrise/sunset) - longest shadows */
    static get shadowMaxLengthRatio() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_MAX_LENGTH_RATIO] : 1.0;
    }
    static set shadowMaxLengthRatio(v) {
        if (this._float32) this._float32[Sun.F32.SHADOW_MAX_LENGTH_RATIO] = v;
    }

    /** Alpha fade compensation when shadows stretch (0=none, 1=full) */
    static get shadowStretchAlphaFactor() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_STRETCH_ALPHA_FACTOR] : 0.5;
    }
    static set shadowStretchAlphaFactor(v) {
        if (this._float32) this._float32[Sun.F32.SHADOW_STRETCH_ALPHA_FACTOR] = Math.max(0, Math.min(1, v));
    }

    // ============ Shadow Computed (read-only for workers) ============

    /** Shadow direction X component (cos of shadow angle) */
    static get shadowDirX() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_DIR_X] : 0;
    }

    /** Shadow direction Y component (sin of shadow angle) */
    static get shadowDirY() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_DIR_Y] : 1;
    }

    /** Current shadow length ratio based on sun elevation */
    static get shadowLengthRatio() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_LENGTH_RATIO] : 1;
    }

    /** Shadow angle in radians (for sprite rotation) */
    static get shadowAngle() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_ANGLE] : 0;
    }

    // ============ Convenience Methods ============

    /**
     * Set sun position and properties based on time of day (0-24)
     * Automatically calculates angle, elevation, intensity, and color
     * @param {number} hour - Hour of day (0-24, wraps automatically)
     */
    static setTimeOfDay(hour) {
        this.hour = hour;
        const h = this.hour; // Use wrapped value

        const dayProgress = h / 24; // 0-1

        // Sun angle: East (90°) at 6am, South (180°) at noon, West (270°) at 6pm
        // Offset so sunrise is at ~6am
        this.angle = ((dayProgress - 0.25) * 360 + 360) % 360;

        // Sun elevation: 0° at sunrise/sunset, peak at noon
        // Using cosine curve centered on noon (hour 12)
        const noonOffset = Math.abs(h - 12) / 12; // 0 at noon, 1 at midnight
        const elevation = Math.max(0, Math.cos(noonOffset * Math.PI) * 90);
        this.elevation = elevation;

        // Sun intensity: smooth day/night transition using cosine curve
        // Peak at noon, zero at night
        this.intensity = Math.max(0, Math.min(1, -Math.cos(dayProgress * Math.PI * 2) * 0.5 + 0.5));

        // Sun color: interpolate from color table
        this.color = this._getColorForHour(h);

        // Compute shadow direction and length ratio
        this._updateShadowValues(elevation);
    }

    /**
     * Update precomputed shadow values based on current sun state
     * @param {number} elevation - Sun elevation in degrees
     * @private
     */
    static _updateShadowValues(elevation) {
        if (!this._float32) return;

        const sunAngleRad = this.angle * (Math.PI / 180);
        // Shadow points opposite to sun direction
        // shadowAngleOffset adds π for southern hemisphere (shadows point south/down)
        const shadowAngle = sunAngleRad + Math.PI + this.shadowAngleOffset;

        this._float32[Sun.F32.SHADOW_ANGLE] = shadowAngle;
        this._float32[Sun.F32.SHADOW_DIR_X] = Math.cos(shadowAngle);
        this._float32[Sun.F32.SHADOW_DIR_Y] = Math.sin(shadowAngle);

        // Shadow length ratio based on elevation (lower sun = longer shadows)
        // Linear interpolation: horizon (0°) = maxLengthRatio, zenith (90°) = minLengthRatio
        const t = elevation / 90; // 0 at horizon, 1 at zenith
        const minRatio = this.shadowMinLengthRatio;
        const maxRatio = this.shadowMaxLengthRatio;
        this._float32[Sun.F32.SHADOW_LENGTH_RATIO] = maxRatio + t * (minRatio - maxRatio);
    }

    /**
     * Get interpolated sun color for a given hour
     * @param {number} hour - Hour of day (0-24)
     * @returns {number} Color as 0xRRGGBB
     * @private
     */
    static _getColorForHour(hour) {
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
     * Config should be pre-merged with SUN_DEFAULTS by Scene
     * @param {Object} config - Sun configuration (merged with defaults)
     */
    static initFromConfig(config) {
        this.enabled = config.enabled;
        this.angle = config.angle;
        this.elevation = config.elevation;
        this.intensity = config.intensity;
        this.color = config.color;
        this.shadowAlpha = config.shadowAlpha;
        this.hour = config.startHour;

        // Shadow config
        this.shadowAngleOffset = config.shadowAngleOffset;
        this.shadowMinLengthRatio = config.shadowMinLengthRatio;
        this.shadowMaxLengthRatio = config.shadowMaxLengthRatio;
        this.shadowStretchAlphaFactor = config.shadowStretchAlphaFactor;

        // Initialize shadow computed values
        this._updateShadowValues(this.elevation);
    }

    /**
     * Advance time by a delta (for day cycle)
     * @param {number} deltaMs - Time delta in milliseconds
     * @param {number} speed - Day cycle speed multiplier (1 = real time)
     * @param {number} dayDurationMinutes - Real-world minutes for one full day cycle
     */
    static advanceTime(deltaMs, speed = 1, dayDurationMinutes = 1440) {
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
    static get buffer() {
        return this._sab;
    }
}
