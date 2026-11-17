// The Pixi worker's WebGL2 program links and frames, for tests/bench/programLinkProbe.mjs (E-475), installed before the
// worker's own modules run (programLinkProbeWorker.js imports this first). Each link: its program's name (the shaders'
// SHADER_NAME), when linkProgram was called, when LINK_STATUS was first read and how long that call blocked (the link's
// wait: Pixi reads it right after linkProgram, or at the first bind of a program linked ahead); the COMPLETION_STATUS_KHR
// polls and their time; every draw call; and each requestAnimationFrame callback's start, length and draws. Read back as
// self.__programLinkProbe; times are the worker's performance.now().
const COMPLETION_STATUS_KHR = 0x91b1;
const P = WebGL2RenderingContext.prototype;
const probe = {
  timeOrigin: performance.timeOrigin,
  links: [],
  /** Flat: start, ms, draws for each requestAnimationFrame callback. */
  frames: [],
  polls: 0,
  pollMs: 0,
  draws: 0,
  firstDrawAt: -1,
};
self.__programLinkProbe = probe;

const shaderNames = new WeakMap();
const programNames = new WeakMap();
const openLinks = new WeakMap();

const shaderSource = P.shaderSource;
P.shaderSource = function (shader, source) {
  const m = /#define\s+SHADER_NAME\s+(\S+)/.exec(source);
  shaderNames.set(shader, m ? m[1] : `${source.length} chars`);
  return shaderSource.call(this, shader, source);
};
const attachShader = P.attachShader;
P.attachShader = function (program, shader) {
  const name = (shaderNames.get(shader) || '?').replace(/-(vertex|fragment)(-\d+)?$/, '$2');
  const prev = programNames.get(program);
  programNames.set(program, prev === undefined || prev === name ? name : `${prev} + ${name}`);
  return attachShader.call(this, program, shader);
};
const linkProgram = P.linkProgram;
P.linkProgram = function (program) {
  const link = { name: programNames.get(program) || '?', linkAt: performance.now(), readAt: -1, blockedMs: -1 };
  probe.links.push(link);
  openLinks.set(program, link);
  return linkProgram.call(this, program);
};
const getProgramParameter = P.getProgramParameter;
P.getProgramParameter = function (program, pname) {
  const start = performance.now();
  const value = getProgramParameter.call(this, program, pname);
  const end = performance.now();
  if (pname === COMPLETION_STATUS_KHR) {
    probe.polls++;
    probe.pollMs += end - start;
  } else if (pname === this.LINK_STATUS) {
    const link = openLinks.get(program);
    if (link !== undefined) {
      link.readAt = start;
      link.blockedMs = end - start;
      openLinks.delete(program);
    }
  }
  return value;
};
for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
  const draw = P[name];
  P[name] = function (...args) {
    if (probe.firstDrawAt < 0) probe.firstDrawAt = performance.now();
    probe.draws++;
    return draw.apply(this, args);
  };
}
const raf = self.requestAnimationFrame.bind(self);
self.requestAnimationFrame = (callback) =>
  raf((ts) => {
    const start = performance.now();
    const draws = probe.draws;
    try {
      callback(ts);
    } finally {
      probe.frames.push(start, performance.now() - start, probe.draws - draws);
    }
  });
