// The page side of stockFirefox.mjs (loaded by integratedWorkerBenchmark.html when the URL has stockDriver): a
// browser started without Playwright takes the runner's page.evaluate calls over HTTP. It long-polls
// /__stock/next for a function's source and its argument, runs it, and posts the value or the error to
// /__stock/done; console output and page errors go to /__stock/log.
(() => {
  const post = (url, data, keepalive = false) =>
    fetch(url, { method: 'POST', body: JSON.stringify(data), keepalive }).catch(() => {});
  const show = (a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (a && typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a);
  };
  // Playwright's console message types: console.warn is 'warning'.
  for (const [method, type] of [['log', 'log'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warning'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      post('/__stock/log', { type, text: args.map(show).join(' ') }, true);
    };
  }
  addEventListener('error', (e) => post('/__stock/log', { type: 'pageerror', text: show(e.error || e.message) }, true));
  addEventListener('unhandledrejection', (e) => post('/__stock/log', { type: 'pageerror', text: show(e.reason) }, true));

  async function run({ id, src, arg }) {
    try {
      const fn = (0, eval)(`(${src})`);
      const value = await fn(arg);
      await post('/__stock/done', { id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      await post('/__stock/done', { id, ok: false, error: show(error) });
    }
  }

  (async () => {
    for (;;) {
      let cmd = null;
      try {
        cmd = await (await fetch('/__stock/next', { method: 'POST' })).json();
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (cmd) run(cmd);
    }
  })();
})();
