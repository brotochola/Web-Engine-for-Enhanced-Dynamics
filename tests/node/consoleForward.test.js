// The editor's console (VISUAL_EDITOR_PLAN.md ED-18): a console's calls passed on as text while it is on, off by
// default and put back exactly when turned off; at most MAX_PER_SECOND a second, the rest counted in one line. A
// worker turns it on and off with a 'consoleForward' message and posts each call as a `log` message; the scene hands
// those to the debug UI, and the console panel draws them, one row per line repeated, errors with their counts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleForward, formatConsoleArgs, MAX_PER_SECOND, MAX_TEXT, CONSOLE_LEVELS } from '../../src/util/consoleForward.js';
import { AbstractWorker } from '../../src/workers/abstractWorker.js';
import { Scene } from '../../src/core/scene.js';
import { ConsolePanel } from '../../src/core/debug/editor/consolePanel.js';

test('formatConsoleArgs: one line, as DevTools joins a call', () => {
  assert.equal(formatConsoleArgs(['hit', 3, true, null, undefined]), 'hit 3 true null undefined');
  assert.equal(formatConsoleArgs(['%cWeedJS%c ready', 'color:red', 'color:blue']), 'WeedJS ready', 'styles dropped');
  assert.equal(formatConsoleArgs(['%s has %d hp (%i)', 'Boss', 12.7, 3.9, 'extra']), 'Boss has 12 hp (3) extra');
  assert.equal(formatConsoleArgs(['100%% done']), '100% done');
  assert.equal(formatConsoleArgs([{ x: 1, y: [2, 3] }]), '{"x":1,"y":[2,3]}');
  const loop = { name: 'loop' };
  loop.self = loop;
  assert.equal(formatConsoleArgs([loop]), '[object Object]', 'a circular object does not throw');
  assert.equal(formatConsoleArgs([new Float32Array(4)]), 'Float32Array(4)');
  assert.equal(formatConsoleArgs([function onHit() {}]), 'ƒ onHit');
  const error = new Error('boom');
  assert.match(formatConsoleArgs(['failed:', error]), /^failed: Error: boom\n {4}at /, 'an error with its stack');
  assert.equal(formatConsoleArgs(['x'.repeat(MAX_TEXT + 50)]).length, MAX_TEXT + 1, 'cut, with an ellipsis');
});

/** A console of our own, so the test's output stays clean. */
function fakeConsole() {
  const calls = [];
  const target = {};
  for (const level of CONSOLE_LEVELS) target[level] = (...args) => calls.push([level, ...args]);
  return { target, calls };
}

test('off by default; on passes each call on and still calls the console; off puts the very same methods back', () => {
  const { target, calls } = fakeConsole();
  const originals = { ...target };
  const posted = [];
  const forward = createConsoleForward(target, (entry) => posted.push(entry), () => 5000);
  target.log('before');
  assert.equal(forward.on, false);
  forward.set(true);
  target.warn('low hp', 3);
  target.error(new Error('x'));
  assert.deepEqual(calls.map((c) => c[0]), ['log', 'warn', 'error'], 'the console still gets every call');
  assert.deepEqual(posted.map((p) => [p.level, p.text.split('\n')[0], p.when]), [
    ['warn', 'low hp 3', 5000],
    ['error', 'Error: x', 5000],
  ]);
  forward.set(false);
  for (const level of CONSOLE_LEVELS) assert.equal(target[level], originals[level], level);
  target.log('after');
  assert.equal(posted.length, 2);
});

test(`at most ${MAX_PER_SECOND} calls a second go on; the rest are counted in one line the next second`, () => {
  const { target } = fakeConsole();
  const posted = [];
  let now = 10_000;
  const forward = createConsoleForward(target, (entry) => posted.push(entry), () => now);
  forward.set(true);
  for (let i = 0; i < MAX_PER_SECOND + 30; i++) target.log(`frame ${i}`);
  assert.equal(posted.length, MAX_PER_SECOND);
  now += 1000;
  target.log('next second');
  assert.deepEqual(posted.slice(-2).map((p) => p.text), [`30 console calls not shown (more than ${MAX_PER_SECOND} a second)`, 'next second']);
});

test('a post that throws (the page went) does not break the caller', () => {
  const { target, calls } = fakeConsole();
  const forward = createConsoleForward(target, () => {
    throw new Error('gone');
  });
  forward.set(true);
  target.log('still logs');
  assert.deepEqual(calls, [['log', 'still logs']]);
  forward.set(false);
});

