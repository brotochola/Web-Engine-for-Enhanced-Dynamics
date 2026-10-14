// Baseline for H-19: preRenderWorker BEFORE the per-entity loop-invariant hoist.
//
// Same rule as the other baseline generators: a baseline has to be CHECKED, and
// a content check is not a validity check. The reversal here is two hunks, and
// the interesting failure mode is a reversal that is *nearly* right - a baseline
// that still hoists one of the two loops would measure a different change than
// the one claimed, and produce a neutral result that looks like evidence.

import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src/workers/preRenderWorker.js';
const OUT = 'tests/results/hyp-baselines/H19.preRenderWorker.unhoisted.js';

// CRLF in the tree, LF in the needles. Normalise explicitly rather than letting
// the guard fail with "found 0" for the right reason at the wrong cause.
const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

let out = source;

function mustHave(hay, needle, what) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) throw new Error(`${what}: expected exactly 1 occurrence, found ${n}`);
}
function mustNotHave(hay, needle, what) {
  if (hay.includes(needle)) throw new Error(`${what}: the baseline would still contain it`);
}

// --- hunk 1: collectVisibleEntities ----------------------------------------
const H1_NEW = `        // H-19. Everything hoisted out of the per-entity loop below.`;
const H1_NEW_FULL = source.slice(
  source.indexOf(H1_NEW),
  source.indexOf('        this.visibleEntitiesCount += visibleCount;') +
    '        this.visibleEntitiesCount += visibleCount;'.length,
);

const H1_OLD = `        for (let idx = 0; idx < iterCount; idx++) {
            const i = iterSource ? iterSource[idx] : idx;
            if (!active[i]) continue;
            if (!spriteRendererActive || !spriteRendererActive[i]) continue;

            if (!this.skipCull) {
                const sx = x[i] * camZoom - cameraOffsetX;
                const sy = y[i] * camZoom - cameraOffsetY;

                // Use cached bounds (updated on scale/animation change)
                let halfExtent = 0;
                if (boundsHalfW) {
                    const halfW = boundsHalfW[i] || 0;
                    const halfH = boundsHalfH ? (boundsHalfH[i] || 0) : 0;
                    if (halfW > halfH) halfExtent = halfW;
                    else if (halfH > 0) halfExtent = halfH;
                }
                if (halfExtent <= 0 && visualRange) halfExtent = visualRange[i] || 0;
                const extent = halfExtent * camZoom;
                const onScreen = sx >= screenMinX - extent && sx <= screenMaxX + extent &&
                    sy >= screenMinY - extent && sy <= screenMaxY + extent;
                if (!onScreen) continue;
            }

            // sheetId 0 = unset (spawn reset / pool recycle). Never queue.
            if (renderVisible[i] && spritesheetId && spritesheetId[i]) {
                this.collectRenderable(0, i, 0);
                this.visibleEntitiesCount++;
            }
            // Sun shadows are a second draw of this sprite. No shadow-queue row.
        }`;

mustHave(out, H1_NEW_FULL, 'hunk 1 (collect hoist + counter)');
out = out.replace(H1_NEW_FULL, H1_OLD);

// --- hunk 2: _collectEntityGlow --------------------------------------------
const H2_NEW = `                const skipCull = this.skipCull;
                const glowHalfW = SpriteRenderer.boundsHalfW;
                const glowHalfH = SpriteRenderer.boundsHalfH;`;
const H2_OLD_BODY = `                    if (!this.skipCull) {`;
const H2_NEW_BODY = `                    if (!skipCull) {`;
const H2_OLD_HALF = `                        const halfW = SpriteRenderer.boundsHalfW?.[i] ?? 0;
                        const halfH = SpriteRenderer.boundsHalfH?.[i] ?? 0;`;
const H2_NEW_HALF = `                        const halfW = glowHalfW ? (glowHalfW[i] ?? 0) : 0;
                        const halfH = glowHalfH ? (glowHalfH[i] ?? 0) : 0;`;

