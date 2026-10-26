// ui.js - the HTML over the canvas: lobby card, race HUD, toasts.
// Only functions at module level: workers import the scene files, which import this.

import { CAR_SKINS, MAX_PLAYERS } from './netShared.js';

const STYLE_ID = 'net-racers-style';

const CSS = `
.nr-root{--nr-bg:rgba(12,14,18,.78);--nr-line:rgba(255,255,255,.09);--nr-text:#eef1f5;--nr-dim:#9aa3ae;
  --nr-accent:#9be15d;--nr-accent2:#00c6a7;--nr-warn:#ffb547;--nr-bad:#ff6b6b;
  position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
  padding:max(16px,env(safe-area-inset-top)) 16px 16px;box-sizing:border-box;pointer-events:none;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--nr-text)}
.nr-root *{box-sizing:border-box}
.nr-card{pointer-events:auto;width:min(440px,100%);max-height:calc(100dvh - 32px);overflow:auto;
  background:var(--nr-bg);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);
  border:1px solid var(--nr-line);border-radius:18px;padding:24px;box-shadow:0 24px 64px rgba(0,0,0,.45)}
.nr-brand{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.nr-logo{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;
  background:linear-gradient(135deg,var(--nr-accent),var(--nr-accent2));box-shadow:0 6px 20px rgba(0,198,167,.35)}
.nr-title{margin:0;font-size:22px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.nr-sub{margin:0;color:var(--nr-dim);font-size:12px;letter-spacing:.04em}
.nr-label{display:block;margin:16px 0 6px;color:var(--nr-dim);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
.nr-input{width:100%;height:44px;padding:0 14px;border-radius:11px;border:1px solid var(--nr-line);
  background:rgba(255,255,255,.05);color:var(--nr-text);font:inherit;font-size:15px;outline:none;transition:border-color .15s,background .15s}
.nr-input:focus{border-color:var(--nr-accent2);background:rgba(255,255,255,.08)}
.nr-input.nr-code{font:700 18px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.18em;text-transform:uppercase;text-align:center}
.nr-skins{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.nr-skin{appearance:none;height:52px;border-radius:12px;border:1px solid var(--nr-line);background:rgba(255,255,255,.04);
  display:grid;place-items:center;cursor:pointer;transition:transform .12s,border-color .12s,background .12s}
.nr-skin:hover{transform:translateY(-1px);background:rgba(255,255,255,.08)}
.nr-skin[aria-pressed="true"]{border-color:var(--nr-accent);background:rgba(155,225,93,.12);box-shadow:0 0 0 2px rgba(155,225,93,.25) inset}
.nr-seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid var(--nr-line)}
.nr-seg button{appearance:none;border:0;border-radius:9px;height:34px;background:transparent;color:var(--nr-dim);font-family:inherit;font-weight:600;font-size:13px;line-height:1;cursor:pointer}
.nr-seg button[aria-pressed="true"]{background:rgba(255,255,255,.12);color:var(--nr-text)}
.nr-hint{margin:6px 2px 0;color:var(--nr-dim);font-size:12px}
.nr-actions{display:grid;gap:10px;margin-top:22px}
.nr-row{display:grid;grid-template-columns:1fr auto;gap:8px}
.nr-btn{appearance:none;height:46px;padding:0 18px;border-radius:12px;border:1px solid var(--nr-line);cursor:pointer;
  background:rgba(255,255,255,.07);color:var(--nr-text);font-family:inherit;font-weight:700;font-size:15px;line-height:1;letter-spacing:.02em;transition:transform .1s,filter .15s,background .15s}
.nr-btn:hover{background:rgba(255,255,255,.12)}
.nr-btn:active{transform:translateY(1px)}
.nr-btn:disabled{opacity:.45;cursor:default;transform:none}
.nr-btn.nr-primary{border:0;color:#0b1a10;background:linear-gradient(135deg,var(--nr-accent),var(--nr-accent2))}
.nr-btn.nr-primary:hover{filter:brightness(1.08)}
.nr-btn.nr-ghost{background:transparent}
.nr-divider{display:flex;align-items:center;gap:10px;color:var(--nr-dim);font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin:4px 0}
.nr-divider::before,.nr-divider::after{content:"";flex:1;height:1px;background:var(--nr-line)}
.nr-codebox{margin-top:6px;padding:16px;border-radius:14px;border:1px dashed rgba(155,225,93,.45);background:rgba(155,225,93,.06);text-align:center}
.nr-bigcode{font:800 34px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.14em;margin:4px 0 12px}
.nr-copyrow{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.nr-chip-btn{appearance:none;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--nr-line);background:rgba(255,255,255,.06);
  color:var(--nr-text);font-family:inherit;font-weight:600;font-size:12px;line-height:1;cursor:pointer}
.nr-chip-btn:hover{background:rgba(255,255,255,.12)}
.nr-players{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.nr-player{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--nr-line)}
.nr-player.nr-empty{color:var(--nr-dim);border-style:dashed;background:transparent}
.nr-pname{font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nr-tag{margin-left:6px;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;background:rgba(255,255,255,.1);color:var(--nr-dim)}
.nr-tag.nr-you{background:rgba(0,198,167,.18);color:#7fe9d6}
.nr-ping{font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;color:var(--nr-dim);display:flex;align-items:center;gap:6px}
.nr-dot{width:8px;height:8px;border-radius:50%;background:var(--nr-dim)}
.nr-dot.nr-good{background:var(--nr-accent)}.nr-dot.nr-ok{background:var(--nr-warn)}.nr-dot.nr-bad{background:var(--nr-bad)}
.nr-status{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--nr-dim);margin:18px 0 4px}
.nr-spinner{width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,.15);border-top-color:var(--nr-accent2);animation:nr-spin .8s linear infinite}
@keyframes nr-spin{to{transform:rotate(360deg)}}
.nr-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2100;display:grid;gap:8px;pointer-events:none;width:min(420px,calc(100% - 32px))}
.nr-toast{pointer-events:auto;padding:12px 16px;border-radius:12px;background:rgba(20,22,27,.95);border:1px solid var(--nr-line);
  box-shadow:0 10px 30px rgba(0,0,0,.4);font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef1f5;animation:nr-in .2s ease-out}
.nr-toast.nr-error{border-color:rgba(255,107,107,.5)}
@keyframes nr-in{from{opacity:0;transform:translateY(8px)}}
.nr-hud{position:fixed;inset:0;z-index:2000;pointer-events:none;font:13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef1f5}
.nr-hud-top{position:absolute;top:max(56px,env(safe-area-inset-top));left:16px;right:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.nr-pill{pointer-events:auto;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;background:rgba(12,14,18,.72);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.09)}
.nr-pill b{font:800 13px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.12em}
.nr-hud-players{display:grid;gap:6px;justify-items:end}
.nr-hud-player{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:rgba(12,14,18,.6);border:1px solid rgba(255,255,255,.08)}
.nr-hud-bottom{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(12,14,18,.6);color:#c9d0d8;
  border:1px solid rgba(255,255,255,.08);white-space:nowrap}
.nr-kbd{display:inline-block;min-width:22px;padding:2px 6px;margin:0 2px;border-radius:6px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);
  font:700 11px/1.3 ui-monospace,Menlo,Consolas,monospace;text-align:center}
.nr-hud .nr-btn{pointer-events:auto;height:36px;font-size:13px;padding:0 14px}
.nr-modal{position:fixed;inset:0;z-index:2050;display:grid;place-items:center;background:rgba(0,0,0,.45);pointer-events:auto}
@media (max-width:420px){.nr-card{padding:18px}.nr-bigcode{font-size:28px}.nr-skins{grid-template-columns:repeat(3,1fr)}}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** h('div', { class: 'x', onclick }, child, 'text') */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(
      typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c
    );
  }
  return el;
}

/** A top-down car in the skin's colour (the chips and the player rows). */
export function carIcon(color, size = 30) {
  const svg = `<svg width="${size}" height="${Math.round(size * 0.6)}" viewBox="0 0 50 30" aria-hidden="true">
    <rect x="3" y="4" width="44" height="22" rx="8" fill="${color}" stroke="rgba(0,0,0,.45)" stroke-width="1.5"/>
    <rect x="27" y="7.5" width="10" height="15" rx="3" fill="rgba(20,30,40,.75)"/>
    <rect x="11" y="8.5" width="8" height="13" rx="3" fill="rgba(20,30,40,.6)"/>
    <rect x="44" y="7" width="3" height="4" rx="1" fill="#fff6c2"/><rect x="44" y="19" width="3" height="4" rx="1" fill="#fff6c2"/>
    <rect x="3" y="7" width="2.5" height="4" rx="1" fill="#ff5a5a"/><rect x="3" y="19" width="2.5" height="4" rx="1" fill="#ff5a5a"/></svg>`;
  return h('span', { html: svg, style: 'display:inline-grid;place-items:center' });
}

const LOGO_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0b1a10" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 11l10-4M7 13l10 4"/></svg>`;

