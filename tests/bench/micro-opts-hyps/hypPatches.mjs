/**
 * Isolate each more_micro_opts runtime change on top of main (0695a8d).
 *
 * Snapshots come from `git show`, never from a dirty working tree.
 * Exclusive files overlay HEAD; mixed files get surgical transforms so
 * hyps do not drag siblings along (logicWorker = COLLIDE/TICK/ECB/HYGIENE).
 *
 * Dropped hyps (AABB/PACT/BULLET/LIGHT/VP/TICK/ECB) are historical A/B
 * patches only — they are NOT present in the merge-ready tree after the
 * 2026-09-16 pre-merge strip. Do not treat applyHyp('TICK') as “current src”.
 *
 * Always call restoreHead() in a finally so main is not left checked out.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const MAIN_REV = '0695a8d';
export const HEAD_REV = 'HEAD';

export const SRC_FILES = [
  'src/box2d/box2dQueryAabb.js',
  'src/box2d/box2dQueryAabbImpl.js',
  'src/box2d/physicsHostImpl.js',
  'src/box2d/weedjsPost.js',
  'src/core/bulletPool.js',
  'src/core/flash.js',
  'src/core/gameEngine.js',
  'src/core/gameObject.js',
  'src/core/navGrid.js',
  'src/core/particleEmitter.js',
  'src/core/querySystem.js',
  'src/core/scene.js',
  'src/core/sharedAtomicPool.js',
  'src/core/soundManager.js',
  'src/core/spriteSheetRegistry.js',
  'src/util/atomicFreeList.js',
  'src/util/configDefaults.js',
  'src/util/debugLog.js',
  'src/util/sceneSharedBuffers.js',
  'src/util/sceneWorkerBootstrap.js',
  'src/util/utils.js',
  'src/util/workersUtils.js',
  'src/workers/abstractWorker.js',
  'src/workers/logicWorker.js',
  'src/workers/particleWorker.js',
  'src/workers/pixiWorker.js',
  'src/workers/preRenderWorker.js',
  'src/workers/spatialWorker.js',
];

export const CANONICAL_ORDER = [
  'HYGIENE',
  'COLLIDE',
  'AABB',
  'P2',
  'P6',
  'PACT',
  'BULLET',
  'LIGHT',
  'VP',
  'TICK',
  'ECB',
  'HASH',
];

/** L3 scene keys; L2 only when Balls/Predator cannot see the hyp (or ECB weak). */
export const HYP_CATALOG = [
  {
    id: 'HYGIENE',
    kind: 'hygiene',
    l3: ['balls', 'predator'],
    l2: [],
    l1: [],
    detailedStats: false,
    primary: { balls: 'logic0_STEP_MS', predator: 'logic0_STEP_MS' },
  },
  {
    id: 'COLLIDE',
    kind: 'bugfix',
    l3: ['balls', 'predator'],
    l2: [],
    l1: [],
    detailedStats: false,
    primary: { balls: 'logic0_STEP_MS', predator: 'logic0_STEP_MS' },
  },
  {
    id: 'AABB',
    kind: 'speed',
    l3: [],
    l2: ['queryAabb'],
    l1: [],
    detailedStats: false,
    primary: { queryAabb: 'physics_STEP_MS' },
  },
  {
    id: 'P2',
    kind: 'speed',
    l3: ['predator'],
    l2: [],
    l1: ['emit'],
    detailedStats: false,
    primary: { predator: 'particle_STEP_MS', emit: 'emitFlat_ops' },
  },
  {
    id: 'P6',
    kind: 'speed',
    l3: ['predator'],
    l2: [],
    l1: ['emit', 'treiber'],
    detailedStats: false,
    primary: { predator: 'particle_STEP_MS', emit: 'emitFlat_ops', treiber: 'batchPop_ops' },
  },
  {
    id: 'PACT',
    kind: 'speed',
    l3: ['predator'],
    l2: [],
    l1: ['integrate'],
    detailedStats: true,
    primary: { predator: 'PARTICLE_PHYSICS_MS' },
    secondary: { predator: 'BUILD_ACTIVE_VISIBLE_MS' },
  },
  {
    id: 'BULLET',
    kind: 'speed',
    l3: ['predator'],
    l2: [],
    l1: [],
    detailedStats: false,
    primary: { predator: 'particle_STEP_MS' },
  },
  {
    id: 'LIGHT',
    kind: 'speed',
    l3: ['predator'],
    l2: [],
    l1: [],
    detailedStats: true,
    primary: { predator: 'pixi_STEP_MS' },
    secondary: { predator: 'LIGHTS_MS' },
  },
  {
    id: 'VP',
    kind: 'speed',
    l3: [],
    l2: ['zenithal'],
    l1: [],
    detailedStats: true,
    primary: { zenithal: 'VISIBILITY_MS' },
    secondary: { zenithal: 'preRender_STEP_MS' },
  },
  {
    id: 'TICK',
    kind: 'speed',
    l3: ['balls', 'predator'],
    l2: [],
    l1: [],
    detailedStats: false,
    primary: { balls: 'logic0_STEP_MS', predator: 'logic0_STEP_MS' },
  },
  {
    id: 'ECB',
    kind: 'speed',
    l3: ['balls', 'predator'],
    l2: ['spawnStorm', 'queryChurn'],
    l1: [],
    detailedStats: false,
    primary: { balls: 'logic0_STEP_MS', predator: 'logic0_STEP_MS', spawnStorm: 'logic0_STEP_MS', queryChurn: 'logic0_STEP_MS' },
  },
  {
    id: 'HASH',
    kind: 'speed',
    l3: ['balls', 'predator'],
    l2: [],
    l1: ['spatial'],
    detailedStats: false,
    primary: { balls: 'spatialMax_STEP_MS', predator: 'spatialMax_STEP_MS' },
    secondary: { balls: 'spatialMax_NEIGHBOR_MS', predator: 'spatialMax_NEIGHBOR_MS' },
  },
];

