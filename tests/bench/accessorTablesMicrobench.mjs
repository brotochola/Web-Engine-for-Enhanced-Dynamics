// Kernel (N-303 CR-29): the call cost of the accessors CR-29 writes from tables, against the hand-written ones they
// replace. Gamepad's pad-0 getters (leftX, isADown, isAPressed, ... read in a loop, as a game's update reads its input),
// with a pad of 4 axes and 17 buttons in the shared data. The getters are called through the class, the way game code
// does; each case warms through short calls first (a normal compile, not OSR). A checksum ties both sides' reads.
//
//   node tests/bench/accessorTablesMicrobench.mjs [--output path]
import { Gamepad } from '../../src/core/gamepad.js';
import { parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;

Gamepad.initialize(new SharedArrayBuffer(Gamepad.BUFFER_SIZE));
const data = new Float32Array(Gamepad._data.buffer);
data[Gamepad._CONNECTED] = 1;
for (let a = 0; a < 4; a++) data[Gamepad._AXIS0 + a] = 0.25 * (a + 1);
for (let b = 0; b < 17; b++) data[Gamepad._BUTTON0 + b] = b % 3 === 0 ? 1 : 0;
Gamepad.updateEdgeFlags();

let sink = 0;
function readSticks() {
  sink += Gamepad.leftX + Gamepad.leftY + Gamepad.rightX + Gamepad.rightY;
}
function readDown() {
  sink += (Gamepad.isADown ? 1 : 0) + (Gamepad.isBDown ? 2 : 0) + (Gamepad.isXDown ? 4 : 0) + (Gamepad.isYDown ? 8 : 0)
    + (Gamepad.isLBDown ? 16 : 0) + (Gamepad.isStartDown ? 32 : 0) + (Gamepad.isUpDown ? 64 : 0) + (Gamepad.isHomeDown ? 128 : 0);
}
function readPressed() {
  sink += (Gamepad.isAPressed ? 1 : 0) + (Gamepad.isBPressed ? 2 : 0) + (Gamepad.isLeftPressed ? 4 : 0)
    + (Gamepad.isRightPressed ? 8 : 0) + (Gamepad.isSelectPressed ? 16 : 0) + (Gamepad.isR3Pressed ? 32 : 0);
}

const cases = { sticks: readSticks, down: readDown, pressed: readPressed };
const results = {};
for (const [name, fn] of Object.entries(cases)) {
  warmNormalCompile(fn);
  results[name] = timeIt(`Gamepad ${name}`, (n) => {
    for (let i = 0; i < n; i++) fn();
  }, { iterations: 200000 });
}
// One call of each, from zero: what the getters read, the same on both sides.
sink = 0;
for (const fn of Object.values(cases)) fn();
console.log(`checksum ${sink}`);
if (OUTPUT) writeReport(OUTPUT, { kernel: 'accessorTables', results, checksum: sink });
