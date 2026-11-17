// Where the bench's headed Chrome windows open: where the owner last left one. Each run opens its window at the saved
// position (a launch argument, so it never flashes elsewhere) and saves where the window is when the run ends, so a
// window dragged aside (a corner, another screen) stays there for the next runs instead of opening over what the
// owner is doing. Position only: the window's size sets the page's viewport and canvas, which the measurements
// depend on, so it is never changed here.
//
// The position lives in the user's home folder (~/.weed-bench-window.json), shared by the main folder and every
// worktree. WEED_BENCH_WINDOW_FILE overrides the path (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function benchWindowFile() {
  return process.env.WEED_BENCH_WINDOW_FILE || path.join(os.homedir(), '.weed-bench-window.json');
}

/** The saved position, or null. */
export function savedBenchWindow() {
  try {
    const j = JSON.parse(fs.readFileSync(benchWindowFile(), 'utf8'));
    if (Number.isFinite(j.left) && Number.isFinite(j.top)) return { left: Math.round(j.left), top: Math.round(j.top) };
  } catch {}
  return null;
}

/**
 * Chrome's launch arguments: the saved position (none when nothing is saved), and a device scale factor of 1, so a
 * window on a screen scaled to 125 % (the owner's second screen) renders the canvas at the same pixels as on the 100 %
 * one: the measurements do not depend on which screen the window is on.
 */
export function benchWindowArgs() {
  const p = savedBenchWindow();
  launchedAt = p;
  return [...(p ? [`--window-position=${p.left},${p.top}`] : []), '--force-device-scale-factor=1'];
}

/** Where this process launched its window (benchWindowArgs), so only a window the owner moved is saved. */
let launchedAt = null;

/**
 * Save where `page`'s window is now, when it is a normal window (not minimized, maximized or full screen). Never
 * throws: a run's result matters more than its window's place.
 * @param {import('playwright').Page} page
 */
export async function rememberBenchWindow(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    await cdp.detach().catch(() => {});
    if (bounds.windowState !== 'normal' || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) return;
    // Only a window the owner moved during the run: one still where it was launched says nothing new, and saving it
    // would undo a position written meanwhile (the owner's screens changed while a run's window sat off them).
    if (launchedAt && launchedAt.left === bounds.left && launchedAt.top === bounds.top) return;
    const prev = savedBenchWindow();
    if (prev && prev.left === bounds.left && prev.top === bounds.top) return;
    fs.writeFileSync(benchWindowFile(), JSON.stringify({ left: bounds.left, top: bounds.top, savedAt: new Date().toISOString() }) + '\n');
  } catch {}
}
