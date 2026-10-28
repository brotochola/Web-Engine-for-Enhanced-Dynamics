#!/usr/bin/env node
/**
 * E-139: the component getters (`this.collider`, `this.rigidBody`, a game's own `this.personComponent`), read from
 * the entities' own tick code the way games read them, over several entity classes.
 *
 *   node tests/bench/componentGetterMicrobench.mjs [--entities 2048] [--output path]
 *
 * shipped: the real GameObject's getters (gameObject.js, the component getter), on five classes.
 * slots:   the same classes' copies with E-139's variant: each class numbers its components, an instance keeps them in
 *          an array made in its constructor, and each getter reads its slot by an integer it captured.
 * Each class's tick reads its components in its own order (a lazily filled cache then has a shape per order).
 * Reports ops/s (one op = one tick of every entity) and a checksum (the sum of the component indices read).
 */
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Component } from '../../src/core/component.js';
import { GameObject } from '../../src/core/gameObject.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

class PersonComponent extends Component {
  static ARRAY_SCHEMA = { health: Float32Array };
}
class LootComponent extends Component {
  static ARRAY_SCHEMA = { money: Float32Array };
}

/** The five classes, as a factory: the shipped run and the slots run each get their own. */
function makeClasses(Base) {
  class Soldier extends Base {
    static components = [RigidBody, Collider, SpriteRenderer, PersonComponent, LootComponent];
    tick() {
      return this.personComponent.index + this.collider.index + this.rigidBody.index + this.lootComponent.index;
    }
  }
  class Civilian extends Base {
    static components = [RigidBody, Collider, SpriteRenderer, PersonComponent];
    tick() {
      return this.spriteRenderer.index + this.personComponent.index + this.collider.index;
    }
  }
  class Crate extends Base {
    static components = [Collider, SpriteRenderer, LootComponent];
    tick() {
      return this.lootComponent.index + this.spriteRenderer.index;
    }
  }
  class Bullet extends Base {
    static components = [RigidBody, Collider];
    tick() {
      return this.rigidBody.index + this.collider.index;
    }
  }
  class Tree extends Base {
    static components = [SpriteRenderer];
    tick() {
      return this.spriteRenderer.index;
    }
  }
  return [Soldier, Civilian, Crate, Bullet, Tree];
}

/** E-139's variant on a class: numbered components, an array per instance, a getter per component reading its slot. */
function installSlotAccessors(Cls) {
  GameObject._assignComponentClassMap(Cls);
  const map = Cls._componentClassMap;
  const names = Object.keys(map);
  Cls._slotCount = names.length;
  names.forEach((name, slot) => {
    const ComponentClass = map[name];
    Object.defineProperty(Cls.prototype, name, {
      get() {
        const c = this._components[slot];
        if (c !== null) return c;
        const made = new ComponentClass(this.index);
        made.owner = this;
        this._components[slot] = made;
        return made;
      },
      enumerable: true,
      configurable: true,
    });
  });
  Cls.prototype._componentAccessorsCreated = true;
}

class SlotBase extends GameObject {
  constructor(...args) {
    super(...args);
    this._components = new Array(this.constructor._slotCount).fill(null);
  }
}

function build(Base, perClass, slots) {
  const classes = makeClasses(Base);
  for (const C of classes) {
    if (slots) installSlotAccessors(C);
    else GameObject._assignComponentClassMap(C);
  }
  const entities = [];
  let index = 0;
  for (let k = 0; k < perClass; k++) for (const C of classes) entities.push(new C(index++, {}, null, { page: true }));
  return entities;
}

function tickAll(entities) {
  let sum = 0;
  for (let i = 0; i < entities.length; i++) sum += entities[i].tick();
  return sum;
}

export function runComponentGetterMicrobench({ entities = 2048 } = {}) {
  const perClass = Math.max(1, Math.round(entities / 5));
  const shipped = build(GameObject, perClass, false);
  const slots = build(SlotBase, perClass, true);
  const checksum = tickAll(shipped);
  if (tickAll(slots) !== checksum) throw new Error('the slots variant reads other components');

  warmNormalCompile(() => tickAll(shipped.slice(0, 50)));
  warmNormalCompile(() => tickAll(slots.slice(0, 50)));
  const cases = {
    shipped: timeIt('shipped', () => tickAll(shipped), { iterations: 200 }),
    slots: timeIt('slots', () => tickAll(slots), { iterations: 200 }),
  };
  const nsPerGet = (c) => (c.ms / c.iterations / (perClass * 13)) * 1e6; // 13 getter reads per round of five
  for (const [name, c] of Object.entries(cases)) console.log(`${name.padEnd(8)} ~${nsPerGet(c).toFixed(2)} ns a getter read`);
  console.log(`checksum ${checksum}`);
  return { feature: 'component-getter', entities: perClass * 5, checksum, cases };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = runComponentGetterMicrobench({ entities: Number(args.entities ?? 2048) });
  if (args.output) writeReport(String(args.output), report);
}
