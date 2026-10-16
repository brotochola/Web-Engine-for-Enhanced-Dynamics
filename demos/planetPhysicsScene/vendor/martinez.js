// martinez-polygon-clipping 0.8.1 — MIT. Bundled ESM (splaytree + robust-predicates + tinyqueue).
function u(f2, e) {
  return f2 > e ? 1 : f2 < e ? -1 : 0;
}
var g = class _g {
  constructor(e = u, t = false) {
    this._compare = e, this._root = null, this._size = 0, this._noDuplicates = !!t;
  }
  rotateLeft(e) {
    var t = e.right;
    t && (e.right = t.left, t.left && (t.left.parent = e), t.parent = e.parent), e.parent ? e === e.parent.left ? e.parent.left = t : e.parent.right = t : this._root = t, t && (t.left = e), e.parent = t;
  }
  rotateRight(e) {
    var t = e.left;
    t && (e.left = t.right, t.right && (t.right.parent = e), t.parent = e.parent), e.parent ? e === e.parent.left ? e.parent.left = t : e.parent.right = t : this._root = t, t && (t.right = e), e.parent = t;
  }
  _splay(e) {
    for (; e.parent; ) {
      var t = e.parent;
      t.parent ? t.left === e && t.parent.left === t ? (this.rotateRight(t.parent), this.rotateRight(t)) : t.right === e && t.parent.right === t ? (this.rotateLeft(t.parent), this.rotateLeft(t)) : t.left === e && t.parent.right === t ? (this.rotateRight(t), this.rotateLeft(t)) : (this.rotateLeft(t), this.rotateRight(t)) : t.left === e ? this.rotateRight(t) : this.rotateLeft(t);
    }
  }
  splay(e) {
    for (var t, r2, i, l, h; e.parent; ) t = e.parent, r2 = t.parent, r2 && r2.parent ? (i = r2.parent, i.left === r2 ? i.left = e : i.right = e, e.parent = i) : (e.parent = null, this._root = e), l = e.left, h = e.right, e === t.left ? (r2 && (r2.left === t ? (t.right ? (r2.left = t.right, r2.left.parent = r2) : r2.left = null, t.right = r2, r2.parent = t) : (l ? (r2.right = l, l.parent = r2) : r2.right = null, e.left = r2, r2.parent = e)), h ? (t.left = h, h.parent = t) : t.left = null, e.right = t, t.parent = e) : (r2 && (r2.right === t ? (t.left ? (r2.right = t.left, r2.right.parent = r2) : r2.right = null, t.left = r2, r2.parent = t) : (h ? (r2.left = h, h.parent = r2) : r2.left = null, e.right = r2, r2.parent = e)), l ? (t.right = l, l.parent = t) : t.right = null, e.left = t, t.parent = e);
  }
  replace(e, t) {
    e.parent ? e === e.parent.left ? e.parent.left = t : e.parent.right = t : this._root = t, t && (t.parent = e.parent);
  }
  minNode(e = this._root) {
    if (e) for (; e.left; ) e = e.left;
    return e;
  }
  maxNode(e = this._root) {
    if (e) for (; e.right; ) e = e.right;
    return e;
  }
  insert(e, t) {
    var r2 = this._root, i = null, l = this._compare, h;
    if (this._noDuplicates) for (; r2; ) {
      if (i = r2, h = l(r2.key, e), h === 0) return;
      l(r2.key, e) < 0 ? r2 = r2.right : r2 = r2.left;
    }
    else for (; r2; ) i = r2, l(r2.key, e) < 0 ? r2 = r2.right : r2 = r2.left;
    return r2 = { key: e, data: t, left: null, right: null, parent: i }, i ? l(i.key, r2.key) < 0 ? i.right = r2 : i.left = r2 : this._root = r2, this.splay(r2), this._size++, r2;
  }
  find(e) {
    for (var t = this._root, r2 = this._compare; t; ) {
      var i = r2(t.key, e);
      if (i < 0) t = t.right;
      else if (i > 0) t = t.left;
      else return t;
    }
    return null;
  }
  contains(e) {
    for (var t = this._root, r2 = this._compare; t; ) {
      var i = r2(e, t.key);
      if (i === 0) return true;
      i < 0 ? t = t.left : t = t.right;
    }
    return false;
  }
  remove(e) {
    var t = this.find(e);
    if (!t) return false;
    if (this.splay(t), !t.left) this.replace(t, t.right);
    else if (!t.right) this.replace(t, t.left);
    else {
      var r2 = this.minNode(t.right);
      r2.parent !== t && (this.replace(r2, r2.right), r2.right = t.right, r2.right.parent = r2), this.replace(t, r2), r2.left = t.left, r2.left.parent = r2;
    }
    return this._size--, true;
  }
  removeNode(e) {
    if (!e) return false;
    if (this.splay(e), !e.left) this.replace(e, e.right);
    else if (!e.right) this.replace(e, e.left);
    else {
      var t = this.minNode(e.right);
      t.parent !== e && (this.replace(t, t.right), t.right = e.right, t.right.parent = t), this.replace(e, t), t.left = e.left, t.left.parent = t;
    }
    return this._size--, true;
  }
  erase(e) {
    var t = this.find(e);
    if (t) {
      this.splay(t);
      var r2 = t.left, i = t.right, l = null;
      r2 && (r2.parent = null, l = this.maxNode(r2), this.splay(l), this._root = l), i && (r2 ? l.right = i : this._root = i, i.parent = l), this._size--;
    }
  }
  pop() {
    var e = this._root, t = null;
    if (e) {
      for (; e.left; ) e = e.left;
      t = { key: e.key, data: e.data }, this.remove(e.key);
    }
    return t;
  }
  next(e) {
    var t = e;
    if (t) if (t.right) for (t = t.right; t && t.left; ) t = t.left;
    else for (t = e.parent; t && t.right === e; ) e = t, t = t.parent;
    return t;
  }
  prev(e) {
    var t = e;
    if (t) if (t.left) for (t = t.left; t && t.right; ) t = t.right;
    else for (t = e.parent; t && t.left === e; ) e = t, t = t.parent;
    return t;
  }
  forEach(e) {
    for (var t = this._root, r2 = [], i = false, l = 0; !i; ) t ? (r2.push(t), t = t.left) : r2.length > 0 ? (t = r2.pop(), e(t, l++), t = t.right) : i = true;
    return this;
  }
  range(e, t, r2, i) {
    const l = [], h = this._compare;
    let s = this._root, n;
    for (; l.length !== 0 || s; ) if (s) l.push(s), s = s.left;
    else {
      if (s = l.pop(), n = h(s.key, t), n > 0) break;
      if (h(s.key, e) >= 0 && r2.call(i, s)) return this;
      s = s.right;
    }
    return this;
  }
  keys() {
    for (var e = this._root, t = [], r2 = [], i = false; !i; ) e ? (t.push(e), e = e.left) : t.length > 0 ? (e = t.pop(), r2.push(e.key), e = e.right) : i = true;
    return r2;
  }
  values() {
    for (var e = this._root, t = [], r2 = [], i = false; !i; ) e ? (t.push(e), e = e.left) : t.length > 0 ? (e = t.pop(), r2.push(e.data), e = e.right) : i = true;
    return r2;
  }
  at(e) {
    for (var t = this._root, r2 = [], i = false, l = 0; !i; ) if (t) r2.push(t), t = t.left;
    else if (r2.length > 0) {
      if (t = r2.pop(), l === e) return t;
      l++, t = t.right;
    } else i = true;
    return null;
  }
  load(e = [], t = [], r2 = false) {
    if (this._size !== 0) throw new Error("bulk-load: tree is not empty");
    const i = e.length;
    return r2 && p(e, t, 0, i - 1, this._compare), this._root = o(null, e, t, 0, i), this._size = i, this;
  }
  min() {
    var e = this.minNode(this._root);
    return e ? e.key : null;
  }
  max() {
    var e = this.maxNode(this._root);
    return e ? e.key : null;
  }
  isEmpty() {
    return this._root === null;
  }
  get size() {
    return this._size;
  }
  static createTree(e, t, r2, i, l) {
    return new _g(r2, l).load(e, t, i);
  }
};
function o(f2, e, t, r2, i) {
  const l = i - r2;
  if (l > 0) {
    const h = r2 + Math.floor(l / 2), s = e[h], n = t[h], a = { key: s, data: n, parent: f2 };
    return a.left = o(a, e, t, r2, h), a.right = o(a, e, t, h + 1, i), a;
  }
  return null;
}
function p(f2, e, t, r2, i) {
  if (t >= r2) return;
  const l = f2[t + r2 >> 1];
  let h = t - 1, s = r2 + 1;
  for (; ; ) {
    do
      h++;
    while (i(f2[h], l) < 0);
    do
      s--;
    while (i(f2[s], l) > 0);
    if (h >= s) break;
    let n = f2[h];
    f2[h] = f2[s], f2[s] = n, n = e[h], e[h] = e[s], e[s] = n;
  }
  p(f2, e, t, s, i), p(f2, e, s + 1, r2, i);
}

