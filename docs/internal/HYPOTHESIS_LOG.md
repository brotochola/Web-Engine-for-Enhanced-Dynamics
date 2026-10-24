# Hypothesis log (moved)

The record of every sitting, kernel run, gate and decision now lives in the register,
[`hypotheses.json`](./hypotheses.json) (`records`), with its date, its time when known, its verdict
and its numbers. Every row this file held is there, linked to its hypothesis.

- Read it in the terminal: `node scripts/hypotheses.mjs log`, `find <text>`, `show <id>`.
- Read it as a page: `node scripts/buildHypothesesPage.mjs --open` (the Timeline tab).
- Add a record: `node scripts/hypotheses.mjs record --hyp <id> --title "…" --verdict <word> --text-file <note.md>`.

A row written below this line by mistake is moved into the register by
`node scripts/hypotheses.mjs import-log`.
