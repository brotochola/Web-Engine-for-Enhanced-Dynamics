/**
 * webgpuFrameRecorder.mjs's worker side: the functions it runs in the Pixi worker (Playwright sends each one's source,
 * so each is self-contained: no imports, no module state). Apart from the CLI so that a node test can run them on a
 * fake WebGPU (tests/node/webgpuFrameRecorder.test.js).
 */

/**
 * Runs in the Pixi worker as soon as it starts (before its module has run): records what each WebGPU object is as it
 * is made, so a pass or draw in the window can be named. Kept for the worker's life (creation calls only).
 */
export function installCreationHooks() {
  if (self.__wgpuMeta) return 'already';
  if (typeof GPUDevice === 'undefined') return 'no WebGPU in this worker';
  const meta = {
    modules: new WeakMap(),
    pipelines: new WeakMap(),
    views: new WeakMap(),
    canvas: new WeakSet(),
    bindGroups: new WeakMap(),
    installedAt: performance.now(),
    deviceAt: 0,
    requestedFeatures: null,
    made: { modules: 0, pipelines: 0, views: 0, bindGroups: 0 },
  };
  self.__wgpuMeta = meta;
  const hook = (proto, name, after) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function') return;
    const orig = d.value;
    Object.defineProperty(proto, name, {
      ...d,
      value: function (...a) {
        const r = orig.apply(this, a);
        try {
          after(r, a, this);
        } catch {
          // a name is a nicety: never break the call
        }
        return r;
      },
    });
  };
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  hook(GPUDevice.prototype, 'createShaderModule', (m, [desc]) => {
    const code = String(desc?.code || '');
    const names = [];
    const re = /@binding\s*\(\s*\d+\s*\)\s*var(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g;
    let x;
    while ((x = re.exec(code)) && names.length < 16) names.push(x[1]);
    meta.modules.set(m, { hash: hash(code), names, label: desc?.label || '' });
    meta.made.modules++;
  });
  const pipeInfo = (desc, kind) => {
    const mod = (stage) => (stage && stage.module ? meta.modules.get(stage.module) : null);
    if (kind === 'compute') {
      const c = mod(desc?.compute);
      return { kind, label: desc?.label || '', entry: desc?.compute?.entryPoint || '', names: c?.names || [], hash: c?.hash || '' };
    }
    const v = mod(desc?.vertex);
    const f = mod(desc?.fragment);
    return {
      kind,
      label: desc?.label || '',
      entry: desc?.fragment?.entryPoint || '',
      names: [...new Set([...(f?.names || []), ...(v?.names || [])])],
      hash: `${v?.hash || ''}${f && f !== v ? `/${f.hash}` : ''}`,
      targets: (desc?.fragment?.targets || []).map((t) => t?.format || '-').join(','),
    };
  };
  hook(GPUDevice.prototype, 'createRenderPipeline', (p, [desc]) => {
    meta.pipelines.set(p, pipeInfo(desc, 'render'));
    meta.made.pipelines++;
  });
  hook(GPUDevice.prototype, 'createComputePipeline', (p, [desc]) => {
    meta.pipelines.set(p, pipeInfo(desc, 'compute'));
    meta.made.pipelines++;
  });
  hook(GPUDevice.prototype, 'createRenderPipelineAsync', (pr, [desc]) => {
    const info = pipeInfo(desc, 'render');
    pr.then((p) => { meta.pipelines.set(p, info); meta.made.pipelines++; }, () => {});
  });
  hook(GPUDevice.prototype, 'createComputePipelineAsync', (pr, [desc]) => {
    const info = pipeInfo(desc, 'compute');
    pr.then((p) => { meta.pipelines.set(p, info); meta.made.pipelines++; }, () => {});
  });
  hook(GPUTexture.prototype, 'createView', (v, a, tex) => {
    meta.views.set(v, tex);
    meta.made.views++;
  });
  if (typeof GPUCanvasContext !== 'undefined') hook(GPUCanvasContext.prototype, 'getCurrentTexture', (t) => meta.canvas.add(t));
  hook(GPUDevice.prototype, 'createBindGroup', (bg, [desc]) => {
    const tex = [];
    for (const e of desc?.entries || []) {
      const r = e?.resource;
      if (!r) continue;
      if (r instanceof GPUTextureView) {
        const t = meta.views.get(r);
        if (t) tex.push(t);
      } else if (r instanceof GPUTexture) tex.push(r);
    }
    meta.bindGroups.set(bg, tex);
    meta.made.bindGroups++;
  });
  hook(GPUAdapter.prototype, 'requestDevice', (pr, [desc]) => {
    meta.deviceAt = performance.now();
    meta.requestedFeatures = [...(desc?.requiredFeatures || [])];
  });
  return 'installed';
}