export const STACK_META = {
  id: 'STACK',
  kind: 'stack',
  l3: ['balls', 'predator'],
  l2: [],
  l1: [],
  detailedStats: false,
  primary: {
    balls: 'physics_STEP_MS',
    predator: 'particle_STEP_MS',
  },
};

function gitShowRaw(rev, relPath) {
  try {
    return execFileSync('git', ['show', `${rev}:${relPath.replace(/\\/g, '/')}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function gitShow(rev, relPath) {
  const raw = gitShowRaw(rev, relPath);
  return raw == null ? null : raw.replace(/\r\n/g, '\n');
}

function abs(relPath) {
  return path.join(repoRoot, relPath);
}

function writeRel(relPath, contents) {
  const filePath = abs(relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const headRaw = gitShowRaw(HEAD_REV, relPath);
  const eol = headRaw && headRaw.includes('\r\n') ? '\r\n' : '\n';
  const body = contents.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  fs.writeFileSync(filePath, body);
}

function readRel(relPath) {
  return fs.readFileSync(abs(relPath), 'utf8').replace(/\r\n/g, '\n');
}

function mustInclude(src, needle, hyp) {
  if (!src.includes(needle)) {
    throw new Error(`${hyp}: patch anchor missing: ${needle.slice(0, 120)}`);
  }
}

function replaceOnce(src, from, to, hyp) {
  mustInclude(src, from, hyp);
  const out = src.replace(from, to);
  if (out === src) throw new Error(`${hyp}: replace had no effect`);
  return out;
}

function replaceOneOf(src, pairs, hyp) {
  for (const [from, to] of pairs) {
    if (src.includes(from)) return replaceOnce(src, from, to, hyp);
  }
  throw new Error(`${hyp}: no variant matched (${pairs[0][0].slice(0, 80)})`);
}

function insertOnce(src, after, insert, hyp) {
  if (src.includes(insert.trim())) return src;
  return replaceOnce(src, after, after + insert, hyp);
}

function overlayHead(relPaths) {
  for (const rel of relPaths) {
    const text = gitShow(HEAD_REV, rel);
    if (text == null) throw new Error(`HEAD missing ${rel}`);
    writeRel(rel, text);
  }
}

function patchRel(relPath, fn, hyp) {
  writeRel(relPath, fn(readRel(relPath), hyp));
}

export function restoreMain() {
  for (const rel of SRC_FILES) {
    const text = gitShow(MAIN_REV, rel);
    if (text == null) {
      const filePath = abs(rel);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      writeRel(rel, text);
    }
  }
}

export function restoreHead() {
  execFileSync('git', ['checkout', 'HEAD', '--', ...SRC_FILES], { cwd: repoRoot, stdio: 'pipe' });
}

export function applyStack() {
  overlayHead(SRC_FILES.filter((rel) => gitShow(HEAD_REV, rel) != null));
}

function ensureImportAfter(src, afterImport, statement) {
  if (src.includes(statement.trim())) return src;
  mustInclude(src, afterImport, 'import');
  return src.replace(afterImport, `${afterImport}\n${statement}`);
}

function replaceConsoleLog(src) {
  return src.replaceAll('console.log', 'debugWorkerLog');
}

function hygieneExclusive() {
  overlayHead([
    'src/util/debugLog.js',
    'src/util/configDefaults.js',
    'src/core/flash.js',
    'src/core/gameEngine.js',
    'src/core/navGrid.js',
    'src/core/querySystem.js',
    'src/core/soundManager.js',
    'src/core/spriteSheetRegistry.js',
    'src/util/workersUtils.js',
    'src/box2d/physicsHostImpl.js',
  ]);
}

function applyHygiene() {
  hygieneExclusive();

  patchRel(
    'src/workers/abstractWorker.js',
    (src, hyp) => {
      let out = ensureImportAfter(
        src,
        `import { createWorkerQueryFunctions } from '../core/querySystem.js';`,
        `import { setVerboseWorkers, installQuietConsoleLog } from '../util/debugLog.js';`
      );
      out = replaceOnce(
        out,
        'const shouldProfileMessages = !!this.stats;',
        'const shouldProfileMessages = !!this.collectDetailedStats;',
        hyp
      );
      out = replaceOnce(
        out,
        `    this.collectDetailedStats = !!(this.config.debug?.collectDetailedStats);\n    Ray.collectDetailedStats = this.collectDetailedStats;`,
        `    this.collectDetailedStats = !!(this.config.debug?.collectDetailedStats);\n    setVerboseWorkers(!!this.config.debug?.verboseWorkers);\n    installQuietConsoleLog();\n    Ray.collectDetailedStats = this.collectDetailedStats;`,
        hyp
      );
      return out;
    },
    'HYGIENE'
  );

  patchRel(
    'src/core/scene.js',
    (src, hyp) => {
      let out = ensureImportAfter(
        src,
        `} from '../util/configDefaults.js';`,
        `import { setVerboseWorkers, debugWorkerLog } from '../util/debugLog.js';`
      );
      out = insertOnce(
        out,
        `    this.config.debug = {\n      ...DEBUG_DEFAULTS,\n      ...(this.config.debug || {}),\n    };\n`,
        `\n    setVerboseWorkers(!!this.config.debug.verboseWorkers);\n`,
        hyp
      );
      return replaceConsoleLog(out);
    },
    'HYGIENE'
  );

  patchRel(
    'src/util/utils.js',
    (src, hyp) => {
      let out = ensureImportAfter(
        src,
        `import { GameObject } from '../core/gameObject.js';`,
        `import { debugWorkerLog } from './debugLog.js';`
      );
      return replaceConsoleLog(out);
    },
    'HYGIENE'
  );

  patchRel(
    'src/util/sceneSharedBuffers.js',
    (src) => {
      let out = src;
      if (!out.includes("from './debugLog.js'")) {
        out = `import { debugWorkerLog } from './debugLog.js';\n` + out;
      }
      return replaceConsoleLog(out);
    },
    'HYGIENE'
  );

  patchRel(
    'src/util/sceneWorkerBootstrap.js',
    (src, hyp) => {
      let out = ensureImportAfter(
        src,
        `import { getPortTransferables, postWorkerInitMessage } from './utils.js';`,
        `import { debugWorkerLog } from './debugLog.js';`
      );
      return replaceConsoleLog(out);
    },
    'HYGIENE'
  );

  patchRel(
    'src/core/sharedAtomicPool.js',
    (src, hyp) => {
      let out = src;
      if (!out.includes("from '../util/debugLog.js'")) {
        out = replaceOnce(
          out,
          `} from '../util/atomicFreeList.js';\n`,
          `} from '../util/atomicFreeList.js';\nimport { debugWorkerLog } from '../util/debugLog.js';\n`,
          hyp
        );
      }
      return replaceConsoleLog(out);
    },
    'HYGIENE'
  );

  patchRel(
    'src/workers/logicWorker.js',
    (src, hyp) => {
      let out = insertOnce(
        src,
        `    this.frameStartTime = 0; // For timing diagnostics\n`,
        `    this.queryPublishMsThisFrame = 0;\n`,
        hyp
      );
      out = replaceOnce(
        out,
        `    if (activeQueryPopulationChanged && this._publishPrecomputedActiveQueries) {\n      this._publishPrecomputedActiveQueries(this.frameNumber);\n    }`,
        `    if (activeQueryPopulationChanged && this._publishPrecomputedActiveQueries) {\n      if (this.collectDetailedStats) {\n        const t0 = performance.now();\n        this._publishPrecomputedActiveQueries(this.frameNumber);\n        this.queryPublishMsThisFrame += performance.now() - t0;\n      } else {\n        this._publishPrecomputedActiveQueries(this.frameNumber);\n      }\n    }`,
        hyp
      );
      out = replaceOnce(
        out,
        `    this.frameStartTime = performance.now();\n    this._latchDisplayPose();`,
        `    if (this.collectDetailedStats) this.frameStartTime = performance.now();\n    this._latchDisplayPose();`,
        hyp
      );
      out = replaceOnce(
        out,
        `    this.tickMsThisFrame = 0;\n    if (this.collectDetailedStats) Ray.beginFrame();`,
        `    this.tickMsThisFrame = 0;\n    this.queryPublishMsThisFrame = 0;\n    if (this.collectDetailedStats) Ray.beginFrame();`,
        hyp
      );
      out = replaceOnce(
        out,
        `    this.stats[LOGIC_STATS.TICK_MS] = this.tickMsThisFrame || 0;\n  }`,
        `    this.stats[LOGIC_STATS.TICK_MS] = this.tickMsThisFrame || 0;\n    this.stats[LOGIC_STATS.QUERY_PUBLISH_MS] = this.queryPublishMsThisFrame || 0;\n  }`,
        hyp
      );
      return out;
    },
    'HYGIENE'
  );
}

