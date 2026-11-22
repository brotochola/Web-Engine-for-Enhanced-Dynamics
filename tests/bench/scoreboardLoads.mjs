/**
 * DX-SCORELOAD: the scoreboard's stress rows at a load the machine at hand can measure. The catalog's loads were chosen
 * on the main PC, so on a slower machine (the ASUS: about half the stress rows) a baseline's primary sat under the
 * 6 ms floor and the row read FAIL. A row whose scene has a load knob names it (catalog scene.loadKnob: its query key,
 * its default and a cap); calibrateScoreboardLoads.mjs raises it on this machine and writes a loads file:
 *
 *   { "vs": "v0.14.0", "sha": "...", "targetMs": 9, "rows": { "ray": { "casts": 6144, "baselineMs": 9.1, "tries": [...] } } }
 *
 * runScoreboard --loads <file> then runs both sides of each row at that load.
 */
import fs from 'node:fs';

/** A loads file's rows ({ rowId: { knobKey: value, ... } }), or a WeedJS error saying what is wrong with it. */
export function readScoreboardLoads(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json || typeof json.rows !== 'object' || json.rows === null) {
    throw new Error(`scoreboard loads: ${file} has no "rows" object (write it with calibrateScoreboardLoads.mjs)`);
  }
  return json.rows;
}

/**
 * The row's scene with its load knob at the value `rows` holds for it (the scene's own query kept), or the catalog's
 * scene itself when the row has no knob or no value there.
 * @param {{ id: string, scene: { loadKnob?: { key: string }, query?: string } }} feature
 * @param {Record<string, Record<string, number>> | null} rows
 */
export function sceneAtLoad(feature, rows) {
  const knob = feature.scene?.loadKnob;
  const value = rows && knob ? rows[feature.id]?.[knob.key] : undefined;
  if (value === undefined || value === null) return feature.scene;
  const params = new URLSearchParams(String(feature.scene.query || '').replace(/^\?/, ''));
  params.set(knob.key, String(value));
  return { ...feature.scene, query: params.toString() };
}

/**
 * The knob's next value after a run whose primary read `primaryMs`: scaled in a straight line to `targetMs` (the
 * knobs load their worker linearly: R-1592's casts ladder), at least one step up, never past the knob's cap.
 * @param {{ max?: number }} knob
 * @param {number} value
 * @param {number} primaryMs
 * @param {number} targetMs
 */
export function nextLoad(knob, value, primaryMs, targetMs) {
  const scaled = Math.ceil((value * targetMs) / Math.max(primaryMs, 0.1));
  const cap = Number.isFinite(knob.max) ? knob.max : Number.MAX_SAFE_INTEGER;
  return Math.min(cap, Math.max(value + 1, scaled));
}

/** The largest median of a row's ms primaries in a run's summary (the one the floor judges), or NaN. */
export function primaryMs(feature, summary) {
  let ms = NaN;
  for (const key of feature.primary || []) {
    if (!/_MS$/i.test(key)) continue;
    const med = summary?.[key]?.median;
    if (Number.isFinite(med) && !(med <= ms)) ms = med;
  }
  return ms;
}
