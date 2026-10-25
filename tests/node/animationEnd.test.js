import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { installEmitJs } from '../reference/preRenderEmitJs.mjs';
import { Messages, MESSAGE_ANIMATION_END } from '../../src/core/messages.js';
import { drainMessages } from '../../src/util/messageRing.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

// DX 4.3. A play-once animation could only be watched by polling the frame.
// Pre-render reports its end through the message inboxes; the logic worker
// calls onAnimationEnd(name).

const N = 4;

function bindComponents() {
  for (const C of [Transform, SpriteRenderer, AdobeAnimComponent]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  }
  Transform.entityType.fill(0);
  Transform.entityType[3] = 1; // type 1 does not listen
}

function sent() {
  const out = [];
  drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], (t, f, id, g, a, b) => out.push([t, id, a, b]));
  return out;
}

test('pre-render reports a held last frame once per animation and per spawn', async () => {
  bindComponents();
  const pr = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pr.globalEntityCount = N;
  pr._bindAnimationEndTypes([
    { entityType: 0, animationEnd: true },
    { entityType: 1, animationEnd: false },
  ]);
  Messages.bind(Messages.createBuffers(1, 32, N), []);
  try {
    pr._spriteAnimationEnded(1, 7);
    pr._spriteAnimationEnded(1, 7); // the last frame is still held
    assert.deepEqual(sent(), [[1, MESSAGE_ANIMATION_END, 0, 7]]);
    pr._spriteAnimationEnded(1, 8); // a different animation ended
    Messages.bumpGeneration(1); // despawned, respawned, played 8 again
    pr._spriteAnimationEnded(1, 8);
    assert.deepEqual(sent(), [
      [1, MESSAGE_ANIMATION_END, 0, 8],
      [1, MESSAGE_ANIMATION_END, 0, 8],
    ]);
  } finally {
    Messages.unbind();
  }
});

test('an Adobe clip played without loop reports its end once, only for listening types', async () => {
  bindComponents();
  const pr = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  // The clocks through the JS the kernel replaced (tests/reference): this test mocks the registry's clip lengths,
  // which the kernel reads from its own tables. The end message and its type filter are pre-render's.
  installEmitJs(pr);
  pr._emitWasm = null;
  pr.globalEntityCount = N;
  pr._bindAnimationEndTypes([
    { entityType: 0, animationEnd: true },
    { entityType: 1, animationEnd: false },
  ]);
  const realCount = AdobeAnimRegistry.getClipFrameCount;
  const realRate = AdobeAnimRegistry.getClipFrameRate;
  AdobeAnimRegistry.getClipFrameCount = () => 10;
  AdobeAnimRegistry.getClipFrameRate = () => 10; // a one-second clip
  Messages.bind(Messages.createBuffers(1, 32, N), []);
  try {
    for (const i of [2, 3]) {
      AdobeAnimComponent.active[i] = 1;
      AdobeAnimComponent.playing[i] = 1;
      AdobeAnimComponent.playbackRate[i] = 1;
      AdobeAnimComponent.loop[i] = 0;
      AdobeAnimComponent.clipId[i] = 5;
    }
    pr._frameAdobeEntities = [2, 3];
    pr.advanceAdobeAnimations(600);
    assert.deepEqual(sent(), []);
    pr.advanceAdobeAnimations(600);
    pr.advanceAdobeAnimations(600);
    assert.deepEqual(sent(), [[2, MESSAGE_ANIMATION_END, 1, 5]], 'entity 3 is a type without the hook');
    assert.equal(AdobeAnimComponent.playing[2], 0);
  } finally {
    AdobeAnimRegistry.getClipFrameCount = realCount;
    AdobeAnimRegistry.getClipFrameRate = realRate;
    Messages.unbind();
  }
});

test('the logic worker calls onAnimationEnd with the animation name', async () => {
  bindComponents();
  const w = await loadWorker('logicWorker.js', 'logicWorker');
  const heard = [];
  w.gameObjects = [null, { onAnimationEnd: (name) => heard.push(name) }];
  w.animEndListenerByType = Uint8Array.of(1, 0);
  w.messageListenerByType = Uint8Array.of(0, 0);
  Transform.active[1] = 1;
  SpriteRenderer.spritesheetId[1] = 3;
  const realName = SpriteSheetRegistry.getSpritesheetName;
  const realAnim = SpriteSheetRegistry.getAnimationName;
  SpriteSheetRegistry.getSpritesheetName = (id) => (id === 3 ? 'civil1' : null);
  SpriteSheetRegistry.getAnimationName = (sheet, i) => (sheet === 'civil1' && i === 7 ? 'hurt' : undefined);
  Messages.bind(Messages.createBuffers(1, 32, N), []);
  try {
    Messages.sendSystem(1, MESSAGE_ANIMATION_END, 0, 7);
    drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], w._onMessageEvent);
  } finally {
    SpriteSheetRegistry.getSpritesheetName = realName;
    SpriteSheetRegistry.getAnimationName = realAnim;
    Messages.unbind();
  }
  assert.deepEqual(heard, ['hurt']);
});