function applyCollide() {
  patchRel(
    'src/util/utils.js',
    (src, hyp) => {
      if (src.includes('export function collisionPairKey')) return src;
      return replaceOnce(
        src,
        `export function cantorPair(a, b) {
  return ((a + b) * (a + b + 1)) / 2 + b;
}
`,
        `export function cantorPair(a, b) {
  return ((a + b) * (a + b + 1)) / 2 + b;
}

/**
 * Unordered pair key for entity indices < 65536.
 * Same packing as logicWorker contact drain / isCollidingWith.
 */
export function collisionPairKey(minE, maxE) {
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

export function collisionPairUnpack(key, out) {
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}
`,
        hyp
      );
    },
    'COLLIDE'
  );

  patchRel(
    'src/core/gameObject.js',
    (src, hyp) => {
      let out = replaceOnce(
        src,
        `import { collectComponents, cantorPair, distanceSq2D } from '../util/utils.js';`,
        `import { collectComponents, collisionPairKey, distanceSq2D } from '../util/utils.js';`,
        hyp
      );
      out = replaceOnce(
        out,
        `    const key = cantorPair(minE, maxE);`,
        `    const key = collisionPairKey(minE, maxE);`,
        hyp
      );
      if (out.includes('Cantor pairing is order-sensitive')) {
        out = out.replace(
          `    // Collision keys are stored ONCE per pair, normalized as (min, max).\n    // Cantor pairing is order-sensitive, so normalize before keying.\n`,
          `    // Collision keys are stored ONCE per pair, normalized as (min, max).\n`
        );
      }
      return out;
    },
    'COLLIDE'
  );
}