// demos/destructibleTerrainScene/vendor/robust-predicates.js
var rt = 11102230246251565e-32;
var f = 134217729;
var _n = (3 + 8 * rt) * rt;
function it(I, J2, V2, S2, R2) {
  let K, j2, D2, E, e = J2[0], b2 = S2[0], l = 0, r2 = 0;
  b2 > e == b2 > -e ? (K = e, e = J2[++l]) : (K = b2, b2 = S2[++r2]);
  let i = 0;
  if (l < I && r2 < V2) for (b2 > e == b2 > -e ? (j2 = e + K, D2 = K - (j2 - e), e = J2[++l]) : (j2 = b2 + K, D2 = K - (j2 - b2), b2 = S2[++r2]), K = j2, D2 !== 0 && (R2[i++] = D2); l < I && r2 < V2; ) b2 > e == b2 > -e ? (j2 = K + e, E = j2 - K, D2 = K - (j2 - E) + (e - E), e = J2[++l]) : (j2 = K + b2, E = j2 - K, D2 = K - (j2 - E) + (b2 - E), b2 = S2[++r2]), K = j2, D2 !== 0 && (R2[i++] = D2);
  for (; l < I; ) j2 = K + e, E = j2 - K, D2 = K - (j2 - E) + (e - E), e = J2[++l], K = j2, D2 !== 0 && (R2[i++] = D2);
  for (; r2 < V2; ) j2 = K + b2, E = j2 - K, D2 = K - (j2 - E) + (b2 - E), b2 = S2[++r2], K = j2, D2 !== 0 && (R2[i++] = D2);
  return (K !== 0 || i === 0) && (R2[i++] = K), i;
}
function Mn(I, J2) {
  let V2 = J2[0];
  for (let S2 = 1; S2 < I; S2++) V2 += J2[S2];
  return V2;
}
function N(I) {
  return new Float64Array(I);
}
var Bc = (3 + 16 * rt) * rt;
var Qc = (2 + 12 * rt) * rt;
var gc = (9 + 64 * rt) * rt * rt;
var kt = N(4);
var cc = N(8);
var sc = N(12);
var oc = N(16);
var $t = N(4);
function Dc(I, J2, V2, S2, R2, K, j2) {
  let D2, E, e, b2, l, r2, i, v2, t, o2, a, C2, M2, Q2, d, F2, $2, A2;
  const H2 = I - R2, O = V2 - R2, U2 = J2 - K, P2 = S2 - K;
  Q2 = H2 * P2, r2 = f * H2, i = r2 - (r2 - H2), v2 = H2 - i, r2 = f * P2, t = r2 - (r2 - P2), o2 = P2 - t, d = v2 * o2 - (Q2 - i * t - v2 * t - i * o2), F2 = U2 * O, r2 = f * U2, i = r2 - (r2 - U2), v2 = U2 - i, r2 = f * O, t = r2 - (r2 - O), o2 = O - t, $2 = v2 * o2 - (F2 - i * t - v2 * t - i * o2), a = d - $2, l = d - a, kt[0] = d - (a + l) + (l - $2), C2 = Q2 + a, l = C2 - Q2, M2 = Q2 - (C2 - l) + (a - l), a = M2 - F2, l = M2 - a, kt[1] = M2 - (a + l) + (l - F2), A2 = C2 + a, l = A2 - C2, kt[2] = C2 - (A2 - l) + (a - l), kt[3] = A2;
  let Y = Mn(4, kt), n = Qc * j2;
  if (Y >= n || -Y >= n || (l = I - H2, D2 = I - (H2 + l) + (l - R2), l = V2 - O, e = V2 - (O + l) + (l - R2), l = J2 - U2, E = J2 - (U2 + l) + (l - K), l = S2 - P2, b2 = S2 - (P2 + l) + (l - K), D2 === 0 && E === 0 && e === 0 && b2 === 0) || (n = gc * j2 + _n * Math.abs(Y), Y += H2 * b2 + P2 * D2 - (U2 * e + O * E), Y >= n || -Y >= n)) return Y;
  Q2 = D2 * P2, r2 = f * D2, i = r2 - (r2 - D2), v2 = D2 - i, r2 = f * P2, t = r2 - (r2 - P2), o2 = P2 - t, d = v2 * o2 - (Q2 - i * t - v2 * t - i * o2), F2 = E * O, r2 = f * E, i = r2 - (r2 - E), v2 = E - i, r2 = f * O, t = r2 - (r2 - O), o2 = O - t, $2 = v2 * o2 - (F2 - i * t - v2 * t - i * o2), a = d - $2, l = d - a, $t[0] = d - (a + l) + (l - $2), C2 = Q2 + a, l = C2 - Q2, M2 = Q2 - (C2 - l) + (a - l), a = M2 - F2, l = M2 - a, $t[1] = M2 - (a + l) + (l - F2), A2 = C2 + a, l = A2 - C2, $t[2] = C2 - (A2 - l) + (a - l), $t[3] = A2;
  const u2 = it(4, kt, 4, $t, cc);
  Q2 = H2 * b2, r2 = f * H2, i = r2 - (r2 - H2), v2 = H2 - i, r2 = f * b2, t = r2 - (r2 - b2), o2 = b2 - t, d = v2 * o2 - (Q2 - i * t - v2 * t - i * o2), F2 = U2 * e, r2 = f * U2, i = r2 - (r2 - U2), v2 = U2 - i, r2 = f * e, t = r2 - (r2 - e), o2 = e - t, $2 = v2 * o2 - (F2 - i * t - v2 * t - i * o2), a = d - $2, l = d - a, $t[0] = d - (a + l) + (l - $2), C2 = Q2 + a, l = C2 - Q2, M2 = Q2 - (C2 - l) + (a - l), a = M2 - F2, l = M2 - a, $t[1] = M2 - (a + l) + (l - F2), A2 = C2 + a, l = A2 - C2, $t[2] = C2 - (A2 - l) + (a - l), $t[3] = A2;
  const h = it(u2, cc, 4, $t, sc);
  Q2 = D2 * b2, r2 = f * D2, i = r2 - (r2 - D2), v2 = D2 - i, r2 = f * b2, t = r2 - (r2 - b2), o2 = b2 - t, d = v2 * o2 - (Q2 - i * t - v2 * t - i * o2), F2 = E * e, r2 = f * E, i = r2 - (r2 - E), v2 = E - i, r2 = f * e, t = r2 - (r2 - e), o2 = e - t, $2 = v2 * o2 - (F2 - i * t - v2 * t - i * o2), a = d - $2, l = d - a, $t[0] = d - (a + l) + (l - $2), C2 = Q2 + a, l = C2 - Q2, M2 = Q2 - (C2 - l) + (a - l), a = M2 - F2, l = M2 - a, $t[1] = M2 - (a + l) + (l - F2), A2 = C2 + a, l = A2 - C2, $t[2] = C2 - (A2 - l) + (a - l), $t[3] = A2;
  const q2 = it(h, sc, 4, $t, oc);
  return oc[q2 - 1];
}
function Fc(I, J2, V2, S2, R2, K) {
  const j2 = (J2 - K) * (V2 - R2), D2 = (I - R2) * (S2 - K), E = j2 - D2;
  if (j2 === 0 || D2 === 0 || j2 > 0 != D2 > 0) return E;
  const e = Math.abs(j2 + D2);
  return Math.abs(E) >= Bc * e ? E : -Dc(I, J2, V2, S2, R2, K, e);
}
var Ec = (7 + 56 * rt) * rt;
var Gc = (3 + 28 * rt) * rt;
var Hc = (26 + 288 * rt) * rt * rt;
var zt = N(4);
var xt = N(4);
var yt = N(4);
var ec = N(4);
var ic = N(4);
var rc = N(4);
var ac = N(4);
var lc = N(4);
var uc = N(4);
var gn = N(8);
var Dn = N(8);
var Fn = N(8);
var Gt = N(4);
var pn = N(8);
var bc = N(8);
var Ct = N(8);
var tn = N(12);
var nn = N(192);
var qn = N(192);
var Lc = (10 + 96 * rt) * rt;
var Nc = (4 + 48 * rt) * rt;
var Oc = (44 + 576 * rt) * rt * rt;
var Lt = N(4);
var Nt = N(4);
var Ot = N(4);
var Ht = N(4);
var It = N(4);
var Jt = N(4);
var vt = N(4);
var wt = N(4);
var Gn = N(8);
var Hn = N(8);
var In = N(8);
var Jn = N(8);
var Kn = N(8);
var Ln = N(8);
var $n = N(8);
var vn = N(8);
var wn = N(8);
var St = N(4);
var Tt = N(4);
var Ut = N(4);
var k = N(8);
var tt = N(16);
var at = N(16);
var lt = N(16);
var ot = N(32);
var Pt = N(32);
var bt = N(48);
var jt = N(64);
var sn = N(1152);
var Nn = N(1152);
var Tc = (16 + 224 * rt) * rt;
var Uc = (5 + 72 * rt) * rt;
var Vc = (71 + 1408 * rt) * rt * rt;
var mt = N(4);
var At = N(4);
var Bt = N(4);
var Vt = N(4);
var Wt = N(4);
var Qt = N(4);
var gt = N(4);
var Xt = N(4);
var Dt = N(4);
var Yt = N(4);
var On = N(24);
var Pn = N(24);
var Rn = N(24);
var Sn = N(24);
var Tn = N(24);
var Un = N(24);
var Vn = N(24);
var Wn = N(24);
var Xn = N(24);
var Yn = N(24);
var bn = N(1152);
var Cn = N(1152);
var fn = N(1152);
var jn = N(1152);
var fc = N(1152);
var Zn = N(2304);
var kn = N(2304);
var dc = N(3456);
var hc = N(5760);
var _c = N(8);
var Mc = N(8);
var pc = N(8);
var Wc = N(16);
var mn = N(24);
var Rt = N(48);
var zn = N(48);
var An = N(96);
var Zt = N(192);
var $c = N(384);
var vc = N(384);
var wc = N(384);
var Xc = N(768);
var Cc = N(96);
var jc = N(96);
var mc = N(96);
var Ac = N(1152);