export function pingClass(ms) {
  if (!(ms >= 0)) return '';
  return ms < 80 ? 'nr-good' : ms < 180 ? 'nr-ok' : 'nr-bad';
}

export function pingText(ms) {
  return ms >= 0 ? `${Math.round(ms)} ms` : '—';
}

// -----------------------------------------------------------------------------
// Toasts
// -----------------------------------------------------------------------------

export function toast(text, kind = 'info', ms = 4200) {
  ensureStyle();
  let box = document.querySelector('.nr-toasts');
  if (!box) {
    box = h('div', { class: 'nr-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(box);
  }
  const el = h('div', { class: `nr-toast${kind === 'error' ? ' nr-error' : ''}` }, text);
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// -----------------------------------------------------------------------------
// Lobby
// -----------------------------------------------------------------------------

/**
 * The lobby card. `view` is redrawn by calling render(state) with:
 *   { screen: 'home'|'connecting'|'room', name, skin, signaling, code, joinCode, isHost,
 *     players, myId, statusText, canStart }
 * and actions: { onName, onSkin, onSignaling, onCreate, onJoin, onJoinCode, onStart, onLeave, onCopyCode, onCopyLink }
 */
export function mountLobby(actions) {
  ensureStyle();
  const root = h('div', { class: 'nr-root' });
  document.body.appendChild(root);

  function brand() {
    return h(
      'div',
      { class: 'nr-brand' },
      h('div', { class: 'nr-logo', html: LOGO_SVG }),
      h(
        'div',
        null,
        h('h1', { class: 'nr-title' }, 'Net Racers'),
        h('p', { class: 'nr-sub' }, 'WeedJS multiplayer · peer to peer')
      )
    );
  }

  function home(s) {
    const name = h('input', {
      class: 'nr-input',
      id: 'nr-name',
      maxlength: 16,
      placeholder: 'Your name',
      value: s.name,
      autocomplete: 'nickname',
      oninput: (e) => actions.onName(e.target.value),
    });
    const skins = h(
      'div',
      { class: 'nr-skins', role: 'group', 'aria-label': 'Car' },
      CAR_SKINS.map((skin, i) =>
        h(
          'button',
          {
            class: 'nr-skin',
            type: 'button',
            title: skin.label,
            'aria-label': skin.label,
            'aria-pressed': String(i === s.skin),
            onclick: () => actions.onSkin(i),
          },
          carIcon(skin.color)
        )
      )
    );
    const seg = h(
      'div',
      { class: 'nr-seg', role: 'group', 'aria-label': 'Connection' },
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(s.signaling === 'firebase'),
          onclick: () => actions.onSignaling('firebase'),
        },
        'Internet'
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(s.signaling === 'local'),
          onclick: () => actions.onSignaling('local'),
        },
        'This computer'
      )
    );
    const hint = h(
      'p',
      { class: 'nr-hint' },
      s.signaling === 'local'
        ? 'Two tabs of this browser on this machine. No internet needed.'
        : 'Two computers anywhere. Firebase only for the handshake; the game goes peer to peer.'
    );
    const code = h('input', {
      class: 'nr-input nr-code',
      id: 'nr-join-code',
      maxlength: 9,
      placeholder: 'XXXX-XXXX',
      value: s.joinCode,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Room code',
      oninput: (e) => actions.onJoinCode(e.target, e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Enter') actions.onJoin();
      },
    });
    return [
      brand(),
      h('label', { class: 'nr-label', for: 'nr-name' }, 'Driver'),
      name,
      h('span', { class: 'nr-label' }, 'Car'),
      skins,
      h('span', { class: 'nr-label' }, 'Play over'),
      seg,
      hint,
      h(
        'div',
        { class: 'nr-actions' },
        h(
          'button',
          {
            class: 'nr-btn nr-primary',
            type: 'button',
            id: 'nr-create',
            onclick: actions.onCreate,
          },
          'Create a room'
        ),
        h('div', { class: 'nr-divider' }, 'or join one'),
        h(
          'div',
          { class: 'nr-row' },
          code,
          h(
            'button',
            { class: 'nr-btn', type: 'button', id: 'nr-join', onclick: actions.onJoin },
            'Join'
          )
        )
      ),
    ];
  }

  function connecting(s) {
    return [
      brand(),
      h(
        'div',
        { class: 'nr-status' },
        h('div', { class: 'nr-spinner' }),
        h('span', null, s.statusText || 'Connecting…')
      ),
      h(
        'div',
        { class: 'nr-actions' },
        h(
          'button',
          { class: 'nr-btn nr-ghost', type: 'button', onclick: actions.onLeave },
          'Cancel'
        )
      ),
    ];
  }

  function room(s) {
    const rows = [];
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const p = s.players.find((q) => q.slot === slot);
      if (!p) {
        rows.push(
          h(
            'li',
            { class: 'nr-player nr-empty' },
            h('span', { style: 'width:30px' }),
            h('span', null, 'Open seat'),
            h('span')
          )
        );
        continue;
      }
      const skin = CAR_SKINS[p.skin] || CAR_SKINS[0];
      const ping = rowPing(s, p);
      rows.push(
        h(
          'li',
          { class: 'nr-player' },
          carIcon(skin.color),
          h(
            'span',
            { class: 'nr-pname' },
            p.name || 'Driver',
            p.isHost ? h('span', { class: 'nr-tag' }, 'host') : null,
            p.id === s.myId ? h('span', { class: 'nr-tag nr-you' }, 'you') : null
          ),
          ping === null
            ? h('span')
            : h(
                'span',
                { class: 'nr-ping', 'data-ping-for': p.id },
                h('span', { class: `nr-dot ${pingClass(ping)}` }),
                pingText(ping)
              )
        )
      );
    }
    const guests = s.players.filter((p) => !p.isHost).length;
    return [
      brand(),
      h(
        'div',
        { class: 'nr-codebox' },
        h('span', { class: 'nr-label', style: 'margin-top:0' }, s.isHost ? 'Your room' : 'Room'),
        h('div', { class: 'nr-bigcode', id: 'nr-room-code' }, s.code),
        h(
          'div',
          { class: 'nr-copyrow' },
          h(
            'button',
            { class: 'nr-chip-btn', type: 'button', onclick: actions.onCopyCode },
            'Copy code'
          ),
          h(
            'button',
            { class: 'nr-chip-btn', type: 'button', onclick: actions.onCopyLink },
            'Copy invite link'
          )
        )
      ),
      h('span', { class: 'nr-label' }, `Drivers · ${s.players.length}/${MAX_PLAYERS}`),
      h('ul', { class: 'nr-players', id: 'nr-players' }, rows),
      s.isHost
        ? h(
            'div',
            { class: 'nr-actions' },
            h(
              'button',
              {
                class: 'nr-btn nr-primary',
                type: 'button',
                id: 'nr-start',
                onclick: actions.onStart,
              },
              guests > 0 ? 'Start the race' : 'Start alone (waiting for drivers)'
            ),
            h(
              'button',
              { class: 'nr-btn nr-ghost', type: 'button', onclick: actions.onLeave },
              'Close room'
            )
          )
        : h(
            'div',
            null,
            h(
              'div',
              { class: 'nr-status' },
              h('div', { class: 'nr-spinner' }),
              h('span', null, 'Waiting for the host to start…')
            ),
            h(
              'div',
              { class: 'nr-actions' },
              h(
                'button',
                { class: 'nr-btn nr-ghost', type: 'button', onclick: actions.onLeave },
                'Leave room'
              )
            )
          ),
    ];
  }

  /** The ping a row shows: the host row shows the guest's own ping to it; the host sees each guest's. */
  function rowPing(s, p) {
    return p.isHost ? (s.isHost ? null : s.hostRtt) : p.rtt;
  }

  /** What the room card is built from, pings aside. Same key: update the pings in place. */
  function roomKey(s) {
    return JSON.stringify([
      s.code,
      s.isHost,
      s.myId,
      s.players.map((p) => [p.id, p.name, p.skin, p.slot, p.isHost]),
    ]);
  }

  let lastScreen = '';
  let lastRoomKey = '';
  return {
    root,
    render(s) {
      // The host refreshes pings every second: rebuilding the card then would swap the
      // Start button under a click. Only the ping cells change.
      if (s.screen === 'room' && lastScreen === 'room') {
        const key = roomKey(s);
        if (key === lastRoomKey) {
          for (const p of s.players) {
            const cell = root.querySelector(`[data-ping-for="${p.id}"]`);
            const ms = rowPing(s, p);
            if (!cell || ms === null) continue;
            cell.replaceChildren(h('span', { class: `nr-dot ${pingClass(ms)}` }), pingText(ms));
          }
          return;
        }
        lastRoomKey = key;
      } else if (s.screen === 'room') {
        lastRoomKey = roomKey(s);
      }
      // Keep focus and caret in the inputs: only rebuild the home screen when the screen changes.
      if (s.screen === 'home' && lastScreen === 'home') {
        root
          .querySelectorAll('.nr-skin')
          .forEach((b, i) => b.setAttribute('aria-pressed', String(i === s.skin)));
        const seg = root.querySelectorAll('.nr-seg button');
        if (seg.length === 2) {
          seg[0].setAttribute('aria-pressed', String(s.signaling === 'firebase'));
          seg[1].setAttribute('aria-pressed', String(s.signaling === 'local'));
          const hint = root.querySelector('.nr-hint');
          if (hint) {
            hint.textContent =
              s.signaling === 'local'
                ? 'Two tabs of this browser on this machine. No internet needed.'
                : 'Two computers anywhere. Firebase only for the handshake; the game goes peer to peer.';
          }
        }
        return;
      }
      lastScreen = s.screen;
      const card = h(
        'div',
        { class: 'nr-card' },
        s.screen === 'home' ? home(s) : s.screen === 'connecting' ? connecting(s) : room(s)
      );
      root.replaceChildren(card);
      if (s.screen === 'home') {
        const target = root.querySelector(
          !s.name ? '#nr-name' : s.joinCode ? '#nr-join' : '#nr-create'
        );
        if (target) target.focus();
      }
    },
    destroy() {
      root.remove();
    },
  };
}

