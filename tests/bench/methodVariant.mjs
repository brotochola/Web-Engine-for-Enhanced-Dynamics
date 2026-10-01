/**
 * Hypothesis variants of worker methods, built in memory from the shipped
 * source. A variant is the shipped method text plus an exact diff (the same
 * edit that would land in src/), compiled with the module's imports in scope.
 * Nothing is written to disk. An anchor that no longer matches the shipped
 * code throws, so a variant cannot silently drift from the engine.
 */

/**
 * @param {Function} Ctor
 * @param {string} name method name on Ctor.prototype
 * @param {Array<[string, string] | { beforeEnd: string }>} edits
 * @param {Record<string, unknown>} scope identifiers the method body uses from its module
 */
export function patchMethod(Ctor, name, edits, scope) {
  let src = Ctor.prototype[name].toString();
  for (const edit of edits) {
    if (Array.isArray(edit)) {
      const [from, to] = edit;
      if (!src.includes(from)) throw new Error(`${name}: anchor not found: ${from.slice(0, 120)}`);
      src = src.split(from).join(to);
    } else if (edit.beforeEnd) {
      const end = src.lastIndexOf('}');
      src = `${src.slice(0, end)}${edit.beforeEnd}\n${src.slice(end)}`;
    }
  }
  const keys = Object.keys(scope);
  const holder = new Function(...keys, `return { ${src} };`)(...keys.map((k) => scope[k]));
  return holder[name];
}

/**
 * Patched copy of a module-level function declaration (same edit format as
 * patchMethod). Extra declarations can be appended with `{ append: src }`.
 * @param {Function} fn
 * @param {Array<[string, string] | { append: string }>} edits
 * @param {Record<string, unknown>} scope
 */
export function patchFunction(fn, edits, scope) {
  let src = fn.toString();
  let extra = '';
  for (const edit of edits) {
    if (Array.isArray(edit)) {
      const [from, to] = edit;
      if (!src.includes(from)) throw new Error(`${fn.name}: anchor not found: ${from.slice(0, 120)}`);
      src = src.split(from).join(to);
    } else if (edit.append) {
      extra += `\n${edit.append}`;
    }
  }
  const keys = Object.keys(scope);
  return new Function(...keys, `${src}${extra}\nreturn ${fn.name};`)(...keys.map((k) => scope[k]));
}

/**
 * Subclass of `Ctor` whose listed methods are patched copies.
 * @param {Function} Ctor
 * @param {Array<{ method: string, edits: Array }>} patches
 * @param {Record<string, unknown>} scope
 */
export function variantClass(Ctor, patches, scope) {
  class Variant extends Ctor {}
  for (const p of patches) {
    Object.defineProperty(Variant.prototype, p.method, {
      value: patchMethod(Ctor, p.method, p.edits, scope),
      writable: true,
      configurable: true,
    });
  }
  return Variant;
}
