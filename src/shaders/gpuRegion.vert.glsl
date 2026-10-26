// A GPU particle look layer's region among the entities (gpuParticleChunks.js): a quad in world px whose UVs
// (set per frame from the camera) sample the layer's finished look target.
in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vUV;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 clip = mvp * vec3(aPosition, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vUV = aUV;
}
