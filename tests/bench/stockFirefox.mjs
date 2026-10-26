// --browser firefox: the Firefox installed on this machine, started without Playwright. Playwright's own Firefox build
// (153) ran WASM 5–18x slower than release Firefox 158 on the same machine, with or without Playwright attached, while
// its JS ran at the same speed (2026-10-24, a two-loop probe): its numbers are not Firefox's. Here the bench page loads
// stockDriver.js (?stockDriver=1), which takes this module's calls over HTTP, so the runner's page.evaluate and
// waitForFunction work as they do with Playwright. Tracing, screenshots, the window watch and the viewport size (all
// Chrome's CDP or Playwright's) do not; worker console lines only arrive when the engine forwards them to the page.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fresh profile otherwise stops on first-run pages or the default-browser prompt, holds its first request while it
// looks for a proxy (30 s and more here), upgrades http to https, or syncs settings, block lists and updates in the
// background while the scene runs (the quieting prefs are the ones Playwright's playwright.cfg sets).
const PREFS = {
  'network.proxy.type': 0,
  'network.captive-portal-service.enabled': false,
  'network.connectivity-service.enabled': false,
  'services.settings.server': '',
  'app.normandy.enabled': false,
  'app.normandy.api_url': '',
  'app.update.enabled': false,
  'app.update.service.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'browser.safebrowsing.phishing.enabled': false,
  'browser.safebrowsing.downloads.enabled': false,
  'browser.safebrowsing.blockedURIs.enabled': false,
  'browser.safebrowsing.provider.mozilla.updateURL': '',
  'browser.search.update': false,
  'browser.newtabpage.enabled': false,
  'extensions.update.enabled': false,
  'datareporting.healthreport.uploadEnabled': false,
  'toolkit.telemetry.enabled': false,
  'browser.aboutwelcome.enabled': false,
  'browser.shell.checkDefaultBrowser': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'browser.startup.page': 0,
  'browser.tabs.warnOnClose': false,
  'trailhead.firstrun.didSeeAboutWelcome': true,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'dom.security.https_first': false,
  'dom.security.https_first_schemeless': false,
  'app.update.auto': false,
  'app.update.checkInstallTime': false,
  'browser.sessionstore.resume_from_crash': false,
  // No "Open Firefox in Troubleshoot Mode?" prompt after ended runs (see close).
  'toolkit.startup.max_resumed_crashes': -1,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows: a running Firefox holds its profile's parent.lock open with no sharing. */
function profileInUse(profile) {
  if (process.platform !== 'win32') return false;
  const lock = path.join(profile, 'parent.lock');
  if (!fs.existsSync(lock)) return false;
  try {
    fs.closeSync(fs.openSync(lock, 'r+'));
    return false;
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM';
  }
}

/** The Firefox to start: --firefox-exe, else WEED_FIREFOX_EXE, else where the installer puts it. */
export function stockFirefoxExe(cliArgs = {}) {
  const explicit = typeof cliArgs['firefox-exe'] === 'string' ? cliArgs['firefox-exe'] : process.env.WEED_FIREFOX_EXE;
  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['C:/Program Files/Mozilla Firefox/firefox.exe', 'C:/Program Files (x86)/Mozilla Firefox/firefox.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Firefox.app/Contents/MacOS/firefox']
        : ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`--browser firefox: no Firefox at ${candidates.join(', ')} (pass --firefox-exe <path> or set WEED_FIREFOX_EXE)`);
  }
  return found;
}

/**
 * The bridge: `routes` for createStaticBenchmarkServer, and `launch(exe, { headed })`, a stand-in for Playwright's
 * browser whose one page is the Firefox it starts at the page's goto.
 */