// demos/destructibleTerrainScene/vendor/tinyqueue.js
var r = class {
  constructor(t = [], h = (i, n) => i < n ? -1 : i > n ? 1 : 0) {
    if (this.data = t, this.length = this.data.length, this.compare = h, this.length > 0) for (let i = (this.length >> 1) - 1; i >= 0; i--) this._down(i);
  }
  push(t) {
    this.data.push(t), this._up(this.length++);
  }
  pop() {
    if (this.length === 0) return;
    const t = this.data[0], h = this.data.pop();
    return --this.length > 0 && (this.data[0] = h, this._down(0)), t;
  }
  peek() {
    return this.data[0];
  }
  _up(t) {
    const { data: h, compare: i } = this, n = h[t];
    for (; t > 0; ) {
      const s = t - 1 >> 1, e = h[s];
      if (i(n, e) >= 0) break;
      h[t] = e, t = s;
    }
    h[t] = n;
  }
  _down(t) {
    const { data: h, compare: i } = this, n = this.length >> 1, s = h[t];
    for (; t < n; ) {
      let e = (t << 1) + 1;
      const a = e + 1;
      if (a < this.length && i(h[a], h[e]) < 0 && (e = a), i(h[e], s) >= 0) break;
      h[t] = h[e], t = e;
    }
    h[t] = s;
  }
};

