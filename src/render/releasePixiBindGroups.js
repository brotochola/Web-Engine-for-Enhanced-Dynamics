/**
 * Pixi 8 BindGroup subscribes to TextureSource/style "change". Destroying
 * the source while that listener is live warns and can leave a dead GPU bind.
 * EventEmitter3 keys are optionally prefixed with '~'.
 */

function changeListenerList(resource) {
  const events = resource?._events;
  if (!events) return null;
  const list = events.change || events['~change'];
  if (!list) return null;
  return list.fn ? [list] : list;
}

/**
 * Destroy BindGroups still listening on a TextureSource / TextureStyle.
 * @param {{_events?: object}|null|undefined} resource
 * @returns {number} BindGroups destroyed
 */
export function releasePixiBindGroupsOnResource(resource) {
  const items = changeListenerList(resource);
  if (!items) return 0;
  const copy = items.slice();
  let n = 0;
  for (let i = 0; i < copy.length; i++) {
    const ctx = copy[i].context;
    if (ctx && ctx.resources && typeof ctx.setResource === 'function' && typeof ctx.destroy === 'function') {
      ctx.destroy();
      n++;
    }
  }
  return n;
}