/** Runs in the Pixi worker: wrap the WebGPU prototypes, record `ms`, unwrap, return the totals. */
export async function recordInWorker({ ms, mode }) {
  const px = self.pixiRenderer;
  const renderer = px?.pixiApp?.renderer;
  const device = renderer?.gpu?.device;
  if (!device) return { error: 'no WebGPU device in the Pixi worker (a WebGL backend? add --query backend=webgpu)' };
  const meta = self.__wgpuMeta || null;
  const INSIDE = 'chromium-experimental-timestamp-query-inside-passes';
  const hasTs = device.features.has('timestamp-query');
  const inside = device.features.has(INSIDE);
  const timing = hasTs && (mode === 'passes' || mode === 'draws' || mode === 'split');
  const RP = GPURenderPassEncoder.prototype;
  const CP = GPUComputePassEncoder.prototype;
  const CE = GPUCommandEncoder.prototype;
  const DV = GPUDevice.prototype;
  const QU = GPUQueue.prototype;
  const BU = GPUBuffer.prototype;
  // A method's descriptor on the prototype or the first one above it that has it (Chrome puts the mixins' methods on
  // each interface's own prototype; this does not count on it).
  const descOf = (proto, n) => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, n);
      if (d) return { d, own: p === proto };
    }
    return null;
  };
  const raw = (proto, n) => descOf(proto, n)?.d.value;
  const rawTsRender = raw(RP, 'writeTimestamp');
  const rawTsCompute = raw(CP, 'writeTimestamp');
  const rawResolve = raw(CE, 'resolveQuerySet');
  const rawCopyBB = raw(CE, 'copyBufferToBuffer');
  const rawCreateQS = raw(DV, 'createQuerySet');
  const rawCreateBuf = raw(DV, 'createBuffer');
  const rawMap = raw(BU, 'mapAsync');
  const rawRange = raw(BU, 'getMappedRange');
  const rawUnmap = raw(BU, 'unmap');
  const perDraw = timing && mode === 'draws' && inside && typeof rawTsRender === 'function' && typeof rawTsCompute === 'function';
  const split = timing && mode === 'split';
  const STATE_CALLS = ['setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference'];
  const RENDER_DRAWS = ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect', 'executeBundles'];
  const COMPUTE_DRAWS = ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'];
  const rawRender = Object.create(null);
  for (const n of ['setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', ...STATE_CALLS, ...RENDER_DRAWS, 'end']) rawRender[n] = raw(RP, n);
  const rawCompute = Object.create(null);
  for (const n of ['setPipeline', 'setBindGroup', ...COMPUTE_DRAWS, 'end']) rawCompute[n] = raw(CP, n);
  const rawBeginRender = raw(CE, 'beginRenderPass');
  const rawBeginCompute = raw(CE, 'beginComputePass');
  const errors = [];
  const onError = (ev) => { if (errors.length < 20) errors.push(String(ev?.error?.message || ev?.error || ev)); };
  device.addEventListener('uncapturederror', onError);

  // Names.
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => {
    if (!o) return 0;
    let i = ids.get(o);
    if (!i) ids.set(o, (i = nextId++));
    return i;
  };
  const short = (s, n) => String(s || '').split('/').pop().slice(0, n);
  // A texture by id, size and format (the canvas's, a new object each frame, by 'canvas' alone).
  const texName = (t) => {
    const msaa = t.sampleCount > 1 ? ` msaa${t.sampleCount}` : '';
    if (meta?.canvas.has(t)) return `canvas ${t.width}x${t.height} ${t.format}${msaa}`;
    const lbl = short(t.label, 28);
    return `tex#${idOf(t)} ${t.width}x${t.height} ${t.format}${msaa}${lbl ? ` ${lbl}` : ''}`;
  };
  // Objects the creation hooks did not see (made before them), each counted once.
  const unnamed = new WeakSet();
  let unknownViews = 0;
  let unknownPipes = 0;
  // The views of Pixi's own textures from its record of them (names them when the hooks came late).
  const pixiViews = new WeakMap();
  try {
    const sys = renderer.texture;
    const list = sys?.managedTextures || Object.values(sys?._managedTextures?.items || {});
    for (const src of list) {
      const gd = src?._gpuData?.[renderer.uid];
      if (!gd?.gpuTexture) continue;
      if (gd.textureView) pixiViews.set(gd.textureView, gd.gpuTexture);
      for (const v of Object.values(gd.textureViews || {})) if (v) pixiViews.set(v, gd.gpuTexture);
    }
  } catch {
    // a Pixi without that record: the hooks' names only
  }
  const viewName = (v) => {
    const t = meta?.views.get(v) || pixiViews.get(v);
    if (t) return texName(t);
    if (v && !unnamed.has(v)) {
      unnamed.add(v);
      unknownViews++;
    }
    return `view#${idOf(v)}${v?.label ? ` ${short(v.label, 28)}` : ''}`;
  };
  const passLabel = (desc) => {
    const cas = (desc?.colorAttachments || []).filter(Boolean);
    const ds = desc?.depthStencilAttachment;
    let s = cas.length ? viewName(cas[0].view) : ds ? `depth only ${viewName(ds.view)}` : 'no attachment';
    if (cas.length > 1) s += ` +${cas.length - 1} colour`;
    if (cas.length && ds) s += ' +depth';
    if (desc?.label) s += ` "${short(desc.label, 32)}"`;
    return s;
  };
  const pipeName = (p) => {
    if (!p) return 'no pipeline';
    const m = meta?.pipelines.get(p);
    if (!m && !unnamed.has(p)) {
      unnamed.add(p);
      unknownPipes++;
    }
    let l = String(m?.label || p.label || '').replace(/^PIXI Pipeline \((.*)\)$/, '$1').replace(/^PIXI Pipeline$/, 'pixi');
    if (!l) l = `pipe#${idOf(p)}${m?.hash ? ` ${m.hash}` : ''}`;
    const entry = m?.entry && m.entry !== 'main' && m.entry !== 'mainFrag' ? `:${m.entry}` : '';
    const names = (m?.names || []).filter((n) => n !== 'globalUniforms' && n !== 'localUniforms').slice(0, 8);
    return `${l}${entry}${names.length ? ` [${names.join(',')}]` : ''}`;
  };
  const boundTex = (ps) => {
    const out = [];
    for (const bg of ps.groups) {
      const tx = bg ? meta?.bindGroups.get(bg) : null;
      if (!tx) continue;
      for (const t of tx) if (out.length < 4) out.push(`${short(t.label, 24) || `#${idOf(t)}`} ${t.width}x${t.height}`);
    }
    return out.length ? ` {${out.join('; ')}}` : '';
  };

  // Counts.
  const counts = Object.create(null);
  const redundant = Object.create(null);
  const count = (n) => { counts[n] = (counts[n] || 0) + 1; };
  const redo = (n) => { redundant[n] = (redundant[n] || 0) + 1; };
  const detail = new Map();
  const note = (key, bytes) => {
    const d = detail.get(key) || { calls: 0, bytes: 0 };
    d.calls++;
    d.bytes += bytes;
    detail.set(key, d);
  };
  let draws = 0;
  let instances = 0;
  let dispatches = 0;
  let bytesBuffer = 0;
  let bytesTexture = 0;
  const texelBytes = (f) => {
    f = String(f || '');
    if (/^rgba32/.test(f)) return 16;
    if (/^(rg32|rgba16)/.test(f)) return 8;
    if (/^(r32|rg16|rgba8|bgra8|rgb10a2|rg11b10|depth32|depth24)/.test(f)) return 4;
    if (/^(r16|rg8|depth16)/.test(f)) return 2;
    if (/^(r8|stencil8)/.test(f)) return 1;
    return 4;
  };
  const extent = (size) => {
    if (!size) return [0, 0, 0];
    if (Array.isArray(size) || typeof size[Symbol.iterator] === 'function') {
      const a = [...size];
      return [a[0] | 0, (a[1] ?? 1) | 0, (a[2] ?? 1) | 0];
    }
    return [size.width | 0, (size.height ?? 1) | 0, (size.depthOrArrayLayers ?? 1) | 0];
  };

  // Timestamp slots: a query set, the buffer it resolves into and the copy that is mapped. A slot goes back to the
  // pool only once its copy has been read, so no query set is written again with a map pending.
  const Q = 1024;
  const MAX_SLOTS = 256;
  const slots = [];
  const free = [];
  let skippedEncoders = 0;
  let mapFailures = 0;
  const takeSlot = () => {
    let s = free.pop();
    if (!s) {
      if (slots.length >= MAX_SLOTS) return null;
      s = {
        qs: rawCreateQS.call(device, { type: 'timestamp', count: Q, label: 'webgpuFrameRecorder' }),
        res: rawCreateBuf.call(device, { size: Q * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, label: 'webgpuFrameRecorder resolve' }),
        read: rawCreateBuf.call(device, { size: Q * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'webgpuFrameRecorder read' }),
        used: 0,
      };
      slots.push(s);
    }
    s.used = 0;
    return s;
  };
  const jobs = new WeakMap(); // command encoder -> its timestamps
  const cbJobs = new WeakMap(); // command buffer -> the same
  const pending = new Set();
  const jobOf = (enc) => {
    let j = jobs.get(enc);
    if (!j) {
      j = { slots: [], cur: null, passes: [], frame: px.frameNumber | 0, dead: false };
      jobs.set(enc, j);
    }
    return j;
  };
  // Two consecutive queries in one slot (a pass's beginning and end, a draw's before and after); the handle is
  // slot * Q + query of the first, or -1 when the pool is used up (the rest of that encoder is not timed).
  const alloc2 = (j) => {
    if (j.dead) return -1;
    if (!j.cur || j.cur.used + 2 > Q) {
      const s = takeSlot();
      if (!s) {
        j.dead = true;
        skippedEncoders++;
        return -1;
      }
      j.slots.push(s);
      j.cur = s;
    }
    const h = (j.slots.length - 1) * Q + j.cur.used;
    j.cur.used += 2;
    return h;
  };
  const qsOf = (j, h) => j.slots[(h / Q) | 0].qs;

  // What the timestamps add up to.
  const passRows = new Map(); // pass label -> { ns, n, draws, instances, pre, post, drawNs }
  const drawRows = new Map(); // draw label -> { ns, n, instances, pass }
  const frameSpan = new Map(); // frame -> { min, max, sum }
  let invalid = 0;
  // Chrome quantizes timestamps unless its WebGPU developer features are on: to 2^16 ns in Chrome 157 (to 100 us before).
  let quantizedDurations = 0;
  let durations = 0;
  const addRow = (map, key, ns, extra) => {
    let r = map.get(key);
    if (!r) map.set(key, (r = { label: key, ns: 0, n: 0, instances: 0, draws: 0, pre: 0, post: 0, drawNs: 0, cal: 0, calN: 0, ...extra }));
    r.ns += ns;
    r.n++;
    return r;
  };
  // A split pass: its clear, draws and last pass each timed alone (the gaps between them left out), and the empty pass.
  const collectSplit = (ps, ts, dur) => {
    const key = `${ps.kind} ${ps.label} | first ${ps.first || 'no draw'}`;
    const dk = `${ps.kind} ${ps.label}`;
    let lo = 0n;
    let hi = 0n;
    const take = (h) => {
      if (h < 0) return -1;
      const ns = dur(h, h + 1);
      if (ns < 0) return -1;
      if (!lo || ts(h) < lo) lo = ts(h);
      if (ts(h + 1) > hi) hi = ts(h + 1);
      return ns;
    };
    const pre = take(ps.preH);
    const items = ps.items.map((d) => take(d.h));
    const post = take(ps.postH);
    const cal = ps.calH >= 0 ? dur(ps.calH, ps.calH + 1) : -1;
    if (!lo) return;
    const drawNs = items.reduce((t, x) => t + Math.max(0, x), 0);
    const total = Math.max(0, pre) + drawNs + Math.max(0, post);
    const row = addRow(passRows, key, total);
    row.draws += ps.nDraws;
    row.instances += ps.inst;
    row.drawNs += drawNs;
    if (pre >= 0) {
      row.pre += pre;
      addRow(drawRows, `${dk} | ${ps.load} (a pass of its own)`, pre, { pass: key });
    }
    if (post >= 0) {
      row.post += post;
      addRow(drawRows, `${dk} | end (a pass of its own: store, resolve)`, post, { pass: key });
    }
    if (cal >= 0) {
      row.cal += cal;
      row.calN++;
      addRow(drawRows, `${dk} | an empty pass (what each draw's own pass adds to it)`, cal, { pass: key });
    }
    ps.items.forEach((d, i) => {
      if (items[i] < 0) return;
      addRow(drawRows, `${dk} | ${d.label}`, items[i], { pass: key }).instances += d.inst;
    });
    let f = frameSpan.get(ps.frame);
    if (!f) frameSpan.set(ps.frame, (f = { min: lo, max: hi, sum: 0, passes: 0 }));
    if (lo < f.min) f.min = lo;
    if (hi > f.max) f.max = hi;
    f.sum += total;
    f.passes++;
  };
  const collectJob = (j, arrays) => {
    const ts = (h) => {
      const a = arrays[(h / Q) | 0];
      return a ? a[h % Q] : 0n;
    };
    const dur = (b, e) => {
      const tb = ts(b);
      const te = ts(e);
      if (!tb || !te || te < tb) {
        invalid++;
        return -1;
      }
      const ns = Number(te - tb);
      durations++;
      if (ns > 0 && (ns % 65536 === 0 || ns % 100000 === 0)) quantizedDurations++;
      return ns;
    };
    for (const ps of j.passes) {
      if (ps.split) {
        collectSplit(ps, ts, dur);
        continue;
      }
      if (ps.h < 0) continue;
      const key = `${ps.kind} ${ps.label} | first ${ps.first || 'no draw'}`;
      const ns = dur(ps.h, ps.h + 1);
      if (ns < 0) continue;
      const row = addRow(passRows, key, ns);
      row.draws += ps.nDraws;
      row.instances += ps.inst;
      let f = frameSpan.get(ps.frame);
      if (!f) frameSpan.set(ps.frame, (f = { min: ts(ps.h), max: ts(ps.h + 1), sum: 0, passes: 0 }));
      if (ts(ps.h) < f.min) f.min = ts(ps.h);
      if (ts(ps.h + 1) > f.max) f.max = ts(ps.h + 1);
      f.sum += ns;
      f.passes++;
      if (!perDraw) continue;
      if (!ps.items.length) {
        addRow(drawRows, `${ps.kind} ${ps.label} | ${ps.kind === 'render' ? `no draw (${ps.load})` : 'no dispatch'}`, ns, { pass: key });
        row.pre += ns;
        continue;
      }
      for (const d of ps.items) {
        const dn = dur(d.h, d.h + 1);
        if (dn < 0) continue;
        const r = addRow(drawRows, `${ps.kind} ${ps.label} | ${d.label}`, dn, { pass: key });
        r.instances += d.inst;
        row.drawNs += dn;
      }
      const pre = dur(ps.h, ps.items[0].h);
      const post = dur(ps.items[ps.items.length - 1].h + 1, ps.h + 1);
      if (pre >= 0) {
        row.pre += pre;
        addRow(drawRows, `${ps.kind} ${ps.label} | ${ps.kind === 'render' ? `${ps.load} (to the first draw)` : 'to the first dispatch'}`, pre, { pass: key });
      }
      if (post >= 0) {
        row.post += post;
        addRow(drawRows, `${ps.kind} ${ps.label} | ${ps.kind === 'render' ? 'end (from the last draw: store, resolve)' : 'end (from the last dispatch)'}`, post, { pass: key });
      }
    }
  };

  // The wrappers.
  const saved = [];
  const patch = (proto, name, make) => {
    const found = descOf(proto, name);
    if (!found || typeof found.d.value !== 'function') return;
    saved.push([proto, name, found.own ? found.d : null]);
    Object.defineProperty(proto, name, { ...found.d, value: make(found.d.value) });
  };
  const passes = new WeakMap(); // pass encoder -> its record
  const newPass = (kind, label, load, h, j) => ({
    kind, label, load, h, job: j, items: [], groups: [], pipeline: null, first: '', nDraws: 0, inst: 0, frame: px.frameNumber | 0,
    vb: [], ib: null, state: Object.create(null), split: false, preH: -1, postH: -1, calH: -1,
  });
  const beginPass = (kind) => (orig) => function (desc) {
    count(kind === 'render' ? 'beginRenderPass' : 'beginComputePass');
    const j = timing ? jobOf(this) : null;
    const load = kind === 'render'
      ? (desc?.colorAttachments?.[0]?.loadOp || desc?.depthStencilAttachment?.depthLoadOp || 'load')
      : '';
    const label = kind === 'render' ? passLabel(desc) : `${desc?.label ? `"${short(desc.label, 32)}"` : 'compute'}`;
    if (split && j && !desc?.timestampWrites) {
      const ps = newPass(kind, label, load, -1, j);
      ps.split = true;
      j.passes.push(ps);
      return standIn(kind, this, desc || {}, ps, j);
    }
    let d = desc;
    let h = -1;
    // A pass that carries its own timestampWrites keeps them (and is not timed).
    if (j && !desc?.timestampWrites) {
      h = alloc2(j);
      if (h >= 0) d = { ...(desc || {}), timestampWrites: { querySet: qsOf(j, h), beginningOfPassWriteIndex: h % Q, endOfPassWriteIndex: (h % Q) + 1 } };
    }
    const pe = orig.call(this, d);
    const ps = newPass(kind, label, load, h, j);
    passes.set(pe, ps);
    if (j && h >= 0) j.passes.push(ps);
    return pe;
  };
  patch(CE, 'beginRenderPass', beginPass('render'));
  patch(CE, 'beginComputePass', beginPass('compute'));
  patch(CE, 'finish', (orig) => function (...a) {
    count('finish');
    const j = jobs.get(this);
    if (j && j.slots.length) {
      for (const s of j.slots) {
        rawResolve.call(this, s.qs, 0, s.used, s.res, 0);
        rawCopyBB.call(this, s.res, 0, s.read, 0, s.used * 8);
      }
    }
    const cb = orig.apply(this, a);
    if (j && j.slots.length) cbJobs.set(cb, j);
    jobs.delete(this);
    return cb;
  });
  for (const n of ['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer', 'resolveQuerySet']) {
    patch(CE, n, (orig) => function (...a) {
      count(n);
      if (n === 'copyTextureToTexture' || n === 'copyBufferToTexture') {
        const [w, hgt, dd] = extent(a[2]);
        const t = a[1]?.texture;
        note(`${n} -> ${t ? texName(t) : '?'} ${w}x${hgt}${dd > 1 ? `x${dd}` : ''}`, w * hgt * dd * texelBytes(t?.format));
      }
      return orig.apply(this, a);
    });
  }
  patch(DV, 'createCommandEncoder', (orig) => function (...a) { count('createCommandEncoder'); return orig.apply(this, a); });
  for (const n of ['createBindGroup', 'createBuffer', 'createTexture', 'createSampler', 'createRenderPipeline', 'createComputePipeline', 'createShaderModule', 'createQuerySet']) {
    patch(DV, n, (orig) => function (...a) {
      count(n);
      if (n === 'createBuffer' || n === 'createTexture') {
        const desc = a[0] || {};
        const size = n === 'createBuffer' ? `${desc.size} B` : extent(desc.size).join('x');
        note(`${n} ${size}${desc.label ? ` ${short(desc.label, 28)}` : ''}`, 0);
      }
      return orig.apply(this, a);
    });
  }
  patch(GPUTexture.prototype, 'createView', (orig) => function (...a) { count('createView'); return orig.apply(this, a); });
  patch(QU, 'submit', (orig) => function (cbs) {
    count('submit');
    const r = orig.call(this, cbs);
    for (const cb of cbs || []) {
      const j = cbJobs.get(cb);
      if (!j) continue;
      cbJobs.delete(cb);
      pending.add(j);
      Promise.allSettled(j.slots.map((s) => rawMap.call(s.read, GPUMapMode.READ, 0, s.used * 8))).then((res) => {
        pending.delete(j);
        if (res.some((x) => x.status !== 'fulfilled')) {
          mapFailures++;
          j.slots.forEach((s, i) => { if (res[i].status === 'fulfilled') rawUnmap.call(s.read); });
          return;
        }
        const arrays = j.slots.map((s) => {
          const a = new BigUint64Array(rawRange.call(s.read, 0, s.used * 8).slice(0));
          rawUnmap.call(s.read);
          return a;
        });
        for (const s of j.slots) free.push(s);
        collectJob(j, arrays);
      });
    }
    return r;
  });
  patch(QU, 'writeBuffer', (orig) => function (buffer, offset, data, dataOffset, size) {
    count('writeBuffer');
    const el = data?.BYTES_PER_ELEMENT || 1;
    const b = size !== undefined ? size * el : (data?.byteLength || 0) - (dataOffset || 0) * el;
    bytesBuffer += b;
    note(`writeBuffer buffer#${idOf(buffer)} (${buffer?.size} B${buffer?.label ? ` ${short(buffer.label, 28)}` : ''})`, b);
    return orig.apply(this, arguments);
  });
  patch(QU, 'writeTexture', (orig) => function (dest, data, layout, size) {
    count('writeTexture');
    const [w, hgt, dd] = extent(size);
    const t = dest?.texture;
    const b = w * hgt * dd * texelBytes(t?.format);
    bytesTexture += b;
    note(`writeTexture ${t ? texName(t) : '?'} ${w}x${hgt}${dd > 1 ? `x${dd}` : ''}`, b);
    return orig.apply(this, arguments);
  });
  patch(QU, 'copyExternalImageToTexture', (orig) => function (src, dest, size) {
    count('copyExternalImageToTexture');
    const [w, hgt] = extent(size);
    bytesTexture += w * hgt * 4;
    note(`copyExternalImageToTexture ${dest?.texture ? texName(dest.texture) : '?'} ${w}x${hgt}`, w * hgt * 4);
    return orig.apply(this, arguments);
  });
  patch(QU, 'onSubmittedWorkDone', (orig) => function (...a) { count('onSubmittedWorkDone'); return orig.apply(this, a); });
  patch(BU, 'mapAsync', (orig) => function (...a) { count('mapAsync'); return orig.apply(this, a); });

  // The pass's state calls, counted with what each repeats of the pass's state: the prototype wrappers and the split
  // stand-ins both go through these.
  const onPipeline = (ps, p) => {
    count('setPipeline');
    if (!ps) return;
    if (ps.pipeline === p) redo('setPipeline');
    ps.pipeline = p;
  };
  const onBindGroup = (ps, i, bg, rest) => {
    count('setBindGroup');
    if (!ps) return;
    if (ps.groups[i] === bg && !rest.length) redo('setBindGroup');
    ps.groups[i] = bg;
  };
  const onVertexBuffer = (ps, slot, buffer, offset, size) => {
    count('setVertexBuffer');
    if (!ps) return;
    const k = `${idOf(buffer)}:${offset || 0}:${size ?? ''}`;
    if (ps.vb[slot] === k) redo('setVertexBuffer');
    ps.vb[slot] = k;
  };
  const onIndexBuffer = (ps, buffer, format, offset, size) => {
    count('setIndexBuffer');
    if (!ps) return;
    const k = `${idOf(buffer)}:${format}:${offset || 0}:${size ?? ''}`;
    if (ps.ib === k) redo('setIndexBuffer');
    ps.ib = k;
  };
  const onState = (ps, n, a) => {
    count(n);
    if (!ps) return;
    const v = a.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : x)).join(',');
    if (ps.state[n] === v) redo(n);
    ps.state[n] = v;
  };
  // A draw or dispatch: counted, and named by its place in the pass, its pipeline and its textures.
  const onDraw = (ps, name, a, n, kind) => {
    count(name);
    if (kind === 'draw') {
      draws++;
      instances += n;
    } else dispatches++;
    if (!ps) return '';
    ps.nDraws++;
    ps.inst += n;
    if (!ps.first) ps.first = pipeName(ps.pipeline);
    if (!perDraw && !split) return '';
    return kind === 'draw'
      ? `draw ${ps.nDraws - 1}${name === 'draw' || name === 'drawIndexed' ? '' : ` (${name})`}: ${pipeName(ps.pipeline)}${boundTex(ps)}`
      : `dispatch ${ps.nDraws - 1} ${name === 'dispatchWorkgroups' ? `${a[0] | 0}x${(a[1] ?? 1) | 0}x${(a[2] ?? 1) | 0}` : '(indirect)'}: ${pipeName(ps.pipeline)}${boundTex(ps)}`;
  };
  const instOf = (name, a) => (name === 'draw' || name === 'drawIndexed' ? (a[1] ?? 1) | 0 : 0);

  for (const P of [RP, CP]) {
    patch(P, 'setPipeline', (orig) => function (p) {
      onPipeline(passes.get(this), p);
      return orig.call(this, p);
    });
    patch(P, 'setBindGroup', (orig) => function (i, bg, ...rest) {
      onBindGroup(passes.get(this), i, bg, rest);
      return orig.call(this, i, bg, ...rest);
    });
  }
  patch(RP, 'setVertexBuffer', (orig) => function (slot, buffer, offset, size) {
    onVertexBuffer(passes.get(this), slot, buffer, offset, size);
    return orig.apply(this, arguments);
  });
  patch(RP, 'setIndexBuffer', (orig) => function (buffer, format, offset, size) {
    onIndexBuffer(passes.get(this), buffer, format, offset, size);
    return orig.apply(this, arguments);
  });
  for (const n of STATE_CALLS) {
    patch(RP, n, (orig) => function (...a) {
      onState(passes.get(this), n, a);
      return orig.apply(this, a);
    });
  }
  const timed = (P, name, rawTs, kind) => patch(P, name, (orig) => function (...a) {
    const ps = passes.get(this);
    const n = instOf(name, a);
    const what = onDraw(ps, name, a, n, kind);
    if (perDraw && ps && ps.job && ps.h >= 0) {
      const h = alloc2(ps.job);
      if (h >= 0) {
        const qs = qsOf(ps.job, h);
        rawTs.call(this, qs, h % Q);
        const r = orig.apply(this, a);
        rawTs.call(this, qs, (h % Q) + 1);
        ps.items.push({ h, label: what, inst: n });
        return r;
      }
    }
    return orig.apply(this, a);
  });
  for (const n of RENDER_DRAWS) timed(RP, n, rawTsRender, 'draw');
  for (const n of COMPUTE_DRAWS) timed(CP, n, rawTsCompute, 'dispatch');

  // --split-passes (mode 'split', for a browser without timestamps inside passes): each draw and dispatch in a pass of
  // its own, timed by that pass's timestampWrites. The caller gets a stand-in for its pass that keeps the pass's state
  // and sets it again in each new pass. A first pass clears (when the caller's clears), the draws' passes load and
  // store, and a last pass stores or resolves as the caller's would have (a discard, an MSAA resolve). A draw's time
  // then includes its own pass's beginning and end: an empty pass, timed once per caller's pass, shows how much.
  const splitColour = (desc, phase) => (desc.colorAttachments || []).map((a) => {
    if (!a) return a;
    const o = { ...a };
    if (phase !== 'final') {
      o.storeOp = 'store';
      delete o.resolveTarget;
    }
    if (phase !== 'clear') {
      o.loadOp = 'load';
      delete o.clearValue;
    }
    return o;
  });
  const splitDepth = (a, phase) => {
    const o = { ...a };
    for (const [load, store, clear] of [['depthLoadOp', 'depthStoreOp', 'depthClearValue'], ['stencilLoadOp', 'stencilStoreOp', 'stencilClearValue']]) {
      if (o[load] === undefined) continue; // a read-only aspect has no ops
      if (phase !== 'final') o[store] = 'store';
      if (phase !== 'clear') {
        o[load] = 'load';
        delete o[clear];
      }
    }
    return o;
  };
  const splitClears = (desc) => (desc.colorAttachments || []).some((a) => a && a.loadOp === 'clear')
    || desc.depthStencilAttachment?.depthLoadOp === 'clear' || desc.depthStencilAttachment?.stencilLoadOp === 'clear';
  const splitNeedsFinal = (desc) => (desc.colorAttachments || []).some((a) => a && (a.resolveTarget || a.storeOp === 'discard'))
    || desc.depthStencilAttachment?.depthStoreOp === 'discard' || desc.depthStencilAttachment?.stencilStoreOp === 'discard';
  // A real pass for one phase of the caller's: its attachments' ops for that phase and its own timestamps (none when
  // the pool is used up: the pass still runs, untimed).
  const openSplit = (kind, enc, desc, j, phase) => {
    const h = alloc2(j);
    const d = { ...desc };
    if (kind === 'render') {
      d.colorAttachments = splitColour(desc, phase);
      if (desc.depthStencilAttachment) d.depthStencilAttachment = splitDepth(desc.depthStencilAttachment, phase);
    }
    if (h >= 0) d.timestampWrites = { querySet: qsOf(j, h), beginningOfPassWriteIndex: h % Q, endOfPassWriteIndex: (h % Q) + 1 };
    return { pass: (kind === 'render' ? rawBeginRender : rawBeginCompute).call(enc, d), h };
  };
  const standIn = (kind, enc, desc, ps, j) => {
    const R = kind === 'render' ? rawRender : rawCompute;
    const args = { groups: [], vb: [], ib: null, state: Object.create(null) };
    const copy = (x) => (ArrayBuffer.isView(x) ? x.slice() : Array.isArray(x) ? [...x] : x);
    // The arguments given, without the undefined ones at the end (as the call had them).
    const trim = (a) => {
      let n = a.length;
      while (n > 0 && a[n - 1] === undefined) n--;
      return a.slice(0, n);
    };
    const replay = (p) => {
      if (ps.pipeline) R.setPipeline.call(p, ps.pipeline);
      for (const a of args.groups) if (a) R.setBindGroup.apply(p, a);
      if (kind !== 'render') return;
      for (const a of args.vb) if (a) R.setVertexBuffer.apply(p, a);
      if (args.ib) R.setIndexBuffer.apply(p, args.ib);
      for (const n of STATE_CALLS) if (args.state[n]) R[n].apply(p, args.state[n]);
    };
    const run = (name, a, kindOfCall) => {
      const n = instOf(name, a);
      const what = onDraw(ps, name, a, n, kindOfCall);
      const { pass, h } = openSplit(kind, enc, desc, j, 'draw');
      replay(pass);
      R[name].apply(pass, a);
      R.end.call(pass);
      if (h >= 0) ps.items.push({ h, label: what, inst: n });
    };
    const empty = (phase) => {
      const { pass, h } = openSplit(kind, enc, desc, j, phase);
      R.end.call(pass);
      return h;
    };
    if (kind === 'render' && splitClears(desc)) ps.preH = empty('clear');
    const o = {
      label: desc.label || '',
      setPipeline(p) {
        onPipeline(ps, p);
      },
      setBindGroup(i, bg, ...rest) {
        onBindGroup(ps, i, bg, rest);
        args.groups[i] = [i, bg, ...rest.map(copy)];
      },
      end() {
        if (ps.items.length) ps.calH = empty('draw');
        if (kind === 'render' && splitNeedsFinal(desc)) ps.postH = empty('final');
      },
      pushDebugGroup() {},
      popDebugGroup() {},
      insertDebugMarker() {},
    };
    if (kind === 'render') {
      o.setVertexBuffer = (slot, buffer, offset, size) => {
        onVertexBuffer(ps, slot, buffer, offset, size);
        args.vb[slot] = trim([slot, buffer, offset, size]);
      };
      o.setIndexBuffer = (buffer, format, offset, size) => {
        onIndexBuffer(ps, buffer, format, offset, size);
        args.ib = trim([buffer, format, offset, size]);
      };
      for (const n of STATE_CALLS) {
        o[n] = (...a) => {
          onState(ps, n, a);
          args.state[n] = a.map(copy);
        };
      }
      for (const n of RENDER_DRAWS) o[n] = (...a) => run(n, a, 'draw');
    } else {
      for (const n of COMPUTE_DRAWS) o[n] = (...a) => run(n, a, 'dispatch');
    }
    return o;
  };

  const f0 = px.frameNumber | 0;
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const frames = (px.frameNumber | 0) - f0;
  const elapsed = performance.now() - t0;
  for (let i = saved.length - 1; i >= 0; i--) {
    const [proto, name, d] = saved[i];
    if (d) Object.defineProperty(proto, name, d);
    else delete proto[name];
  }
  // Read what is still in flight (a command buffer finished in the window and submitted after it is not read).
  for (let t = 0; t < 100 && pending.size; t++) await new Promise((resolve) => setTimeout(resolve, 20));
  device.removeEventListener('uncapturederror', onError);
  const lost = pending.size;
  for (const s of free) {
    s.qs.destroy();
    s.res.destroy();
    s.read.destroy();
  }

  const fr = Math.max(1, frames);
  const per = (v) => Math.round((v / fr) * 10) / 10;
  // N-243: the GPU rows carry rates a frame unrounded, with the totals they come from: a pass that runs in fewer than
  // every frame read about +-8 % per draw from a draws-a-frame rounded to 0.1. Only the printed table rounds.
  const rate = (v) => v / fr;
  const perMs = (ns) => ns / 1e6 / fr;
  const median = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : NaN;
  };
  let gpu = null;
  if (timing) {
    const spans = [...frameSpan.values()];
    gpu = {
      perDraw,
      split,
      insidePasses: inside,
      msPerFrame: perMs([...passRows.values()].reduce((s, p) => s + p.ns, 0)),
      spanMsMedian: median(spans.map((f) => Number(f.max - f.min) / 1e6)),
      passSumMsMedian: median(spans.map((f) => f.sum / 1e6)),
      framesTimed: spans.length,
      invalid,
      lost,
      skippedEncoders,
      mapFailures,
      quantized: durations ? Math.round((quantizedDurations / durations) * 1000) / 1000 : null,
      slots: slots.length,
      passes: [...passRows.values()].sort((x, y) => y.ns - x.ns).map((p) => ({
        label: p.label,
        msPerFrame: perMs(p.ns),
        passesPerFrame: rate(p.n),
        drawsPerFrame: rate(p.draws),
        instancesPerFrame: rate(p.instances),
        drawsMsPerFrame: perMs(p.drawNs),
        preMsPerFrame: perMs(p.pre),
        postMsPerFrame: perMs(p.post),
        msPerDraw: p.draws > 0 ? p.drawNs / 1e6 / p.draws : 0,
        // The totals (ns) and the count of passes timed: a pass's mean is ns / n.
        ns: p.ns, n: p.n, drawCount: p.draws, instances: p.instances, drawNs: p.drawNs, preNs: p.pre, postNs: p.post,
        emptyPassNs: p.cal, emptyPasses: p.calN,
      })),
    };
    if (perDraw || split) {
      gpu.draws = [...drawRows.values()].sort((x, y) => y.ns - x.ns).map((r) => ({
        label: r.label, msPerFrame: perMs(r.ns), perFrame: rate(r.n), instancesPerFrame: rate(r.instances), pass: r.pass, ns: r.ns, n: r.n,
        instances: r.instances,
      }));
    }
  }
  const info = renderer.gpu.adapter?.info;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, perFrame: per(n), redundantPerFrame: per(redundant[name] || 0) }));
  return {
    frames,
    ms: Math.round(elapsed),
    adapter: info ? { vendor: info.vendor, architecture: info.architecture, description: info.description, device: info.device } : null,
    features: { timestampQuery: hasTs, insidePasses: inside, requested: meta?.requestedFeatures || null },
    hooks: meta
      ? { beforeDevice: meta.deviceAt > 0 && meta.installedAt < meta.deviceAt, made: meta.made, unknownViews, unknownPipelines: unknownPipes }
      : null,
    errors,
    gpu,
    perFrame: {
      calls: per(Object.values(counts).reduce((s, n) => s + n, 0)),
      renderPasses: per(counts.beginRenderPass || 0),
      computePasses: per(counts.beginComputePass || 0),
      draws: per(draws),
      instances: per(instances),
      dispatches: per(dispatches),
      bytesBuffer: per(bytesBuffer),
      bytesTexture: per(bytesTexture),
      redundant: per(Object.values(redundant).reduce((s, n) => s + n, 0)),
      submits: per(counts.submit || 0),
    },
    top,
    detail: [...detail]
      .map(([key, d]) => ({ key, perFrame: per(d.calls), kbPerFrame: Math.round((d.bytes / 1024 / fr) * 10) / 10 }))
      .sort((x, y) => y.kbPerFrame - x.kbPerFrame || y.perFrame - x.perFrame),
  };
}