function applyAabb() {
  overlayHead([
    'src/box2d/box2dQueryAabb.js',
    'src/box2d/box2dQueryAabbImpl.js',
    'src/box2d/weedjsPost.js',
  ]);
}

function applyP2() {
  patchRel(
    'src/core/particleEmitter.js',
    (src, hyp) => {
      let out = src;
      if (!out.includes('_cfgFieldList')) {
        out = replaceOnce(
          out,
          `  static _cfgScratch = Object.create(null);\n`,
          `  static _cfgScratch = Object.create(null);
  static _cfgFieldList = [
    'count', 'flat', 'viewMode', 'texture', 'spritesheet', 'animation', 'frame',
    'x', 'y', 'z', 'dirX', 'dirY', 'speed', 'spread', 'angleXY',
    'vx', 'vy', 'vz', 'lifespan', 'gravity',
    'scale', 'scaleX', 'scaleY', 'alpha', 'tint',
    'rotC', 'rotS', 'rotation', 'flipX', 'flipY',
    'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact',
    'blendMode', 'layerId',
  ];
`,
          hyp
        );
      }
      out = replaceOnce(
        out,
        `  /** Merge config + overrides into reusable scratch (clears stale keys). */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    for (const k in s) delete s[k];
    for (const k in config) s[k] = config[k];
    for (const k in modeOverrides) s[k] = modeOverrides[k];
    return s;
  }`,
        `  /**
   * Merge config + overrides into reusable scratch (stable shape — see _cfgFieldList).
   * Assign each known field instead of delete-all + for-in (V8 dictionary mode).
   */
  static _mergeCfg(config, modeOverrides) {
    const s = this._cfgScratch;
    const fields = this._cfgFieldList;
    for (let f = 0; f < fields.length; f++) {
      const k = fields[f];
      s[k] = config[k];
    }
    if (modeOverrides) {
      for (const k in modeOverrides) s[k] = modeOverrides[k];
    }
    return s;
  }`,
        hyp
      );
      return out;
    },
    'P2'
  );
}

function applyP6() {
  overlayHead(['src/util/atomicFreeList.js']);
  patchRel(
    'src/core/sharedAtomicPool.js',
    (src, hyp) => {
      let out = src;
      if (!out.includes('popFreeIndices')) {
        out = replaceOnce(
          out,
          `  popFreeIndex,
  pushFreeIndex,`,
          `  popFreeIndex,
  popFreeIndices,
  pushFreeIndex,`,
          hyp
        );
      }
      if (!out.includes('static acquireIndices')) {
        out = replaceOnce(
          out,
          `        return popFreeIndex(this.freeListTop, this.freeList);
    }

    /**
     * Return an index to the free list (called when items die/despawn)`,
          `        return popFreeIndex(this.freeListTop, this.freeList);
    }

    /**
     * Batch acquire. Returns how many indices were written into outArray.
     */
    static acquireIndices(maxToPop, outArray, outOffset = 0) {
        if (!this.initialized || !this.freeList || !this.freeListTop || maxToPop <= 0) {
            return 0;
        }
        return popFreeIndices(this.freeListTop, this.freeList, maxToPop, outArray, outOffset);
    }

    /**
     * Return an index to the free list (called when items die/despawn)`,
          hyp
        );
      }
      return out;
    },
    'P6'
  );

  patchRel(
    'src/core/particleEmitter.js',
    (src, hyp) => {
      let out = src;
      if (!out.includes('_acquireBatch')) {
        out = insertOnce(
          out,
          `  static _cfgScratch = Object.create(null);\n`,
          `  static _acquireBatch = new Uint16Array(256);\n`,
          hyp
        );
      }
      out = replaceOnce(
        out,
        `    while (spawned < count) {
      const i = this.acquireIndex();
      if (i < 0) {
        break;
      }

      x[i] = randomRange(cfg.x);`,
        `    while (spawned < count) {
      const want = Math.min(count - spawned, this._acquireBatch.length);
      const got = this.acquireIndices(want, this._acquireBatch, 0);
      if (got <= 0) {
        break;
      }
      for (let b = 0; b < got; b++) {
      const i = this._acquireBatch[b];

      x[i] = randomRange(cfg.x);`,
        hyp
      );
      out = replaceOnce(
        out,
        `      spawned++;
    }

    if (spawned < count && !this._warnedPoolExhausted) {`,
        `      spawned++;
      }
    }

    if (spawned < count && !this._warnedPoolExhausted) {`,
        hyp
      );
      return out;
    },
    'P6'
  );
}