export function createStockFirefox() {
  const queue = [];
  const pending = new Map();
  const listeners = { console: [], pageerror: [] };
  let poll = null;
  let nextId = 1;

  function send(src, arg) {
    const cmd = { id: nextId++, src, arg: arg === undefined ? null : arg };
    return new Promise((resolve, reject) => {
      pending.set(cmd.id, { resolve, reject });
      if (poll) {
        const p = poll;
        poll = null;
        p(cmd);
      } else {
        queue.push(cmd);
      }
    });
  }

  const routes = {
    // The page's long poll: the next call, or null after 20 s so the request never outlives the server's timeouts.
    '/__stock/next': () => {
      if (queue.length) return queue.shift();
      if (poll) poll(null);
      return new Promise((resolve) => {
        poll = resolve;
        setTimeout(() => {
          if (poll === resolve) {
            poll = null;
            resolve(null);
          }
        }, 20000);
      });
    },
    '/__stock/done': (body) => {
      const { id, ok, value, error } = JSON.parse(body);
      const p = pending.get(id);
      pending.delete(id);
      if (p) ok ? p.resolve(value) : p.reject(new Error(error));
      return true;
    },
    '/__stock/log': (body) => {
      const { type, text } = JSON.parse(body);
      if (type === 'pageerror') for (const fn of listeners.pageerror) fn(new Error(text));
      else for (const fn of listeners.console) fn({ type: () => type, text: () => text });
      return true;
    },
  };

  function launch(exe, { headed }) {
    // One profile kept between runs (WEED_FIREFOX_PROFILE, else in the temp folder): a new one held the first page
    // about 50 s here. One run at a time uses it.
    const profile = process.env.WEED_FIREFOX_PROFILE || path.join(os.tmpdir(), 'weed-firefox-profile');
    let child = null;
    const page = {
      setDefaultTimeout() {},
      on(event, fn) {
        if (listeners[event]) listeners[event].push(fn);
      },
      async goto(url) {
        fs.mkdirSync(profile, { recursive: true });
        if (profileInUse(profile)) {
          throw new Error(`the Firefox bench profile ${profile} is in use by another Firefox: close it (or set WEED_FIREFOX_PROFILE)`);
        }
        const prefs = Object.entries(PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`);
        fs.writeFileSync(path.join(profile, 'user.js'), prefs.join(''));
        const driven = url + (url.includes('?') ? '&' : '?') + 'stockDriver=1';
        // -wait-for-browser keeps Windows' launcher process alive with the browser, so killing its tree ends both.
        const args = [...(headed ? [] : ['-headless']), '-no-remote', '-new-instance', '-wait-for-browser', '-profile', profile, driven];
        child = spawn(exe, args, { stdio: 'ignore' });
        child.on('exit', (code) => {
          child = null;
          for (const p of pending.values()) p.reject(new Error(`Firefox exited (${code}) before the page answered`));
          pending.clear();
        });
      },
      async waitForFunction(fn, arg, { timeout = 30000 } = {}) {
        const end = Date.now() + timeout;
        for (;;) {
          const left = end - Date.now();
          const value = await Promise.race([
            send(String(fn), arg),
            sleep(Math.max(0, left)).then(() => {
              throw new Error(`waitForFunction: no answer from Firefox in ${timeout} ms`);
            }),
          ]);
          if (value) return value;
          if (Date.now() > end) throw new Error(`waitForFunction: still false after ${timeout} ms`);
          await sleep(100);
        }
      },
      evaluate: (fn, arg) => send(String(fn), arg),
      async setViewportSize() {},
      async bringToFront() {},
    };
    return {
      async newPage() {
        return page;
      },
      async close() {
        // A graceful close first: a forced end counts as a crash, and after three Firefox opened on a "Troubleshoot
        // Mode?" prompt that held the profile, so every run after it failed (2026-10-24). Forced only past 10 s.
        if (process.platform === 'win32') {
          // Windows' launcher process can hand off to the browser and exit, so the browser is found by its profile.
          const mark = path.basename(profile);
          const ours = `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -like '*${mark}*' }`;
          spawnSync('powershell', ['-NoProfile', '-Command', `${ours} | ForEach-Object { taskkill /PID $_.ProcessId | Out-Null }`], { stdio: 'ignore' });
          for (let k = 0; k < 40 && child; k++) await sleep(250);
          if (child) {
            spawnSync('powershell', ['-NoProfile', '-Command', `${ours} | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }`], { stdio: 'ignore' });
            if (child) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
          }
        } else if (child) {
          child.kill('SIGTERM');
          for (let k = 0; k < 40 && child; k++) await sleep(250);
          if (child) child.kill('SIGKILL');
        }
        // The profile's lock is let go a moment after the process ends; the next run starts on it.
        await sleep(1000);
      },
    };
  }

  return { routes, launch };
}
