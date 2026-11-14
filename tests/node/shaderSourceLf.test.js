// Shaders with CR LF line ends are read as LF (rendererBackend.js shaderSourceLf, review N-169). A clone made with
// core.autocrlf=true (Git for Windows' default) wrote src/shaders with CR LF, and the rewrites below find their lines
// by "\n": the renderer stopped on a friend's fresh clone with 'the sprite vertex shader needs one "void main() {"'.
// The engine's fetches (pixiWorker fetchEngineShader, the scene's shader assets) pass what they read through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { shaderSourceLf } from '../../src/render/rendererBackend.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { faceMapVertex, faceMapWgsl } from '../../src/render/faceMap.js';
import { gpuParticleTextureVertex } from '../../src/render/gpuParticleBatch.js';

/** A shader of src/shaders as LF (whatever this clone's checkout wrote) and as the CR LF a Windows clone had. */
function shader(name) {
  const lf = shaderSourceLf(fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8'));
  return { lf, crlf: lf.replace(/\n/g, '\r\n') };
}

test('a CR LF sprite shader read through shaderSourceLf rewrites as its LF copy does', () => {
  const vert = shader('instancedSprite.vert.glsl');
  assert.throws(() => spriteIndexedVertex(vert.crlf), /the sprite vertex shader needs one "void main\(\) \{"/);
  assert.equal(spriteIndexedVertex(shaderSourceLf(vert.crlf)), spriteIndexedVertex(vert.lf));
  assert.equal(faceMapVertex(shaderSourceLf(vert.crlf)), faceMapVertex(vert.lf));
  const wgsl = shader('instancedSprite.wgsl');
  assert.equal(spriteIndexedWgsl(shaderSourceLf(wgsl.crlf)), spriteIndexedWgsl(wgsl.lf));
  assert.equal(faceMapWgsl(shaderSourceLf(wgsl.crlf)), faceMapWgsl(wgsl.lf));
  const particle = shader('gpuParticle.vert.glsl');
  assert.equal(gpuParticleTextureVertex(shaderSourceLf(particle.crlf)), gpuParticleTextureVertex(particle.lf));
});

test('shaderSourceLf returns LF text as it is and reads a lone CR as a line end', () => {
  const lf = 'void main() {\n}\n';
  assert.equal(shaderSourceLf(lf), lf);
  assert.equal(shaderSourceLf('a\rb\r\nc\n'), 'a\nb\nc\n');
});
