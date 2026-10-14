/**
 * Does a stress scene actually have the population it was asked for?
 *
 * Extracted from `runIntegratedWorkerBenchmark.mjs` so it can be unit-tested.
 * The whole point of this check is that it must be trustworthy without launching
 * a browser, and a guard that can only be exercised by running the thing it
 * guards is a guard that rots.
 */

/**
 * Compare what a scene says it resolved against what the page URL asked for.
 *
 * @param {Record<string, unknown>|null} requested  exported `stressSceneConfig.requested`
 * @param {string|URLSearchParams}     search      the live query
 * @returns {string[]} mismatches; empty means the scene has what it was asked for
 */
export function compareSceneParams(requested, search) {
  if (!requested) return [];
  const live = search instanceof URLSearchParams ? search : new URLSearchParams(search || '');
  const out = [];
  for (const [key, value] of Object.entries(requested)) {
    const raw = live.get(key);
    // Not requested: the scene's own default stands, and there is nothing to check.
    if (raw === null) continue;
    const want = Number(raw);
    const got = Number(value);
    if (Number.isFinite(want) && Number.isFinite(got)) {
      if (want !== got) out.push(`${key}: requested ${raw}, scene used ${value}`);
    } else if (String(raw) !== String(value)) {
      out.push(`${key}: requested ${raw}, scene used ${value}`);
    }
  }
  return out;
}

/**
 * The message a run must fail with. Kept next to the comparison so the wording
 * and the rule cannot drift apart.
 */
export function mismatchMessage(mismatches) {
  return (
    `SCENE PARAMETER MISMATCH - the scene did not receive what was asked for:\n` +
    `  ${mismatches.join('; ')}\n` +
    `  A stress scene reads its parameters from location.search. A query on ` +
    `--scene lands in the module specifier instead and is silently ignored.\n` +
    `  Fix: pass the parameters via --query, and have the scene export\n` +
    `  stressSceneConfig.requested so this is caught rather than measured.`
  );
}

export default compareSceneParams;