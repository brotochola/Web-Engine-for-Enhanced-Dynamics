/** A key typed into a field (a debug panel's input, the page's own form) is the field's. */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
