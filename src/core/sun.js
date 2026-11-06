/**
 * Sun - Static class representing the sun/directional light
 * Backed by SharedArrayBuffer for cross-worker access
 * Pattern follows Camera, Mouse, Keyboard static classes
 *
 * Main thread: reads and writes a private copy, published to the SAB once a frame (see initializeStaged)
 * Workers: read and write the SAB directly
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
    // SAB layout (96 bytes total, 4-byte aligned)
    static BYTE_LENGTH = 96;

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
        NIGHT_FACTOR: 60, // Float32 (0 by day, 1 by night; computed from INTENSITY)
        NIGHT_COLOR: 64, // Uint32 (0xRRGGBB)
        NIGHT_INTENSITY: 68, // Float32 (0-1, the night light at factor 1; 0 = no night light)
        NIGHT_FROM: 72, // Float32 (sun intensity at which the night light starts)
        NIGHT_TO: 76, // Float32 (sun intensity at which it is full)
        // reserved: 80-95
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
        NIGHT_FACTOR: 15,
        NIGHT_INTENSITY: 17,
        NIGHT_FROM: 18,
        NIGHT_TO: 19,
    };

    // Uint32 indices (offset / 4)
    static U32 = {
        COLOR: 4,
        NIGHT_COLOR: 16,
    };

    // Sun intensity at or under which the sun casts no shadow
    static SHADOW_MIN_INTENSITY = 0.1;

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

    // The hour-to-color table in use: DEFAULT_COLORS, or the scene's lighting.sun.colors (see setColors)
    static _colors = Sun.DEFAULT_COLORS;

    // Field views: the SAB on a worker, the private stage on the main thread (see initializeStaged)
    static _sab = null;
    static _uint8 = null;
    static _float32 = null;
    static _uint32 = null;

    // Main thread only: the SAB's words, and bit i set when word i of the stage was written since the last publish.
    static _sharedU32 = null;
    static _written = 0;

    /** cos(phase * 2π); phase in turns. One sun/scene — plain Math.cos. */
    static _cosTau(phase01) {
        let t = phase01 - Math.floor(phase01);
        if (t < 0) t += 1;
        return Math.cos(t * Math.PI * 2);
    }

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
     * Main thread's initialize: the getters and setters work on a private copy, which publish() puts in the SAB once
     * a frame, so a worker never sees a value the frame later overwrites (a day cycle's, under a scene's override).
     * @param {SharedArrayBuffer} sharedArrayBuffer - SAB of at least Sun.BYTE_LENGTH bytes
     */
    static initializeStaged(sharedArrayBuffer) {
        this.initialize(sharedArrayBuffer);
        const stage = new ArrayBuffer(Sun.BYTE_LENGTH);
        this._sharedU32 = this._uint32;
        this._uint8 = new Uint8Array(stage);
        this._float32 = new Float32Array(stage);
        this._uint32 = new Uint32Array(stage);
        this._written = 0;
    }

    /**
     * Start of the main thread's frame: the stage takes what the workers wrote, except the fields written since the
     * last publish (a handler's, between two frames), which are still on their way out. No-op on a worker.
     */
    static beginFrame() {
        const shared = this._sharedU32;
        if (shared === null) return;
        const stage = this._uint32;
        const written = this._written;
        for (let i = 0; i < stage.length; i++) {
            if ((written & (1 << i)) === 0) stage[i] = shared[i];
        }
    }

    /**
     * End of the main thread's frame: the fields written since the last publish go to the SAB, and only those, so a
     * worker's write to a field the main thread did not touch stands. No-op on a worker.
     */
    static publish() {
        const shared = this._sharedU32;
        const written = this._written;
        if (shared === null || written === 0) return;
        const stage = this._uint32;
        for (let i = 0; i < stage.length; i++) {
            if ((written & (1 << i)) !== 0) shared[i] = stage[i];
        }
        this._written = 0;
    }

    /** A wholesale restore wrote the views directly: every field goes out on the next publish. */
    static markAllWritten() {
        this._written = -1;
    }

    /** Forget the buffers and the scene's color table (a scene's teardown). */
    static unbind() {
        this._colors = Sun.DEFAULT_COLORS;
        this._sab = null;
        this._uint8 = null;
        this._float32 = null;
        this._uint32 = null;
        this._sharedU32 = null;
        this._written = 0;
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
        if (this._uint8) {
            this._uint8[Sun.OFFSETS.ENABLED] = v ? 1 : 0;
            this._written |= 1;
        }
    }

    /** Sun angle in degrees (0=East, 90=South, 180=West, 270=North) */
    static get angle() {
        return this._float32 ? this._float32[Sun.F32.ANGLE] : 0;
    }
    static set angle(v) {
        if (this._float32) {
            this._float32[Sun.F32.ANGLE] = v;
            this._written |= 1 << Sun.F32.ANGLE;
        }
    }

    /** Sun elevation in degrees (0=horizon, 90=directly overhead) */
    static get elevation() {
        return this._float32 ? this._float32[Sun.F32.ELEVATION] : 0;
    }
    static set elevation(v) {
        if (this._float32) {
            this._float32[Sun.F32.ELEVATION] = v;
            this._written |= 1 << Sun.F32.ELEVATION;
        }
    }

    /** Sun intensity (0-1), affects ambient light and point light shadow suppression */
    static get intensity() {
        return this._float32 ? this._float32[Sun.F32.INTENSITY] : 0;
    }
    static set intensity(v) {
        if (this._float32) {
            this._float32[Sun.F32.INTENSITY] = Math.max(0, Math.min(1, v));
            this._written |= 1 << Sun.F32.INTENSITY;
            this._updateNightFactor();
        }
    }

    /** Sun color as 0xRRGGBB */
    static get color() {
        return this._uint32 ? this._uint32[Sun.U32.COLOR] : 0xffffff;
    }
    static set color(v) {
        if (this._uint32) {
            this._uint32[Sun.U32.COLOR] = v;
            this._written |= 1 << Sun.U32.COLOR;
        }
    }

    /** Base shadow alpha for sun-cast shadows (0-1) */
    static get shadowAlpha() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_ALPHA] : 0;
    }
    static set shadowAlpha(v) {
        if (this._float32) {
            this._float32[Sun.F32.SHADOW_ALPHA] = Math.max(0, Math.min(1, v));
            this._written |= 1 << Sun.F32.SHADOW_ALPHA;
        }
    }

    /** Current hour of day (0-24) */
    static get hour() {
        return this._float32 ? this._float32[Sun.F32.HOUR] : 12;
    }
    static set hour(v) {
        if (this._float32) {
            this._float32[Sun.F32.HOUR] = ((v % 24) + 24) % 24;
            this._written |= 1 << Sun.F32.HOUR;
        } // Wrap to 0-24
    }

    // ============ Night Light ============

    /** 0 by day, 1 by night, from the sun's intensity and nightFrom / nightTo. Computed; follows Sun.intensity. */
    static get nightFactor() {
        return this._float32 ? this._float32[Sun.F32.NIGHT_FACTOR] : 0;
    }

    /** The night light's strength at factor 1 (0-1). It adds to the scene's light and leaves Sun.intensity alone. */
    static get nightIntensity() {
        return this._float32 ? this._float32[Sun.F32.NIGHT_INTENSITY] : 0;
    }
    static set nightIntensity(v) {
        if (this._float32) {
            this._float32[Sun.F32.NIGHT_INTENSITY] = Math.max(0, Math.min(1, v));
            this._written |= 1 << Sun.F32.NIGHT_INTENSITY;
        }
    }

    /** The night light's color as 0xRRGGBB */
    static get nightColor() {
        return this._uint32 ? this._uint32[Sun.U32.NIGHT_COLOR] : 0xffffff;
    }
    static set nightColor(v) {
        if (this._uint32) {
            this._uint32[Sun.U32.NIGHT_COLOR] = v;
            this._written |= 1 << Sun.U32.NIGHT_COLOR;
        }
    }

    /** Sun intensity at which the night light starts (factor 0) */
    static get nightFrom() {
        return this._float32 ? this._float32[Sun.F32.NIGHT_FROM] : 0;
    }
    static set nightFrom(v) {
        if (this._float32) {
            this._float32[Sun.F32.NIGHT_FROM] = v;
            this._written |= 1 << Sun.F32.NIGHT_FROM;
            this._updateNightFactor();
        }
    }

    /** Sun intensity at which the night light is full (factor 1) */
    static get nightTo() {
        return this._float32 ? this._float32[Sun.F32.NIGHT_TO] : 0;
    }
    static set nightTo(v) {
        if (this._float32) {
            this._float32[Sun.F32.NIGHT_TO] = v;
            this._written |= 1 << Sun.F32.NIGHT_TO;
            this._updateNightFactor();
        }
    }

    /**
     * The night light as it adds to the scene now: color × strength × factor, 0-1 per channel.
     * @param {Float32Array} out - rgb
     */
    static nightLightRGB(out) {
        const k = this.nightIntensity * this.nightFactor;
        const c = this.nightColor;
        out[0] = (((c >> 16) & 255) / 255) * k;
        out[1] = (((c >> 8) & 255) / 255) * k;
        out[2] = ((c & 255) / 255) * k;
    }

    /** clamp((from - I) / (from - to)): a step at to when the two meet. */
    static _updateNightFactor() {
        const from = this._float32[Sun.F32.NIGHT_FROM];
        const to = this._float32[Sun.F32.NIGHT_TO];
        const i = this._float32[Sun.F32.INTENSITY];
        const f = from === to ? (i <= to ? 1 : 0) : (from - i) / (from - to);
        this._float32[Sun.F32.NIGHT_FACTOR] = f < 0 ? 0 : f > 1 ? 1 : f;
        this._written |= 1 << Sun.F32.NIGHT_FACTOR;
    }

    // ============ Shadow Config (set once from config) ============

    /** Shadow angle offset in radians (π for southern hemisphere, 0 for northern) */
    static get shadowAngleOffset() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_ANGLE_OFFSET] : Math.PI;
    }
    static set shadowAngleOffset(v) {
        if (this._float32) {
            this._float32[Sun.F32.SHADOW_ANGLE_OFFSET] = v;
            this._written |= 1 << Sun.F32.SHADOW_ANGLE_OFFSET;
        }
    }

    /** Shadow length multiplier at zenith (noon) - shortest shadows */
    static get shadowMinLengthRatio() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_MIN_LENGTH_RATIO] : 0.1;
    }
    static set shadowMinLengthRatio(v) {
        if (this._float32) {
            this._float32[Sun.F32.SHADOW_MIN_LENGTH_RATIO] = v;
            this._written |= 1 << Sun.F32.SHADOW_MIN_LENGTH_RATIO;
        }
    }

    /** Shadow length multiplier at horizon (sunrise/sunset) - longest shadows */
    static get shadowMaxLengthRatio() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_MAX_LENGTH_RATIO] : 1.0;
    }
    static set shadowMaxLengthRatio(v) {
        if (this._float32) {
            this._float32[Sun.F32.SHADOW_MAX_LENGTH_RATIO] = v;
            this._written |= 1 << Sun.F32.SHADOW_MAX_LENGTH_RATIO;
        }
    }

    /** Alpha fade compensation when shadows stretch (0=none, 1=full) */
    static get shadowStretchAlphaFactor() {
        return this._float32 ? this._float32[Sun.F32.SHADOW_STRETCH_ALPHA_FACTOR] : 0.5;
    }
    static set shadowStretchAlphaFactor(v) {
        if (this._float32) {
            this._float32[Sun.F32.SHADOW_STRETCH_ALPHA_FACTOR] = Math.max(0, Math.min(1, v));
            this._written |= 1 << Sun.F32.SHADOW_STRETCH_ALPHA_FACTOR;
        }
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

    /**
     * How dark a sun-cast shadow is now: 0 with the sun off or under SHADOW_MIN_INTENSITY. The ShadowCaster pass and
     * alphaBySun: 'shadow' both read this, so a layer drawn in black is exactly as dark as a person's shadow.
     */
    static get shadowOpacity() {
        if (!this.enabled) return 0;
        const si = this.intensity;
        if (!(si > Sun.SHADOW_MIN_INTENSITY)) return 0;
        const len = this.shadowLengthRatio || 1;
        return this.shadowAlpha * si * (1 - this.shadowStretchAlphaFactor * (1 - this.shadowMinLengthRatio / len));
    }

    /**
     * The factor a layer's alphaBySun multiplies its alpha by.
     * @param {'shadow'|'night'|{from: number, to: number}} spec
     * @returns {number} 0-1
     */
    static alphaFactor(spec) {
        if (spec === 'shadow') return this.shadowOpacity;
        if (spec === 'night') return this.nightFactor;
        const { from, to } = spec;
        const i = this.intensity;
        const f = from === to ? (i >= to ? 1 : 0) : (i - from) / (to - from);
        return f < 0 ? 0 : f > 1 ? 1 : f;
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

        // Elevation: cos(π * noonOffset) = cos(2π * noonOffset/2)
        const noonOffset = Math.abs(h - 12) / 12; // 0 at noon, 1 at midnight
        const elevation = Math.max(0, this._cosTau(noonOffset * 0.5) * 90);
        this.elevation = elevation;

        // Intensity: (1 - cos(2π dayProgress)) / 2
        this.intensity = Math.max(0, Math.min(1, -this._cosTau(dayProgress) * 0.5 + 0.5));

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

        // Sun bearing in turns [0,1); shadow = sun + 0.5 turns + offset
        const sunTurns = this.angle / 360;
        const offsetTurns = this.shadowAngleOffset / (Math.PI * 2);
        const shadowTurns = sunTurns + 0.5 + offsetTurns;
        const shadowAngle = shadowTurns * Math.PI * 2;

        this._float32[Sun.F32.SHADOW_ANGLE] = shadowAngle;
        // cos(θ+π)=-cosθ, sin(θ+π)=-sinθ — sample sun bearing then flip
        const sunC = this._cosTau(sunTurns + offsetTurns);
        // sin(τ) = cos(τ - 0.25)
        const sunS = this._cosTau(sunTurns + offsetTurns - 0.25);
        this._float32[Sun.F32.SHADOW_DIR_X] = -sunC;
        this._float32[Sun.F32.SHADOW_DIR_Y] = -sunS;

        // Shadow length ratio based on elevation (lower sun = longer shadows)
        // Linear interpolation: horizon (0°) = maxLengthRatio, zenith (90°) = minLengthRatio
        const t = elevation / 90; // 0 at horizon, 1 at zenith
        const minRatio = this.shadowMinLengthRatio;
        const maxRatio = this.shadowMaxLengthRatio;
        this._float32[Sun.F32.SHADOW_LENGTH_RATIO] = maxRatio + t * (minRatio - maxRatio);
        this._written |=
            (1 << Sun.F32.SHADOW_ANGLE) |
            (1 << Sun.F32.SHADOW_DIR_X) |
            (1 << Sun.F32.SHADOW_DIR_Y) |
            (1 << Sun.F32.SHADOW_LENGTH_RATIO);
    }

    /**
     * Get interpolated sun color for a given hour
     * @param {number} hour - Hour of day (0-24)
     * @returns {number} Color as 0xRRGGBB
     * @private
     */
    static _getColorForHour(hour) {
        const colors = this._colors;

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
     * Use the scene's hour-to-color table instead of DEFAULT_COLORS. Keyframes in any order; hours outside the table
     * wrap around midnight. Nothing or an empty table goes back to DEFAULT_COLORS.
     * @param {{hour: number, color: number}[]} [colors]
     */
    static setColors(colors) {
        if (!Array.isArray(colors) || colors.length === 0) {
            this._colors = Sun.DEFAULT_COLORS;
            return;
        }
        const sorted = [...colors].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        this._colors = [{ hour: last.hour - 24, color: last.color }, ...sorted, { hour: first.hour + 24, color: first.color }];
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
        this.setColors(config.colors);

        const night = config.night;
        if (night) {
            this.nightIntensity = night.intensity;
            this.nightColor = night.color;
            this.nightFrom = night.from;
            this.nightTo = night.to;
        }

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
