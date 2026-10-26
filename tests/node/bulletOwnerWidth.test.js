import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';

// The bullet's owner is an entity index, so it takes the scene's entity id width: at 32-bit ids a 16-bit column
// cut a shooter past 65 535, and the cast (which excludes the owner by index) let its own bullets hit it.
test('the bullet owner column is as wide as entity ids', () => {
  try {
    for (const [width, Type] of [[16, Uint16Array], [32, Uint32Array]]) {
      bindEntityIdWidth(width);
      const n = 8;
      const sab = new SharedArrayBuffer(BulletComponent.getBufferSize(n));
      BulletComponent.initializeArrays(sab, n);
      assert.ok(BulletComponent.ownerId instanceof Type, `${width}-bit ids: ${Type.name}`);
      if (width === 32) {
        BulletComponent.ownerId[3] = 70000;
        assert.equal(BulletComponent.ownerId[3], 70000, 'a shooter past 65 535 is kept');
      }
    }
  } finally {
    bindEntityIdWidth(16);
  }
});
