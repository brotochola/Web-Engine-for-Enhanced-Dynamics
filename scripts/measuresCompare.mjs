/**
 * Two sides of the kept measures against each other (scripts/measures.mjs, docs/internal/measures.html): no Node import, so
 * the page runs the same code.
 */
export const median = (v) => {
  const s = [...v].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
};

/** A side's value of a case on a VM: the rounds' median, as a rate (more is better) over the ruler's mean rate there. */
function sideValue(measure, c, vm, side) {
  const v = median(c.vms[vm][side]);
  if (!(v > 0)) return null;
  const rate = c.higher ? v : 1 / v;
  const ruler = measure.vms[vm]?.ruler;
  if (!ruler) return { rate, ruled: null };
  const at = (k) => (ruler.start[k] + (ruler.end?.[k] ?? ruler.start[k])) / 2;
  return { rate, ruled: rate / Math.cbrt(at('float') * at('memory') * at('branch')) };
}

/**
 * Side y of one measure against side x of another, case by case and CPU model by CPU model:
 * [{ kernel, case, cpu, log, vms: [x, y], ruled }], log(y / x) of the rates (> 0 is faster). The same measure: by VM.
 */
export function compareKernels(mx, sx, my, sy) {
  const rows = [];
  const same = mx.file !== undefined && mx.file === my.file;
  for (const [label, kx] of Object.entries(mx.kernels)) {
    const ky = my.kernels[label];
    if (!ky) continue;
    for (const [name, cx] of Object.entries(kx.cases)) {
      const cy = ky.cases[name];
      if (!cy) continue;
      const groups = new Map();
      const add = (m, c, side, which) => {
        for (const vm of Object.keys(c.vms)) {
          const cpu = m.vms[vm]?.cpu ?? '?';
          const v = sideValue(m, c, vm, side);
          if (!v) continue;
          const key = same ? vm : cpu;
          const g = groups.get(key) ?? { cpu, x: [], y: [] };
          g[which].push(v);
          groups.set(key, g);
        }
      };
      add(mx, cx, sx, 'x');
      add(my, cy, sy, 'y');
      for (const g of groups.values()) {
        if (!g.x.length || !g.y.length) continue;
        const ruled = !same && [...g.x, ...g.y].every((v) => v.ruled !== null);
        const pick = (list) => median(list.map((v) => (ruled ? v.ruled : v.rate)));
        rows.push({ kernel: label, case: name, cpu: g.cpu, log: Math.log(pick(g.y) / pick(g.x)), vms: [g.x.length, g.y.length], ruled });
      }
    }
  }
  return rows;
}

/** What a worker's frames say of its time (collect.mjs framesDoubt's rule; null: it can be read). */
function doubtOf(frames) {
  if (frames.some((f) => f === null)) return 'frames not kept';
  if (Math.min(...frames) < 120) return 'few frames';
  return Math.max(...frames) > 1.25 * Math.min(...frames) ? 'other frames' : null;
}

/**
 * Scene workers of side y of one measure against side x of another, by machine kind: [{ scene, worker, machine, x, y, log,
 * vms, doubt, changed, agree }], x and y in ms a frame, log(y / x) (< 0 is less time). The same measure: the median of the VMs'
 * own differences, `agree` when every VM's went the same way; two measures: the medians of their VMs, whose CPUs may differ.
 */
export function compareScenes(mx, sx, my, sy) {
  const rows = [];
  const same = mx.file !== undefined && mx.file === my.file;
  for (const [scene, ax] of Object.entries(mx.scenes)) {
    const ay = my.scenes[scene];
    if (!ay) continue;
    for (const [worker, wx] of Object.entries(ax.workers)) {
      const wy = ay.workers[worker];
      if (!wy) continue;
      const kinds = new Set(Object.keys(wx).map((vm) => mx.vms[vm]?.machine));
      for (const machine of kinds) {
        const of = (m, w, side) => Object.entries(w).filter(([vm]) => m.vms[vm]?.machine === machine)
          .map(([vm, v]) => ({ vm, ms: v[side].every((x) => x > 0) ? median(v[side]) : null, frames: Math.min(...v[side === 'a' ? 'framesA' : 'framesB'].map((f) => f ?? -1)) }))
          .filter((v) => v.ms !== null);
        const vx = of(mx, wx, sx);
        const vy = of(my, wy, sy);
        if (!vx.length || !vy.length) continue;
        const x = median(vx.map((v) => v.ms));
        const y = median(vy.map((v) => v.ms));
        const pairs = same ? vx.map((v) => [v.ms, vy.find((u) => u.vm === v.vm)?.ms]).filter(([, b]) => b > 0) : [];
        const log = pairs.length ? median(pairs.map(([p, q]) => Math.log(q / p))) : Math.log(y / x);
        const frames = [...vx, ...vy].map((v) => (v.frames < 0 ? null : v.frames));
        rows.push({ scene, worker, machine, x, y, log, vms: [vx.length, vy.length], doubt: doubtOf(frames), changed: same ? ax.changed ?? [] : [], agree: pairs.length > 1 && (pairs.every(([p, q]) => q > p) || pairs.every(([p, q]) => q < p)) });
      }
    }
  }
  return rows;
}
