/**
 * The engine cannot start without SharedArrayBuffer, and browsers only expose it
 * on a cross-origin isolated page. Most people meet this on their first deploy,
 * so the error names the two headers and where the per-host setup lives.
 */
export const SHARED_ARRAY_BUFFER_MISSING =
  'WeedJS needs SharedArrayBuffer, which browsers only enable on a cross-origin isolated page. ' +
  'Serve the HTML page with "Cross-Origin-Opener-Policy: same-origin" and ' +
  '"Cross-Origin-Embedder-Policy: require-corp". Per-host setup (Vercel, Netlify, GitHub Pages, itch.io): ' +
  'docs/guide/DEPLOY.md.';

/**
 * @param {object} [scope] - globalThis, or a stand-in in tests
 * @returns {string|null} the message when SharedArrayBuffer is missing, else null
 */
export function sharedArrayBufferMissing(scope = globalThis) {
  return typeof scope.SharedArrayBuffer === 'undefined' ? SHARED_ARRAY_BUFFER_MISSING : null;
}
