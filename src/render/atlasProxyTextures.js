// SST-7 step 4: the atlas's frames grouped by proxy sheet, for the renderer's proxy sheets (pixiWorker loadSpritesheets).

/**
 * SST-7 step 4: each proxy sheet's frames, by its prefix: the atlas's frames whose names start with it, by their names
 * past it, in the atlas's order. One pass over the frames: a sheet's prefix is its name and '_' (a chunk's is ''), so a
 * frame's candidates are its name up to each '_'; a prefix without that ending is matched frame by frame. Scanning every
 * frame for every sheet (and an Object.entries of the atlas a sheet) cost frames x sheets.
 * @param {Object<string, import('../vendor/pixi.min.js').Texture>} atlasTextures the atlas's textures by frame name
 * @param {Object<string, {prefix: string}>} proxySheets
 * @returns {Map<string, Object<string, import('../vendor/pixi.min.js').Texture>>} prefix -> { unprefixed frame name: texture }
 */
export function proxyTexturesByPrefix(atlasTextures, proxySheets) {
  const out = new Map();
  const odd = [];
  for (const name in proxySheets) {
    const prefix = proxySheets[name].prefix;
    if (out.has(prefix)) continue;
    out.set(prefix, {});
    if (prefix !== '' && prefix.charCodeAt(prefix.length - 1) !== 95) odd.push(prefix);
  }
  const all = out.get('');
  for (const frameName in atlasTextures) {
    const texture = atlasTextures[frameName];
    if (all !== undefined) all[frameName] = texture;
    for (let at = frameName.indexOf('_'); at >= 0; at = frameName.indexOf('_', at + 1)) {
      const textures = out.get(frameName.slice(0, at + 1));
      if (textures !== undefined) textures[frameName.slice(at + 1)] = texture;
    }
    for (let i = 0; i < odd.length; i++) {
      if (frameName.startsWith(odd[i])) out.get(odd[i])[frameName.slice(odd[i].length)] = texture;
    }
  }
  return out;
}