mustHave(out, H2_NEW, 'hunk 2a (glow hoists)');
mustHave(out, H2_NEW_BODY, 'hunk 2b (glow skipCull use)');
mustHave(out, H2_NEW_HALF, 'hunk 2c (glow half extents)');

out = out.replace(H2_NEW + '\n', '');
out = out.replace(H2_NEW_BODY, H2_OLD_BODY);
out = out.replace(H2_NEW_HALF, H2_OLD_HALF);

// Hunk 2's comment block is now orphaned above the removed declarations; drop it
// so the baseline is the real pre-change file rather than a comment about it.
out = out.replace(
  /                \/\/ H-19, same hoist as collectVisibleEntities[\s\S]*?per light, not just a truthiness test\.\n/,
  '',
);

// --- validity --------------------------------------------------------------
// Against CODE, not prose.
//
// The H-19 comments quote the removed lines verbatim (`SpriteRenderer.boundsHalfW?.[i]`,
// `this.visibleEntitiesCount++`) to explain what they replaced. A `mustHave` on the
// raw text therefore matches the comment rather than the code - and the orphan
// strip above removes the glow comment but not the one inside the entity loop.
// Counting the real code total is the check; matching a string that also appears
// in documentation is not.
const outCode = out.replace(/^\s*\/\/.*$/gm, '');

mustNotHave(outCode, 'H-19.', 'H-19 marker');
mustNotHave(outCode, 'const skipCull = this.skipCull;', 'skipCull hoist');
mustNotHave(outCode, 'glowHalfW', 'glow half-width hoist');
mustNotHave(outCode, 'visibleEntitiesCount += visibleCount', 'local counter');

mustHave(outCode, 'const halfW = SpriteRenderer.boundsHalfW?.[i] ?? 0;', 'original glow extent');
mustHave(outCode, 'SpriteRenderer.boundsHalfW?.[i]', 'original static property chain');

// Three cull branches, and only two of them were hoisted: the entity loop, the
// glow loop, and `collectVisibleAdobeAnimations` (untouched by H-19, and the
// `skipCull.test.js` expectation of 2 in the entity body + 1 in the adobe body
// agrees). A reversal that produced 2 would have silently rewritten the adobe
// collector's cull into the hoisted form.
//
// This is the third "expected exactly 1" in these generators that was wrong
// because the file has parallel loops with near-identical lines. Counting the
// real total is the check; guessing one is not.
const cullCount = out.split('if (!this.skipCull) {').length - 1;
if (cullCount !== 3) {
  throw new Error(
    `skipCull branches: expected 3 (entity + glow + adobe), found ${cullCount}. ` +
      'H-19 hoisted two of the three; the reversal must restore exactly those two.',
  );
}

// The per-element counter belongs to BOTH collectors - the entity loop H-19
// hoisted, and `collectVisibleAdobeAnimations` which H-19 never touched. So the
// pre-change file has exactly two, and the reversal must restore both. Asserting
// "one" would have accepted a baseline that dropped the adobe increment
// outright, which is a behaviour change masquerading as a baseline.
const counterCount = out.split('this.visibleEntitiesCount++;').length - 1;
if (counterCount !== 2) {
  throw new Error(
    `per-element counter: expected 2 (entity loop + adobe), found ${counterCount}. ` +
      'A reversal that drops the adobe increment is a behaviour change, not a baseline.',
  );
}

// Brace balance is the check that catches a half-reversed hunk.
const open = (out.match(/\{/g) || []).length;
const close = (out.match(/\}/g) || []).length;
if (open !== close) {
  throw new Error(`brace imbalance: ${open} open vs ${close} close - the reversal is partial`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

const delta = source.split('\n').length - out.split('\n').length;
console.log(`baseline written: ${OUT}`);
console.log(`  ${source.split('\n').length} -> ${out.split('\n').length} lines (${delta} removed)`);
console.log('  validity: no hoists, original per-element counter and cull branches restored,');
console.log('  glow static property chain restored, braces balanced.');