// demos/destructibleTerrainScene/vendor/martinez.raw.js
var U = 0;
var _ = 1;
var z = 2;
var G = 3;
var R = 0;
var y = 1;
var g2 = 2;
var T = 3;
function P(n, t, e) {
  t === null ? (n.inOut = false, n.otherInOut = true) : (n.isSubject === t.isSubject ? (n.inOut = !t.inOut, n.otherInOut = t.otherInOut) : (n.inOut = !t.otherInOut, n.otherInOut = t.isVertical() ? !t.inOut : t.inOut), t && (n.prevInResult = !F(t, e) || t.isVertical() ? t.prevInResult : t)), F(n, e) ? n.resultTransition = J(n, e) : n.resultTransition = 0;
}
function F(n, t) {
  switch (n.type) {
    case U:
      switch (t) {
        case R:
          return !n.otherInOut;
        case y:
          return n.otherInOut;
        case g2:
          return n.isSubject && n.otherInOut || !n.isSubject && !n.otherInOut;
        case T:
          return true;
      }
      break;
    case z:
      return t === R || t === y;
    case G:
      return t === g2;
    case _:
      return false;
  }
  return false;
}
function J(n, t) {
  let e = !n.inOut, i = !n.otherInOut, o2;
  switch (t) {
    case R:
      o2 = e && i;
      break;
    case y:
      o2 = e || i;
      break;
    case T:
      o2 = e !== i;
      break;
    case g2:
      n.isSubject ? o2 = e && !i : o2 = i && !e;
      break;
  }
  return o2 ? 1 : -1;
}
var S = class _S {
  /**
   * Sweepline event
   *
   * @class {SweepEvent}
   * @param {Position}        point
   * @param {boolean}         left
   * @param {SweepEvent=}     otherEvent
   * @param {boolean}         isSubject
   * @param {EdgeType}        edgeType
   */
  constructor(t, e, i, o2, r2) {
    this.left = e, this.point = t, this.otherEvent = i, this.isSubject = o2 ?? false, this.type = r2 || U, this.inOut = false, this.otherInOut = false, this.prevInResult = null, this.resultTransition = 0, this.otherPos = -1, this.outputContourId = -1, this.isExteriorRing = true;
  }
  /**
   * @param  {Position}  p
   * @return {boolean}
   */
  isBelow(t) {
    const e = this.point, i = this.otherEvent.point;
    return this.left ? (e[0] - t[0]) * (i[1] - t[1]) - (i[0] - t[0]) * (e[1] - t[1]) > 0 : (i[0] - t[0]) * (e[1] - t[1]) - (e[0] - t[0]) * (i[1] - t[1]) > 0;
  }
  /**
   * @param  {Position}  p
   * @return {boolean}
   */
  isAbove(t) {
    return !this.isBelow(t);
  }
  /**
   * @return {boolean}
   */
  isVertical() {
    return this.point[0] === this.otherEvent.point[0];
  }
  /**
   * Does event belong to result?
   * @return {boolean}
   */
  get inResult() {
    return this.resultTransition !== 0;
  }
  clone() {
    const t = new _S(
      this.point,
      this.left,
      this.otherEvent,
      this.isSubject,
      this.type
    );
    return t.contourId = this.contourId, t.resultTransition = this.resultTransition, t.prevInResult = this.prevInResult, t.isExteriorRing = this.isExteriorRing, t.inOut = this.inOut, t.otherInOut = this.otherInOut, t;
  }
};
function v(n, t) {
  return n[0] === t[0] ? n[1] === t[1] : false;
}
function A(n, t, e) {
  const i = Fc(n[0], n[1], t[0], t[1], e[0], e[1]);
  return i > 0 ? -1 : i < 0 ? 1 : 0;
}
function w(n, t) {
  const e = n.point, i = t.point;
  return e[0] > i[0] ? 1 : e[0] < i[0] ? -1 : e[1] !== i[1] ? e[1] > i[1] ? 1 : -1 : W(n, t, e);
}
function W(n, t, e, i) {
  return n.left !== t.left ? n.left ? 1 : -1 : A(e, n.otherEvent.point, t.otherEvent.point) !== 0 ? n.isBelow(t.otherEvent.point) ? -1 : 1 : !n.isSubject && t.isSubject ? 1 : -1;
}
function m(n, t, e) {
  const i = new S(t, false, n, n.isSubject), o2 = new S(t, true, n.otherEvent, n.isSubject);
  return v(n.point, n.otherEvent.point) && console.warn("what is that, a collapsed segment?", n), i.contourId = o2.contourId = n.contourId, w(o2, n.otherEvent) > 0 && (n.otherEvent.left = true, o2.left = false), n.otherEvent.otherEvent = o2, n.otherEvent = i, e.push(o2), e.push(i), e;
}
function k2(n, t) {
  return n[0] * t[1] - n[1] * t[0];
}
function M(n, t) {
  return n[0] * t[0] + n[1] * t[1];
}
function Z(n, t, e, i, o2) {
  const r2 = [t[0] - n[0], t[1] - n[1]], s = [i[0] - e[0], i[1] - e[1]];
  function l(d, O, B) {
    return [
      d[0] + O * B[0],
      d[1] + O * B[1]
    ];
  }
  const c = [e[0] - n[0], e[1] - n[1]];
  let u2 = k2(r2, s), f2 = u2 * u2;
  const p2 = M(r2, r2);
  if (f2 > 0) {
    const d = k2(c, s) / u2;
    if (d < 0 || d > 1)
      return null;
    const O = k2(c, r2) / u2;
    return O < 0 || O > 1 ? null : d === 0 || d === 1 ? [l(n, d, r2)] : O === 0 || O === 1 ? [l(e, O, s)] : [l(n, d, r2)];
  }
  if (u2 = k2(c, r2), f2 = u2 * u2, f2 > 0)
    return null;
  const h = M(r2, c) / p2, E = h + M(r2, s) / p2, a = Math.min(h, E), I = Math.max(h, E);
  return a <= 1 && I >= 0 ? a === 1 ? [l(n, a > 0 ? a : 0, r2)] : I === 0 ? [l(n, I < 1 ? I : 1, r2)] : [
    l(n, a > 0 ? a : 0, r2),
    l(n, I < 1 ? I : 1, r2)
  ] : null;
}
function x(n, t, e) {
  const i = Z(
    n.point,
    n.otherEvent.point,
    t.point,
    t.otherEvent.point
  ), o2 = i ? i.length : 0;
  if (o2 === 0 || o2 === 1 && (v(n.point, t.point) || v(n.otherEvent.point, t.otherEvent.point)) || o2 === 2 && n.isSubject === t.isSubject)
    return 0;
  if (o2 === 1)
    return !v(n.point, i[0]) && !v(n.otherEvent.point, i[0]) && m(n, i[0], e), !v(t.point, i[0]) && !v(t.otherEvent.point, i[0]) && m(t, i[0], e), 1;
  const r2 = [];
  let s = false, l = false;
  return v(n.point, t.point) ? s = true : w(n, t) === 1 ? r2.push(t, n) : r2.push(n, t), v(n.otherEvent.point, t.otherEvent.point) ? l = true : w(n.otherEvent, t.otherEvent) === 1 ? r2.push(t.otherEvent, n.otherEvent) : r2.push(n.otherEvent, t.otherEvent), s && l || s ? (t.type = _, n.type = t.inOut === n.inOut ? z : G, s && !l && m(r2[1].otherEvent, r2[0].point, e), 2) : l ? (m(r2[0], r2[1].point, e), 3) : r2[0] !== r2[3].otherEvent ? (m(r2[0], r2[1].point, e), m(r2[1], r2[2].point, e), 3) : (m(r2[0], r2[1].point, e), m(r2[3].otherEvent, r2[2].point, e), 3);
}
function $(n, t) {
  if (n === t) return 0;
  if (A(n.point, n.otherEvent.point, t.point) !== 0 || A(n.point, n.otherEvent.point, t.otherEvent.point) !== 0)
    return v(n.point, t.point) ? n.isBelow(t.otherEvent.point) ? -1 : 1 : n.point[0] === t.point[0] ? n.point[1] < t.point[1] ? -1 : 1 : w(n, t) === 1 ? t.isAbove(n.point) ? -1 : 1 : n.isBelow(t.point) ? -1 : 1;
  if (n.isSubject === t.isSubject) {
    let e = n.point, i = t.point;
    if (e[0] === i[0] && e[1] === i[1])
      return e = n.otherEvent.point, i = t.otherEvent.point, e[0] === i[0] && e[1] === i[1] ? 0 : (n.contourId ?? 0) > (t.contourId ?? 0) ? 1 : -1;
  } else
    return n.isSubject ? -1 : 1;
  return w(n, t) === 1 ? 1 : -1;
}
function Q(n, t, e, i, o2, r2) {
  const s = new g($), l = [], c = Math.min(i[2], o2[2]);
  let u2, f2, p2;
  for (; n.length !== 0; ) {
    let h = n.pop();
    if (l.push(h), r2 === R && h.point[0] > c || r2 === g2 && h.point[0] > i[2])
      break;
    if (h.left) {
      f2 = u2 = s.insert(h), p2 = s.minNode(), u2 !== p2 ? u2 = s.prev(u2) : u2 = null, f2 = s.next(f2);
      const E = u2 ? u2.key : null;
      let a;
      if (P(h, E, r2), f2 && x(h, f2.key, n) === 2 && (P(h, E, r2), P(f2.key, h, r2)), u2 && x(u2.key, h, n) === 2) {
        let I = u2;
        I !== p2 ? I = s.prev(I) : I = null, a = I ? I.key : null, P(E, a, r2), P(h, E, r2);
      }
    } else
      h = h.otherEvent, f2 = u2 = s.find(h), u2 && f2 && (u2 !== p2 ? u2 = s.prev(u2) : u2 = null, f2 = s.next(f2), s.remove(h), f2 && u2 && x(u2.key, f2.key, n));
  }
  return l;
}
var H = class {
  /**
   * Contour
   *
   * @class {Contour}
   */
  constructor() {
    this.points = [], this.holeIds = [], this.holeOf = null, this.depth = null;
  }
  isExterior() {
    return this.holeOf == null;
  }
};
function b(n) {
  let t, e, i, o2, r2;
  const s = [];
  for (e = 0, i = n.length; e < i; e++)
    t = n[e], (t.left && t.inResult || !t.left && t.otherEvent.inResult) && s.push(t);
  let l = false;
  for (; !l; )
    for (l = true, e = 0, i = s.length; e < i; e++)
      e + 1 < i && w(s[e], s[e + 1]) === 1 && (o2 = s[e], s[e] = s[e + 1], s[e + 1] = o2, l = false);
  for (e = 0, i = s.length; e < i; e++)
    t = s[e], t.otherPos = e;
  for (e = 0, i = s.length; e < i; e++)
    t = s[e], t.left || (r2 = t.otherPos, t.otherPos = t.otherEvent.otherPos, t.otherEvent.otherPos = r2);
  return s;
}
function q(n, t, e, i) {
  let o2 = n + 1, r2 = t[n].point, s;
  const l = t.length;
  for (o2 < l && (s = t[o2].point); o2 < l && s[0] === r2[0] && s[1] === r2[1]; ) {
    if (e[o2])
      o2++;
    else
      return o2;
    o2 < l && (s = t[o2].point);
  }
  for (o2 = n - 1; e[o2] && o2 > i; )
    o2--;
  return o2;
}
function tt2(n, t, e) {
  const i = new H();
  if (n.prevInResult != null) {
    const o2 = n.prevInResult, r2 = o2.outputContourId;
    if (o2.resultTransition > 0) {
      const l = t[r2];
      if (l.holeOf != null) {
        const c = l.holeOf;
        t[c].holeIds.push(e), i.holeOf = c, i.depth = t[r2].depth;
      } else
        t[r2].holeIds.push(e), i.holeOf = r2, i.depth = t[r2].depth + 1;
    } else
      i.holeOf = null, i.depth = t[r2].depth;
  } else
    i.holeOf = null, i.depth = 0;
  return i;
}
function nt(n) {
  let t, e;
  const i = b(n), o2 = {}, r2 = [];
  for (t = 0, e = i.length; t < e; t++) {
    if (o2[t])
      continue;
    const s = r2.length, l = tt2(i[t], r2, s), c = (h) => {
      o2[h] = true, h < i.length && i[h] && (i[h].outputContourId = s);
    };
    let u2 = t, f2 = t;
    const p2 = i[t].point;
    for (l.points.push(p2); c(u2), u2 = i[u2].otherPos, c(u2), l.points.push(i[u2].point), u2 = q(u2, i, o2, f2), !(u2 == f2 || u2 >= i.length || !i[u2]); )
      ;
    r2.push(l);
  }
  return r2;
}
var L = Math.max;
var V = Math.min;
var N2 = 0;
function D(n, t, e, i, o2, r2) {
  let s, l, c, u2, f2, p2;
  for (s = 0, l = n.length - 1; s < l; s++) {
    if (c = n[s], u2 = n[s + 1], f2 = new S(c, false, void 0, t), p2 = new S(u2, false, f2, t), f2.otherEvent = p2, c[0] === u2[0] && c[1] === u2[1])
      continue;
    f2.contourId = p2.contourId = e, r2 || (f2.isExteriorRing = false, p2.isExteriorRing = false), w(f2, p2) > 0 ? p2.left = true : f2.left = true;
    const h = c[0], E = c[1];
    o2[0] = V(o2[0], h), o2[1] = V(o2[1], E), o2[2] = L(o2[2], h), o2[3] = L(o2[3], E), i.push(f2), i.push(p2);
  }
}
function et(n, t, e, i, o2) {
  const r2 = new r(void 0, w);
  let s, l, c, u2, f2, p2;
  for (c = 0, u2 = n.length; c < u2; c++)
    for (s = n[c], f2 = 0, p2 = s.length; f2 < p2; f2++)
      l = f2 === 0, l && N2++, D(
        s[f2],
        true,
        N2,
        r2,
        e,
        l
      );
  for (c = 0, u2 = t.length; c < u2; c++)
    for (s = t[c], f2 = 0, p2 = s.length; f2 < p2; f2++)
      l = f2 === 0, o2 === g2 && (l = false), l && N2++, D(
        s[f2],
        false,
        N2,
        r2,
        i,
        l
      );
  return r2;
}
var C = [];
function it2(n, t, e) {
  let i = null;
  return n.length * t.length === 0 && (e === R ? i = C : e === g2 ? i = n : (e === y || e === T) && (i = n.length === 0 ? t : n)), i;
}
function rt2(n, t, e, i, o2) {
  let r2 = null;
  return (e[0] > i[2] || i[0] > e[2] || e[1] > i[3] || i[1] > e[3]) && (o2 === R ? r2 = C : o2 === g2 ? r2 = n : (o2 === y || o2 === T) && (r2 = n.concat(t))), r2;
}
function j(n, t, e) {
  let i = n, o2 = t;
  typeof n[0][0][0] == "number" && (i = [n]), typeof t[0][0][0] == "number" && (o2 = [t]);
  let r2 = it2(i, o2, e);
  if (r2)
    return r2 === C ? null : r2;
  const s = [1 / 0, 1 / 0, -1 / 0, -1 / 0], l = [1 / 0, 1 / 0, -1 / 0, -1 / 0], c = et(i, o2, s, l, e);
  if (r2 = rt2(i, o2, s, l, e), r2)
    return r2 === C ? null : r2;
  const u2 = Q(
    c,
    i,
    o2,
    s,
    l,
    e
  ), f2 = nt(u2), p2 = [];
  for (let h = 0; h < f2.length; h++) {
    let E = f2[h];
    if (E.isExterior()) {
      let a = [E.points];
      for (let I = 0; I < E.holeIds.length; I++) {
        let d = E.holeIds[I];
        a.push(f2[d].points);
      }
      p2.push(a);
    }
  }
  return p2;
}
function lt2(n, t) {
  return j(n, t, y);
}
function ft(n, t) {
  return j(n, t, g2);
}
function ht(n, t) {
  return j(n, t, T);
}
function ct(n, t) {
  return j(n, t, R);
}
var pt = { UNION: y, DIFFERENCE: g2, INTERSECTION: R, XOR: T };
export {
  ft as diff,
  ct as intersection,
  pt as operations,
  lt2 as union,
  ht as xor
};
