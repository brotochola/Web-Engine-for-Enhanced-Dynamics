// A WebGPU program's explicit layout names its resources by group and binding, and Pixi files a Shader's resources by
// the WGSL's own declarations (extractStructAndGroups): a name the layout lists that the WGSL does not declare goes to a
// spare group, and the bind group then lacks that binding. Pixi reports it as "the resource bound as '<name>' was
// destroyed while a shader still uses it" on every frame (the lamps' map columns' uFoot did, DX-SHADOW3D F7). Every
// program the engine builds from transformed WGSL declares what its layout names, at the same group and binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SUN_MAP_COLUMNS, sunMapColumnsWgsl, sunMapWgsl } from '../../src/render/sunShadowMap.js';
import { lampMapColumnsWgsl, lampMapWgsl } from '../../src/render/lampShadowMap.js';
import { volumeLampWgsl, volumeMapGpuProgram, volumeMapWgsl } from '../../src/render/volumeShadowMap.js';
import { pixelDepthWgsl } from '../../src/render/pixelDepth.js';
import { spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import {
  instancedSpriteGpuProgram,
  instancedSpriteIndexedGpuProgram,
  sunShadowGpuProgram,
} from '../../src/render/webgpu/instancedSpriteWgsl.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
const GpuProgram = { from: (o) => o };

/** The WGSL's declared bindings as Pixi reads them: `@group(g) @binding(b) var<…> name`. */
function declared(wgsl) {
  const out = new Map();
  for (const m of wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]+>)?\s+(\w+)/g)) {
    out.set(m[3], `${m[1]}:${m[2]}`);
  }
  return out;
}

function assertLayoutDeclared(label, program) {
  const source = program.vertex.source;
  const have = declared(source);
  for (const [group, names] of Object.entries(program.layout)) {
    for (const [name, binding] of Object.entries(names)) {
      assert.equal(have.get(name), `${group}:${binding}`, `${label}: the layout's ${name} (group ${group}, binding ${binding})`);
    }
  }
  // And the GPU layout has an entry at each of those bindings.
  for (const [name, binding] of Object.entries(program.layout[2] || {})) {
    assert.ok(program.gpuLayout[2].some((e) => e.binding === binding), `${label}: gpuLayout has ${name}'s binding ${binding}`);
  }
}

test('the sun and lamps\' shadow programs declare every binding their layouts name', () => {
  const wgsl = shader('instancedSpriteShadow.wgsl');
  const cases = [
    ['sun-map', sunMapWgsl(wgsl, { heights: true }), 'mainFragMap', {}],
    ['sun-cards', sunMapWgsl(wgsl, { heights: false }), 'mainFrag', {}],
    ['sun-map-columns', sunMapColumnsWgsl(wgsl, SUN_MAP_COLUMNS, { heights: true }), 'mainFragMap', { maps: true }],
    ['sun-columns', sunMapColumnsWgsl(wgsl, SUN_MAP_COLUMNS, { heights: false }), 'mainFrag', { maps: true }],
    ['lamp-map', lampMapWgsl(wgsl), 'mainFragLamp', { lampTiles: true }],
    ['lamp-map-columns', lampMapColumnsWgsl(wgsl), 'mainFragLamp', { maps: true, lampTiles: true }],
  ];
  for (const [name, source, frag, opts] of cases) {
    assertLayoutDeclared(name, sunShadowGpuProgram(GpuProgram, source, frag, name, opts));
  }
});

test('the volumes\' map programs declare every binding their layouts name', () => {
  const mesh = shader('meshUvFill.wgsl');
  assertLayoutDeclared('sun-map-volumes', volumeMapGpuProgram(GpuProgram, volumeMapWgsl(mesh), 'mainFragMap', 'v'));
  assertLayoutDeclared(
    'lamp-map-volumes',
    volumeMapGpuProgram(GpuProgram, volumeLampWgsl(mesh), 'mainFragLamp', 'l', { lampTiles: true }),
  );
});

