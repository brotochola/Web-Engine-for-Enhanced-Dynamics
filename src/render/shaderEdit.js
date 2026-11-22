/**
 * CR-16: string edits on the engine's shader sources. Each mark must occur exactly once: a source that is not the one an
 * edit knows (a newer shader, a CRLF checkout, a game's own) throws a WeedJS error that names the mark.
 */

/** True when `mark` occurs exactly once in `source`. */
export function hasOnce(source, mark) {
  const at = source.indexOf(mark);
  return at >= 0 && source.indexOf(mark, at + mark.length) < 0;
}

/**
 * Throws `WeedJS: <what> (<mark>)` for the first mark that does not occur exactly once.
 * @param {string} source
 * @param {string[]} marks
 * @param {string} what what needs them, e.g. "the sun shadow map needs the sprite shadow WGSL"
 */
export function requireMarks(source, marks, what) {
  for (const mark of marks) {
    if (!hasOnce(source, mark)) throw new Error(`WeedJS: ${what} (${mark.trim()})`);
  }
}

/**
 * `source` with its one `from` replaced by `to` (taken literally: no $ patterns), or `WeedJS: <what> needs one "<from>"`.
 * @param {string} source
 * @param {string} from
 * @param {string} to
 * @param {string} what the shader the edit expects, e.g. "the sprite vertex shader"
 */
export function replaceOnce(source, from, to, what) {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + from.length) >= 0) throw new Error(`WeedJS: ${what} needs one "${from.trim()}"`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}
