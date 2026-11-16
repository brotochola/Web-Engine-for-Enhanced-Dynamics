// Runs GameObject's per-frame setters, so `node --print-bytecode --print-bytecode-filter=set* <this file>` prints
// their bytecode (V8 makes it on a function's first call). setterBytecodeSize.test.js reads the lengths.
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';

const N = 2;
Transform.x = new Float32Array(N);
Transform.y = new Float32Array(N);
Transform.rotC = new Float32Array(N).fill(1);
Transform.rotS = new Float32Array(N);
Transform.entityType = new Uint8Array(N);
RigidBody.vx = new Float32Array(N);
RigidBody.vy = new Float32Array(N);
RigidBody.angularVelocity = new Float32Array(N);
for (const k of ['alpha', 'animationSpeed', 'scaleX', 'scaleY']) SpriteRenderer[k] = new Float32Array(N);
for (const k of ['renderDirty', 'keyedDirty', 'flip']) SpriteRenderer[k] = new Uint8Array(N);
SpriteRenderer.updateBounds = () => {};
for (const k of ['alpha', 'scaleX', 'scaleY']) AdobeAnimComponent[k] = new Float32Array(N);
AdobeAnimComponent.flip = new Uint8Array(N);
AdobeAnimComponent.applyClipBounds = () => {};
MeshRenderer.alpha = new Float32Array(N);
MeshRenderer.renderDirty = new Uint8Array(N);

const e = Object.create(GameObject.prototype);
e.index = 1;
e._hasComponents = { RigidBody: true, SpriteRenderer: true, adobeAnimComponent: true, MeshRenderer: true };
e.x = 0.3;
e.y = 0.3;
e.vx = 0.3;
e.vy = 0.3;
e.angularVelocity = 0.3;
e.alpha = 0.3;
e.setAlpha(0.4);
e.setAnimationSpeed(0.3);
e.setPosition(1.3, 2.3);
e.setVelocity(1.3, 2.3);
e.setScale(0.3, 0.7);
