/**
 * SABParticleRenderer - High-performance particle renderer that reads directly from SharedArrayBuffers
 *
 * This bypasses PixiJS's Particle objects entirely, reading transform and sprite data
 * directly from ECS component SABs and uploading to WebGL vertex buffers.
 *
 * Architecture:
 * - No Particle objects - data stays in typed arrays
 * - Index-based Y-sorting - just reorder indices, not data
 * - Single upload pass - SAB → vertex buffer
 * - Shares WebGL context with PixiJS
 *
 * Performance gains:
 * - Zero object property access during upload
 * - No GC pressure from Particle objects
 * - Cache-friendly sequential memory access
 * - Minimal data movement during sorting
 */

// Vertex shader for SAB particles
const VERTEX_SHADER = `#version 300 es
precision highp float;

// Per-vertex attributes (4 vertices per particle, forming a quad)
in vec2 aVertex;      // Vertex offset from center (scaled by size)
in vec2 aPosition;    // World position (same for all 4 vertices of a particle)
in float aRotation;   // Rotation in radians
in vec2 aUV;          // Texture coordinates
in vec4 aColor;       // RGBA color (tint + alpha)

// Uniforms
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransform;

// Outputs to fragment shader
out vec2 vUV;
out vec4 vColor;

void main() {
    // Apply rotation to vertex offset
    float cosR = cos(aRotation);
    float sinR = sin(aRotation);
    vec2 rotatedVertex = vec2(
        aVertex.x * cosR - aVertex.y * sinR,
        aVertex.x * sinR + aVertex.y * cosR
    );

    // World position = particle position + rotated vertex offset
    vec2 worldPos = aPosition + rotatedVertex;

    // Apply world transform (camera) and projection
    vec3 clipPos = uProjectionMatrix * uWorldTransform * vec3(worldPos, 1.0);
    gl_Position = vec4(clipPos.xy, 0.0, 1.0);

    vUV = aUV;
    vColor = aColor;
}
`;

