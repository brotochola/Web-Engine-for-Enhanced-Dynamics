#!/usr/bin/env node
/** The workflow's first job: ci-request.json as the matrix (GITHUB_OUTPUT's `matrix` and `name`), or printed. */
import fs from 'node:fs';

import { expandRequest, readRequest } from './request.mjs';

const req = readRequest('ci-request.json');
const include = expandRequest(req);
const text = `name=${req.name}\nmatrix=${JSON.stringify({ include })}\n`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, text);
for (const e of include) console.log(`${e.id.padEnd(34)} ${e.os.padEnd(18)} ${e.args}`);
console.log(`${include.length} jobs`);
