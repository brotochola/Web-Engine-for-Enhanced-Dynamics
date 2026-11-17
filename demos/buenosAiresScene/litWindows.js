// The houses' lit windows: the Editor de Barrios draws each window's lit pane in an unshaded sheet (`ventanas`), and the
// loader spawns them hidden. At dusk a share of them comes on, one by one, each fading in; late at night most go off,
// and the rest at dawn. It runs on the page (the scene's update), writing the panes' alpha (DecorationComponent.alpha,
// which the scene hands it): nothing a frame but the few that change.

/** A lit pane's alpha. */
const LIT_ALPHA = 0.95;
/** How long one window takes to come on or go off, ms. */
const FADE_MS = 700;
/** Windows that fade at once (the ones past it change at once). */
const MAX_FADING = 256;

/**
 * The share of windows lit at an hour: none by day; at dusk they come on, from 18:15 to 19:45, up to 45 %; from 23 h
 * people go to bed, down to 12 % at 1 h; at dawn, from 5:30 to 6:30, the rest go off.
 */
export function litShare(hour) {
  const ramp = (from, to) => Math.max(0, Math.min(1, (hour - from) / (to - from)));
  if (hour >= 12) return 0.45 * ramp(18.25, 19.75) - 0.33 * ramp(23, 25);
  return 0.12 * (1 - ramp(5.5, 6.5)) + (hour < 1 ? 0.33 * (1 - ramp(-1, 1)) : 0);
}

export class LitWindows {
  /**
   * @param {ArrayLike<number>} poolIndices the panes' decoration pool indices
   * @param {() => number} random
   * @param {Float32Array} alphas the decorations' alpha column (DecorationComponent.alpha)
   */
  constructor(poolIndices, random, alphas) {
    this.alphas = alphas;
    this.panes = Uint32Array.from(poolIndices);
    // Shuffled once: the order they come on in, the reverse of the order they go off in.
    for (let last = this.panes.length - 1; last > 0; last--) {
      const pick = Math.floor(random() * (last + 1));
      const kept = this.panes[last];
      this.panes[last] = this.panes[pick];
      this.panes[pick] = kept;
    }
    this.lit = 0;
    this.fadingPane = new Uint32Array(MAX_FADING);
    this.fadingStart = new Float64Array(MAX_FADING);
    this.fadingIn = new Uint8Array(MAX_FADING);
    this.fadingCount = 0;
  }

  /** Bring the windows towards the hour's share: a few a frame (more when far from it), each fading. */
  update(hour, nowMs) {
    const wanted = Math.round(litShare(hour) * this.panes.length);
    const step = Math.max(2, Math.ceil(Math.abs(wanted - this.lit) / 90));
    for (let n = 0; n < step && this.lit < wanted; n++) this.startFade(this.panes[this.lit++], true, nowMs);
    for (let n = 0; n < step && this.lit > wanted; n++) this.startFade(this.panes[--this.lit], false, nowMs);
    this.advanceFades(nowMs);
  }

  startFade(pane, comingOn, nowMs) {
    // A pane still fading the other way (the clock moved back and forth) stops that fade: the new one decides.
    for (let slot = 0; slot < this.fadingCount; slot++) {
      if (this.fadingPane[slot] !== pane) continue;
      const last = --this.fadingCount;
      this.fadingPane[slot] = this.fadingPane[last];
      this.fadingStart[slot] = this.fadingStart[last];
      this.fadingIn[slot] = this.fadingIn[last];
      break;
    }
    if (this.fadingCount >= MAX_FADING) {
      this.alphas[pane] = comingOn ? LIT_ALPHA : 0;
      return;
    }
    const slot = this.fadingCount++;
    this.fadingPane[slot] = pane;
    this.fadingStart[slot] = nowMs;
    this.fadingIn[slot] = comingOn ? 1 : 0;
  }

  /** Each fading pane's alpha at this moment; the finished ones leave the list (the last one takes their slot). */
  advanceFades(nowMs) {
    for (let slot = 0; slot < this.fadingCount; slot++) {
      const progress = Math.min(1, (nowMs - this.fadingStart[slot]) / FADE_MS);
      const shown = this.fadingIn[slot] ? progress : 1 - progress;
      this.alphas[this.fadingPane[slot]] = shown * LIT_ALPHA;
      if (progress < 1) continue;
      const last = --this.fadingCount;
      this.fadingPane[slot] = this.fadingPane[last];
      this.fadingStart[slot] = this.fadingStart[last];
      this.fadingIn[slot] = this.fadingIn[last];
      slot--;
    }
  }
}
