// Production build: no hot swap (see ../hotSwap.js). Hot reload never starts in
// production, so a worker never receives a swap; if one came, it asks for a reload.
export function hotModuleUrl(url, version) {
  return `${url}${url.includes('?') ? '&' : '?'}weedHot=${version}`;
}

export function swapModule() {
  return { swapped: [], reload: 'hot swap is off in production builds' };
}