// Fragment shader for SAB particles
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTexture;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(uTexture, vUV);
    fragColor = texColor * vColor;
}
`;

/**
 * Pre-computed UV coordinates for texture regions
 * Stored as Float32Array for direct buffer upload
 */
class UVCache {
    constructor(maxTextures = 256) {
        // 4 UV pairs per texture (4 corners of quad)
        // Each UV pair = 2 floats, so 8 floats per texture
        this.uvData = new Float32Array(maxTextures * 8);
        this.textureCount = 0;
        this.textureMap = new Map(); // texture -> index
    }

    /**
     * Register a texture and cache its UVs
     * @param {WebGLTexture} texture - The texture
     * @param {Object} uvs - UV coordinates {x0, y0, x1, y1, x2, y2, x3, y3}
     * @returns {number} - Texture index for lookup
     */
    addTexture(texture, uvs) {
        if (this.textureMap.has(texture)) {
            return this.textureMap.get(texture);
        }

        const index = this.textureCount++;
        this.textureMap.set(texture, index);

        const offset = index * 8;
        this.uvData[offset + 0] = uvs.x0;
        this.uvData[offset + 1] = uvs.y0;
        this.uvData[offset + 2] = uvs.x1;
        this.uvData[offset + 3] = uvs.y1;
        this.uvData[offset + 4] = uvs.x2;
        this.uvData[offset + 5] = uvs.y2;
        this.uvData[offset + 6] = uvs.x3;
        this.uvData[offset + 7] = uvs.y3;

        return index;
    }

    /**
     * Get UV coordinates for a texture index
     * @param {number} index - Texture index
     * @returns {Float32Array} - Subarray view of UV data (8 floats)
     */
    getUVs(index) {
        const offset = index * 8;
        return this.uvData.subarray(offset, offset + 8);
    }
}

/**
 * SABParticleRenderer - Main renderer class
 */
export class SABParticleRenderer {
    /**
     * @param {WebGL2RenderingContext} gl - WebGL2 context (shared with PixiJS)
     * @param {number} maxParticles - Maximum number of particles to render
     */
    constructor(gl, maxParticles = 10000) {
        this.gl = gl;
        this.maxParticles = maxParticles;
        this.particleCount = 0;

        // Compile shaders
        this.program = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER);

        // Get attribute locations
        this.attribs = {
            vertex: gl.getAttribLocation(this.program, 'aVertex'),
            position: gl.getAttribLocation(this.program, 'aPosition'),
            rotation: gl.getAttribLocation(this.program, 'aRotation'),
            uv: gl.getAttribLocation(this.program, 'aUV'),
            color: gl.getAttribLocation(this.program, 'aColor'),
        };

        // Get uniform locations
        this.uniforms = {
            projectionMatrix: gl.getUniformLocation(this.program, 'uProjectionMatrix'),
            worldTransform: gl.getUniformLocation(this.program, 'uWorldTransform'),
            texture: gl.getUniformLocation(this.program, 'uTexture'),
        };

        // Create VAO
        this.vao = gl.createVertexArray();

        // Vertex layout:
        // aVertex (2) + aPosition (2) + aRotation (1) + aUV (2) + aColor (4) = 11 floats per vertex
        // 4 vertices per particle = 44 floats per particle
        this.stride = 11 * 4; // bytes
        this.verticesPerParticle = 4;
        this.floatsPerParticle = 44;

        // Create vertex buffer
        this.vertexBuffer = gl.createBuffer();
        this.vertexData = new Float32Array(maxParticles * this.floatsPerParticle);
        this.colorView = new Uint8Array(this.vertexData.buffer); // For RGBA byte access

        // Create index buffer (6 indices per particle: 2 triangles)
        this.indexBuffer = gl.createBuffer();
        this.indexData = this._createIndices(maxParticles);

        // Setup VAO
        this._setupVAO();

        // UV cache for texture regions
        this.uvCache = new UVCache();

        // Sorted indices for Y-sorting (just indices, not data!)
        this.sortedIndices = new Uint16Array(maxParticles);
        this.sortKeys = new Float32Array(maxParticles); // Y values for sorting

        // SAB references (set externally)
        this.positionX = null;  // Float32Array - Transform.x
        this.positionY = null;  // Float32Array - Transform.y
        this.rotation = null;   // Float32Array - Transform.rotation
        this.scaleX = null;     // Float32Array - SpriteRenderer.scaleX
        this.scaleY = null;     // Float32Array - SpriteRenderer.scaleY
        this.anchorX = null;    // Float32Array - SpriteRenderer.anchorX
        this.anchorY = null;    // Float32Array - SpriteRenderer.anchorY
        this.tint = null;       // Uint32Array - SpriteRenderer.tint (BGR format)
        this.alpha = null;      // Float32Array - SpriteRenderer.alpha
        this.textureIds = null; // Uint8Array - texture index per entity

        // Texture dimensions (for vertex calculation)
        this.textureWidths = new Float32Array(256);
        this.textureHeights = new Float32Array(256);

        // Current texture (all particles must use same base texture)
        this.currentTexture = null;

        // Projection and world transform matrices (3x3 for 2D)
        this.projectionMatrix = new Float32Array(9);
        this.worldTransform = new Float32Array(9);
        this._setIdentityMatrix(this.projectionMatrix);
        this._setIdentityMatrix(this.worldTransform);
    }

    /**
     * Set SAB references for direct data access
     * @param {Object} sabs - Object containing SAB references
     */
    setSABs(sabs) {
        this.positionX = sabs.positionX;
        this.positionY = sabs.positionY;
        this.rotation = sabs.rotation;
        this.scaleX = sabs.scaleX;
        this.scaleY = sabs.scaleY;
        this.anchorX = sabs.anchorX;
        this.anchorY = sabs.anchorY;
        this.tint = sabs.tint;
        this.alpha = sabs.alpha;
    }

    /**
     * Set projection matrix for screen coordinates
     * @param {number} width - Screen width
     * @param {number} height - Screen height
     */
    setProjection(width, height) {
        // Orthographic projection: maps world coords to clip space [-1, 1]
        this.projectionMatrix[0] = 2 / width;
        this.projectionMatrix[1] = 0;
        this.projectionMatrix[2] = 0;
        this.projectionMatrix[3] = 0;
        this.projectionMatrix[4] = -2 / height; // Flip Y
        this.projectionMatrix[5] = 0;
        this.projectionMatrix[6] = -1;
        this.projectionMatrix[7] = 1;
        this.projectionMatrix[8] = 1;
    }

    /**
     * Set world transform (camera)
     * @param {number} x - Camera X offset
     * @param {number} y - Camera Y offset
     * @param {number} zoom - Camera zoom
     */
    setWorldTransform(x, y, zoom) {
        this.worldTransform[0] = zoom;
        this.worldTransform[1] = 0;
        this.worldTransform[2] = 0;
        this.worldTransform[3] = 0;
        this.worldTransform[4] = zoom;
        this.worldTransform[5] = 0;
        this.worldTransform[6] = -x * zoom;
        this.worldTransform[7] = -y * zoom;
        this.worldTransform[8] = 1;
    }

    /**
     * Register a texture region for rendering
     * @param {number} textureId - ID for this texture region
     * @param {Object} uvs - UV coordinates {x0, y0, x1, y1, x2, y2, x3, y3}
     * @param {number} width - Texture region width in pixels
     * @param {number} height - Texture region height in pixels
     */
    registerTexture(textureId, uvs, width, height) {
        this.uvCache.addTexture(textureId, uvs);
        this.textureWidths[textureId] = width;
        this.textureHeights[textureId] = height;
    }

    /**
     * Set the active texture atlas
     * @param {WebGLTexture} texture - WebGL texture
     */
    setTexture(texture) {
        this.currentTexture = texture;
    }

    /**
     * Update particle data and render
     * @param {Uint16Array} activeIndices - Array of active entity indices
     * @param {number} count - Number of active entities
     * @param {Uint8Array} textureIds - Texture ID per entity
     * @param {boolean} ySort - Whether to Y-sort particles
     */
    render(activeIndices, count, textureIds, ySort = true) {
        if (count === 0 || !this.currentTexture) return;

        const gl = this.gl;

        // Y-sorting: sort indices by Y position
        if (ySort) {
            // Copy indices and Y values
            for (let i = 0; i < count; i++) {
                const idx = activeIndices[i];
                this.sortedIndices[i] = idx;
                this.sortKeys[i] = this.positionY[idx];
            }
            // Sort indices by Y (insertion sort for nearly-sorted data)
            this._insertionSort(count);
        } else {
            // Just copy indices
            for (let i = 0; i < count; i++) {
                this.sortedIndices[i] = activeIndices[i];
            }
        }

        // Upload vertex data directly from SABs
        this._uploadVertices(count, textureIds);

        // Bind program and VAO
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);

        // Set uniforms
        gl.uniformMatrix3fv(this.uniforms.projectionMatrix, false, this.projectionMatrix);
        gl.uniformMatrix3fv(this.uniforms.worldTransform, false, this.worldTransform);

        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.currentTexture);
        gl.uniform1i(this.uniforms.texture, 0);

        // Upload vertex buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertexData.subarray(0, count * this.floatsPerParticle));

        // Draw
        gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_SHORT, 0);

        // Unbind
        gl.bindVertexArray(null);

        this.particleCount = count;
    }

    /**
     * Upload vertex data from SABs (SINGLE PASS - no intermediate objects!)
     * @private
     */
    _uploadVertices(count, textureIds) {
        const vd = this.vertexData;
        const cv = this.colorView;
        const stride = this.floatsPerParticle;

        // SAB references (cached for tight loop)
        const px = this.positionX;
        const py = this.positionY;
        const rot = this.rotation;
        const sx = this.scaleX;
        const sy = this.scaleY;
        const ax = this.anchorX;
        const ay = this.anchorY;
        const tint = this.tint;
        const alpha = this.alpha;
        const tw = this.textureWidths;
        const th = this.textureHeights;
        const uvData = this.uvCache.uvData;
        const sortedIdx = this.sortedIndices;

        for (let i = 0; i < count; i++) {
            const entityIdx = sortedIdx[i];
            const texId = textureIds[entityIdx];
            const offset = i * stride;

            // Get entity data directly from SABs
            const x = px[entityIdx];
            const y = py[entityIdx];
            const r = rot[entityIdx];
            const scX = sx[entityIdx];
            const scY = sy[entityIdx];
            const ancX = ax[entityIdx];
            const ancY = ay[entityIdx];

            // Calculate vertex offsets (scaled quad corners)
            const w = tw[texId];
            const h = th[texId];
            const w0 = w * (1 - ancX) * scX;
            const w1 = -w * ancX * scX;
            const h0 = h * (1 - ancY) * scY;
            const h1 = -h * ancY * scY;

            // Get UVs for this texture
            const uvOffset = texId * 8;
            const u0 = uvData[uvOffset + 0];
            const v0 = uvData[uvOffset + 1];
            const u1 = uvData[uvOffset + 2];
            const v1 = uvData[uvOffset + 3];
            const u2 = uvData[uvOffset + 4];
            const v2 = uvData[uvOffset + 5];
            const u3 = uvData[uvOffset + 6];
            const v3 = uvData[uvOffset + 7];

            // Pack color (tint is BGR, we need RGBA)
            const t = tint[entityIdx];
            const a = Math.floor(alpha[entityIdx] * 255);
            // tint is stored as 0x00BBGGRR, we need RGBA bytes
            const colorR = t & 0xFF;
            const colorG = (t >> 8) & 0xFF;
            const colorB = (t >> 16) & 0xFF;

            // Vertex 0 (bottom-left)
            vd[offset + 0] = w1;      // vertex.x
            vd[offset + 1] = h1;      // vertex.y
            vd[offset + 2] = x;       // position.x
            vd[offset + 3] = y;       // position.y
            vd[offset + 4] = r;       // rotation
            vd[offset + 5] = u0;      // uv.x
            vd[offset + 6] = v0;      // uv.y
            // Color as normalized floats
            vd[offset + 7] = colorR / 255;
            vd[offset + 8] = colorG / 255;
            vd[offset + 9] = colorB / 255;
            vd[offset + 10] = a / 255;

            // Vertex 1 (bottom-right)
            vd[offset + 11] = w0;
            vd[offset + 12] = h1;
            vd[offset + 13] = x;
            vd[offset + 14] = y;
            vd[offset + 15] = r;
            vd[offset + 16] = u1;
            vd[offset + 17] = v1;
            vd[offset + 18] = colorR / 255;
            vd[offset + 19] = colorG / 255;
            vd[offset + 20] = colorB / 255;
            vd[offset + 21] = a / 255;

            // Vertex 2 (top-right)
            vd[offset + 22] = w0;
            vd[offset + 23] = h0;
            vd[offset + 24] = x;
            vd[offset + 25] = y;
            vd[offset + 26] = r;
            vd[offset + 27] = u2;
            vd[offset + 28] = v2;
            vd[offset + 29] = colorR / 255;
            vd[offset + 30] = colorG / 255;
            vd[offset + 31] = colorB / 255;
            vd[offset + 32] = a / 255;

            // Vertex 3 (top-left)
            vd[offset + 33] = w1;
            vd[offset + 34] = h0;
            vd[offset + 35] = x;
            vd[offset + 36] = y;
            vd[offset + 37] = r;
            vd[offset + 38] = u3;
            vd[offset + 39] = v3;
            vd[offset + 40] = colorR / 255;
            vd[offset + 41] = colorG / 255;
            vd[offset + 42] = colorB / 255;
            vd[offset + 43] = a / 255;
        }
    }

    /**
     * Insertion sort for nearly-sorted data (Y-sorting between frames)
     * @private
     */
    _insertionSort(count) {
        const indices = this.sortedIndices;
        const keys = this.sortKeys;

        for (let i = 1; i < count; i++) {
            const idx = indices[i];
            const key = keys[i];
            let j = i - 1;

            while (j >= 0 && keys[j] > key) {
                indices[j + 1] = indices[j];
                keys[j + 1] = keys[j];
                j--;
            }

            indices[j + 1] = idx;
            keys[j + 1] = key;
        }
    }

    /**
     * Create index buffer data
     * @private
     */
    _createIndices(maxParticles) {
        const indices = new Uint16Array(maxParticles * 6);
        for (let i = 0, j = 0; i < maxParticles; i++, j += 4) {
            const offset = i * 6;
            indices[offset + 0] = j + 0;
            indices[offset + 1] = j + 1;
            indices[offset + 2] = j + 2;
            indices[offset + 3] = j + 0;
            indices[offset + 4] = j + 2;
            indices[offset + 5] = j + 3;
        }
        return indices;
    }

    /**
     * Setup VAO with vertex attributes
     * @private
     */
    _setupVAO() {
        const gl = this.gl;

        gl.bindVertexArray(this.vao);

        // Bind vertex buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.byteLength, gl.DYNAMIC_DRAW);

        // Bind index buffer
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData, gl.STATIC_DRAW);

        const stride = this.stride;

        // aVertex (vec2) - offset 0
        gl.enableVertexAttribArray(this.attribs.vertex);
        gl.vertexAttribPointer(this.attribs.vertex, 2, gl.FLOAT, false, stride, 0);

        // aPosition (vec2) - offset 8
        gl.enableVertexAttribArray(this.attribs.position);
        gl.vertexAttribPointer(this.attribs.position, 2, gl.FLOAT, false, stride, 8);

        // aRotation (float) - offset 16
        gl.enableVertexAttribArray(this.attribs.rotation);
        gl.vertexAttribPointer(this.attribs.rotation, 1, gl.FLOAT, false, stride, 16);

        // aUV (vec2) - offset 20
        gl.enableVertexAttribArray(this.attribs.uv);
        gl.vertexAttribPointer(this.attribs.uv, 2, gl.FLOAT, false, stride, 20);

        // aColor (vec4) - offset 28
        gl.enableVertexAttribArray(this.attribs.color);
        gl.vertexAttribPointer(this.attribs.color, 4, gl.FLOAT, false, stride, 28);

        gl.bindVertexArray(null);
    }

    /**
     * Create shader program
     * @private
     */
    _createProgram(vertexSrc, fragmentSrc) {
        const gl = this.gl;

        const vertexShader = this._compileShader(gl.VERTEX_SHADER, vertexSrc);
        const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fragmentSrc);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const error = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Failed to link shader program: ${error}`);
        }

        // Clean up shaders (they're now part of the program)
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        return program;
    }

    /**
     * Compile a shader
     * @private
     */
    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
            throw new Error(`Failed to compile ${typeName} shader: ${error}`);
        }

        return shader;
    }

    /**
     * Set identity matrix
     * @private
     */
    _setIdentityMatrix(m) {
        m[0] = 1; m[1] = 0; m[2] = 0;
        m[3] = 0; m[4] = 1; m[5] = 0;
        m[6] = 0; m[7] = 0; m[8] = 1;
    }

    /**
     * Clean up WebGL resources
     */
    destroy() {
        const gl = this.gl;
        gl.deleteProgram(this.program);
        gl.deleteBuffer(this.vertexBuffer);
        gl.deleteBuffer(this.indexBuffer);
        gl.deleteVertexArray(this.vao);
    }
}