function applyPact() {
  patchRel(
    'src/workers/particleWorker.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `    const expectedActive = maxParticles;`,
        `    const live = ParticleEmitter.getActiveCount();
    const expectedActive = live <= 0 ? maxParticles : Math.min(maxParticles, live + 32);`,
        hyp
      ),
    'PACT'
  );
}

function applyBullet() {
  overlayHead(['src/core/bulletPool.js']);
  patchRel(
    'src/workers/abstractWorker.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `      if (data.activeBulletsData) {
        this.activeBulletsData = new Uint16Array(data.activeBulletsData);
      }`,
        `      if (data.activeBulletsData) {
        this.activeBulletsData = new Uint16Array(data.activeBulletsData);
        BulletPool.initializeActiveList(data.activeBulletsData, data.activeBulletsLock || null);
      }`,
        hyp
      ),
    'BULLET'
  );
  patchRel(
    'src/util/sceneSharedBuffers.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `  createCompactUint16ListPair(buffers, 'activeBulletsData', 'visibleBulletsData', maxBullets);

  // Header:`,
        `  createCompactUint16ListPair(buffers, 'activeBulletsData', 'visibleBulletsData', maxBullets);
  buffers.activeBulletsLock = new SharedArrayBuffer(4);
  BulletPool.initializeActiveList(buffers.activeBulletsData, buffers.activeBulletsLock);

  // Header:`,
        hyp
      ),
    'BULLET'
  );
  patchRel(
    'src/util/sceneWorkerBootstrap.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `    activeBulletsData: scene.buffers.activeBulletsData || null,
    visibleBulletsData: scene.buffers.visibleBulletsData || null,`,
        `    activeBulletsData: scene.buffers.activeBulletsData || null,
    activeBulletsLock: scene.buffers.activeBulletsLock || null,
    visibleBulletsData: scene.buffers.visibleBulletsData || null,`,
        hyp
      ),
    'BULLET'
  );
  patchRel(
    'src/workers/particleWorker.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `    let activeWrite = 1;
    let impactWrite = 0;
    const maxImpacts = this._maxImpactsPerFrame;

    for (let i = 0; i < maxBullets; i++) {
      if (!active[i]) continue;`,
        `    let impactWrite = 0;
    const maxImpacts = this._maxImpactsPerFrame;
    const survivors = this._bulletSurvivors || (this._bulletSurvivors = new Uint16Array(maxBullets));
    let survivorCount = 0;

    if (!this._bulletScratch || this._bulletScratch.length < maxBullets) {
      this._bulletScratch = new Uint16Array(maxBullets);
    }
    const compactCount = BulletPool.activeBulletsData
      ? BulletPool.copyActiveSnapshot(this._bulletScratch)
      : 0;
    const useCompact = compactCount > 0 || (BulletPool.activeBulletsData && BulletPool.activeBulletsData[0] === 0);

    const iterCount = useCompact ? compactCount : maxBullets;
    for (let n = 0; n < iterCount; n++) {
      const i = useCompact ? this._bulletScratch[n] : n;
      if (!active[i]) continue;`,
        hyp
      ),
    'BULLET'
  );
  patchRel(
    'src/workers/particleWorker.js',
    (src, hyp) =>
      replaceOnce(
        src,
        `          active[i] = 0;
          BulletPool.returnToPool(i);
          continue;
        }
      }

      activeData[activeWrite++] = i;
    }

    activeData[0] = activeWrite - 1;`,
        `          BulletPool.despawn(i);
          continue;
        }
      }

      survivors[survivorCount++] = i;
    }

    if (!useCompact && activeData) {
      activeData[0] = survivorCount;
      for (let s = 0; s < survivorCount; s++) activeData[1 + s] = survivors[s];
    }`,
        hyp
      ),
    'BULLET'
  );
  patchRel(
    'src/workers/particleWorker.js',
    (src, hyp) => {
      let out = replaceOnce(
        src,
        `    if (activeWrite <= 1 || !this.cameraData || !visibleData) return;`,
        `    if (survivorCount <= 0 || !this.cameraData || !visibleData) return;`,
        hyp
      );
      return replaceOnce(
        out,
        `    let visibleCount = 0;
    const activeCount = activeWrite - 1;
    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[1 + idx];`,
        `    let visibleCount = 0;
    for (let idx = 0; idx < survivorCount; idx++) {
      const i = survivors[idx];`,
        hyp
      );
    },
    'BULLET'
  );
}

function applyLight() {
  overlayHead(['src/workers/pixiWorker.js']);
}

function applyVp() {
  overlayHead(['src/workers/preRenderWorker.js']);
}

function applyTick() {
  patchRel(
    'src/workers/logicWorker.js',
    (src, hyp) => {
      let out = replaceOnce(
        src,
        `            this.decimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              tickInterval,
              startIndex,
              needsScreenCallbacks,
            });`,
        `            this.decimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              tickInterval,
              startIndex,
              needsScreenCallbacks,
              tickFn: typeof EntityClass.prototype.tick === 'function'
                ? EntityClass.prototype.tick
                : null,
            });`,
        hyp
      );
      out = replaceOnce(
        out,
        `            this.nonDecimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              startIndex,
              needsScreenCallbacks,
            });`,
        `            this.nonDecimatedTypes.push({
              EntityClass,
              activeList: EntityClass._activeList,
              startIndex,
              needsScreenCallbacks,
              tickFn: typeof EntityClass.prototype.tick === 'function'
                ? EntityClass.prototype.tick
                : null,
            });`,
        hyp
      );
      out = replaceOnce(
        out,
        `        const obj = gameObjects[entityIndex];
        if (!obj || typeof obj.tick !== 'function') continue;

        activeCount++;
        this.entitiesProcessedThisFrame++;

        if (collectDetailed) {
          const tTick0 = performance.now();
          obj.tick(dtRatio, deltaTime, accTime, frameNum);
          tickMs += performance.now() - tTick0;
        } else {
          obj.tick(dtRatio, deltaTime, accTime, frameNum);
        }`,
        `        const obj = gameObjects[entityIndex];
        if (!obj) continue;
        const tickFn = typeInfo.tickFn && obj.tick === typeInfo.tickFn
          ? typeInfo.tickFn
          : obj.tick;
        if (typeof tickFn !== 'function') continue;

        activeCount++;
        this.entitiesProcessedThisFrame++;

        if (collectDetailed) {
          const tTick0 = performance.now();
          tickFn.call(obj, dtRatio, deltaTime, accTime, frameNum);
          tickMs += performance.now() - tTick0;
        } else {
          tickFn.call(obj, dtRatio, deltaTime, accTime, frameNum);
        }`,
        hyp
      );
      out = replaceOnce(
        out,
        `          const obj = gameObjects[entityIndex];
          if (!obj || typeof obj.tick !== 'function') continue;`,
        `          const obj = gameObjects[entityIndex];
          if (!obj) continue;
          const tickFn = typeInfo.tickFn && obj.tick === typeInfo.tickFn
            ? typeInfo.tickFn
            : obj.tick;
          if (typeof tickFn !== 'function') continue;`,
        hyp
      );
      out = replaceOnce(
        out,
        `          // Tick entity logic
          obj.tick(dtRatio, deltaTime, accTime, frameNum);`,
        `          // Tick entity logic
          tickFn.call(obj, dtRatio, deltaTime, accTime, frameNum);`,
        hyp
      );
      return out;
    },
    'TICK'
  );
}

function applyEcb() {
  patchRel(
    'src/core/scene.js',
    (src, hyp) => {
      let out = insertOnce(
        src,
        `    this.lastFrameTime = performance.now();\n`,
        `    this._pendingLogicSpawns = [];\n    this._pendingLogicDespawns = [];\n`,
        hyp
      );
      out = replaceOneOf(
        out,
        [
          [
            `    console.log(\`[Scene] ✅ All start messages sent\`);
  }`,
            `    console.log(\`[Scene] ✅ All start messages sent\`);
    this._flushLogicSpawnDespawn();
  }`,
          ],
          [
            `    debugWorkerLog(\`[Scene] ✅ All start messages sent\`);
  }`,
            `    debugWorkerLog(\`[Scene] ✅ All start messages sent\`);
    this._flushLogicSpawnDespawn();
  }`,
          ],
        ],
        hyp
      );
      out = replaceOnce(
        out,
        `    Mouse.snapshotPreviousFrame();
  }

  /**
   * Update sun day cycle if enabled`,
        `    Mouse.snapshotPreviousFrame();
    this._flushLogicSpawnDespawn();
  }

  _flushLogicSpawnDespawn() {
    const worker0 = this.workers.logicWorkers?.[0];
    const spawns = this._pendingLogicSpawns;
    const despawns = this._pendingLogicDespawns;
    if (!worker0 || (!spawns.length && !despawns.length)) return;
    worker0.postMessage({
      msg: 'spawnDespawnBatch',
      spawns,
      despawns,
    });
    this._pendingLogicSpawns = [];
    this._pendingLogicDespawns = [];
  }

  /**
   * Update sun day cycle if enabled`,
        hyp
      );
      out = replaceOnce(
        out,
        `    const worker0 = this.workers.logicWorkers?.[0];
    if (worker0) {
      worker0.postMessage({
        msg: 'spawn',
        className: className,
        spawnConfig: spawnConfig,
        entityIndex: entityIndex, // Pre-assigned index
      });
    }`,
        `    this._pendingLogicSpawns.push({
      className,
      spawnConfig,
      entityIndex,
    });`,
        hyp
      );
      out = replaceOnce(
        out,
        `  despawnEntity(entityIndex) {
    // Only worker 0 handles despawn messages
    const worker0 = this.workers.logicWorkers?.[0];
    if (worker0) {
      worker0.postMessage({
        msg: 'despawn',
        entityIndex: entityIndex,
      });
    }
  }`,
        `  despawnEntity(entityIndex) {
    this._pendingLogicDespawns.push(entityIndex);
  }`,
        hyp
      );
      return out;
    },
    'ECB'
  );

  patchRel(
    'src/workers/logicWorker.js',
    (src, hyp) => {
      let out = replaceOnce(
        src,
        `      case 'spawn': {
        // Only worker 0 handles spawn messages to avoid race conditions
        // All workers receive the broadcast, but only worker 0 actually spawns
        if (this.workerIndex !== 0) {
          break; // Ignore spawn messages on other workers
        }

        const { className, spawnConfig, entityIndex } = data;
        const EntityClass = self[className];

        if (!EntityClass) {
          console.error(
            \`LOGIC WORKER \${this.workerIndex}: Cannot spawn \${className} - class not found!\`
          );
          return;
        }

        // If entityIndex is provided, use pre-assigned index from main thread
        // Otherwise, let GameObject.spawn acquire a new index
        const instance = GameObject.spawn(EntityClass, spawnConfig, entityIndex);
        if (!instance) {
          console.warn(
            \`LOGIC WORKER \${this.workerIndex}: Failed to spawn \${className} - pool exhausted!\`
          );
        }
        break;
      }

      case 'despawn': {
        // Only worker 0 handles despawn messages from main thread
        if (this.workerIndex !== 0) {
          break;
        }

        const { entityIndex } = data;

        // Basic validation
        if (entityIndex < 0 || entityIndex >= this.globalEntityCount) {
          break;
        }

        // Get the instance and despawn it
        // Note: despawn() internally checks Transform.active to prevent double-despawn
        const instance = this.gameObjects[entityIndex];
        if (instance && instance.despawn) {
          instance.despawn();
        }
        break;
      }`,
        `      case 'spawnDespawnBatch': {
        if (this.workerIndex !== 0) break;
        const batchDespawns = data.despawns || [];
        for (let i = 0; i < batchDespawns.length; i++) {
          this._mainThreadDespawn(batchDespawns[i]);
        }
        const batchSpawns = data.spawns || [];
        for (let i = 0; i < batchSpawns.length; i++) {
          this._mainThreadSpawn(batchSpawns[i]);
        }
        break;
      }
      case 'spawn': {
        if (this.workerIndex !== 0) break;
        this._mainThreadSpawn(data);
        break;
      }

      case 'despawn': {
        if (this.workerIndex !== 0) break;
        this._mainThreadDespawn(data.entityIndex);
        break;
      }`,
        hyp
      );
      if (!out.includes('_mainThreadSpawn(entry)')) {
        out = replaceOnce(
          out,
          `  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */`,
          `  _mainThreadSpawn(entry) {
    const className = entry.className;
    const spawnConfig = entry.spawnConfig;
    const entityIndex = entry.entityIndex;
    const EntityClass = self[className];
    if (!EntityClass) {
      console.error(
        \`LOGIC WORKER \${this.workerIndex}: Cannot spawn \${className} - class not found!\`
      );
      return;
    }
    const instance = GameObject.spawn(EntityClass, spawnConfig, entityIndex);
    if (!instance) {
      console.warn(
        \`LOGIC WORKER \${this.workerIndex}: Failed to spawn \${className} - pool exhausted!\`
      );
    }
  }

  _mainThreadDespawn(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this.globalEntityCount) return;
    const instance = this.gameObjects[entityIndex];
    if (instance && instance.despawn) instance.despawn();
  }

  /**
   * Override reportFPS to write stats to SharedArrayBuffer
   */`,
          hyp
        );
      }
      return out;
    },
    'ECB'
  );
}

