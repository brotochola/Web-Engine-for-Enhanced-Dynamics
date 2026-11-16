/**
 * A kernel's ASan module in Node (tests/asan/asanBuild.mjs builds it): its instance, the arrays a case malloc's in it
 * (each with ASan's redzones around it, and a name for the reports), ASan's reports parsed and symbolized
 * (llvm-symbolizer on the build's DWARF, inlined frames included), and a fresh instance after a call that reported.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findEmsdk, repoRoot } from './asanBuild.mjs';

export class AsanSession {
  /** @param {ReturnType<import('./asanBuild.mjs').buildAsanKernel>} build */
  constructor(build) {
    this.build = build;
    this.factory = null;
    this.mod = null;
    this.lines = [];
    this.allocs = [];
    /** Every array ever malloc'd in this instance, by address (a report may name one freed since). */
    this.history = new Map();
    this.bytes0 = 0;
    this.instances = 0;
  }

  async start() {
    if (!this.factory) this.factory = (await import(pathToFileURL(this.build.mjs).href)).default;
    this.lines = [];
    this.allocs = [];
    this.history = new Map();
    const sink = (s) => this.lines.push(String(s));
    this.mod = await this.factory({ print: sink, printErr: sink });
    this.bytes0 = this.mod.wasmMemory.buffer.byteLength;
    this.instances++;
    return this;
  }

  /**
   * A fresh instance (after a call that wrote into a redzone: the allocator keeps its records there). The old one's
   * memory is collected first (runAsan.mjs runs with --expose-gc): a few of them at once exhaust the address space.
   */
  async reset() {
    this.mod = null;
    this.allocs = [];
    this.history = new Map();
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
      await new Promise((resolve) => setTimeout(resolve, 0));
      globalThis.gc();
    }
    return this.start();
  }

  /** The instance's memory (shared: the product's clients bind the shipped engine.wasm on it too). */
  get memory() {
    return this.mod.wasmMemory;
  }

  get buffer() {
    return this.mod.wasmMemory.buffer;
  }

  /** Kernel export `name` of the ASan build. */
  fn(name) {
    const f = this.mod[`_${name}`];
    if (typeof f !== 'function') throw new Error(`${this.build.name} (ASan) has no export ${name}`);
    return f;
  }

  /**
   * `bytes` bytes of the module's heap, named for the reports; `productBytes`, when the product's region is larger than
   * what the case allocates, says so in a report past the array's end.
   */
  malloc(bytes, name, productBytes = 0) {
    const n = Math.max(0, Math.floor(bytes));
    const ptr = this.mod._malloc(n);
    if (!ptr) throw new Error(`asan: malloc(${n}) for ${name} failed`);
    const rec = { ptr, bytes: n, name, productBytes };
    this.allocs.push(rec);
    this.history.set(ptr, rec);
    return ptr;
  }

  /** A typed array of n elements in its own malloc'd block. */
  alloc(Ctor, n, name, productLength = 0) {
    const ptr = this.malloc(n * Ctor.BYTES_PER_ELEMENT, name, productLength * Ctor.BYTES_PER_ELEMENT);
    return new Ctor(this.buffer, ptr, n);
  }

  freeAll() {
    for (const a of this.allocs) this.mod._free(a.ptr);
    this.allocs = [];
  }

  /** Throws when the memory grew (a grown shared memory hands out a new buffer the clients would not take). */
  checkGrowth() {
    const now = this.mod.wasmMemory.buffer.byteLength;
    if (now !== this.bytes0) {
      throw new Error(`asan: the module's memory grew from ${this.bytes0} to ${now} bytes; raise INITIAL_MEMORY in asanBuild.mjs`);
    }
  }

  /** The output since the last drain. */
  drain() {
    const out = this.lines;
    this.lines = [];
    return out;
  }

  /** ASan's reports in the output since the last drain, parsed (null when there are none). */
  takeReports() {
    const lines = this.drain();
    const reports = parseReports(lines, this);
    return reports.length ? reports : null;
  }
}

const HEX = '0x[0-9a-fA-F]+';

/**
 * ASan's reports in `lines` (each starts with the ===== line): the kind, the access, the wasm frames and the region it
 * fell around, with the region's name from the session's records.
 */
