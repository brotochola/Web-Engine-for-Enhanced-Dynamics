/**
 * Instanced sprite + LiquidFun splat GLSL (from main). Used when renderer.backend is webgl.
 */

export const INSTANCED_SPRITE_VERTEX_GLSL = `
in vec2 aQuad;
in vec2 aInstXY;
in vec2 aInstScale;
in vec2 aInstAnchor;
in vec2 aInstRotCS;
in float aInstDepth;
in float aInstTintBits;
in float aInstTexId;
in vec2 aInstTileInv;
in vec2 aInstTileOff;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform sampler2D uTexLut;
uniform vec4 uTileWorld;

out vec2 vLocal;
out vec4 vColor;
out vec2 vWorld;
out vec4 vAtlasUV;
out vec2 vTileInv;
out vec2 vTileOff;

void main() {
  int tid = int(aInstTexId + 0.5);
  ivec2 lutSize = textureSize(uTexLut, 0);
  vec2 aInstSize = vec2(0.0);
  vec4 aInstUV = vec4(0.0);
  vec4 aInstTrim = vec4(0.0);
  if (tid >= 0 && tid < lutSize.y) {
    vec4 t0 = texelFetch(uTexLut, ivec2(0, tid), 0);
    vec4 t1 = texelFetch(uTexLut, ivec2(1, tid), 0);
    vec4 t2 = texelFetch(uTexLut, ivec2(2, tid), 0);
    aInstSize = t0.xy;
    aInstUV = vec4(t0.zw, t1.xy);
    aInstTrim = vec4(t1.zw, t2.xy);
  }

  uint tintBits = floatBitsToUint(aInstTintBits);
  vec3 rgb = vec3(
    float((tintBits >> 16u) & 255u),
    float((tintBits >> 8u) & 255u),
    float(tintBits & 255u)
  ) / 255.0;
  float instA = float((tintBits >> 24u) & 255u) / 255.0;

  vec2 content = aInstTrim.xy + aQuad * aInstTrim.zw;
  vec2 local = (content - aInstAnchor * aInstSize) * aInstScale;
  float c = aInstRotCS.x;
  float s = aInstRotCS.y;
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = rotated + aInstXY;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, aInstDepth, 1.0);
  vLocal = aQuad;
  vColor = vec4(rgb, instA);
  vWorld = uTileWorld.w > 0.5 ? world * uTileWorld.z + uTileWorld.xy : world;
  vAtlasUV = aInstUV;
  vTileInv = aInstTileInv;
  vTileOff = aInstTileOff;
}
`;

function tiledSamplePrelude() {
  return `
vec2 weedUv() {
  vec2 t = vLocal;
  if (vTileInv.x > 0.0) t.x = fract(vWorld.x * vTileInv.x + vTileOff.x);
  else if (vTileInv.x < 0.0) t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x);
  if (vTileInv.y > 0.0) t.y = fract(vWorld.y * vTileInv.y + vTileOff.y);
  else if (vTileInv.y < 0.0) t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y);
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}
`;
}

/** Pixi GlProgram only injects GLSL 300 if the fragment contains this string. */
const GLSL300 = '#version 300 es';

export const INSTANCED_SPRITE_FRAGMENT_GLSL = `
${GLSL300}
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
uniform sampler2D uTexture;
out vec4 finalColor;

${tiledSamplePrelude()}

void main() {
  vec4 t = texture(uTexture, weedUv());
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, a);
}
`;

export const INSTANCED_SPRITE_FRAGMENT_BLEND_GLSL = `
${GLSL300}
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
uniform sampler2D uTexture;
out vec4 finalColor;

${tiledSamplePrelude()}

void main() {
  vec4 t = texture(uTexture, weedUv());
  float a = t.a * vColor.a;
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, a);
}
`;

export const INSTANCED_SPRITE_FRAGMENT_ADDITIVE_GLSL = `
${GLSL300}
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec2 vWorld;
in vec4 vAtlasUV;
in vec2 vTileInv;
in vec2 vTileOff;
uniform sampler2D uTexture;
out vec4 finalColor;

${tiledSamplePrelude()}

void main() {
  vec4 t = texture(uTexture, weedUv());
  finalColor = vec4(t.rgb * vColor.rgb * vColor.a, 0.0);
}
`;

export function pickInstancedSpriteFragmentGlsl(premultiplyAlpha, alphaDiscard) {
  if (!premultiplyAlpha) return INSTANCED_SPRITE_FRAGMENT_ADDITIVE_GLSL;
  return alphaDiscard !== false ? INSTANCED_SPRITE_FRAGMENT_GLSL : INSTANCED_SPRITE_FRAGMENT_BLEND_GLSL;
}

export const LF_SPLAT_VERTEX_GLSL = `
in vec2 aQuad;
in vec2 aInstXY;
in float aInstRadius;
in vec4 aInstColor;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vLocal;
out vec4 vColor;

void main() {
  vec2 world = aInstXY + aQuad * aInstRadius;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vLocal = aQuad;
  vColor = aInstColor;
}
`;

export const LF_SPLAT_FRAGMENT_GLSL = `
precision highp float;
in vec2 vLocal;
in vec4 vColor;

void main() {
  float d2 = dot(vLocal, vLocal);
  float a = max(0.0, 1.0 - d2) * vColor.a;
  if (a < 0.001) discard;
  gl_FragColor = vec4(vColor.rgb * a, a);
}
`;

/** Fullscreen look quad. No V-flip (WebGL RT UV already top-origin). */
export const FULLSCREEN_LOOK_VERTEX_GLSL = `
    attribute vec2 aPosition;
    attribute vec2 aUV;
    varying vec2 vTextureCoord;
    void main() {
      vTextureCoord = aUV;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`;