function applyHash() {
  overlayHead(['src/workers/spatialWorker.js']);
}

const TRANSFORMS = {
  HYGIENE: applyHygiene,
  COLLIDE: applyCollide,
  AABB: applyAabb,
  P2: applyP2,
  P6: applyP6,
  PACT: applyPact,
  BULLET: applyBullet,
  LIGHT: applyLight,
  VP: applyVp,
  TICK: applyTick,
  ECB: applyEcb,
  HASH: applyHash,
};

export function applyHyp(id, { reset = true } = {}) {
  if (id === 'BASE') {
    if (reset) restoreMain();
    return;
  }
  if (id === 'STACK') {
    if (reset) restoreMain();
    applyStack();
    return;
  }
  const fn = TRANSFORMS[id];
  if (!fn) throw new Error(`Unknown hyp ${id}`);
  if (reset) restoreMain();
  fn();
}

export function applyKeepIds(ids) {
  restoreMain();
  const set = new Set(ids);
  for (const id of CANONICAL_ORDER) {
    if (set.has(id)) applyHyp(id, { reset: false });
  }
}

export function hypTouchedFiles(id) {
  if (id === 'STACK' || id === 'BASE') return SRC_FILES.filter((rel) => fs.existsSync(abs(rel)));
  applyHyp(id, { reset: true });
  return SRC_FILES.filter((rel) => fs.existsSync(abs(rel)));
}