export function parseReports(lines, session) {
  const reports = [];
  let cur = null;
  let inAccessFrames = false;
  for (const raw of lines) {
    for (const line of raw.split('\n')) {
      if (/^=+$/.test(line.trim())) {
        cur = { kind: '?', address: 0, access: null, frames: [], location: null, raw: [] };
        reports.push(cur);
        inAccessFrames = false;
        continue;
      }
      if (!cur) continue;
      cur.raw.push(line);
      let m = line.match(new RegExp(`ERROR: AddressSanitizer: ([\\w-]+)(?: on (?:unknown )?address (${HEX}))?`));
      if (m) {
        cur.kind = m[1];
        cur.address = m[2] ? parseInt(m[2], 16) : 0;
        continue;
      }
      m = line.match(new RegExp(`^(READ|WRITE) of size (\\d+) at (${HEX})`));
      if (m) {
        cur.access = { op: m[1], size: Number(m[2]), address: parseInt(m[3], 16) };
        inAccessFrames = true;
        continue;
      }
      m = line.match(new RegExp(`^\\s+#(\\d+) (${HEX})`));
      if (m && inAccessFrames) {
        const pc = parseInt(m[2], 16);
        // Frames past 0x80000000 are JavaScript's (Emscripten numbers them so).
        if (pc < 0x80000000) cur.frames.push(pc);
        continue;
      }
      if (line.trim() === '') {
        inAccessFrames = false;
        continue;
      }
      m = line.match(new RegExp(`^(${HEX}) is located (\\d+) bytes (after|before|inside of|to the right of|to the left of) (\\d+)-byte region \\[(${HEX}),(${HEX})\\)`));
      if (m) {
        const start = parseInt(m[5], 16);
        const rec = session ? session.history.get(start) : null;
        cur.location = {
          offset: Number(m[2]),
          side: m[3],
          regionBytes: Number(m[4]),
          start,
          name: rec ? rec.name : null,
          productBytes: rec ? rec.productBytes : 0,
        };
        continue;
      }
      m = line.match(/^(0x[0-9a-fA-F]+ is located .*|Address 0x[0-9a-fA-F]+ is .*)$/);
      if (m && !cur.location) cur.location = { text: m[1] };
    }
  }
  return reports;
}

const symbolCache = new Map();

/**
 * The source frames of wasm code offsets in a build (inlined frames innermost first), from llvm-symbolizer on its DWARF:
 * [{ fn, file, line, col }], the file as its repo path (with @rev for a revision's build).
 */
export function symbolize(build, pcs) {
  const key = (pc) => `${build.wasm}#${pc}`;
  const todo = [...new Set(pcs)].filter((pc) => !symbolCache.has(key(pc)));
  if (todo.length) {
    let text = '';
    try {
      text = execFileSync(findEmsdk().symbolizer, [`--obj=${build.wasm}`, '--inlining', ...todo.map((pc) => `0x${pc.toString(16)}`)],
        { encoding: 'utf8', maxBuffer: 16 << 20 });
    } catch (err) {
      text = '';
    }
    const blocks = text.replace(/\r/g, '').split('\n\n');
    todo.forEach((pc, i) => {
      const lines = (blocks[i] || '').split('\n').filter((l) => l.length);
      const frames = [];
      for (let j = 0; j + 1 < lines.length; j += 2) {
        const m = lines[j + 1].match(/^(.*):(\d+):(\d+)$/);
        frames.push({ fn: lines[j], file: m ? repoFile(build, m[1]) : lines[j + 1], line: m ? Number(m[2]) : 0, col: m ? Number(m[3]) : 0 });
      }
      symbolCache.set(key(pc), frames);
    });
  }
  return pcs.map((pc) => symbolCache.get(key(pc)) || []);
}

/** A DWARF file name of the build as the repo path it came from. */
function repoFile(build, file) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  const f = norm(file);
  for (const s of build.sources) {
    if (norm(s.file) === f) return build.rev ? `${s.repoPath}@${build.rev}` : s.repoPath;
  }
  const rel = path.relative(repoRoot, path.resolve(file)).replace(/\\/g, '/');
  return rel.startsWith('..') ? file.replace(/\\/g, '/') : rel;
}

/** A report in a few lines: what, where (source frames), which array, and how far past it. */
export function describeReport(build, report) {
  const out = [];
  const acc = report.access ? `${report.access.op} of ${report.access.size} bytes` : 'access';
  out.push(`${report.kind}: ${acc} at 0x${(report.access?.address ?? report.address).toString(16)}`);
  const loc = report.location;
  if (loc && loc.name !== undefined) {
    const where = loc.side === 'inside of' ? `${loc.offset} bytes into` : `${loc.offset} bytes ${loc.side}`;
    let note = '';
    if (loc.side === 'after' && loc.productBytes > loc.regionBytes) {
      note = loc.regionBytes + loc.offset < loc.productBytes
        ? ` (the case sized it to the call; inside the ${loc.productBytes}-byte region the product reserves)`
        : ` (past the ${loc.productBytes}-byte region the product reserves too)`;
    }
    out.push(`  ${where} the ${loc.regionBytes}-byte array '${loc.name ?? '?'}'${note}`);
  } else if (loc && loc.text) {
    out.push(`  ${loc.text}`);
  }
  const frames = symbolize(build, report.frames);
  let shown = 0;
  for (let i = 0; i < frames.length && shown < 6; i++) {
    for (const f of frames[i]) {
      if (shown >= 6) break;
      if (/^__asan|^__sanitizer/.test(f.fn)) continue;
      out.push(`  ${shown === 0 ? 'at' : 'in'} ${f.fn} ${f.file}:${f.line}:${f.col}`);
      shown++;
    }
  }
  if (!shown) out.push(`  at wasm offsets ${report.frames.map((pc) => `0x${pc.toString(16)}`).join(' ') || '(none)'}`);
  return out;
}

/** What a finding is, for counting repeats: the kind, the access and its innermost source line. */
export function reportKey(build, report) {
  const top = symbolize(build, report.frames.slice(0, 1))[0]?.[0];
  return `${report.kind}|${report.access?.op ?? ''}|${top ? `${top.file}:${top.line}:${top.col}` : report.frames[0] ?? ''}|${report.location?.name ?? ''}`;
}
