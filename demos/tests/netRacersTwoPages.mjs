#!/usr/bin/env node
/**
 * Net Racers across two pages of one Chromium (signaling 'local', real WebRTC).
 *
 *   npm run dev                              (another terminal; or PORT=8123 node server/node_server.js)
 *   node demos/tests/netRacersTwoPages.mjs [--base http://localhost:8000] [--shots dir] [--headed]
 *
 * Host creates a room, guest joins by code, host starts. The guest drives, then
 * the host (one second of W each). Checks:
 *   - the guest's input packets drive the guest's car on the host, and only that car
 *   - the host's keyboard drives the host's car
 *   - the guest sees both cars where the host has them (within 40 px)
 *   - the guest's camera follows its own car (bodiless puppet)
 *   - "End race" brings both back to the same lobby room
 * Exit code 0 when every check passes. Docs: docs/internal/NETWORKING_PLAN.md (N0).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const BASE = arg('base', process.env.WEED_BASE || 'http://localhost:8000');
const SHOTS = arg('shots', null);
const headed = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  // Host candidates with real addresses: mDNS names do not resolve in every container.
  args: [
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const host = await ctx.newPage();
const guest = await ctx.newPage();
for (const [p, n] of [
  [host, 'host'],
  [guest, 'guest'],
]) {
  p.on('pageerror', (e) => failures.push(`${n} page error: ${e.message}`));
}
const shot = async (p, name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, name) });
};

const url = (extra = '') => `${BASE}/demos/index.html?scene=netracers&net=local&debug=0${extra}`;

try {
  await host.goto(url());
  await host.waitForSelector('#nr-create', { timeout: 60000 });
  await host.fill('#nr-name', 'Host');
  await host.click('#nr-create');
  await host.waitForSelector('#nr-room-code', { timeout: 20000 });
  const code = (await host.textContent('#nr-room-code')).trim();
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `room code ${code}`);

  await guest.goto(url(`&room=${code}`));
  await guest.waitForSelector('#nr-join', { timeout: 60000 });
  await guest.fill('#nr-name', 'Guest');
  await guest.click('#nr-join');
  await guest.waitForSelector('#nr-room-code', { timeout: 20000 });
  await host.waitForFunction(
    () => document.querySelectorAll('.nr-player:not(.nr-empty)').length === 2,
    null,
    {
      timeout: 15000,
    }
  );
  check(true, 'guest joined the lobby');
  await shot(host, '1-lobby-host.png');
  await shot(guest, '2-lobby-guest.png');

  await host.click('#nr-start');
  const raceReady = (p) =>
    p.waitForFunction(
      () =>
        window.scene &&
        window.scene.constructor.name === 'NetRaceScene' &&
        window.scene.byNetId.size > 0,
      null,
      { timeout: 60000 }
    );
  await Promise.all([raceReady(host), raceReady(guest)]);
  await sleep(2000);

  const pos = (p, id) =>
    p.evaluate((netId) => {
      const e = window.scene.byNetId.get(netId);
      const T = window.WEED.Transform;
      return e ? [T.x[e.index], T.y[e.index], T.rotation[e.index]] : null;
    }, id);
  const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  // Coasting cars move between the host read and the guest read, and the guest
  // trails by its smoothing (~60 ms): compare positions once both cars stopped.
  const settle = () =>
    host.waitForFunction(
      () => {
        const RB = window.WEED.RigidBody;
        return [0, 1].every((id) => RB.speed[window.scene.byNetId.get(id).index] < 5);
      },
      null,
      { timeout: 15000, polling: 100 }
    );
  // One second of throttle, then the car coasts to a stop (one driver at a time).
  const drive = async (page) => {
    await page.keyboard.down('w');
    await sleep(1000);
    await page.keyboard.up('w');
  };

  // 1. Only the guest drives: its car moves on the host, the host's does not.
  const t0 = { h0: await pos(host, 0), h1: await pos(host, 1) };
  await drive(guest);
  await settle();
  const t1 = { h0: await pos(host, 0), h1: await pos(host, 1) };
  check(
    dist(t0.h1, t1.h1) > 150,
    `guest input drove the guest car on the host: ${dist(t0.h1, t1.h1).toFixed(0)} px`
  );
  check(dist(t0.h0, t1.h0) < 20, `and not the host car: ${dist(t0.h0, t1.h0).toFixed(1)} px`);

  // 2. Only the host drives.
  await drive(host);
  await shot(host, '3-race-host.png');
  await shot(guest, '4-race-guest.png');
  await settle();
  await sleep(600);
  const end = {
    h0: await pos(host, 0),
    h1: await pos(host, 1),
    g0: await pos(guest, 0),
    g1: await pos(guest, 1),
  };
  check(
    dist(t1.h0, end.h0) > 150,
    `host keyboard drove the host car: ${dist(t1.h0, end.h0).toFixed(0)} px`
  );
  check(
    dist(end.h0, end.g0) < 40,
    `guest sees the host car within ${dist(end.h0, end.g0).toFixed(1)} px`
  );
  check(
    dist(end.h1, end.g1) < 40,
    `guest sees its own car within ${dist(end.h1, end.g1).toFixed(1)} px`
  );

  const view = await guest.evaluate(() => {
    const e = window.scene.byNetId.get(1);
    const T = window.WEED.Transform;
    const v = window.WEED.Camera.getViewportBounds();
    return { x: T.x[e.index], y: T.y[e.index], v };
  });
  const inView =
    view.x > view.v.left && view.x < view.v.right && view.y > view.v.top && view.y < view.v.bottom;
  check(inView, 'guest camera shows the guest car');

  const rtt = await guest.evaluate(() => window.scene.net.rtt(window.scene.net.hostId));
  check(rtt >= 0 && rtt < 200, `ping ${rtt.toFixed(1)} ms`);

  await host.click('.nr-hud .nr-btn');
  await Promise.all(
    [host, guest].map((p) => p.waitForSelector('#nr-room-code', { timeout: 60000 }))
  );
  const back = [
    (await host.textContent('#nr-room-code')).trim(),
    (await guest.textContent('#nr-room-code')).trim(),
  ];
  check(back[0] === code && back[1] === code, `both back in room ${code}`);
} catch (e) {
  failures.push(`threw: ${e.message}`);
  console.error(e);
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall checks passed');