test('the sprites\' pixel depth programs declare every binding their layouts name', () => {
  const sprite = shader('instancedSprite.wgsl');
  const pose = shader('instancedSpritePose.wgsl');
  assertLayoutDeclared('sprite-depth', instancedSpriteGpuProgram(GpuProgram, pixelDepthWgsl(sprite), 'mainFrag', 's', { maps: true }));
  assertLayoutDeclared('sprite-pose-depth', instancedSpriteGpuProgram(GpuProgram, pixelDepthWgsl(pose), 'mainFrag', 'p', { maps: true }));
  const indexed = spriteIndexedWgsl(sprite);
  for (const poseAlpha of [false, true]) {
    assertLayoutDeclared(
      `sprite-indexed-depth poseAlpha=${poseAlpha}`,
      instancedSpriteIndexedGpuProgram(GpuProgram, pixelDepthWgsl(indexed, { poseAlpha }), 'mainFrag', 'i', { maps: true }),
    );
  }
});

test('the G-buffer passes and the light pass declare every binding their layouts name', async () => {
  const { faceMapWgsl, lightingSource } = await import('../../src/render/faceMap.js');
  const { lightingGpuProgram } = await import('../../src/render/webgpu/pixiMeshWgsl.js');
  const sprite = shader('instancedSprite.wgsl');
  const pose = shader('instancedSpritePose.wgsl');
  for (const [gbuf, glow] of [[false, false], [true, false], [true, true]]) {
    const opts = { gbuf, glow };
    for (const entry of gbuf ? ['mainFragFace', 'mainFragIds', 'mainFragGbuf', 'mainFragGlow'] : ['mainFragFace']) {
      const label = `${entry} gbuf=${gbuf} glow=${glow}`;
      assertLayoutDeclared(`face ${label}`, instancedSpriteGpuProgram(GpuProgram, faceMapWgsl(sprite, opts), entry, 'f', { maps: true }));
      assertLayoutDeclared(`face pose ${label}`, instancedSpriteGpuProgram(GpuProgram, faceMapWgsl(pose, opts), entry, 'f', { maps: true }));
      assertLayoutDeclared(
        `face indexed ${label}`,
        instancedSpriteIndexedGpuProgram(GpuProgram, spriteIndexedWgsl(faceMapWgsl(sprite, opts)), entry, 'f', { maps: true }),
      );
    }
  }
  const { glowCompositeGpuProgram } = await import('../../src/render/glowComposite.js');
  const glow = glowCompositeGpuProgram(GpuProgram);
  assertLayoutDeclared('glow layer', glow);
  const lighting = shader('lightingBasic.wgsl');
  const { lightTilesGpuProgram } = await import('../../src/render/lightTiles.js');
  for (const faces of [false, true]) {
    for (const sunMap of [false, true]) {
      for (const lampMap of [false, true]) {
        for (const ids of [false, true]) {
          const source = lightingSource(lighting, { faces, sunMap, selfShadow: true, lampMap, ids });
          assertLayoutDeclared(
            `lighting faces=${faces} sunMap=${sunMap} lampMap=${lampMap} ids=${ids}`,
            lightingGpuProgram(GpuProgram, source, 'l', faces, sunMap, lampMap, ids),
          );
          // E-205: the light tiles' texture at binding 8.
          const tiled = lightingSource(lighting, { faces, sunMap, selfShadow: true, lampMap, ids, tiles: true });
          assertLayoutDeclared(
            `lighting tiles faces=${faces} sunMap=${sunMap} lampMap=${lampMap} ids=${ids}`,
            lightTilesGpuProgram(GpuProgram, (G) => lightingGpuProgram(G, tiled, 'l', faces, sunMap, lampMap, ids)),
          );
        }
      }
    }
  }
});

test('the pixel depth programs with words, and their edge entries, declare every binding their layouts name', async () => {
  const { gbufAttributeWgsl } = await import('../../src/render/faceMap.js');
  const sprite = gbufAttributeWgsl(shader('instancedSprite.wgsl'));
  for (const entry of ['mainFrag', 'mainFragEdge']) {
    assertLayoutDeclared(`sprite-depth-gbuf ${entry}`, instancedSpriteGpuProgram(GpuProgram, pixelDepthWgsl(sprite, { gbuf: true }), entry, 's', { maps: true }));
    assertLayoutDeclared(
      `sprite-indexed-depth-gbuf ${entry}`,
      instancedSpriteIndexedGpuProgram(GpuProgram, pixelDepthWgsl(spriteIndexedWgsl(sprite), { poseAlpha: true, gbuf: true }), entry, 'i', { maps: true }),
    );
  }
});
