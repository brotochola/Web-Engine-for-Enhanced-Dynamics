// A GPU particle look layer's region among the entities (gpuParticleChunks.js): a quad in world px that samples
// the layer's finished look target where the camera puts it on screen.
in vec2 aPosition;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
// World px to the target's UV (screen px / canvas), the camera's this frame (RegionQuads.setView).
uniform vec4 uUvX;
uniform vec4 uUvY;

out vec2 vUV;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 world = vec3(aPosition, 1.0);
  vec3 clip = mvp * world;
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vUV = vec2(dot(uUvX.xyz, world), dot(uUvY.xyz, world));
}
