#!/usr/bin/env node
/**
 * The HLSL ANGLE makes of the light pass (E-406): builds the light pass's GLSL the way the engine does (faceMap.js
 * lightingSource, its variants by flag), compiles it in headed Chrome's WebGL2 (ANGLE on D3D11) with a trivial vertex
 * shader, and writes each variant's translated source (WEBGL_debug_shaders) to <out>/<variant>.hlsl, with its link
 * time. tests/bench/d3dShaderStats.ps1 then compiles those with the system's d3dcompiler_47 and reports instruction
 * slots, temp registers and texture fetches.
 *
 *   node tests/bench/angleHlslDump.mjs [--out dir] [--max-lights 16]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseArgs();
const out = path.resolve(String(args.out || path.join(repoRoot, 'tests/results/angle-hlsl')));
const maxLights = String(args['max-lights'] || 16);
const { lightingSource } = await import(pathToFileURL(path.join(repoRoot, 'src/render/faceMap.js')).href);
const frag = fs.readFileSync(path.join(repoRoot, 'src/shaders/lightingBasic.frag.glsl'), 'utf8');
const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
const full = (s) => (s.startsWith('#version') ? s : HEADER + s);
const VARIANTS = {
  plain: {},
  flat: { faces: false, sunMap: true, lampMap: true },
  light3d: { faces: true, sunMap: true, selfShadow: true, lampMap: true, ids: true },
  light3dPixelArt: { faces: true, sunMap: true, selfShadow: true, lampMap: true, ids: true, pixelArt: true },
  light3dNoLamps: { faces: true, sunMap: true, selfShadow: true, ids: true },
};
const VERT = '#version 300 es\nin vec2 aPosition;\nout vec2 vTextureCoord;\nvoid main() { vTextureCoord = aPosition; gl_Position = vec4(aPosition, 0.0, 1.0); }\n';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--mute-audio'] });
try {
  const page = await browser.newPage();
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for (const [name, flags] of Object.entries(VARIANTS)) {
    const src = full(lightingSource(frag, flags).replace(/MAX_LIGHTS/g, maxLights));
    const r = await page.evaluate(([vs, fs]) => {
      const gl = document.getElementById('c').getContext('webgl2');
      const dbg = gl.getExtension('WEBGL_debug_shaders');
      const mk = (type, s) => { const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
      const v = mk(gl.VERTEX_SHADER, vs);
      const f = mk(gl.FRAGMENT_SHADER, fs);
      const fragOk = gl.getShaderParameter(f, gl.COMPILE_STATUS);
      const p = gl.createProgram();
      gl.attachShader(p, v);
      gl.attachShader(p, f);
      const t0 = performance.now();
      gl.linkProgram(p);
      const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
      const linkMs = performance.now() - t0;
      return { fragOk, ok, linkMs: Math.round(linkMs), log: fragOk ? '' : gl.getShaderInfoLog(f), hlsl: dbg ? dbg.getTranslatedShaderSource(f) : null };
    }, [VERT, src]);
    if (r.hlsl) fs.writeFileSync(path.join(out, `${name}.hlsl`), r.hlsl);
    fs.writeFileSync(path.join(out, `${name}.glsl`), src);
    console.log(`${name}: compile ${r.fragOk ? 'ok' : 'FAILED'}, link ${r.ok ? 'ok' : 'FAILED'} in ${r.linkMs} ms, HLSL ${r.hlsl ? `${r.hlsl.length} chars` : 'unavailable'}${r.log ? `\n${r.log}` : ''}`);
  }
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