/**
 * Publish load counts on a main-shaped tree without turning on sub-timers.
 * Safe to call on a tree that already writes counts (no-op).
 */
export function applyWorkloadCounts() {
  patchRel(
    'src/box2d/weedjsPost.js',
    (src) => {
      if (src.includes('if (!statsF32) return;\n    statsF32[PS.BODY_COUNT] = denseCount;')) {
        return src;
      }
      let out = src;
      if (!out.includes('writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);')) {
        out = replaceOnce(
          out,
          `      maybePublishPose(entityCount);
      afterStep();
      return;
    }
    const t0 = performance.now();`,
          `      maybePublishPose(entityCount);
      afterStep();
      writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);
      return;
    }
    const t0 = performance.now();`,
          'COUNTS'
        );
      }
      return replaceOnce(
        out,
        `    if (!statsF32 || !collectDetailedStats) return;
    statsF32[PS.BODY_COUNT] = denseCount;`,
        `    if (!statsF32) return;
    statsF32[PS.BODY_COUNT] = denseCount;
    const movedViewsEarly =
      typeof Box2dMovedBodies !== 'undefined' && Box2dMovedBodies.getMovedBodiesViews
        ? Box2dMovedBodies.getMovedBodiesViews()
        : null;
    statsF32[PS.BODY_MOVED_COUNT] = movedViewsEarly ? movedViewsEarly.count | 0 : 0;
    if (world && typeof world._getAwakeBodyCount === 'function') {
      statsF32[PS.AWAKE_COUNT] = world._getAwakeBodyCount(world.worldId) | 0;
    } else {
      statsF32[PS.AWAKE_COUNT] = 0;
    }
    if (typeof weedjsHeapBytesUsed === 'function') {
      const usedKbEarly = ((weedjsHeapBytesUsed() | 0) / 1024) | 0;
      if (usedKbEarly > heapHighWaterKb) heapHighWaterKb = usedKbEarly;
      statsF32[PS.HEAP_USED_KB] = usedKbEarly;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    } else {
      statsF32[PS.HEAP_USED_KB] = 0;
      statsF32[PS.HEAP_HIGH_WATER_KB] = heapHighWaterKb;
    }
    if (!collectDetailedStats) return;`,
        'COUNTS'
      );
    },
    'COUNTS'
  );
  patchRel(
    'src/workers/particleWorker.js',
    (src) => {
      if (
        src.includes('this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;\n    if (!this.collectDetailedStats) return;')
      ) {
        return src;
      }
      if (
        src.includes('this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;\n    if (!this.collectDetailedStats) return;')
      ) {
        return src.replace(
          `    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    if (!this.collectDetailedStats) return;`,
          `    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    if (!this.collectDetailedStats) return;`
        );
      }
      return replaceOnce(
        src,
        `    this.stats[PARTICLE_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;`,
        `    this.stats[PARTICLE_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    if (!this.collectDetailedStats) return;`,
        'COUNTS'
      );
    },
    'COUNTS'
  );
  patchRel(
    'src/workers/logicWorker.js',
    (src) => {
      if (
        src.includes('this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;\n    if (!this.collectDetailedStats) return;')
      ) {
        return src;
      }
      return replaceOnce(
        src,
        `    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;`,
        `    this.stats[LOGIC_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[LOGIC_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;
    if (!this.collectDetailedStats) return;`,
        'COUNTS'
      );
    },
    'COUNTS'
  );
  patchRel(
    'src/workers/spatialWorker.js',
    (src) => {
      if (
        src.includes('this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;\n    if (!this.collectDetailedStats) return;')
      ) {
        return src;
      }
      return replaceOnce(
        src,
        `    this.stats[SPATIAL_STATS.STEP_MS] = this.stepTimeThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[SPATIAL_STATS.ENTITIES_PROCESSED] = this.entitiesProcessedThisFrame;`,
        `    this.stats[SPATIAL_STATS.STEP_MS] = this.stepTimeThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    if (!this.collectDetailedStats) return;`,
        'COUNTS'
      );
    },
    'COUNTS'
  );
  patchRel(
    'src/workers/spatialWorker.js',
    (src) => {
      const dup = `    this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[SPATIAL_STATS.NEIGHBORS_REUSED] = this.neighborsReusedThisFrame;
    this.stats[SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS] = this.sleepNeighborSkipsThisFrame;`;
      if (!src.includes(dup)) return src;
      return replaceOnce(
        src,
        dup,
        `    this.stats[SPATIAL_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[SPATIAL_STATS.SLEEP_NEIGHBOR_SKIPS] = this.sleepNeighborSkipsThisFrame;`,
        'COUNTS'
      );
    },
    'COUNTS'
  );
}

export function dryApplyAll(ids = [...CANONICAL_ORDER, 'STACK']) {
  const checked = [];
  try {
    for (const id of ids) {
      applyHyp(id, { reset: true });
      const files = SRC_FILES.filter((rel) => fs.existsSync(abs(rel)));
      for (const rel of files) {
        execFileSync(process.execPath, ['--check', abs(rel)], { stdio: 'pipe' });
      }
      checked.push({ id, files: files.length });
    }
  } finally {
    restoreHead();
  }
  return checked;
}
