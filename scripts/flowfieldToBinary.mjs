// Converts JSON static flowfields to WeedJS's binary format (WEFF version 1, see src/core/staticFlowfieldFile.js).
// The cells come out as the JSON loader makes them, so a scene samples the same field from either file.
//
//   node scripts/flowfieldToBinary.mjs <field.json> [more.json ...] [--out <dir>] [--raw]
//
// Each field.json becomes field.bin beside it, or in --out. The cells are gzipped unless --raw is given.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeStaticFlowfield, staticFlowfieldFromJSON } from '../src/core/staticFlowfieldFile.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : null;
const raw = args.includes('--raw');
const inputs = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!inputs.length || (outAt >= 0 && !outDir)) {
  console.log(
    'usage: node scripts/flowfieldToBinary.mjs <field.json> [more.json ...] [--out <dir>] [--raw]'
  );
  process.exit(1);
}
if (outDir) mkdirSync(outDir, { recursive: true });

let jsonBytes = 0;
let binBytes = 0;
for (const input of inputs) {
  const text = readFileSync(input, 'utf8');
  const field = staticFlowfieldFromJSON(JSON.parse(text));
  const bin = await encodeStaticFlowfield(field, { compress: !raw });
  const output = path.join(
    outDir || path.dirname(input),
    path.basename(input, path.extname(input)) + '.bin'
  );
  writeFileSync(output, bin);
  jsonBytes += Buffer.byteLength(text);
  binBytes += bin.length;
  console.log(
    `${input} -> ${output}: ${field.gridWidth} x ${field.gridHeight} cells of ${field.cellSize} px, ` +
      `${Buffer.byteLength(text)} -> ${bin.length} bytes`
  );
}
if (inputs.length > 1) {
  console.log(
    `${inputs.length} fields: ${jsonBytes} -> ${binBytes} bytes (${((binBytes / jsonBytes) * 100).toFixed(1)} %)`
  );
}
