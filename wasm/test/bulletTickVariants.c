/* The bullet tick's variants the shipped one beat (E-76 W19), a test module (N-303 CR-11): bullet_tick (no hoist, ray
   stamps), bullet_tick_hoist (stamps) and bullet_tick_nostamp (no hoist), beside the shipped bullet_tick_lean and its
   32-bit forms (included). Every variant writes the same bytes (tests/node/bulletTickWasm.test.js); the stamps need
   readyBulletStamps before a call and a stamp region in the layout, which the engine no longer has. */
#include "../bulletTick.c"

BULLET_TICK(bullet_tick, 0, 1, 0, 0)
BULLET_TICK(bullet_tick_hoist, 1, 1, 0, 0)
BULLET_TICK(bullet_tick_nostamp, 0, 0, 0, 0)
