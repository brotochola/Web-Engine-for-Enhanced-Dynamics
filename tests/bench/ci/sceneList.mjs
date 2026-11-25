/**
 * The scenes a revision can be timed in (sceneAb.mjs): the demos and the stress scenes of profileSceneSweep, each with the
 * class it exports in that tree, and whether two trees have the same scene: its file and every demo or bench module it
 * imports, byte for byte (src/ apart, the engine being what is compared). A scene that changed is timed too, and says so: its
 * two sides are two scenes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEMOS, SCENE_EXPORTS, STRESS } from '../profileSceneSweep.mjs';

/** Scenes whose default load is far past four threads (or draws nothing without a knob): the load they run at here. */
const QUERIES = Object.freeze({
  bunnyMarkScene: 'bunnies=60000',
  predatorScene: 'crowd=0.4',
  particleIntegrateStressScene: 'tween=1',
});

/** Every scene's path, demos first. */
export const ALL_SCENE_PATHS = Object.freeze([...DEMOS, ...STRESS]);

/** A scene's short name: its file's. */
export const sceneName = (file) => path.basename(file, '.js');

/** The scene class `file` exports in the tree at `root`, or null when it has none (or no such file). */
export function exportedScene(root, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return null;
  const src = fs.readFileSync(full, 'utf8');
  const names = [...src.matchAll(/export\s+class\s+(\w*Scene\w*)\s+extends\b/g)].map((m) => m[1]);
  const pinned = SCENE_EXPORTS[sceneName(file)];
  if (pinned && names.includes(pinned)) return pinned;
  return names[0] ?? null;
}

/** The demo and bench modules `file` reaches by its imports in the tree at `root` (itself first), sorted. */
export function sceneModules(root, file) {
  const seen = new Set();
  const todo = [file.replace(/^\//, '')];
  while (todo.length > 0) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) continue;
    const src = fs.readFileSync(full, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1].split('?')[0];
      let to = null;
      if (spec.startsWith('/')) to = spec.slice(1);
      else if (spec.startsWith('.')) to = path.posix.join(path.posix.dirname(rel), spec);
      if (to !== null && /^(demos|tests)\//.test(to)) todo.push(to);
    }
  }
  return [...seen].sort();
}

/** The modules of `file` that are not the same in the two trees (missing on one side counts); none: the same scene. */
export function changedModules(rootA, rootB, file) {
  const a = sceneModules(rootA, file);
  const b = sceneModules(rootB, file);
  const changed = [];
  for (const rel of [...new Set([...a, ...b])].sort()) {
    if (!a.includes(rel) || !b.includes(rel)) changed.push(rel);
    else if (!fs.readFileSync(path.join(rootA, rel)).equals(fs.readFileSync(path.join(rootB, rel)))) changed.push(rel);
  }
  return changed;
}

/** The scenes both trees have, each with its class on either side, its query and its modules that changed. */
export function scenesOfBoth(rootA, rootB, paths = ALL_SCENE_PATHS) {
  const out = [];
  for (const file of paths) {
    const exportA = exportedScene(rootA, file);
    const exportB = exportedScene(rootB, file);
    if (exportA === null || exportB === null) continue;
    out.push({
      key: sceneName(file), path: file, exportName: exportB, exportNameA: exportA, query: QUERIES[sceneName(file)] ?? '',
      changed: changedModules(rootA, rootB, file),
    });
  }
  return out;
}
