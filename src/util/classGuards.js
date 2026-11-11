/**
 * DX-GUARDS C3: entity classes written in a way that does not do what it says. Checked once, when the scene
 * registers its classes (main thread, both builds), and said once per class and rule.
 */
import { warnOnce } from './dxWarn.js';

/**
 * C3: `static tickInterval > 1` needs `logic.staggeredUpdates`; without it the type ticks every frame.
 * @param {{ class: Function, count: number }[]} registered
 * @param {Function} BaseClass GameObject
 * @param {{ logic?: { staggeredUpdates?: boolean } }} config the scene's config, defaults applied
 */
export function warnEntityClassMistakes(registered, BaseClass, config) {
  const staggered = config?.logic?.staggeredUpdates === true;
  for (const r of registered) {
    const C = r.class;
    if (!(r.count > 0) || !BaseClass.typeNeedsLogicTick(C)) continue;
    const name = C.name;
    const interval = C.tickInterval | 0;
    if (interval > 1 && !staggered) {
      warnOnce(
        name,
        'tick-interval',
        `${name} has static tickInterval = ${interval}, but the scene's logic.staggeredUpdates is off, so it ticks ` +
          'every frame. Set logic: { staggeredUpdates: true } in the scene\'s config.',
      );
    }
  }
}