// -----------------------------------------------------------------------------
// Race HUD
// -----------------------------------------------------------------------------

export function mountRaceHud(actions) {
  ensureStyle();
  const root = h('div', { class: 'nr-hud' });
  document.body.appendChild(root);
  const code = h('b', null, '');
  const role = h('span', { class: 'nr-tag' }, '');
  const ping = h('span', { class: 'nr-ping' }, h('span', { class: 'nr-dot' }), '—');
  const leave = h('button', { class: 'nr-btn', type: 'button', onclick: actions.onLeave }, 'Leave');
  const players = h('div', { class: 'nr-hud-players' });
  root.append(
    h(
      'div',
      { class: 'nr-hud-top' },
      h('div', { class: 'nr-pill' }, code, role, ping, leave),
      players
    ),
    h(
      'div',
      { class: 'nr-hud-bottom' },
      'Drive with ',
      h('span', { class: 'nr-kbd' }, 'W'),
      h('span', { class: 'nr-kbd' }, 'A'),
      h('span', { class: 'nr-kbd' }, 'S'),
      h('span', { class: 'nr-kbd' }, 'D'),
      ' or the arrows · push the parked cars'
    )
  );
  let modal = null;
  return {
    root,
    update(s) {
      code.textContent = s.code;
      role.textContent = s.isHost ? 'host' : 'guest';
      leave.textContent = s.isHost ? 'End race' : 'Leave';
      ping.replaceChildren(
        h('span', { class: `nr-dot ${pingClass(s.ping)}` }),
        s.isHost
          ? `${s.players.length} driver${s.players.length === 1 ? '' : 's'}`
          : pingText(s.ping)
      );
      players.replaceChildren(
        ...s.players.map((p) =>
          h(
            'div',
            { class: 'nr-hud-player' },
            carIcon((CAR_SKINS[p.skin] || CAR_SKINS[0]).color, 24),
            h('span', null, p.name || 'Driver'),
            p.id === s.myId ? h('span', { class: 'nr-tag nr-you' }, 'you') : null
          )
        )
      );
    },
    showModal(title, text, buttonText, onClick) {
      if (modal) modal.remove();
      modal = h(
        'div',
        { class: 'nr-modal nr-root', style: 'pointer-events:auto' },
        h(
          'div',
          { class: 'nr-card', style: 'text-align:center' },
          h('h2', { class: 'nr-title', style: 'font-size:18px;margin-bottom:8px' }, title),
          h('p', { class: 'nr-sub', style: 'font-size:14px;margin-bottom:18px' }, text),
          h(
            'button',
            { class: 'nr-btn nr-primary', type: 'button', onclick: onClick, style: 'width:100%' },
            buttonText
          )
        )
      );
      document.body.appendChild(modal);
    },
    destroy() {
      if (modal) modal.remove();
      root.remove();
    },
  };
}
