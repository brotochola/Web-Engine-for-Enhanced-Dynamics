#!/usr/bin/env node
/**
 * E-170: a component's field accessors (`this.health.hp`, `this.ai.timer = 0`), read and written from the entities'
 * own tick code the way games do, over several components whose columns are of different types.
 *
 *   node tests/bench/componentFieldMicrobench.mjs [--entities 2048] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/componentFieldMicrobench.mjs [--args '{"entities":2048}']
 *
 * shipped:  the real Component accessors (component.js, `_createInstanceProperties`).
 * perField: each field's accessor compiled on its own (`new Function`), so its column read is monomorphic.
 * Each run builds its own component classes (the same schemas, the same starting values), and its own entities.
 * Reports the median ms of 200 ticks of every entity, ns a field access, and a checksum (every tick's result summed).
 * Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import { Component } from '../../src/core/component.js';
import { GameObject } from '../../src/core/gameObject.js';

/** Short calls first, so the timed loop is a normal TurboFan compile, not OSR (microbenchHelpers' warmNormalCompile). */
function warm(short, calls = 3000) {
  for (let i = 0; i < calls; i++) short();
}

/** Median ms of `reps` runs of `iterations` calls. */
function medianMs(fn, iterations, reps = 7) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[(times.length / 2) | 0];
}

/** The four components, as a factory: each run gets its own classes and columns. */
function makeComponents() {
  class Health extends Component {
    static ARRAY_SCHEMA = { hp: Float32Array, regen: Float32Array, armor: Int16Array };
  }
  class Ai extends Component {
    static ARRAY_SCHEMA = { state: Uint8Array, timer: Float32Array, target: Int32Array };
  }
  class Loot extends Component {
    static ARRAY_SCHEMA = { money: Float64Array, items: Uint16Array };
  }
  class Motion extends Component {
    static ARRAY_SCHEMA = { speed: Float32Array, heading: Float32Array, flags: Uint32Array };
  }
  return { Health, Ai, Loot, Motion };
}

/** The variant: each scalar field's accessor pair compiled on its own, reading its column by a constant name. */
function installPerField(ComponentClass) {
  for (const [name, spec] of Object.entries(ComponentClass.ARRAY_SCHEMA)) {
    if (ComponentClass._schemaEntry(spec).length !== 1) continue;
    if (Object.getOwnPropertyDescriptor(ComponentClass.prototype, name)) continue;
    const key = JSON.stringify(name);
    const make = new Function(
      'C',
      `return { get() { return C[${key}][this.index]; }, set(value) { C[${key}][this.index] = value; } };`,
    );
    const { get, set } = make(ComponentClass);
    Object.defineProperty(ComponentClass.prototype, name, { get, set, enumerable: true, configurable: true });
  }
}

/** Five entity classes whose ticks read and write their components' fields in their own orders. */
function makeEntities({ Health, Ai, Loot, Motion }) {
  class Soldier extends GameObject {
    static components = [Health, Ai, Motion];
    tick() {
      const h = this.health;
      h.hp = h.hp - h.regen * 0.25;
      if (h.armor > 2) h.armor = h.armor - 1;
      const a = this.ai;
      a.timer = a.timer + 1;
      if (a.timer > 50) {
        a.state = (a.state + 1) & 3;
        a.timer = 0;
      }
      const m = this.motion;
      m.heading = m.heading + m.speed * 0.01;
      return h.hp + a.state + m.heading;
    }
  }
  class Civilian extends GameObject {
    static components = [Ai, Health, Loot];
    tick() {
      const a = this.ai;
      if (a.state === 2) a.target = a.target + 1;
      const l = this.loot;
      l.money = l.money + 0.5;
      const h = this.health;
      h.hp = h.hp + h.regen;
      return a.target + l.money + h.hp;
    }
  }
  class Merchant extends GameObject {
    static components = [Loot, Motion];
    tick() {
      const l = this.loot;
      l.items = (l.items + 1) & 1023;
      const m = this.motion;
      m.flags = m.flags ^ 1;
      m.speed = m.speed * 0.99 + 0.01;
      return l.items + m.flags + m.speed + l.money;
    }
  }
  class Beast extends GameObject {
    static components = [Motion, Health];
    tick() {
      const m = this.motion;
      m.speed = m.speed + 0.02;
      const h = this.health;
      if (h.hp < 10) h.hp = 100;
      return m.speed + h.hp + h.armor;
    }
  }
  class Drone extends GameObject {
    static components = [Ai, Motion];
    tick() {
      const a = this.ai;
      const m = this.motion;
      m.heading = m.heading - 0.01;
      a.timer = a.timer + m.speed;
      return a.timer + m.heading + a.target;
    }
  }
  return [Soldier, Civilian, Merchant, Beast, Drone];
}

/** One run's world: its components (columns filled the same way every time) and entities. */
function build(perField, count) {
  const components = makeComponents();
  for (const C of Object.values(components)) {
    if (perField) installPerField(C);
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(count)), count);
    for (const name of Object.keys(C.ARRAY_SCHEMA)) {
      const column = C[name];
      for (let i = 0; i < count; i++) column[i] = (i * 7 + name.length) % 97;
    }
  }
  const classes = makeEntities(components);
  for (const E of classes) GameObject._assignComponentClassMap(E);
  const entities = [];
  for (let i = 0; i < count; i++) entities.push(new classes[i % classes.length](i, undefined, null, { page: true }));
  return entities;
}

function tickAll(entities) {
  let sum = 0;
  for (let i = 0; i < entities.length; i++) sum += entities[i].tick();
  return sum;
}

export function run({ entities = 2048, iterations = 200 } = {}) {
  const count = Math.max(5, entities | 0);
  // The checksum run: both worlds start alike, and one tick of each must agree.
  const checksum = tickAll(build(false, count));
  if (tickAll(build(true, count)) !== checksum) throw new Error('the per-field variant reads or writes other columns');

  const shipped = build(false, count);
  const perField = build(true, count);
  warm(() => tickAll(shipped.slice(0, 50)));
  warm(() => tickAll(perField.slice(0, 50)));
  const accessesPerRound = 14 + 12 + 9 + 6 + 7; // the five ticks' field reads and writes
  const cases = {};
  for (const [name, world] of [['shipped', shipped], ['perField', perField]]) {
    const ms = medianMs(() => tickAll(world), iterations);
    cases[name] = { ms, iterations, nsPerAccess: (ms / iterations / ((count / 5) * accessesPerRound)) * 1e6 };
  }
  return { feature: 'component-field', entities: count, checksum, cases };
}

const fromCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (fromCli) {
  const { parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  const args = parseArgs();
  const report = run({ entities: Number(args.entities ?? 2048) });
  for (const [name, c] of Object.entries(report.cases)) {
    console.log(`${name.padEnd(8)} ${c.ms.toFixed(1)} ms for ${c.iterations} ticks of all, ~${c.nsPerAccess.toFixed(2)} ns a field access`);
  }
  console.log(`checksum ${report.checksum}`);
  if (args.output) writeReport(String(args.output), report);
}
