// consoleForward.js — the editor's console (VISUAL_EDITOR_PLAN.md ED-18): while it is on, a console's calls also go
// somewhere as text (a worker posts them to the page; the page hands them to the editor's console panel), besides
// DevTools. Off, nothing is wrapped: the console is the one the engine found. On, DevTools names this file as the
// source of each call, so it is on only while the editor page shows its console.
//
// At most MAX_PER_SECOND calls a second go on; the rest are counted and said in one line the next second, so a tick
// that logs every frame cannot flood the page.

/** The console methods passed on. */
export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
/** Calls passed on per second, at most; more are counted. */
export const MAX_PER_SECOND = 200;
/** Characters of one call's text, at most. */
export const MAX_TEXT = 2000;

/** One argument as text: strings as they are, errors with their stack, objects as short JSON. */
function argText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'function' ? `ƒ ${value.name || 'anonymous'}` : String(value);
  }
  if (value instanceof Error || (typeof value.message === 'string' && typeof value.stack === 'string')) {
    return value.stack && value.stack.includes(value.message) ? value.stack : `${value.name}: ${value.message}`;
  }
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.length})`;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value); // circular, a BigInt inside, …
  }
}

/**
 * A console call's arguments as one line of text, the way DevTools joins them: `%c` styles dropped with their
 * arguments, `%s`, `%d`, `%i`, `%f` and `%o` filled in.
 * @param {unknown[]} args
 * @returns {string}
 */
export function formatConsoleArgs(args) {
  let rest = args;
  let head = '';
  if (typeof args[0] === 'string' && args[0].includes('%')) {
    let next = 1;
    head = args[0].replace(/%[csdifoO%]/g, (token) => {
      if (token === '%%') return '%';
      if (next >= args.length) return token;
      const value = args[next++];
      if (token === '%c') return '';
      if (token === '%d' || token === '%i') return String(Math.trunc(Number(value)));
      if (token === '%f') return String(Number(value));
      return argText(value);
    });
    rest = args.slice(next);
  } else if (args.length > 0) {
    head = argText(args[0]);
    rest = args.slice(1);
  }
  let text = head;
  for (const value of rest) text += ` ${argText(value)}`;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * A forward of `target`'s console methods to `post({ level, text, when })`, off until `set(true)`.
 * @param {Console} target
 * @param {(entry: { level: string, text: string, when: number }) => void} post
 * @param {() => number} [now] - ms
 */
export function createConsoleForward(target, post, now = () => Date.now()) {
  let originals = null;
  let second = -1;
  let sent = 0;
  let dropped = 0;
  const pass = (level, args) => {
    const when = now();
    const s = Math.floor(when / 1000);
    if (s !== second) {
      if (dropped > 0) {
        post({ level: 'warn', text: `${dropped} console calls not shown (more than ${MAX_PER_SECOND} a second)`, when });
      }
      second = s;
      sent = 0;
      dropped = 0;
    }
    if (sent >= MAX_PER_SECOND) {
      dropped++;
      return;
    }
    sent++;
    post({ level, text: formatConsoleArgs(args), when });
  };
  return {
    get on() {
      return originals !== null;
    },
    set(on) {
      if (on === (originals !== null)) return;
      if (on) {
        originals = {};
        for (const level of CONSOLE_LEVELS) {
          const original = target[level];
          originals[level] = original;
          target[level] = function forwarded(...args) {
            original.apply(target, args);
            try {
              pass(level, args);
            } catch {
              // a post that fails (the page went) does not break the caller
            }
          };
        }
      } else {
        for (const level of CONSOLE_LEVELS) target[level] = originals[level];
        originals = null;
      }
    },
  };
}