test('a worker turns forwarding on and off with consoleForward, and posts each call as a log message', async () => {
  const previousSelf = globalThis.self;
  const posted = [];
  globalThis.self = { postMessage: (m) => posted.push(m) };
  const info = console.info;
  console.info = () => {};
  try {
    await AbstractWorker.prototype.handleMessage.call({}, { data: { msg: 'consoleForward', on: true } });
    console.info('spawned', 4);
    await AbstractWorker.prototype.handleMessage.call({}, { data: { msg: 'consoleForward', on: false } });
    console.info('not passed on');
    assert.deepEqual(posted.map((m) => [m.msg, m.level, m.text]), [['log', 'info', 'spawned 4']]);
  } finally {
    console.info = info;
    globalThis.self = previousSelf;
  }
});

test('the scene hands a worker’s console call to the debug UI, and its own start-up notes not', () => {
  const entries = [];
  const scene = Object.create(Scene.prototype);
  scene.game = { debugUI: { onConsoleEntry: (source, entry) => entries.push([source, entry.level, entry.text]) } };
  scene.handleMessageFromWorker({ data: { msg: 'log', level: 'warn', text: 'low hp', when: 1 }, currentTarget: { name: 'logic1' } });
  scene.handleMessageFromWorker({ data: { msg: 'log', message: 'received start signal', when: 1 }, currentTarget: { name: 'logic0' } });
  assert.deepEqual(entries, [['logic1', 'warn', 'low hp']]);
  const sent = [];
  scene.workers = {
    logicWorkers: [{ postMessage: (m) => sent.push(['logic0', m.on]) }],
    spatialWorkers: [],
    preRenderWorkers: [{ postMessage: (m) => sent.push(['preRender0', m.on]) }],
    particle: null,
    renderer: { postMessage: (m) => sent.push(['renderer', m.on]) },
    physics: { postMessage: () => sent.push(['physics']) },
  };
  scene._setConsoleForward(true);
  assert.deepEqual(sent, [['logic0', true], ['preRender0', true], ['renderer', true]], 'not physics’ own worker');
});

// ---- the panel, against a small fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this._text = '';
    this.classList = { add() {}, toggle() {} };
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get textContent() {
    return this._text;
  }
  set textContent(text) {
    this._text = text;
    this.children = []; // as the DOM: setting it takes the children out
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  appendChild(node) {
    this.children.push(node);
    node.parent = this;
    return node;
  }
  remove() {
    const list = this.parent?.children;
    if (list) list.splice(list.indexOf(this), 1);
  }
}

test('the panel draws at the tick, counts a repeated line on its row, and keeps one row per game code error', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const panel = new ConsolePanel({ editMode: {}, scene: null });
    panel.add('logic0', 'log', 'tick');
    panel.add('logic0', 'log', 'tick');
    assert.equal(panel._list.children.length, 0, 'nothing drawn before the tick');
    panel.update();
    assert.equal(panel._list.children.length, 1);
    panel.add('logic0', 'log', 'tick');
    panel.update();
    assert.equal(panel._list.children.length, 1, 'the same line again: its count');
    assert.equal(panel.entries[0].countEl.textContent, '×3');
    panel.add('logic1', 'log', 'tick');
    panel.update();
    assert.equal(panel._list.children.length, 2, 'another worker’s line is a row of its own');

    const rec = { phase: 'tick', className: 'Enemy', entityIndex: 12, message: 'x is undefined', counts: new Map([['logic0', 1]]) };
    panel.entityError('Enemy|tick|x is undefined', rec);
    panel.update();
    const row = panel._list.children[2];
    assert.equal(row.children[1].textContent, 'Enemy #12 · tick threw: x is undefined');
    assert.equal(row.dataset.entity, '12', 'a click selects it');
    rec.counts.set('logic0', 40);
    rec.counts.set('logic1', 2);
    panel.entityError('Enemy|tick|x is undefined', rec);
    assert.equal(row.children[2].textContent, '×42', 'the count of every worker, on the same row');
    panel.newScene();
    panel.entityError('Enemy|tick|x is undefined', rec);
    panel.update();
    assert.equal(panel._list.children.length, 4, 'another scene’s error is a row of its own');
    panel.clear();
    assert.deepEqual([panel.entries.length, panel._list.children.length], [0, 0]);
  } finally {
    delete globalThis.document;
  }
});
