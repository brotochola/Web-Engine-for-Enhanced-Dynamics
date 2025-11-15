/*!
 * @pixi/webworker - v7.4.3
 * Compiled Thu, 06 Mar 2025 14:58:55 UTC
 *
 * @pixi/webworker is licensed under the MIT License.
 * http://www.opensource.org/licenses/mit-license
 */ var PIXI = (function (v) {
  "use strict";
  var we = ((r) => (
      (r[(r.WEBGL_LEGACY = 0)] = "WEBGL_LEGACY"),
      (r[(r.WEBGL = 1)] = "WEBGL"),
      (r[(r.WEBGL2 = 2)] = "WEBGL2"),
      r
    ))(we || {}),
    Hs = ((r) => (
      (r[(r.UNKNOWN = 0)] = "UNKNOWN"),
      (r[(r.WEBGL = 1)] = "WEBGL"),
      (r[(r.CANVAS = 2)] = "CANVAS"),
      r
    ))(Hs || {}),
    wi = ((r) => (
      (r[(r.COLOR = 16384)] = "COLOR"),
      (r[(r.DEPTH = 256)] = "DEPTH"),
      (r[(r.STENCIL = 1024)] = "STENCIL"),
      r
    ))(wi || {}),
    X = ((r) => (
      (r[(r.NORMAL = 0)] = "NORMAL"),
      (r[(r.ADD = 1)] = "ADD"),
      (r[(r.MULTIPLY = 2)] = "MULTIPLY"),
      (r[(r.SCREEN = 3)] = "SCREEN"),
      (r[(r.OVERLAY = 4)] = "OVERLAY"),
      (r[(r.DARKEN = 5)] = "DARKEN"),
      (r[(r.LIGHTEN = 6)] = "LIGHTEN"),
      (r[(r.COLOR_DODGE = 7)] = "COLOR_DODGE"),
      (r[(r.COLOR_BURN = 8)] = "COLOR_BURN"),
      (r[(r.HARD_LIGHT = 9)] = "HARD_LIGHT"),
      (r[(r.SOFT_LIGHT = 10)] = "SOFT_LIGHT"),
      (r[(r.DIFFERENCE = 11)] = "DIFFERENCE"),
      (r[(r.EXCLUSION = 12)] = "EXCLUSION"),
      (r[(r.HUE = 13)] = "HUE"),
      (r[(r.SATURATION = 14)] = "SATURATION"),
      (r[(r.COLOR = 15)] = "COLOR"),
      (r[(r.LUMINOSITY = 16)] = "LUMINOSITY"),
      (r[(r.NORMAL_NPM = 17)] = "NORMAL_NPM"),
      (r[(r.ADD_NPM = 18)] = "ADD_NPM"),
      (r[(r.SCREEN_NPM = 19)] = "SCREEN_NPM"),
      (r[(r.NONE = 20)] = "NONE"),
      (r[(r.SRC_OVER = 0)] = "SRC_OVER"),
      (r[(r.SRC_IN = 21)] = "SRC_IN"),
      (r[(r.SRC_OUT = 22)] = "SRC_OUT"),
      (r[(r.SRC_ATOP = 23)] = "SRC_ATOP"),
      (r[(r.DST_OVER = 24)] = "DST_OVER"),
      (r[(r.DST_IN = 25)] = "DST_IN"),
      (r[(r.DST_OUT = 26)] = "DST_OUT"),
      (r[(r.DST_ATOP = 27)] = "DST_ATOP"),
      (r[(r.ERASE = 26)] = "ERASE"),
      (r[(r.SUBTRACT = 28)] = "SUBTRACT"),
      (r[(r.XOR = 29)] = "XOR"),
      r
    ))(X || {}),
    Vt = ((r) => (
      (r[(r.POINTS = 0)] = "POINTS"),
      (r[(r.LINES = 1)] = "LINES"),
      (r[(r.LINE_LOOP = 2)] = "LINE_LOOP"),
      (r[(r.LINE_STRIP = 3)] = "LINE_STRIP"),
      (r[(r.TRIANGLES = 4)] = "TRIANGLES"),
      (r[(r.TRIANGLE_STRIP = 5)] = "TRIANGLE_STRIP"),
      (r[(r.TRIANGLE_FAN = 6)] = "TRIANGLE_FAN"),
      r
    ))(Vt || {}),
    A = ((r) => (
      (r[(r.RGBA = 6408)] = "RGBA"),
      (r[(r.RGB = 6407)] = "RGB"),
      (r[(r.RG = 33319)] = "RG"),
      (r[(r.RED = 6403)] = "RED"),
      (r[(r.RGBA_INTEGER = 36249)] = "RGBA_INTEGER"),
      (r[(r.RGB_INTEGER = 36248)] = "RGB_INTEGER"),
      (r[(r.RG_INTEGER = 33320)] = "RG_INTEGER"),
      (r[(r.RED_INTEGER = 36244)] = "RED_INTEGER"),
      (r[(r.ALPHA = 6406)] = "ALPHA"),
      (r[(r.LUMINANCE = 6409)] = "LUMINANCE"),
      (r[(r.LUMINANCE_ALPHA = 6410)] = "LUMINANCE_ALPHA"),
      (r[(r.DEPTH_COMPONENT = 6402)] = "DEPTH_COMPONENT"),
      (r[(r.DEPTH_STENCIL = 34041)] = "DEPTH_STENCIL"),
      r
    ))(A || {}),
    ke = ((r) => (
      (r[(r.TEXTURE_2D = 3553)] = "TEXTURE_2D"),
      (r[(r.TEXTURE_CUBE_MAP = 34067)] = "TEXTURE_CUBE_MAP"),
      (r[(r.TEXTURE_2D_ARRAY = 35866)] = "TEXTURE_2D_ARRAY"),
      (r[(r.TEXTURE_CUBE_MAP_POSITIVE_X = 34069)] =
        "TEXTURE_CUBE_MAP_POSITIVE_X"),
      (r[(r.TEXTURE_CUBE_MAP_NEGATIVE_X = 34070)] =
        "TEXTURE_CUBE_MAP_NEGATIVE_X"),
      (r[(r.TEXTURE_CUBE_MAP_POSITIVE_Y = 34071)] =
        "TEXTURE_CUBE_MAP_POSITIVE_Y"),
      (r[(r.TEXTURE_CUBE_MAP_NEGATIVE_Y = 34072)] =
        "TEXTURE_CUBE_MAP_NEGATIVE_Y"),
      (r[(r.TEXTURE_CUBE_MAP_POSITIVE_Z = 34073)] =
        "TEXTURE_CUBE_MAP_POSITIVE_Z"),
      (r[(r.TEXTURE_CUBE_MAP_NEGATIVE_Z = 34074)] =
        "TEXTURE_CUBE_MAP_NEGATIVE_Z"),
      r
    ))(ke || {}),
    H = ((r) => (
      (r[(r.UNSIGNED_BYTE = 5121)] = "UNSIGNED_BYTE"),
      (r[(r.UNSIGNED_SHORT = 5123)] = "UNSIGNED_SHORT"),
      (r[(r.UNSIGNED_SHORT_5_6_5 = 33635)] = "UNSIGNED_SHORT_5_6_5"),
      (r[(r.UNSIGNED_SHORT_4_4_4_4 = 32819)] = "UNSIGNED_SHORT_4_4_4_4"),
      (r[(r.UNSIGNED_SHORT_5_5_5_1 = 32820)] = "UNSIGNED_SHORT_5_5_5_1"),
      (r[(r.UNSIGNED_INT = 5125)] = "UNSIGNED_INT"),
      (r[(r.UNSIGNED_INT_10F_11F_11F_REV = 35899)] =
        "UNSIGNED_INT_10F_11F_11F_REV"),
      (r[(r.UNSIGNED_INT_2_10_10_10_REV = 33640)] =
        "UNSIGNED_INT_2_10_10_10_REV"),
      (r[(r.UNSIGNED_INT_24_8 = 34042)] = "UNSIGNED_INT_24_8"),
      (r[(r.UNSIGNED_INT_5_9_9_9_REV = 35902)] = "UNSIGNED_INT_5_9_9_9_REV"),
      (r[(r.BYTE = 5120)] = "BYTE"),
      (r[(r.SHORT = 5122)] = "SHORT"),
      (r[(r.INT = 5124)] = "INT"),
      (r[(r.FLOAT = 5126)] = "FLOAT"),
      (r[(r.FLOAT_32_UNSIGNED_INT_24_8_REV = 36269)] =
        "FLOAT_32_UNSIGNED_INT_24_8_REV"),
      (r[(r.HALF_FLOAT = 36193)] = "HALF_FLOAT"),
      r
    ))(H || {}),
    N = ((r) => (
      (r[(r.FLOAT = 0)] = "FLOAT"),
      (r[(r.INT = 1)] = "INT"),
      (r[(r.UINT = 2)] = "UINT"),
      r
    ))(N || {}),
    Qt = ((r) => (
      (r[(r.NEAREST = 0)] = "NEAREST"), (r[(r.LINEAR = 1)] = "LINEAR"), r
    ))(Qt || {}),
    Jt = ((r) => (
      (r[(r.CLAMP = 33071)] = "CLAMP"),
      (r[(r.REPEAT = 10497)] = "REPEAT"),
      (r[(r.MIRRORED_REPEAT = 33648)] = "MIRRORED_REPEAT"),
      r
    ))(Jt || {}),
    Xt = ((r) => (
      (r[(r.OFF = 0)] = "OFF"),
      (r[(r.POW2 = 1)] = "POW2"),
      (r[(r.ON = 2)] = "ON"),
      (r[(r.ON_MANUAL = 3)] = "ON_MANUAL"),
      r
    ))(Xt || {}),
    wt = ((r) => (
      (r[(r.NPM = 0)] = "NPM"),
      (r[(r.UNPACK = 1)] = "UNPACK"),
      (r[(r.PMA = 2)] = "PMA"),
      (r[(r.NO_PREMULTIPLIED_ALPHA = 0)] = "NO_PREMULTIPLIED_ALPHA"),
      (r[(r.PREMULTIPLY_ON_UPLOAD = 1)] = "PREMULTIPLY_ON_UPLOAD"),
      (r[(r.PREMULTIPLIED_ALPHA = 2)] = "PREMULTIPLIED_ALPHA"),
      r
    ))(wt || {}),
    zt = ((r) => (
      (r[(r.NO = 0)] = "NO"),
      (r[(r.YES = 1)] = "YES"),
      (r[(r.AUTO = 2)] = "AUTO"),
      (r[(r.BLEND = 0)] = "BLEND"),
      (r[(r.CLEAR = 1)] = "CLEAR"),
      (r[(r.BLIT = 2)] = "BLIT"),
      r
    ))(zt || {}),
    Ri = ((r) => (
      (r[(r.AUTO = 0)] = "AUTO"), (r[(r.MANUAL = 1)] = "MANUAL"), r
    ))(Ri || {}),
    Pt = ((r) => (
      (r.LOW = "lowp"), (r.MEDIUM = "mediump"), (r.HIGH = "highp"), r
    ))(Pt || {}),
    ut = ((r) => (
      (r[(r.NONE = 0)] = "NONE"),
      (r[(r.SCISSOR = 1)] = "SCISSOR"),
      (r[(r.STENCIL = 2)] = "STENCIL"),
      (r[(r.SPRITE = 3)] = "SPRITE"),
      (r[(r.COLOR = 4)] = "COLOR"),
      r
    ))(ut || {}),
    Za = ((r) => (
      (r[(r.RED = 1)] = "RED"),
      (r[(r.GREEN = 2)] = "GREEN"),
      (r[(r.BLUE = 4)] = "BLUE"),
      (r[(r.ALPHA = 8)] = "ALPHA"),
      r
    ))(Za || {}),
    ot = ((r) => (
      (r[(r.NONE = 0)] = "NONE"),
      (r[(r.LOW = 2)] = "LOW"),
      (r[(r.MEDIUM = 4)] = "MEDIUM"),
      (r[(r.HIGH = 8)] = "HIGH"),
      r
    ))(ot || {}),
    jt = ((r) => (
      (r[(r.ELEMENT_ARRAY_BUFFER = 34963)] = "ELEMENT_ARRAY_BUFFER"),
      (r[(r.ARRAY_BUFFER = 34962)] = "ARRAY_BUFFER"),
      (r[(r.UNIFORM_BUFFER = 35345)] = "UNIFORM_BUFFER"),
      r
    ))(jt || {});
  const Qa = {
      createCanvas: (r, t) => {
        const e = document.createElement("canvas");
        return (e.width = r), (e.height = t), e;
      },
      getCanvasRenderingContext2D: () => CanvasRenderingContext2D,
      getWebGLRenderingContext: () => WebGLRenderingContext,
      getNavigator: () => navigator,
      getBaseUrl: () => {
        var r;
        return (r = document.baseURI) != null ? r : window.location.href;
      },
      getFontFaceSet: () => document.fonts,
      fetch: (r, t) => fetch(r, t),
      parseXML: (r) => new DOMParser().parseFromString(r, "text/xml"),
    },
    B = {
      ADAPTER: Qa,
      RESOLUTION: 1,
      CREATE_IMAGE_BITMAP: !1,
      ROUND_PIXELS: !1,
    };
  var Vs = /iPhone/i,
    Ja = /iPod/i,
    to = /iPad/i,
    eo = /\biOS-universal(?:.+)Mac\b/i,
    Xs = /\bAndroid(?:.+)Mobile\b/i,
    ro = /Android/i,
    er = /(?:SD4930UR|\bSilk(?:.+)Mobile\b)/i,
    Ii = /Silk/i,
    fe = /Windows Phone/i,
    io = /\bWindows(?:.+)ARM\b/i,
    so = /BlackBerry/i,
    no = /BB10/i,
    ao = /Opera Mini/i,
    oo = /\b(CriOS|Chrome)(?:.+)Mobile/i,
    ho = /Mobile(?:.+)Firefox\b/i,
    lo = function (r) {
      return (
        typeof r != "undefined" &&
        r.platform === "MacIntel" &&
        typeof r.maxTouchPoints == "number" &&
        r.maxTouchPoints > 1 &&
        typeof MSStream == "undefined"
      );
    };
  function Lc(r) {
    return function (t) {
      return t.test(r);
    };
  }
  function uo(r) {
    var t = { userAgent: "", platform: "", maxTouchPoints: 0 };
    !r && typeof navigator != "undefined"
      ? (t = {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          maxTouchPoints: navigator.maxTouchPoints || 0,
        })
      : typeof r == "string"
      ? (t.userAgent = r)
      : r &&
        r.userAgent &&
        (t = {
          userAgent: r.userAgent,
          platform: r.platform,
          maxTouchPoints: r.maxTouchPoints || 0,
        });
    var e = t.userAgent,
      i = e.split("[FBAN");
    typeof i[1] != "undefined" && (e = i[0]),
      (i = e.split("Twitter")),
      typeof i[1] != "undefined" && (e = i[0]);
    var s = Lc(e),
      n = {
        apple: {
          phone: s(Vs) && !s(fe),
          ipod: s(Ja),
          tablet: !s(Vs) && (s(to) || lo(t)) && !s(fe),
          universal: s(eo),
          device: (s(Vs) || s(Ja) || s(to) || s(eo) || lo(t)) && !s(fe),
        },
        amazon: {
          phone: s(er),
          tablet: !s(er) && s(Ii),
          device: s(er) || s(Ii),
        },
        android: {
          phone: (!s(fe) && s(er)) || (!s(fe) && s(Xs)),
          tablet: !s(fe) && !s(er) && !s(Xs) && (s(Ii) || s(ro)),
          device:
            (!s(fe) && (s(er) || s(Ii) || s(Xs) || s(ro))) || s(/\bokhttp\b/i),
        },
        windows: { phone: s(fe), tablet: s(io), device: s(fe) || s(io) },
        other: {
          blackberry: s(so),
          blackberry10: s(no),
          opera: s(ao),
          firefox: s(ho),
          chrome: s(oo),
          device: s(so) || s(no) || s(ao) || s(ho) || s(oo),
        },
        any: !1,
        phone: !1,
        tablet: !1,
      };
    return (
      (n.any =
        n.apple.device ||
        n.android.device ||
        n.windows.device ||
        n.other.device),
      (n.phone = n.apple.phone || n.android.phone || n.windows.phone),
      (n.tablet = n.apple.tablet || n.android.tablet || n.windows.tablet),
      n
    );
  }
  var co;
  const Re = ((co = uo.default) != null ? co : uo)(globalThis.navigator);
  (B.RETINA_PREFIX = /@([0-9\.]+)x/), (B.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = !1);
  var zs =
    typeof globalThis != "undefined"
      ? globalThis
      : typeof window != "undefined"
      ? window
      : typeof global != "undefined"
      ? global
      : typeof self != "undefined"
      ? self
      : {};
  function Ge(r) {
    return r &&
      r.__esModule &&
      Object.prototype.hasOwnProperty.call(r, "default")
      ? r.default
      : r;
  }
  function E_(r) {
    return r && Object.prototype.hasOwnProperty.call(r, "default")
      ? r.default
      : r;
  }
  function T_(r) {
    return r &&
      Object.prototype.hasOwnProperty.call(r, "default") &&
      Object.keys(r).length === 1
      ? r.default
      : r;
  }
  function A_(r) {
    if (r.__esModule) return r;
    var t = r.default;
    if (typeof t == "function") {
      var e = function i() {
        if (this instanceof i) {
          var s = [null];
          s.push.apply(s, arguments);
          var n = Function.bind.apply(t, s);
          return new n();
        }
        return t.apply(this, arguments);
      };
      e.prototype = t.prototype;
    } else e = {};
    return (
      Object.defineProperty(e, "__esModule", { value: !0 }),
      Object.keys(r).forEach(function (i) {
        var s = Object.getOwnPropertyDescriptor(r, i);
        Object.defineProperty(
          e,
          i,
          s.get
            ? s
            : {
                enumerable: !0,
                get: function () {
                  return r[i];
                },
              }
        );
      }),
      e
    );
  }
  var js = { exports: {} },
    S_ = js.exports;
  (function (r) {
    "use strict";
    var t = Object.prototype.hasOwnProperty,
      e = "~";
    function i() {}
    Object.create &&
      ((i.prototype = Object.create(null)), new i().__proto__ || (e = !1));
    function s(h, l, u) {
      (this.fn = h), (this.context = l), (this.once = u || !1);
    }
    function n(h, l, u, c, d) {
      if (typeof u != "function")
        throw new TypeError("The listener must be a function");
      var f = new s(u, c || h, d),
        p = e ? e + l : l;
      return (
        h._events[p]
          ? h._events[p].fn
            ? (h._events[p] = [h._events[p], f])
            : h._events[p].push(f)
          : ((h._events[p] = f), h._eventsCount++),
        h
      );
    }
    function a(h, l) {
      --h._eventsCount === 0 ? (h._events = new i()) : delete h._events[l];
    }
    function o() {
      (this._events = new i()), (this._eventsCount = 0);
    }
    (o.prototype.eventNames = function () {
      var l = [],
        u,
        c;
      if (this._eventsCount === 0) return l;
      for (c in (u = this._events)) t.call(u, c) && l.push(e ? c.slice(1) : c);
      return Object.getOwnPropertySymbols
        ? l.concat(Object.getOwnPropertySymbols(u))
        : l;
    }),
      (o.prototype.listeners = function (l) {
        var u = e ? e + l : l,
          c = this._events[u];
        if (!c) return [];
        if (c.fn) return [c.fn];
        for (var d = 0, f = c.length, p = new Array(f); d < f; d++)
          p[d] = c[d].fn;
        return p;
      }),
      (o.prototype.listenerCount = function (l) {
        var u = e ? e + l : l,
          c = this._events[u];
        return c ? (c.fn ? 1 : c.length) : 0;
      }),
      (o.prototype.emit = function (l, u, c, d, f, p) {
        var m = e ? e + l : l;
        if (!this._events[m]) return !1;
        var g = this._events[m],
          x = arguments.length,
          b,
          _;
        if (g.fn) {
          switch ((g.once && this.removeListener(l, g.fn, void 0, !0), x)) {
            case 1:
              return g.fn.call(g.context), !0;
            case 2:
              return g.fn.call(g.context, u), !0;
            case 3:
              return g.fn.call(g.context, u, c), !0;
            case 4:
              return g.fn.call(g.context, u, c, d), !0;
            case 5:
              return g.fn.call(g.context, u, c, d, f), !0;
            case 6:
              return g.fn.call(g.context, u, c, d, f, p), !0;
          }
          for (_ = 1, b = new Array(x - 1); _ < x; _++) b[_ - 1] = arguments[_];
          g.fn.apply(g.context, b);
        } else {
          var y = g.length,
            T;
          for (_ = 0; _ < y; _++)
            switch (
              (g[_].once && this.removeListener(l, g[_].fn, void 0, !0), x)
            ) {
              case 1:
                g[_].fn.call(g[_].context);
                break;
              case 2:
                g[_].fn.call(g[_].context, u);
                break;
              case 3:
                g[_].fn.call(g[_].context, u, c);
                break;
              case 4:
                g[_].fn.call(g[_].context, u, c, d);
                break;
              default:
                if (!b)
                  for (T = 1, b = new Array(x - 1); T < x; T++)
                    b[T - 1] = arguments[T];
                g[_].fn.apply(g[_].context, b);
            }
        }
        return !0;
      }),
      (o.prototype.on = function (l, u, c) {
        return n(this, l, u, c, !1);
      }),
      (o.prototype.once = function (l, u, c) {
        return n(this, l, u, c, !0);
      }),
      (o.prototype.removeListener = function (l, u, c, d) {
        var f = e ? e + l : l;
        if (!this._events[f]) return this;
        if (!u) return a(this, f), this;
        var p = this._events[f];
        if (p.fn)
          p.fn === u && (!d || p.once) && (!c || p.context === c) && a(this, f);
        else {
          for (var m = 0, g = [], x = p.length; m < x; m++)
            (p[m].fn !== u || (d && !p[m].once) || (c && p[m].context !== c)) &&
              g.push(p[m]);
          g.length ? (this._events[f] = g.length === 1 ? g[0] : g) : a(this, f);
        }
        return this;
      }),
      (o.prototype.removeAllListeners = function (l) {
        var u;
        return (
          l
            ? ((u = e ? e + l : l), this._events[u] && a(this, u))
            : ((this._events = new i()), (this._eventsCount = 0)),
          this
        );
      }),
      (o.prototype.off = o.prototype.removeListener),
      (o.prototype.addListener = o.prototype.on),
      (o.prefixed = e),
      (o.EventEmitter = o),
      (r.exports = o);
  })(js);
  var Uc = js.exports,
    Sr = Ge(Uc),
    Ci = { exports: {} },
    w_ = Ci.exports;
  Ci.exports = Mi;
  var R_ = (Ci.exports.default = Mi);
  function Mi(r, t, e) {
    e = e || 2;
    var i = t && t.length,
      s = i ? t[0] * e : r.length,
      n = fo(r, 0, s, e, !0),
      a = [];
    if (!n || n.next === n.prev) return a;
    var o, h, l, u, c, d, f;
    if ((i && (n = Vc(r, t, n, e)), r.length > 80 * e)) {
      (o = l = r[0]), (h = u = r[1]);
      for (var p = e; p < s; p += e)
        (c = r[p]),
          (d = r[p + 1]),
          c < o && (o = c),
          d < h && (h = d),
          c > l && (l = c),
          d > u && (u = d);
      (f = Math.max(l - o, u - h)), (f = f !== 0 ? 32767 / f : 0);
    }
    return wr(n, a, e, o, h, f, 0), a;
  }
  function fo(r, t, e, i, s) {
    var n, a;
    if (s === qs(r, t, e, i) > 0)
      for (n = t; n < e; n += i) a = go(n, r[n], r[n + 1], a);
    else for (n = e - i; n >= t; n -= i) a = go(n, r[n], r[n + 1], a);
    return a && Pi(a, a.next) && (Ir(a), (a = a.next)), a;
  }
  function $e(r, t) {
    if (!r) return r;
    t || (t = r);
    var e = r,
      i;
    do
      if (
        ((i = !1), !e.steiner && (Pi(e, e.next) || st(e.prev, e, e.next) === 0))
      ) {
        if ((Ir(e), (e = t = e.prev), e === e.next)) break;
        i = !0;
      } else e = e.next;
    while (i || e !== t);
    return t;
  }
  function wr(r, t, e, i, s, n, a) {
    if (r) {
      !a && n && Yc(r, i, s, n);
      for (var o = r, h, l; r.prev !== r.next; ) {
        if (((h = r.prev), (l = r.next), n ? Gc(r, i, s, n) : kc(r))) {
          t.push((h.i / e) | 0),
            t.push((r.i / e) | 0),
            t.push((l.i / e) | 0),
            Ir(r),
            (r = l.next),
            (o = l.next);
          continue;
        }
        if (((r = l), r === o)) {
          a
            ? a === 1
              ? ((r = $c($e(r), t, e)), wr(r, t, e, i, s, n, 2))
              : a === 2 && Hc(r, t, e, i, s, n)
            : wr($e(r), t, e, i, s, n, 1);
          break;
        }
      }
    }
  }
  function kc(r) {
    var t = r.prev,
      e = r,
      i = r.next;
    if (st(t, e, i) >= 0) return !1;
    for (
      var s = t.x,
        n = e.x,
        a = i.x,
        o = t.y,
        h = e.y,
        l = i.y,
        u = s < n ? (s < a ? s : a) : n < a ? n : a,
        c = o < h ? (o < l ? o : l) : h < l ? h : l,
        d = s > n ? (s > a ? s : a) : n > a ? n : a,
        f = o > h ? (o > l ? o : l) : h > l ? h : l,
        p = i.next;
      p !== t;

    ) {
      if (
        p.x >= u &&
        p.x <= d &&
        p.y >= c &&
        p.y <= f &&
        rr(s, o, n, h, a, l, p.x, p.y) &&
        st(p.prev, p, p.next) >= 0
      )
        return !1;
      p = p.next;
    }
    return !0;
  }
  function Gc(r, t, e, i) {
    var s = r.prev,
      n = r,
      a = r.next;
    if (st(s, n, a) >= 0) return !1;
    for (
      var o = s.x,
        h = n.x,
        l = a.x,
        u = s.y,
        c = n.y,
        d = a.y,
        f = o < h ? (o < l ? o : l) : h < l ? h : l,
        p = u < c ? (u < d ? u : d) : c < d ? c : d,
        m = o > h ? (o > l ? o : l) : h > l ? h : l,
        g = u > c ? (u > d ? u : d) : c > d ? c : d,
        x = Ws(f, p, t, e, i),
        b = Ws(m, g, t, e, i),
        _ = r.prevZ,
        y = r.nextZ;
      _ && _.z >= x && y && y.z <= b;

    ) {
      if (
        (_.x >= f &&
          _.x <= m &&
          _.y >= p &&
          _.y <= g &&
          _ !== s &&
          _ !== a &&
          rr(o, u, h, c, l, d, _.x, _.y) &&
          st(_.prev, _, _.next) >= 0) ||
        ((_ = _.prevZ),
        y.x >= f &&
          y.x <= m &&
          y.y >= p &&
          y.y <= g &&
          y !== s &&
          y !== a &&
          rr(o, u, h, c, l, d, y.x, y.y) &&
          st(y.prev, y, y.next) >= 0)
      )
        return !1;
      y = y.nextZ;
    }
    for (; _ && _.z >= x; ) {
      if (
        _.x >= f &&
        _.x <= m &&
        _.y >= p &&
        _.y <= g &&
        _ !== s &&
        _ !== a &&
        rr(o, u, h, c, l, d, _.x, _.y) &&
        st(_.prev, _, _.next) >= 0
      )
        return !1;
      _ = _.prevZ;
    }
    for (; y && y.z <= b; ) {
      if (
        y.x >= f &&
        y.x <= m &&
        y.y >= p &&
        y.y <= g &&
        y !== s &&
        y !== a &&
        rr(o, u, h, c, l, d, y.x, y.y) &&
        st(y.prev, y, y.next) >= 0
      )
        return !1;
      y = y.nextZ;
    }
    return !0;
  }
  function $c(r, t, e) {
    var i = r;
    do {
      var s = i.prev,
        n = i.next.next;
      !Pi(s, n) &&
        po(s, i, i.next, n) &&
        Rr(s, n) &&
        Rr(n, s) &&
        (t.push((s.i / e) | 0),
        t.push((i.i / e) | 0),
        t.push((n.i / e) | 0),
        Ir(i),
        Ir(i.next),
        (i = r = n)),
        (i = i.next);
    } while (i !== r);
    return $e(i);
  }
  function Hc(r, t, e, i, s, n) {
    var a = r;
    do {
      for (var o = a.next.next; o !== a.prev; ) {
        if (a.i !== o.i && Zc(a, o)) {
          var h = mo(a, o);
          (a = $e(a, a.next)),
            (h = $e(h, h.next)),
            wr(a, t, e, i, s, n, 0),
            wr(h, t, e, i, s, n, 0);
          return;
        }
        o = o.next;
      }
      a = a.next;
    } while (a !== r);
  }
  function Vc(r, t, e, i) {
    var s = [],
      n,
      a,
      o,
      h,
      l;
    for (n = 0, a = t.length; n < a; n++)
      (o = t[n] * i),
        (h = n < a - 1 ? t[n + 1] * i : r.length),
        (l = fo(r, o, h, i, !1)),
        l === l.next && (l.steiner = !0),
        s.push(Kc(l));
    for (s.sort(Xc), n = 0; n < s.length; n++) e = zc(s[n], e);
    return e;
  }
  function Xc(r, t) {
    return r.x - t.x;
  }
  function zc(r, t) {
    var e = jc(r, t);
    if (!e) return t;
    var i = mo(e, r);
    return $e(i, i.next), $e(e, e.next);
  }
  function jc(r, t) {
    var e = t,
      i = r.x,
      s = r.y,
      n = -1 / 0,
      a;
    do {
      if (s <= e.y && s >= e.next.y && e.next.y !== e.y) {
        var o = e.x + ((s - e.y) * (e.next.x - e.x)) / (e.next.y - e.y);
        if (
          o <= i &&
          o > n &&
          ((n = o), (a = e.x < e.next.x ? e : e.next), o === i)
        )
          return a;
      }
      e = e.next;
    } while (e !== t);
    if (!a) return null;
    var h = a,
      l = a.x,
      u = a.y,
      c = 1 / 0,
      d;
    e = a;
    do
      i >= e.x &&
        e.x >= l &&
        i !== e.x &&
        rr(s < u ? i : n, s, l, u, s < u ? n : i, s, e.x, e.y) &&
        ((d = Math.abs(s - e.y) / (i - e.x)),
        Rr(e, r) &&
          (d < c || (d === c && (e.x > a.x || (e.x === a.x && Wc(a, e))))) &&
          ((a = e), (c = d))),
        (e = e.next);
    while (e !== h);
    return a;
  }
  function Wc(r, t) {
    return st(r.prev, r, t.prev) < 0 && st(t.next, r, r.next) < 0;
  }
  function Yc(r, t, e, i) {
    var s = r;
    do
      s.z === 0 && (s.z = Ws(s.x, s.y, t, e, i)),
        (s.prevZ = s.prev),
        (s.nextZ = s.next),
        (s = s.next);
    while (s !== r);
    (s.prevZ.nextZ = null), (s.prevZ = null), qc(s);
  }
  function qc(r) {
    var t,
      e,
      i,
      s,
      n,
      a,
      o,
      h,
      l = 1;
    do {
      for (e = r, r = null, n = null, a = 0; e; ) {
        for (a++, i = e, o = 0, t = 0; t < l && (o++, (i = i.nextZ), !!i); t++);
        for (h = l; o > 0 || (h > 0 && i); )
          o !== 0 && (h === 0 || !i || e.z <= i.z)
            ? ((s = e), (e = e.nextZ), o--)
            : ((s = i), (i = i.nextZ), h--),
            n ? (n.nextZ = s) : (r = s),
            (s.prevZ = n),
            (n = s);
        e = i;
      }
      (n.nextZ = null), (l *= 2);
    } while (a > 1);
    return r;
  }
  function Ws(r, t, e, i, s) {
    return (
      (r = ((r - e) * s) | 0),
      (t = ((t - i) * s) | 0),
      (r = (r | (r << 8)) & 16711935),
      (r = (r | (r << 4)) & 252645135),
      (r = (r | (r << 2)) & 858993459),
      (r = (r | (r << 1)) & 1431655765),
      (t = (t | (t << 8)) & 16711935),
      (t = (t | (t << 4)) & 252645135),
      (t = (t | (t << 2)) & 858993459),
      (t = (t | (t << 1)) & 1431655765),
      r | (t << 1)
    );
  }
  function Kc(r) {
    var t = r,
      e = r;
    do (t.x < e.x || (t.x === e.x && t.y < e.y)) && (e = t), (t = t.next);
    while (t !== r);
    return e;
  }
  function rr(r, t, e, i, s, n, a, o) {
    return (
      (s - a) * (t - o) >= (r - a) * (n - o) &&
      (r - a) * (i - o) >= (e - a) * (t - o) &&
      (e - a) * (n - o) >= (s - a) * (i - o)
    );
  }
  function Zc(r, t) {
    return (
      r.next.i !== t.i &&
      r.prev.i !== t.i &&
      !Qc(r, t) &&
      ((Rr(r, t) &&
        Rr(t, r) &&
        Jc(r, t) &&
        (st(r.prev, r, t.prev) || st(r, t.prev, t))) ||
        (Pi(r, t) && st(r.prev, r, r.next) > 0 && st(t.prev, t, t.next) > 0))
    );
  }
  function st(r, t, e) {
    return (t.y - r.y) * (e.x - t.x) - (t.x - r.x) * (e.y - t.y);
  }
  function Pi(r, t) {
    return r.x === t.x && r.y === t.y;
  }
  function po(r, t, e, i) {
    var s = Ni(st(r, t, e)),
      n = Ni(st(r, t, i)),
      a = Ni(st(e, i, r)),
      o = Ni(st(e, i, t));
    return !!(
      (s !== n && a !== o) ||
      (s === 0 && Di(r, e, t)) ||
      (n === 0 && Di(r, i, t)) ||
      (a === 0 && Di(e, r, i)) ||
      (o === 0 && Di(e, t, i))
    );
  }
  function Di(r, t, e) {
    return (
      t.x <= Math.max(r.x, e.x) &&
      t.x >= Math.min(r.x, e.x) &&
      t.y <= Math.max(r.y, e.y) &&
      t.y >= Math.min(r.y, e.y)
    );
  }
  function Ni(r) {
    return r > 0 ? 1 : r < 0 ? -1 : 0;
  }
  function Qc(r, t) {
    var e = r;
    do {
      if (
        e.i !== r.i &&
        e.next.i !== r.i &&
        e.i !== t.i &&
        e.next.i !== t.i &&
        po(e, e.next, r, t)
      )
        return !0;
      e = e.next;
    } while (e !== r);
    return !1;
  }
  function Rr(r, t) {
    return st(r.prev, r, r.next) < 0
      ? st(r, t, r.next) >= 0 && st(r, r.prev, t) >= 0
      : st(r, t, r.prev) < 0 || st(r, r.next, t) < 0;
  }
  function Jc(r, t) {
    var e = r,
      i = !1,
      s = (r.x + t.x) / 2,
      n = (r.y + t.y) / 2;
    do
      e.y > n != e.next.y > n &&
        e.next.y !== e.y &&
        s < ((e.next.x - e.x) * (n - e.y)) / (e.next.y - e.y) + e.x &&
        (i = !i),
        (e = e.next);
    while (e !== r);
    return i;
  }
  function mo(r, t) {
    var e = new Ys(r.i, r.x, r.y),
      i = new Ys(t.i, t.x, t.y),
      s = r.next,
      n = t.prev;
    return (
      (r.next = t),
      (t.prev = r),
      (e.next = s),
      (s.prev = e),
      (i.next = e),
      (e.prev = i),
      (n.next = i),
      (i.prev = n),
      i
    );
  }
  function go(r, t, e, i) {
    var s = new Ys(r, t, e);
    return (
      i
        ? ((s.next = i.next), (s.prev = i), (i.next.prev = s), (i.next = s))
        : ((s.prev = s), (s.next = s)),
      s
    );
  }
  function Ir(r) {
    (r.next.prev = r.prev),
      (r.prev.next = r.next),
      r.prevZ && (r.prevZ.nextZ = r.nextZ),
      r.nextZ && (r.nextZ.prevZ = r.prevZ);
  }
  function Ys(r, t, e) {
    (this.i = r),
      (this.x = t),
      (this.y = e),
      (this.prev = null),
      (this.next = null),
      (this.z = 0),
      (this.prevZ = null),
      (this.nextZ = null),
      (this.steiner = !1);
  }
  Mi.deviation = function (r, t, e, i) {
    var s = t && t.length,
      n = s ? t[0] * e : r.length,
      a = Math.abs(qs(r, 0, n, e));
    if (s)
      for (var o = 0, h = t.length; o < h; o++) {
        var l = t[o] * e,
          u = o < h - 1 ? t[o + 1] * e : r.length;
        a -= Math.abs(qs(r, l, u, e));
      }
    var c = 0;
    for (o = 0; o < i.length; o += 3) {
      var d = i[o] * e,
        f = i[o + 1] * e,
        p = i[o + 2] * e;
      c += Math.abs(
        (r[d] - r[p]) * (r[f + 1] - r[d + 1]) -
          (r[d] - r[f]) * (r[p + 1] - r[d + 1])
      );
    }
    return a === 0 && c === 0 ? 0 : Math.abs((c - a) / a);
  };
  function qs(r, t, e, i) {
    for (var s = 0, n = t, a = e - i; n < e; n += i)
      (s += (r[a] - r[n]) * (r[n + 1] + r[a + 1])), (a = n);
    return s;
  }
  Mi.flatten = function (r) {
    for (
      var t = r[0][0].length,
        e = { vertices: [], holes: [], dimensions: t },
        i = 0,
        s = 0;
      s < r.length;
      s++
    ) {
      for (var n = 0; n < r[s].length; n++)
        for (var a = 0; a < t; a++) e.vertices.push(r[s][n][a]);
      s > 0 && ((i += r[s - 1].length), e.holes.push(i));
    }
    return e;
  };
  var td = Ci.exports,
    _o = Ge(td),
    Cr = {},
    Oi = { exports: {} };
  /*! https://mths.be/punycode v1.3.2 by @mathias */ var I_ = Oi.exports;
  (function (r, t) {
    (function (e) {
      var i = t && !t.nodeType && t,
        s = r && !r.nodeType && r,
        n = typeof zs == "object" && zs;
      (n.global === n || n.window === n || n.self === n) && (e = n);
      var a,
        o = 2147483647,
        h = 36,
        l = 1,
        u = 26,
        c = 38,
        d = 700,
        f = 72,
        p = 128,
        m = "-",
        g = /^xn--/,
        x = /[^\x20-\x7E]/,
        b = /[\x2E\u3002\uFF0E\uFF61]/g,
        _ = {
          overflow: "Overflow: input needs wider integers to process",
          "not-basic": "Illegal input >= 0x80 (not a basic code point)",
          "invalid-input": "Invalid input",
        },
        y = h - l,
        T = Math.floor,
        C = String.fromCharCode,
        R;
      function S(P) {
        throw RangeError(_[P]);
      }
      function I(P, M) {
        for (var q = P.length, Q = []; q--; ) Q[q] = M(P[q]);
        return Q;
      }
      function $(P, M) {
        var q = P.split("@"),
          Q = "";
        q.length > 1 && ((Q = q[0] + "@"), (P = q[1])), (P = P.replace(b, "."));
        var J = P.split("."),
          vt = I(J, M).join(".");
        return Q + vt;
      }
      function z(P) {
        for (var M = [], q = 0, Q = P.length, J, vt; q < Q; )
          (J = P.charCodeAt(q++)),
            J >= 55296 && J <= 56319 && q < Q
              ? ((vt = P.charCodeAt(q++)),
                (vt & 64512) == 56320
                  ? M.push(((J & 1023) << 10) + (vt & 1023) + 65536)
                  : (M.push(J), q--))
              : M.push(J);
        return M;
      }
      function F(P) {
        return I(P, function (M) {
          var q = "";
          return (
            M > 65535 &&
              ((M -= 65536),
              (q += C(((M >>> 10) & 1023) | 55296)),
              (M = 56320 | (M & 1023))),
            (q += C(M)),
            q
          );
        }).join("");
      }
      function E(P) {
        return P - 48 < 10
          ? P - 22
          : P - 65 < 26
          ? P - 65
          : P - 97 < 26
          ? P - 97
          : h;
      }
      function w(P, M) {
        return P + 22 + 75 * (P < 26) - ((M != 0) << 5);
      }
      function V(P, M, q) {
        var Q = 0;
        for (P = q ? T(P / d) : P >> 1, P += T(P / M); P > (y * u) >> 1; Q += h)
          P = T(P / y);
        return T(Q + ((y + 1) * P) / (P + c));
      }
      function k(P) {
        var M = [],
          q = P.length,
          Q,
          J = 0,
          vt = p,
          ct = f,
          xt,
          St,
          Ft,
          bt,
          it,
          dt,
          ft,
          ue,
          ce;
        for (xt = P.lastIndexOf(m), xt < 0 && (xt = 0), St = 0; St < xt; ++St)
          P.charCodeAt(St) >= 128 && S("not-basic"), M.push(P.charCodeAt(St));
        for (Ft = xt > 0 ? xt + 1 : 0; Ft < q; ) {
          for (
            bt = J, it = 1, dt = h;
            Ft >= q && S("invalid-input"),
              (ft = E(P.charCodeAt(Ft++))),
              (ft >= h || ft > T((o - J) / it)) && S("overflow"),
              (J += ft * it),
              (ue = dt <= ct ? l : dt >= ct + u ? u : dt - ct),
              !(ft < ue);
            dt += h
          )
            (ce = h - ue), it > T(o / ce) && S("overflow"), (it *= ce);
          (Q = M.length + 1),
            (ct = V(J - bt, Q, bt == 0)),
            T(J / Q) > o - vt && S("overflow"),
            (vt += T(J / Q)),
            (J %= Q),
            M.splice(J++, 0, vt);
        }
        return F(M);
      }
      function L(P) {
        var M,
          q,
          Q,
          J,
          vt,
          ct,
          xt,
          St,
          Ft,
          bt,
          it,
          dt = [],
          ft,
          ue,
          ce,
          yi;
        for (
          P = z(P), ft = P.length, M = p, q = 0, vt = f, ct = 0;
          ct < ft;
          ++ct
        )
          (it = P[ct]), it < 128 && dt.push(C(it));
        for (Q = J = dt.length, J && dt.push(m); Q < ft; ) {
          for (xt = o, ct = 0; ct < ft; ++ct)
            (it = P[ct]), it >= M && it < xt && (xt = it);
          for (
            ue = Q + 1,
              xt - M > T((o - q) / ue) && S("overflow"),
              q += (xt - M) * ue,
              M = xt,
              ct = 0;
            ct < ft;
            ++ct
          )
            if (((it = P[ct]), it < M && ++q > o && S("overflow"), it == M)) {
              for (
                St = q, Ft = h;
                (bt = Ft <= vt ? l : Ft >= vt + u ? u : Ft - vt), !(St < bt);
                Ft += h
              )
                (yi = St - bt),
                  (ce = h - bt),
                  dt.push(C(w(bt + (yi % ce), 0))),
                  (St = T(yi / ce));
              dt.push(C(w(St, 0))), (vt = V(q, ue, Q == J)), (q = 0), ++Q;
            }
          ++q, ++M;
        }
        return dt.join("");
      }
      function W(P) {
        return $(P, function (M) {
          return g.test(M) ? k(M.slice(4).toLowerCase()) : M;
        });
      }
      function lt(P) {
        return $(P, function (M) {
          return x.test(M) ? "xn--" + L(M) : M;
        });
      }
      if (
        ((a = {
          version: "1.3.2",
          ucs2: { decode: z, encode: F },
          decode: k,
          encode: L,
          toASCII: lt,
          toUnicode: W,
        }),
        i && s)
      )
        if (r.exports == i) s.exports = a;
        else for (R in a) a.hasOwnProperty(R) && (i[R] = a[R]);
      else e.punycode = a;
    })(zs);
  })(Oi, Oi.exports);
  var vo = Oi.exports,
    C_ = Ge(vo),
    xo = {
      isString: function (r) {
        return typeof r == "string";
      },
      isObject: function (r) {
        return typeof r == "object" && r !== null;
      },
      isNull: function (r) {
        return r === null;
      },
      isNullOrUndefined: function (r) {
        return r == null;
      },
    },
    M_ = Ge(xo),
    Mr = {};
  function ed(r, t) {
    return Object.prototype.hasOwnProperty.call(r, t);
  }
  var yo = function (r, t, e, i) {
      (t = t || "&"), (e = e || "=");
      var s = {};
      if (typeof r != "string" || r.length === 0) return s;
      var n = /\+/g;
      r = r.split(t);
      var a = 1e3;
      i && typeof i.maxKeys == "number" && (a = i.maxKeys);
      var o = r.length;
      a > 0 && o > a && (o = a);
      for (var h = 0; h < o; ++h) {
        var l = r[h].replace(n, "%20"),
          u = l.indexOf(e),
          c,
          d,
          f,
          p;
        u >= 0
          ? ((c = l.substr(0, u)), (d = l.substr(u + 1)))
          : ((c = l), (d = "")),
          (f = decodeURIComponent(c)),
          (p = decodeURIComponent(d)),
          ed(s, f)
            ? Array.isArray(s[f])
              ? s[f].push(p)
              : (s[f] = [s[f], p])
            : (s[f] = p);
      }
      return s;
    },
    P_ = Ge(yo),
    Pr = function (r) {
      switch (typeof r) {
        case "string":
          return r;
        case "boolean":
          return r ? "true" : "false";
        case "number":
          return isFinite(r) ? r : "";
        default:
          return "";
      }
    },
    bo = function (r, t, e, i) {
      return (
        (t = t || "&"),
        (e = e || "="),
        r === null && (r = void 0),
        typeof r == "object"
          ? Object.keys(r)
              .map(function (s) {
                var n = encodeURIComponent(Pr(s)) + e;
                return Array.isArray(r[s])
                  ? r[s]
                      .map(function (a) {
                        return n + encodeURIComponent(Pr(a));
                      })
                      .join(t)
                  : n + encodeURIComponent(Pr(r[s]));
              })
              .join(t)
          : i
          ? encodeURIComponent(Pr(i)) + e + encodeURIComponent(Pr(r))
          : ""
      );
    },
    D_ = Ge(bo),
    rd,
    id,
    N_ = (Mr.decode = id = Mr.parse = yo),
    O_ = (Mr.encode = rd = Mr.stringify = bo),
    sd = vo,
    te = xo,
    nd = (Cr.parse = Dr),
    ad = (Cr.resolve = _d),
    B_ = (Cr.resolveObject = vd),
    od = (Cr.format = gd),
    F_ = (Cr.Url = Ut);
  function Ut() {
    (this.protocol = null),
      (this.slashes = null),
      (this.auth = null),
      (this.host = null),
      (this.port = null),
      (this.hostname = null),
      (this.hash = null),
      (this.search = null),
      (this.query = null),
      (this.pathname = null),
      (this.path = null),
      (this.href = null);
  }
  var hd = /^([a-z0-9.+-]+:)/i,
    ld = /:[0-9]*$/,
    ud = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,
    cd = [
      "<",
      ">",
      '"',
      "`",
      " ",
      "\r",
      `
`,
      "	",
    ],
    dd = ["{", "}", "|", "\\", "^", "`"].concat(cd),
    Ks = ["'"].concat(dd),
    Eo = ["%", "/", "?", ";", "#"].concat(Ks),
    To = ["/", "?", "#"],
    fd = 255,
    Ao = /^[+a-z0-9A-Z_-]{0,63}$/,
    pd = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    md = { javascript: !0, "javascript:": !0 },
    Zs = { javascript: !0, "javascript:": !0 },
    ir = {
      http: !0,
      https: !0,
      ftp: !0,
      gopher: !0,
      file: !0,
      "http:": !0,
      "https:": !0,
      "ftp:": !0,
      "gopher:": !0,
      "file:": !0,
    },
    Qs = Mr;
  function Dr(r, t, e) {
    if (r && te.isObject(r) && r instanceof Ut) return r;
    var i = new Ut();
    return i.parse(r, t, e), i;
  }
  Ut.prototype.parse = function (r, t, e) {
    if (!te.isString(r))
      throw new TypeError("Parameter 'url' must be a string, not " + typeof r);
    var i = r.indexOf("?"),
      s = i !== -1 && i < r.indexOf("#") ? "?" : "#",
      n = r.split(s),
      a = /\\/g;
    (n[0] = n[0].replace(a, "/")), (r = n.join(s));
    var o = r;
    if (((o = o.trim()), !e && r.split("#").length === 1)) {
      var h = ud.exec(o);
      if (h)
        return (
          (this.path = o),
          (this.href = o),
          (this.pathname = h[1]),
          h[2]
            ? ((this.search = h[2]),
              t
                ? (this.query = Qs.parse(this.search.substr(1)))
                : (this.query = this.search.substr(1)))
            : t && ((this.search = ""), (this.query = {})),
          this
        );
    }
    var l = hd.exec(o);
    if (l) {
      l = l[0];
      var u = l.toLowerCase();
      (this.protocol = u), (o = o.substr(l.length));
    }
    if (e || l || o.match(/^\/\/[^@\/]+@[^@\/]+/)) {
      var c = o.substr(0, 2) === "//";
      c && !(l && Zs[l]) && ((o = o.substr(2)), (this.slashes = !0));
    }
    if (!Zs[l] && (c || (l && !ir[l]))) {
      for (var d = -1, f = 0; f < To.length; f++) {
        var p = o.indexOf(To[f]);
        p !== -1 && (d === -1 || p < d) && (d = p);
      }
      var m, g;
      d === -1 ? (g = o.lastIndexOf("@")) : (g = o.lastIndexOf("@", d)),
        g !== -1 &&
          ((m = o.slice(0, g)),
          (o = o.slice(g + 1)),
          (this.auth = decodeURIComponent(m))),
        (d = -1);
      for (var f = 0; f < Eo.length; f++) {
        var p = o.indexOf(Eo[f]);
        p !== -1 && (d === -1 || p < d) && (d = p);
      }
      d === -1 && (d = o.length),
        (this.host = o.slice(0, d)),
        (o = o.slice(d)),
        this.parseHost(),
        (this.hostname = this.hostname || "");
      var x =
        this.hostname[0] === "[" &&
        this.hostname[this.hostname.length - 1] === "]";
      if (!x)
        for (
          var b = this.hostname.split(/\./), f = 0, _ = b.length;
          f < _;
          f++
        ) {
          var y = b[f];
          if (y && !y.match(Ao)) {
            for (var T = "", C = 0, R = y.length; C < R; C++)
              y.charCodeAt(C) > 127 ? (T += "x") : (T += y[C]);
            if (!T.match(Ao)) {
              var S = b.slice(0, f),
                I = b.slice(f + 1),
                $ = y.match(pd);
              $ && (S.push($[1]), I.unshift($[2])),
                I.length && (o = "/" + I.join(".") + o),
                (this.hostname = S.join("."));
              break;
            }
          }
        }
      this.hostname.length > fd
        ? (this.hostname = "")
        : (this.hostname = this.hostname.toLowerCase()),
        x || (this.hostname = sd.toASCII(this.hostname));
      var z = this.port ? ":" + this.port : "",
        F = this.hostname || "";
      (this.host = F + z),
        (this.href += this.host),
        x &&
          ((this.hostname = this.hostname.substr(1, this.hostname.length - 2)),
          o[0] !== "/" && (o = "/" + o));
    }
    if (!md[u])
      for (var f = 0, _ = Ks.length; f < _; f++) {
        var E = Ks[f];
        if (o.indexOf(E) !== -1) {
          var w = encodeURIComponent(E);
          w === E && (w = escape(E)), (o = o.split(E).join(w));
        }
      }
    var V = o.indexOf("#");
    V !== -1 && ((this.hash = o.substr(V)), (o = o.slice(0, V)));
    var k = o.indexOf("?");
    if (
      (k !== -1
        ? ((this.search = o.substr(k)),
          (this.query = o.substr(k + 1)),
          t && (this.query = Qs.parse(this.query)),
          (o = o.slice(0, k)))
        : t && ((this.search = ""), (this.query = {})),
      o && (this.pathname = o),
      ir[u] && this.hostname && !this.pathname && (this.pathname = "/"),
      this.pathname || this.search)
    ) {
      var z = this.pathname || "",
        L = this.search || "";
      this.path = z + L;
    }
    return (this.href = this.format()), this;
  };
  function gd(r) {
    return (
      te.isString(r) && (r = Dr(r)),
      r instanceof Ut ? r.format() : Ut.prototype.format.call(r)
    );
  }
  Ut.prototype.format = function () {
    var r = this.auth || "";
    r &&
      ((r = encodeURIComponent(r)), (r = r.replace(/%3A/i, ":")), (r += "@"));
    var t = this.protocol || "",
      e = this.pathname || "",
      i = this.hash || "",
      s = !1,
      n = "";
    this.host
      ? (s = r + this.host)
      : this.hostname &&
        ((s =
          r +
          (this.hostname.indexOf(":") === -1
            ? this.hostname
            : "[" + this.hostname + "]")),
        this.port && (s += ":" + this.port)),
      this.query &&
        te.isObject(this.query) &&
        Object.keys(this.query).length &&
        (n = Qs.stringify(this.query));
    var a = this.search || (n && "?" + n) || "";
    return (
      t && t.substr(-1) !== ":" && (t += ":"),
      this.slashes || ((!t || ir[t]) && s !== !1)
        ? ((s = "//" + (s || "")), e && e.charAt(0) !== "/" && (e = "/" + e))
        : s || (s = ""),
      i && i.charAt(0) !== "#" && (i = "#" + i),
      a && a.charAt(0) !== "?" && (a = "?" + a),
      (e = e.replace(/[?#]/g, function (o) {
        return encodeURIComponent(o);
      })),
      (a = a.replace("#", "%23")),
      t + s + e + a + i
    );
  };
  function _d(r, t) {
    return Dr(r, !1, !0).resolve(t);
  }
  Ut.prototype.resolve = function (r) {
    return this.resolveObject(Dr(r, !1, !0)).format();
  };
  function vd(r, t) {
    return r ? Dr(r, !1, !0).resolveObject(t) : t;
  }
  (Ut.prototype.resolveObject = function (r) {
    if (te.isString(r)) {
      var t = new Ut();
      t.parse(r, !1, !0), (r = t);
    }
    for (var e = new Ut(), i = Object.keys(this), s = 0; s < i.length; s++) {
      var n = i[s];
      e[n] = this[n];
    }
    if (((e.hash = r.hash), r.href === "")) return (e.href = e.format()), e;
    if (r.slashes && !r.protocol) {
      for (var a = Object.keys(r), o = 0; o < a.length; o++) {
        var h = a[o];
        h !== "protocol" && (e[h] = r[h]);
      }
      return (
        ir[e.protocol] &&
          e.hostname &&
          !e.pathname &&
          (e.path = e.pathname = "/"),
        (e.href = e.format()),
        e
      );
    }
    if (r.protocol && r.protocol !== e.protocol) {
      if (!ir[r.protocol]) {
        for (var l = Object.keys(r), u = 0; u < l.length; u++) {
          var c = l[u];
          e[c] = r[c];
        }
        return (e.href = e.format()), e;
      }
      if (((e.protocol = r.protocol), !r.host && !Zs[r.protocol])) {
        for (
          var _ = (r.pathname || "").split("/");
          _.length && !(r.host = _.shift());

        );
        r.host || (r.host = ""),
          r.hostname || (r.hostname = ""),
          _[0] !== "" && _.unshift(""),
          _.length < 2 && _.unshift(""),
          (e.pathname = _.join("/"));
      } else e.pathname = r.pathname;
      if (
        ((e.search = r.search),
        (e.query = r.query),
        (e.host = r.host || ""),
        (e.auth = r.auth),
        (e.hostname = r.hostname || r.host),
        (e.port = r.port),
        e.pathname || e.search)
      ) {
        var d = e.pathname || "",
          f = e.search || "";
        e.path = d + f;
      }
      return (e.slashes = e.slashes || r.slashes), (e.href = e.format()), e;
    }
    var p = e.pathname && e.pathname.charAt(0) === "/",
      m = r.host || (r.pathname && r.pathname.charAt(0) === "/"),
      g = m || p || (e.host && r.pathname),
      x = g,
      b = (e.pathname && e.pathname.split("/")) || [],
      _ = (r.pathname && r.pathname.split("/")) || [],
      y = e.protocol && !ir[e.protocol];
    if (
      (y &&
        ((e.hostname = ""),
        (e.port = null),
        e.host && (b[0] === "" ? (b[0] = e.host) : b.unshift(e.host)),
        (e.host = ""),
        r.protocol &&
          ((r.hostname = null),
          (r.port = null),
          r.host && (_[0] === "" ? (_[0] = r.host) : _.unshift(r.host)),
          (r.host = null)),
        (g = g && (_[0] === "" || b[0] === ""))),
      m)
    )
      (e.host = r.host || r.host === "" ? r.host : e.host),
        (e.hostname =
          r.hostname || r.hostname === "" ? r.hostname : e.hostname),
        (e.search = r.search),
        (e.query = r.query),
        (b = _);
    else if (_.length)
      b || (b = []),
        b.pop(),
        (b = b.concat(_)),
        (e.search = r.search),
        (e.query = r.query);
    else if (!te.isNullOrUndefined(r.search)) {
      if (y) {
        e.hostname = e.host = b.shift();
        var T = e.host && e.host.indexOf("@") > 0 ? e.host.split("@") : !1;
        T && ((e.auth = T.shift()), (e.host = e.hostname = T.shift()));
      }
      return (
        (e.search = r.search),
        (e.query = r.query),
        (!te.isNull(e.pathname) || !te.isNull(e.search)) &&
          (e.path =
            (e.pathname ? e.pathname : "") + (e.search ? e.search : "")),
        (e.href = e.format()),
        e
      );
    }
    if (!b.length)
      return (
        (e.pathname = null),
        e.search ? (e.path = "/" + e.search) : (e.path = null),
        (e.href = e.format()),
        e
      );
    for (
      var C = b.slice(-1)[0],
        R =
          ((e.host || r.host || b.length > 1) && (C === "." || C === "..")) ||
          C === "",
        S = 0,
        I = b.length;
      I >= 0;
      I--
    )
      (C = b[I]),
        C === "."
          ? b.splice(I, 1)
          : C === ".."
          ? (b.splice(I, 1), S++)
          : S && (b.splice(I, 1), S--);
    if (!g && !x) for (; S--; S) b.unshift("..");
    g && b[0] !== "" && (!b[0] || b[0].charAt(0) !== "/") && b.unshift(""),
      R && b.join("/").substr(-1) !== "/" && b.push("");
    var $ = b[0] === "" || (b[0] && b[0].charAt(0) === "/");
    if (y) {
      e.hostname = e.host = $ ? "" : b.length ? b.shift() : "";
      var T = e.host && e.host.indexOf("@") > 0 ? e.host.split("@") : !1;
      T && ((e.auth = T.shift()), (e.host = e.hostname = T.shift()));
    }
    return (
      (g = g || (e.host && b.length)),
      g && !$ && b.unshift(""),
      b.length
        ? (e.pathname = b.join("/"))
        : ((e.pathname = null), (e.path = null)),
      (!te.isNull(e.pathname) || !te.isNull(e.search)) &&
        (e.path = (e.pathname ? e.pathname : "") + (e.search ? e.search : "")),
      (e.auth = r.auth || e.auth),
      (e.slashes = e.slashes || r.slashes),
      (e.href = e.format()),
      e
    );
  }),
    (Ut.prototype.parseHost = function () {
      var r = this.host,
        t = ld.exec(r);
      t &&
        ((t = t[0]),
        t !== ":" && (this.port = t.substr(1)),
        (r = r.substr(0, r.length - t.length))),
        r && (this.hostname = r);
    });
  const So = {};
  function xd(r, t, e = 3) {
    if (So[t]) return;
    let i = new Error().stack;
    typeof i == "undefined"
      ? console.warn(
          "PixiJS Deprecation Warning: ",
          `${t}
Deprecated since v${r}`
        )
      : ((i = i
          .split(
            `
`
          )
          .splice(e).join(`
`)),
        console.groupCollapsed
          ? (console.groupCollapsed(
              "%cPixiJS Deprecation Warning: %c%s",
              "color:#614108;background:#fffbe6",
              "font-weight:normal;color:#614108;background:#fffbe6",
              `${t}
Deprecated since v${r}`
            ),
            console.warn(i),
            console.groupEnd())
          : (console.warn(
              "PixiJS Deprecation Warning: ",
              `${t}
Deprecated since v${r}`
            ),
            console.warn(i))),
      (So[t] = !0);
  }
  const yd = {
    get parse() {
      return nd;
    },
    get format() {
      return od;
    },
    get resolve() {
      return ad;
    },
  };
  function Wt(r) {
    if (typeof r != "string")
      throw new TypeError(
        `Path must be a string. Received ${JSON.stringify(r)}`
      );
  }
  function Nr(r) {
    return r.split("?")[0].split("#")[0];
  }
  function bd(r) {
    return r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function Ed(r, t, e) {
    return r.replace(new RegExp(bd(t), "g"), e);
  }
  function Td(r, t) {
    let e = "",
      i = 0,
      s = -1,
      n = 0,
      a = -1;
    for (let o = 0; o <= r.length; ++o) {
      if (o < r.length) a = r.charCodeAt(o);
      else {
        if (a === 47) break;
        a = 47;
      }
      if (a === 47) {
        if (!(s === o - 1 || n === 1))
          if (s !== o - 1 && n === 2) {
            if (
              e.length < 2 ||
              i !== 2 ||
              e.charCodeAt(e.length - 1) !== 46 ||
              e.charCodeAt(e.length - 2) !== 46
            ) {
              if (e.length > 2) {
                const h = e.lastIndexOf("/");
                if (h !== e.length - 1) {
                  h === -1
                    ? ((e = ""), (i = 0))
                    : ((e = e.slice(0, h)),
                      (i = e.length - 1 - e.lastIndexOf("/"))),
                    (s = o),
                    (n = 0);
                  continue;
                }
              } else if (e.length === 2 || e.length === 1) {
                (e = ""), (i = 0), (s = o), (n = 0);
                continue;
              }
            }
            t && (e.length > 0 ? (e += "/..") : (e = ".."), (i = 2));
          } else
            e.length > 0
              ? (e += `/${r.slice(s + 1, o)}`)
              : (e = r.slice(s + 1, o)),
              (i = o - s - 1);
        (s = o), (n = 0);
      } else a === 46 && n !== -1 ? ++n : (n = -1);
    }
    return e;
  }
  const yt = {
    toPosix(r) {
      return Ed(r, "\\", "/");
    },
    isUrl(r) {
      return /^https?:/.test(this.toPosix(r));
    },
    isDataUrl(r) {
      return /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z0-9-.!#$%*+.{}|~`]+=[a-z0-9-.!#$%*+.{}()_|~`]+)*)?(;base64)?,([a-z0-9!$&',()*+;=\-._~:@\/?%\s<>]*?)$/i.test(
        r
      );
    },
    isBlobUrl(r) {
      return r.startsWith("blob:");
    },
    hasProtocol(r) {
      return /^[^/:]+:/.test(this.toPosix(r));
    },
    getProtocol(r) {
      Wt(r), (r = this.toPosix(r));
      const t = /^file:\/\/\//.exec(r);
      if (t) return t[0];
      const e = /^[^/:]+:\/{0,2}/.exec(r);
      return e ? e[0] : "";
    },
    toAbsolute(r, t, e) {
      if ((Wt(r), this.isDataUrl(r) || this.isBlobUrl(r))) return r;
      const i = Nr(this.toPosix(t != null ? t : B.ADAPTER.getBaseUrl())),
        s = Nr(this.toPosix(e != null ? e : this.rootname(i)));
      return (
        (r = this.toPosix(r)),
        r.startsWith("/")
          ? yt.join(s, r.slice(1))
          : this.isAbsolute(r)
          ? r
          : this.join(i, r)
      );
    },
    normalize(r) {
      if ((Wt(r), r.length === 0)) return ".";
      if (this.isDataUrl(r) || this.isBlobUrl(r)) return r;
      r = this.toPosix(r);
      let t = "";
      const e = r.startsWith("/");
      this.hasProtocol(r) && ((t = this.rootname(r)), (r = r.slice(t.length)));
      const i = r.endsWith("/");
      return (
        (r = Td(r, !1)), r.length > 0 && i && (r += "/"), e ? `/${r}` : t + r
      );
    },
    isAbsolute(r) {
      return (
        Wt(r),
        (r = this.toPosix(r)),
        this.hasProtocol(r) ? !0 : r.startsWith("/")
      );
    },
    join(...r) {
      var t;
      if (r.length === 0) return ".";
      let e;
      for (let i = 0; i < r.length; ++i) {
        const s = r[i];
        if ((Wt(s), s.length > 0))
          if (e === void 0) e = s;
          else {
            const n = (t = r[i - 1]) != null ? t : "";
            this.joinExtensions.includes(this.extname(n).toLowerCase())
              ? (e += `/../${s}`)
              : (e += `/${s}`);
          }
      }
      return e === void 0 ? "." : this.normalize(e);
    },
    dirname(r) {
      if ((Wt(r), r.length === 0)) return ".";
      r = this.toPosix(r);
      let t = r.charCodeAt(0);
      const e = t === 47;
      let i = -1,
        s = !0;
      const n = this.getProtocol(r),
        a = r;
      r = r.slice(n.length);
      for (let o = r.length - 1; o >= 1; --o)
        if (((t = r.charCodeAt(o)), t === 47)) {
          if (!s) {
            i = o;
            break;
          }
        } else s = !1;
      return i === -1
        ? e
          ? "/"
          : this.isUrl(a)
          ? n + r
          : n
        : e && i === 1
        ? "//"
        : n + r.slice(0, i);
    },
    rootname(r) {
      Wt(r), (r = this.toPosix(r));
      let t = "";
      if (
        (r.startsWith("/") ? (t = "/") : (t = this.getProtocol(r)),
        this.isUrl(r))
      ) {
        const e = r.indexOf("/", t.length);
        e !== -1 ? (t = r.slice(0, e)) : (t = r), t.endsWith("/") || (t += "/");
      }
      return t;
    },
    basename(r, t) {
      Wt(r), t && Wt(t), (r = Nr(this.toPosix(r)));
      let e = 0,
        i = -1,
        s = !0,
        n;
      if (t !== void 0 && t.length > 0 && t.length <= r.length) {
        if (t.length === r.length && t === r) return "";
        let a = t.length - 1,
          o = -1;
        for (n = r.length - 1; n >= 0; --n) {
          const h = r.charCodeAt(n);
          if (h === 47) {
            if (!s) {
              e = n + 1;
              break;
            }
          } else
            o === -1 && ((s = !1), (o = n + 1)),
              a >= 0 &&
                (h === t.charCodeAt(a)
                  ? --a === -1 && (i = n)
                  : ((a = -1), (i = o)));
        }
        return e === i ? (i = o) : i === -1 && (i = r.length), r.slice(e, i);
      }
      for (n = r.length - 1; n >= 0; --n)
        if (r.charCodeAt(n) === 47) {
          if (!s) {
            e = n + 1;
            break;
          }
        } else i === -1 && ((s = !1), (i = n + 1));
      return i === -1 ? "" : r.slice(e, i);
    },
    extname(r) {
      Wt(r), (r = Nr(this.toPosix(r)));
      let t = -1,
        e = 0,
        i = -1,
        s = !0,
        n = 0;
      for (let a = r.length - 1; a >= 0; --a) {
        const o = r.charCodeAt(a);
        if (o === 47) {
          if (!s) {
            e = a + 1;
            break;
          }
          continue;
        }
        i === -1 && ((s = !1), (i = a + 1)),
          o === 46
            ? t === -1
              ? (t = a)
              : n !== 1 && (n = 1)
            : t !== -1 && (n = -1);
      }
      return t === -1 ||
        i === -1 ||
        n === 0 ||
        (n === 1 && t === i - 1 && t === e + 1)
        ? ""
        : r.slice(t, i);
    },
    parse(r) {
      Wt(r);
      const t = { root: "", dir: "", base: "", ext: "", name: "" };
      if (r.length === 0) return t;
      r = Nr(this.toPosix(r));
      let e = r.charCodeAt(0);
      const i = this.isAbsolute(r);
      let s;
      const n = "";
      (t.root = this.rootname(r)), i || this.hasProtocol(r) ? (s = 1) : (s = 0);
      let a = -1,
        o = 0,
        h = -1,
        l = !0,
        u = r.length - 1,
        c = 0;
      for (; u >= s; --u) {
        if (((e = r.charCodeAt(u)), e === 47)) {
          if (!l) {
            o = u + 1;
            break;
          }
          continue;
        }
        h === -1 && ((l = !1), (h = u + 1)),
          e === 46
            ? a === -1
              ? (a = u)
              : c !== 1 && (c = 1)
            : a !== -1 && (c = -1);
      }
      return (
        a === -1 ||
        h === -1 ||
        c === 0 ||
        (c === 1 && a === h - 1 && a === o + 1)
          ? h !== -1 &&
            (o === 0 && i
              ? (t.base = t.name = r.slice(1, h))
              : (t.base = t.name = r.slice(o, h)))
          : (o === 0 && i
              ? ((t.name = r.slice(1, a)), (t.base = r.slice(1, h)))
              : ((t.name = r.slice(o, a)), (t.base = r.slice(o, h))),
            (t.ext = r.slice(a, h))),
        (t.dir = this.dirname(r)),
        n && (t.dir = n + t.dir),
        t
      );
    },
    sep: "/",
    delimiter: ":",
    joinExtensions: [".html"],
  };
  let Js;
  async function wo() {
    return (
      Js != null ||
        (Js = (async () => {
          var r;
          const t = document.createElement("canvas").getContext("webgl");
          if (!t) return wt.UNPACK;
          const e = await new Promise((a) => {
            const o = document.createElement("video");
            (o.onloadeddata = () => a(o)),
              (o.onerror = () => a(null)),
              (o.autoplay = !1),
              (o.crossOrigin = "anonymous"),
              (o.preload = "auto"),
              (o.src =
                "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEXTbuMU6uEHFO7a1OsggG97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEBEAAAAAAAAFlSua8yuAQAAAAAAAEPXgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAJiWgDglLCBArqBApqBAlPAgQFVsIRVuYEBElTDZ9Vzc9JjwItjxYgAAAAAAAAAAWfInEWjh0VOQ09ERVJEh49MYXZjIGxpYnZweC12cDlnyKJFo4hEVVJBVElPTkSHlDAwOjAwOjAwLjA0MDAwMDAwMAAAH0O2dcfngQCgwqGggQAAAIJJg0IAABAAFgA4JBwYSgAAICAAEb///4r+AAB1oZ2mm+6BAaWWgkmDQgAAEAAWADgkHBhKAAAgIABIQBxTu2uRu4+zgQC3iveBAfGCAXHwgQM="),
              o.load();
          });
          if (!e) return wt.UNPACK;
          const i = t.createTexture();
          t.bindTexture(t.TEXTURE_2D, i);
          const s = t.createFramebuffer();
          t.bindFramebuffer(t.FRAMEBUFFER, s),
            t.framebufferTexture2D(
              t.FRAMEBUFFER,
              t.COLOR_ATTACHMENT0,
              t.TEXTURE_2D,
              i,
              0
            ),
            t.pixelStorei(t.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !1),
            t.pixelStorei(t.UNPACK_COLORSPACE_CONVERSION_WEBGL, t.NONE),
            t.texImage2D(t.TEXTURE_2D, 0, t.RGBA, t.RGBA, t.UNSIGNED_BYTE, e);
          const n = new Uint8Array(4);
          return (
            t.readPixels(0, 0, 1, 1, t.RGBA, t.UNSIGNED_BYTE, n),
            t.deleteFramebuffer(s),
            t.deleteTexture(i),
            (r = t.getExtension("WEBGL_lose_context")) == null ||
              r.loseContext(),
            n[0] <= n[3] ? wt.PMA : wt.UNPACK
          );
        })()),
      Js
    );
  }
  function Ad() {}
  function Sd() {}
  let tn;
  function Ro() {
    return (
      typeof tn == "undefined" &&
        (tn = (function () {
          var r;
          const t = {
            stencil: !0,
            failIfMajorPerformanceCaveat: B.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT,
          };
          try {
            if (!B.ADAPTER.getWebGLRenderingContext()) return !1;
            const e = B.ADAPTER.createCanvas();
            let i =
              e.getContext("webgl", t) || e.getContext("experimental-webgl", t);
            const s = !!(
              (r = i == null ? void 0 : i.getContextAttributes()) != null &&
              r.stencil
            );
            if (i) {
              const n = i.getExtension("WEBGL_lose_context");
              n && n.loseContext();
            }
            return (i = null), s;
          } catch (e) {
            return !1;
          }
        })()),
      tn
    );
  }
  var wd = { grad: 0.9, turn: 360, rad: 360 / (2 * Math.PI) },
    pe = function (r) {
      return typeof r == "string" ? r.length > 0 : typeof r == "number";
    },
    pt = function (r, t, e) {
      return (
        t === void 0 && (t = 0),
        e === void 0 && (e = Math.pow(10, t)),
        Math.round(e * r) / e + 0
      );
    },
    kt = function (r, t, e) {
      return (
        t === void 0 && (t = 0),
        e === void 0 && (e = 1),
        r > e ? e : r > t ? r : t
      );
    },
    Io = function (r) {
      return (r = isFinite(r) ? r % 360 : 0) > 0 ? r : r + 360;
    },
    Co = function (r) {
      return {
        r: kt(r.r, 0, 255),
        g: kt(r.g, 0, 255),
        b: kt(r.b, 0, 255),
        a: kt(r.a),
      };
    },
    en = function (r) {
      return { r: pt(r.r), g: pt(r.g), b: pt(r.b), a: pt(r.a, 3) };
    },
    Rd = /^#([0-9a-f]{3,8})$/i,
    Bi = function (r) {
      var t = r.toString(16);
      return t.length < 2 ? "0" + t : t;
    },
    Mo = function (r) {
      var t = r.r,
        e = r.g,
        i = r.b,
        s = r.a,
        n = Math.max(t, e, i),
        a = n - Math.min(t, e, i),
        o = a
          ? n === t
            ? (e - i) / a
            : n === e
            ? 2 + (i - t) / a
            : 4 + (t - e) / a
          : 0;
      return {
        h: 60 * (o < 0 ? o + 6 : o),
        s: n ? (a / n) * 100 : 0,
        v: (n / 255) * 100,
        a: s,
      };
    },
    Po = function (r) {
      var t = r.h,
        e = r.s,
        i = r.v,
        s = r.a;
      (t = (t / 360) * 6), (e /= 100), (i /= 100);
      var n = Math.floor(t),
        a = i * (1 - e),
        o = i * (1 - (t - n) * e),
        h = i * (1 - (1 - t + n) * e),
        l = n % 6;
      return {
        r: 255 * [i, o, a, a, h, i][l],
        g: 255 * [h, i, i, o, a, a][l],
        b: 255 * [a, a, h, i, i, o][l],
        a: s,
      };
    },
    Do = function (r) {
      return { h: Io(r.h), s: kt(r.s, 0, 100), l: kt(r.l, 0, 100), a: kt(r.a) };
    },
    No = function (r) {
      return { h: pt(r.h), s: pt(r.s), l: pt(r.l), a: pt(r.a, 3) };
    },
    Oo = function (r) {
      return Po(
        ((e = (t = r).s),
        {
          h: t.h,
          s:
            (e *= ((i = t.l) < 50 ? i : 100 - i) / 100) > 0
              ? ((2 * e) / (i + e)) * 100
              : 0,
          v: i + e,
          a: t.a,
        })
      );
      var t, e, i;
    },
    Or = function (r) {
      return {
        h: (t = Mo(r)).h,
        s:
          (s = ((200 - (e = t.s)) * (i = t.v)) / 100) > 0 && s < 200
            ? ((e * i) / 100 / (s <= 100 ? s : 200 - s)) * 100
            : 0,
        l: s / 2,
        a: t.a,
      };
      var t, e, i, s;
    },
    Id =
      /^hsla?\(\s*([+-]?\d*\.?\d+)(deg|rad|grad|turn)?\s*,\s*([+-]?\d*\.?\d+)%\s*,\s*([+-]?\d*\.?\d+)%\s*(?:,\s*([+-]?\d*\.?\d+)(%)?\s*)?\)$/i,
    Cd =
      /^hsla?\(\s*([+-]?\d*\.?\d+)(deg|rad|grad|turn)?\s+([+-]?\d*\.?\d+)%\s+([+-]?\d*\.?\d+)%\s*(?:\/\s*([+-]?\d*\.?\d+)(%)?\s*)?\)$/i,
    Md =
      /^rgba?\(\s*([+-]?\d*\.?\d+)(%)?\s*,\s*([+-]?\d*\.?\d+)(%)?\s*,\s*([+-]?\d*\.?\d+)(%)?\s*(?:,\s*([+-]?\d*\.?\d+)(%)?\s*)?\)$/i,
    Pd =
      /^rgba?\(\s*([+-]?\d*\.?\d+)(%)?\s+([+-]?\d*\.?\d+)(%)?\s+([+-]?\d*\.?\d+)(%)?\s*(?:\/\s*([+-]?\d*\.?\d+)(%)?\s*)?\)$/i,
    rn = {
      string: [
        [
          function (r) {
            var t = Rd.exec(r);
            return t
              ? (r = t[1]).length <= 4
                ? {
                    r: parseInt(r[0] + r[0], 16),
                    g: parseInt(r[1] + r[1], 16),
                    b: parseInt(r[2] + r[2], 16),
                    a:
                      r.length === 4
                        ? pt(parseInt(r[3] + r[3], 16) / 255, 2)
                        : 1,
                  }
                : r.length === 6 || r.length === 8
                ? {
                    r: parseInt(r.substr(0, 2), 16),
                    g: parseInt(r.substr(2, 2), 16),
                    b: parseInt(r.substr(4, 2), 16),
                    a:
                      r.length === 8
                        ? pt(parseInt(r.substr(6, 2), 16) / 255, 2)
                        : 1,
                  }
                : null
              : null;
          },
          "hex",
        ],
        [
          function (r) {
            var t = Md.exec(r) || Pd.exec(r);
            return t
              ? t[2] !== t[4] || t[4] !== t[6]
                ? null
                : Co({
                    r: Number(t[1]) / (t[2] ? 100 / 255 : 1),
                    g: Number(t[3]) / (t[4] ? 100 / 255 : 1),
                    b: Number(t[5]) / (t[6] ? 100 / 255 : 1),
                    a: t[7] === void 0 ? 1 : Number(t[7]) / (t[8] ? 100 : 1),
                  })
              : null;
          },
          "rgb",
        ],
        [
          function (r) {
            var t = Id.exec(r) || Cd.exec(r);
            if (!t) return null;
            var e,
              i,
              s = Do({
                h:
                  ((e = t[1]),
                  (i = t[2]),
                  i === void 0 && (i = "deg"),
                  Number(e) * (wd[i] || 1)),
                s: Number(t[3]),
                l: Number(t[4]),
                a: t[5] === void 0 ? 1 : Number(t[5]) / (t[6] ? 100 : 1),
              });
            return Oo(s);
          },
          "hsl",
        ],
      ],
      object: [
        [
          function (r) {
            var t = r.r,
              e = r.g,
              i = r.b,
              s = r.a,
              n = s === void 0 ? 1 : s;
            return pe(t) && pe(e) && pe(i)
              ? Co({ r: Number(t), g: Number(e), b: Number(i), a: Number(n) })
              : null;
          },
          "rgb",
        ],
        [
          function (r) {
            var t = r.h,
              e = r.s,
              i = r.l,
              s = r.a,
              n = s === void 0 ? 1 : s;
            if (!pe(t) || !pe(e) || !pe(i)) return null;
            var a = Do({
              h: Number(t),
              s: Number(e),
              l: Number(i),
              a: Number(n),
            });
            return Oo(a);
          },
          "hsl",
        ],
        [
          function (r) {
            var t = r.h,
              e = r.s,
              i = r.v,
              s = r.a,
              n = s === void 0 ? 1 : s;
            if (!pe(t) || !pe(e) || !pe(i)) return null;
            var a = (function (o) {
              return {
                h: Io(o.h),
                s: kt(o.s, 0, 100),
                v: kt(o.v, 0, 100),
                a: kt(o.a),
              };
            })({ h: Number(t), s: Number(e), v: Number(i), a: Number(n) });
            return Po(a);
          },
          "hsv",
        ],
      ],
    },
    Bo = function (r, t) {
      for (var e = 0; e < t.length; e++) {
        var i = t[e][0](r);
        if (i) return [i, t[e][1]];
      }
      return [null, void 0];
    },
    Fo = function (r) {
      return typeof r == "string"
        ? Bo(r.trim(), rn.string)
        : typeof r == "object" && r !== null
        ? Bo(r, rn.object)
        : [null, void 0];
    },
    L_ = function (r) {
      return Fo(r)[1];
    },
    sn = function (r, t) {
      var e = Or(r);
      return { h: e.h, s: kt(e.s + 100 * t, 0, 100), l: e.l, a: e.a };
    },
    nn = function (r) {
      return (299 * r.r + 587 * r.g + 114 * r.b) / 1e3 / 255;
    },
    Lo = function (r, t) {
      var e = Or(r);
      return { h: e.h, s: e.s, l: kt(e.l + 100 * t, 0, 100), a: e.a };
    },
    Fi = (function () {
      function r(t) {
        (this.parsed = Fo(t)[0]),
          (this.rgba = this.parsed || { r: 0, g: 0, b: 0, a: 1 });
      }
      return (
        (r.prototype.isValid = function () {
          return this.parsed !== null;
        }),
        (r.prototype.brightness = function () {
          return pt(nn(this.rgba), 2);
        }),
        (r.prototype.isDark = function () {
          return nn(this.rgba) < 0.5;
        }),
        (r.prototype.isLight = function () {
          return nn(this.rgba) >= 0.5;
        }),
        (r.prototype.toHex = function () {
          return (
            (t = en(this.rgba)),
            (e = t.r),
            (i = t.g),
            (s = t.b),
            (a = (n = t.a) < 1 ? Bi(pt(255 * n)) : ""),
            "#" + Bi(e) + Bi(i) + Bi(s) + a
          );
          var t, e, i, s, n, a;
        }),
        (r.prototype.toRgb = function () {
          return en(this.rgba);
        }),
        (r.prototype.toRgbString = function () {
          return (
            (t = en(this.rgba)),
            (e = t.r),
            (i = t.g),
            (s = t.b),
            (n = t.a) < 1
              ? "rgba(" + e + ", " + i + ", " + s + ", " + n + ")"
              : "rgb(" + e + ", " + i + ", " + s + ")"
          );
          var t, e, i, s, n;
        }),
        (r.prototype.toHsl = function () {
          return No(Or(this.rgba));
        }),
        (r.prototype.toHslString = function () {
          return (
            (t = No(Or(this.rgba))),
            (e = t.h),
            (i = t.s),
            (s = t.l),
            (n = t.a) < 1
              ? "hsla(" + e + ", " + i + "%, " + s + "%, " + n + ")"
              : "hsl(" + e + ", " + i + "%, " + s + "%)"
          );
          var t, e, i, s, n;
        }),
        (r.prototype.toHsv = function () {
          return (
            (t = Mo(this.rgba)),
            { h: pt(t.h), s: pt(t.s), v: pt(t.v), a: pt(t.a, 3) }
          );
          var t;
        }),
        (r.prototype.invert = function () {
          return ee({
            r: 255 - (t = this.rgba).r,
            g: 255 - t.g,
            b: 255 - t.b,
            a: t.a,
          });
          var t;
        }),
        (r.prototype.saturate = function (t) {
          return t === void 0 && (t = 0.1), ee(sn(this.rgba, t));
        }),
        (r.prototype.desaturate = function (t) {
          return t === void 0 && (t = 0.1), ee(sn(this.rgba, -t));
        }),
        (r.prototype.grayscale = function () {
          return ee(sn(this.rgba, -1));
        }),
        (r.prototype.lighten = function (t) {
          return t === void 0 && (t = 0.1), ee(Lo(this.rgba, t));
        }),
        (r.prototype.darken = function (t) {
          return t === void 0 && (t = 0.1), ee(Lo(this.rgba, -t));
        }),
        (r.prototype.rotate = function (t) {
          return t === void 0 && (t = 15), this.hue(this.hue() + t);
        }),
        (r.prototype.alpha = function (t) {
          return typeof t == "number"
            ? ee({ r: (e = this.rgba).r, g: e.g, b: e.b, a: t })
            : pt(this.rgba.a, 3);
          var e;
        }),
        (r.prototype.hue = function (t) {
          var e = Or(this.rgba);
          return typeof t == "number"
            ? ee({ h: t, s: e.s, l: e.l, a: e.a })
            : pt(e.h);
        }),
        (r.prototype.isEqual = function (t) {
          return this.toHex() === ee(t).toHex();
        }),
        r
      );
    })(),
    ee = function (r) {
      return r instanceof Fi ? r : new Fi(r);
    },
    Uo = [],
    Dd = function (r) {
      r.forEach(function (t) {
        Uo.indexOf(t) < 0 && (t(Fi, rn), Uo.push(t));
      });
    },
    U_ = function () {
      return new Fi({
        r: 255 * Math.random(),
        g: 255 * Math.random(),
        b: 255 * Math.random(),
      });
    };
  function Nd(r, t) {
    var e = {
        white: "#ffffff",
        bisque: "#ffe4c4",
        blue: "#0000ff",
        cadetblue: "#5f9ea0",
        chartreuse: "#7fff00",
        chocolate: "#d2691e",
        coral: "#ff7f50",
        antiquewhite: "#faebd7",
        aqua: "#00ffff",
        azure: "#f0ffff",
        whitesmoke: "#f5f5f5",
        papayawhip: "#ffefd5",
        plum: "#dda0dd",
        blanchedalmond: "#ffebcd",
        black: "#000000",
        gold: "#ffd700",
        goldenrod: "#daa520",
        gainsboro: "#dcdcdc",
        cornsilk: "#fff8dc",
        cornflowerblue: "#6495ed",
        burlywood: "#deb887",
        aquamarine: "#7fffd4",
        beige: "#f5f5dc",
        crimson: "#dc143c",
        cyan: "#00ffff",
        darkblue: "#00008b",
        darkcyan: "#008b8b",
        darkgoldenrod: "#b8860b",
        darkkhaki: "#bdb76b",
        darkgray: "#a9a9a9",
        darkgreen: "#006400",
        darkgrey: "#a9a9a9",
        peachpuff: "#ffdab9",
        darkmagenta: "#8b008b",
        darkred: "#8b0000",
        darkorchid: "#9932cc",
        darkorange: "#ff8c00",
        darkslateblue: "#483d8b",
        gray: "#808080",
        darkslategray: "#2f4f4f",
        darkslategrey: "#2f4f4f",
        deeppink: "#ff1493",
        deepskyblue: "#00bfff",
        wheat: "#f5deb3",
        firebrick: "#b22222",
        floralwhite: "#fffaf0",
        ghostwhite: "#f8f8ff",
        darkviolet: "#9400d3",
        magenta: "#ff00ff",
        green: "#008000",
        dodgerblue: "#1e90ff",
        grey: "#808080",
        honeydew: "#f0fff0",
        hotpink: "#ff69b4",
        blueviolet: "#8a2be2",
        forestgreen: "#228b22",
        lawngreen: "#7cfc00",
        indianred: "#cd5c5c",
        indigo: "#4b0082",
        fuchsia: "#ff00ff",
        brown: "#a52a2a",
        maroon: "#800000",
        mediumblue: "#0000cd",
        lightcoral: "#f08080",
        darkturquoise: "#00ced1",
        lightcyan: "#e0ffff",
        ivory: "#fffff0",
        lightyellow: "#ffffe0",
        lightsalmon: "#ffa07a",
        lightseagreen: "#20b2aa",
        linen: "#faf0e6",
        mediumaquamarine: "#66cdaa",
        lemonchiffon: "#fffacd",
        lime: "#00ff00",
        khaki: "#f0e68c",
        mediumseagreen: "#3cb371",
        limegreen: "#32cd32",
        mediumspringgreen: "#00fa9a",
        lightskyblue: "#87cefa",
        lightblue: "#add8e6",
        midnightblue: "#191970",
        lightpink: "#ffb6c1",
        mistyrose: "#ffe4e1",
        moccasin: "#ffe4b5",
        mintcream: "#f5fffa",
        lightslategray: "#778899",
        lightslategrey: "#778899",
        navajowhite: "#ffdead",
        navy: "#000080",
        mediumvioletred: "#c71585",
        powderblue: "#b0e0e6",
        palegoldenrod: "#eee8aa",
        oldlace: "#fdf5e6",
        paleturquoise: "#afeeee",
        mediumturquoise: "#48d1cc",
        mediumorchid: "#ba55d3",
        rebeccapurple: "#663399",
        lightsteelblue: "#b0c4de",
        mediumslateblue: "#7b68ee",
        thistle: "#d8bfd8",
        tan: "#d2b48c",
        orchid: "#da70d6",
        mediumpurple: "#9370db",
        purple: "#800080",
        pink: "#ffc0cb",
        skyblue: "#87ceeb",
        springgreen: "#00ff7f",
        palegreen: "#98fb98",
        red: "#ff0000",
        yellow: "#ffff00",
        slateblue: "#6a5acd",
        lavenderblush: "#fff0f5",
        peru: "#cd853f",
        palevioletred: "#db7093",
        violet: "#ee82ee",
        teal: "#008080",
        slategray: "#708090",
        slategrey: "#708090",
        aliceblue: "#f0f8ff",
        darkseagreen: "#8fbc8f",
        darkolivegreen: "#556b2f",
        greenyellow: "#adff2f",
        seagreen: "#2e8b57",
        seashell: "#fff5ee",
        tomato: "#ff6347",
        silver: "#c0c0c0",
        sienna: "#a0522d",
        lavender: "#e6e6fa",
        lightgreen: "#90ee90",
        orange: "#ffa500",
        orangered: "#ff4500",
        steelblue: "#4682b4",
        royalblue: "#4169e1",
        turquoise: "#40e0d0",
        yellowgreen: "#9acd32",
        salmon: "#fa8072",
        saddlebrown: "#8b4513",
        sandybrown: "#f4a460",
        rosybrown: "#bc8f8f",
        darksalmon: "#e9967a",
        lightgoldenrodyellow: "#fafad2",
        snow: "#fffafa",
        lightgrey: "#d3d3d3",
        lightgray: "#d3d3d3",
        dimgray: "#696969",
        dimgrey: "#696969",
        olivedrab: "#6b8e23",
        olive: "#808000",
      },
      i = {};
    for (var s in e) i[e[s]] = s;
    var n = {};
    (r.prototype.toName = function (a) {
      if (!(this.rgba.a || this.rgba.r || this.rgba.g || this.rgba.b))
        return "transparent";
      var o,
        h,
        l = i[this.toHex()];
      if (l) return l;
      if (a != null && a.closest) {
        var u = this.toRgb(),
          c = 1 / 0,
          d = "black";
        if (!n.length) for (var f in e) n[f] = new r(e[f]).toRgb();
        for (var p in e) {
          var m =
            ((o = u),
            (h = n[p]),
            Math.pow(o.r - h.r, 2) +
              Math.pow(o.g - h.g, 2) +
              Math.pow(o.b - h.b, 2));
          m < c && ((c = m), (d = p));
        }
        return d;
      }
    }),
      t.string.push([
        function (a) {
          var o = a.toLowerCase(),
            h = o === "transparent" ? "#0000" : e[o];
          return h ? new r(h).toRgb() : null;
        },
        "name",
      ]);
  }
  var Od = Object.defineProperty,
    ko = Object.getOwnPropertySymbols,
    Bd = Object.prototype.hasOwnProperty,
    Fd = Object.prototype.propertyIsEnumerable,
    Go = (r, t, e) =>
      t in r
        ? Od(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Ld = (r, t) => {
      for (var e in t || (t = {})) Bd.call(t, e) && Go(r, e, t[e]);
      if (ko) for (var e of ko(t)) Fd.call(t, e) && Go(r, e, t[e]);
      return r;
    };
  Dd([Nd]);
  const sr = class Ls {
    constructor(t = 16777215) {
      (this._value = null),
        (this._components = new Float32Array(4)),
        this._components.fill(1),
        (this._int = 16777215),
        (this.value = t);
    }
    get red() {
      return this._components[0];
    }
    get green() {
      return this._components[1];
    }
    get blue() {
      return this._components[2];
    }
    get alpha() {
      return this._components[3];
    }
    setValue(t) {
      return (this.value = t), this;
    }
    set value(t) {
      if (t instanceof Ls)
        (this._value = this.cloneSource(t._value)),
          (this._int = t._int),
          this._components.set(t._components);
      else {
        if (t === null) throw new Error("Cannot set PIXI.Color#value to null");
        (this._value === null || !this.isSourceEqual(this._value, t)) &&
          (this.normalize(t), (this._value = this.cloneSource(t)));
      }
    }
    get value() {
      return this._value;
    }
    cloneSource(t) {
      return typeof t == "string" ||
        typeof t == "number" ||
        t instanceof Number ||
        t === null
        ? t
        : Array.isArray(t) || ArrayBuffer.isView(t)
        ? t.slice(0)
        : typeof t == "object" && t !== null
        ? Ld({}, t)
        : t;
    }
    isSourceEqual(t, e) {
      const i = typeof t;
      if (i !== typeof e) return !1;
      if (i === "number" || i === "string" || t instanceof Number)
        return t === e;
      if (
        (Array.isArray(t) && Array.isArray(e)) ||
        (ArrayBuffer.isView(t) && ArrayBuffer.isView(e))
      )
        return t.length !== e.length ? !1 : t.every((s, n) => s === e[n]);
      if (t !== null && e !== null) {
        const s = Object.keys(t),
          n = Object.keys(e);
        return s.length !== n.length ? !1 : s.every((a) => t[a] === e[a]);
      }
      return t === e;
    }
    toRgba() {
      const [t, e, i, s] = this._components;
      return { r: t, g: e, b: i, a: s };
    }
    toRgb() {
      const [t, e, i] = this._components;
      return { r: t, g: e, b: i };
    }
    toRgbaString() {
      const [t, e, i] = this.toUint8RgbArray();
      return `rgba(${t},${e},${i},${this.alpha})`;
    }
    toUint8RgbArray(t) {
      const [e, i, s] = this._components;
      return (
        (t = t != null ? t : []),
        (t[0] = Math.round(e * 255)),
        (t[1] = Math.round(i * 255)),
        (t[2] = Math.round(s * 255)),
        t
      );
    }
    toRgbArray(t) {
      t = t != null ? t : [];
      const [e, i, s] = this._components;
      return (t[0] = e), (t[1] = i), (t[2] = s), t;
    }
    toNumber() {
      return this._int;
    }
    toLittleEndianNumber() {
      const t = this._int;
      return (t >> 16) + (t & 65280) + ((t & 255) << 16);
    }
    multiply(t) {
      const [e, i, s, n] = Ls.temp.setValue(t)._components;
      return (
        (this._components[0] *= e),
        (this._components[1] *= i),
        (this._components[2] *= s),
        (this._components[3] *= n),
        this.refreshInt(),
        (this._value = null),
        this
      );
    }
    premultiply(t, e = !0) {
      return (
        e &&
          ((this._components[0] *= t),
          (this._components[1] *= t),
          (this._components[2] *= t)),
        (this._components[3] = t),
        this.refreshInt(),
        (this._value = null),
        this
      );
    }
    toPremultiplied(t, e = !0) {
      if (t === 1) return (255 << 24) + this._int;
      if (t === 0) return e ? 0 : this._int;
      let i = (this._int >> 16) & 255,
        s = (this._int >> 8) & 255,
        n = this._int & 255;
      return (
        e &&
          ((i = (i * t + 0.5) | 0),
          (s = (s * t + 0.5) | 0),
          (n = (n * t + 0.5) | 0)),
        ((t * 255) << 24) + (i << 16) + (s << 8) + n
      );
    }
    toHex() {
      const t = this._int.toString(16);
      return `#${"000000".substring(0, 6 - t.length) + t}`;
    }
    toHexa() {
      const t = Math.round(this._components[3] * 255).toString(16);
      return this.toHex() + "00".substring(0, 2 - t.length) + t;
    }
    setAlpha(t) {
      return (this._components[3] = this._clamp(t)), this;
    }
    round(t) {
      const [e, i, s] = this._components;
      return (
        (this._components[0] = Math.round(e * t) / t),
        (this._components[1] = Math.round(i * t) / t),
        (this._components[2] = Math.round(s * t) / t),
        this.refreshInt(),
        (this._value = null),
        this
      );
    }
    toArray(t) {
      t = t != null ? t : [];
      const [e, i, s, n] = this._components;
      return (t[0] = e), (t[1] = i), (t[2] = s), (t[3] = n), t;
    }
    normalize(t) {
      let e, i, s, n;
      if (
        (typeof t == "number" || t instanceof Number) &&
        t >= 0 &&
        t <= 16777215
      ) {
        const a = t;
        (e = ((a >> 16) & 255) / 255),
          (i = ((a >> 8) & 255) / 255),
          (s = (a & 255) / 255),
          (n = 1);
      } else if (
        (Array.isArray(t) || t instanceof Float32Array) &&
        t.length >= 3 &&
        t.length <= 4
      )
        (t = this._clamp(t)), ([e, i, s, n = 1] = t);
      else if (
        (t instanceof Uint8Array || t instanceof Uint8ClampedArray) &&
        t.length >= 3 &&
        t.length <= 4
      )
        (t = this._clamp(t, 0, 255)),
          ([e, i, s, n = 255] = t),
          (e /= 255),
          (i /= 255),
          (s /= 255),
          (n /= 255);
      else if (typeof t == "string" || typeof t == "object") {
        if (typeof t == "string") {
          const o = Ls.HEX_PATTERN.exec(t);
          o && (t = `#${o[2]}`);
        }
        const a = ee(t);
        a.isValid() &&
          (({ r: e, g: i, b: s, a: n } = a.rgba),
          (e /= 255),
          (i /= 255),
          (s /= 255));
      }
      if (e !== void 0)
        (this._components[0] = e),
          (this._components[1] = i),
          (this._components[2] = s),
          (this._components[3] = n),
          this.refreshInt();
      else throw new Error(`Unable to convert color ${t}`);
    }
    refreshInt() {
      this._clamp(this._components);
      const [t, e, i] = this._components;
      this._int = ((t * 255) << 16) + ((e * 255) << 8) + ((i * 255) | 0);
    }
    _clamp(t, e = 0, i = 1) {
      return typeof t == "number"
        ? Math.min(Math.max(t, e), i)
        : (t.forEach((s, n) => {
            t[n] = Math.min(Math.max(s, e), i);
          }),
          t);
    }
  };
  (sr.shared = new sr()),
    (sr.temp = new sr()),
    (sr.HEX_PATTERN = /^(#|0x)?(([a-f0-9]{3}){1,2}([a-f0-9]{2})?)$/i);
  let K = sr;
  function Ud(r, t = []) {
    return K.shared.setValue(r).toRgbArray(t);
  }
  function kd(r) {
    return K.shared.setValue(r).toHex();
  }
  function Gd(r) {
    return K.shared.setValue(r).toNumber();
  }
  function $d(r) {
    return K.shared.setValue(r).toNumber();
  }
  function Hd() {
    const r = [],
      t = [];
    for (let i = 0; i < 32; i++) (r[i] = i), (t[i] = i);
    (r[X.NORMAL_NPM] = X.NORMAL),
      (r[X.ADD_NPM] = X.ADD),
      (r[X.SCREEN_NPM] = X.SCREEN),
      (t[X.NORMAL] = X.NORMAL_NPM),
      (t[X.ADD] = X.ADD_NPM),
      (t[X.SCREEN] = X.SCREEN_NPM);
    const e = [];
    return e.push(t), e.push(r), e;
  }
  const an = Hd();
  function on(r, t) {
    return an[t ? 1 : 0][r];
  }
  function Vd(r, t, e, i = !0) {
    return K.shared
      .setValue(r)
      .premultiply(t, i)
      .toArray(e != null ? e : new Float32Array(4));
  }
  function Xd(r, t) {
    return K.shared.setValue(r).toPremultiplied(t);
  }
  function zd(r, t, e, i = !0) {
    return K.shared
      .setValue(r)
      .premultiply(t, i)
      .toArray(e != null ? e : new Float32Array(4));
  }
  const $o =
    /^\s*data:(?:([\w-]+)\/([\w+.-]+))?(?:;charset=([\w-]+))?(?:;(base64))?,(.*)/i;
  function Ho(r, t = null) {
    const e = r * 6;
    if (((t = t || new Uint16Array(e)), t.length !== e))
      throw new Error(
        `Out buffer length is incorrect, got ${t.length} and expected ${e}`
      );
    for (let i = 0, s = 0; i < e; i += 6, s += 4)
      (t[i + 0] = s + 0),
        (t[i + 1] = s + 1),
        (t[i + 2] = s + 2),
        (t[i + 3] = s + 0),
        (t[i + 4] = s + 2),
        (t[i + 5] = s + 3);
    return t;
  }
  function Li(r) {
    if (r.BYTES_PER_ELEMENT === 4)
      return r instanceof Float32Array
        ? "Float32Array"
        : r instanceof Uint32Array
        ? "Uint32Array"
        : "Int32Array";
    if (r.BYTES_PER_ELEMENT === 2) {
      if (r instanceof Uint16Array) return "Uint16Array";
    } else if (r.BYTES_PER_ELEMENT === 1 && r instanceof Uint8Array)
      return "Uint8Array";
    return null;
  }
  const jd = { Float32Array, Uint32Array, Int32Array, Uint8Array };
  function Wd(r, t) {
    let e = 0,
      i = 0;
    const s = {};
    for (let h = 0; h < r.length; h++) (i += t[h]), (e += r[h].length);
    const n = new ArrayBuffer(e * 4);
    let a = null,
      o = 0;
    for (let h = 0; h < r.length; h++) {
      const l = t[h],
        u = r[h],
        c = Li(u);
      s[c] || (s[c] = new jd[c](n)), (a = s[c]);
      for (let d = 0; d < u.length; d++) {
        const f = ((d / l) | 0) * i + o,
          p = d % l;
        a[f + p] = u[d];
      }
      o += l;
    }
    return new Float32Array(n);
  }
  function Br(r) {
    return (
      (r += r === 0 ? 1 : 0),
      --r,
      (r |= r >>> 1),
      (r |= r >>> 2),
      (r |= r >>> 4),
      (r |= r >>> 8),
      (r |= r >>> 16),
      r + 1
    );
  }
  function hn(r) {
    return !(r & (r - 1)) && !!r;
  }
  function ln(r) {
    let t = (r > 65535 ? 1 : 0) << 4;
    r >>>= t;
    let e = (r > 255 ? 1 : 0) << 3;
    return (
      (r >>>= e),
      (t |= e),
      (e = (r > 15 ? 1 : 0) << 2),
      (r >>>= e),
      (t |= e),
      (e = (r > 3 ? 1 : 0) << 1),
      (r >>>= e),
      (t |= e),
      t | (r >> 1)
    );
  }
  function nr(r, t, e) {
    const i = r.length;
    let s;
    if (t >= i || e === 0) return;
    e = t + e > i ? i - t : e;
    const n = i - e;
    for (s = t; s < n; ++s) r[s] = r[s + e];
    r.length = n;
  }
  function He(r) {
    return r === 0 ? 0 : r < 0 ? -1 : 1;
  }
  let Yd = 0;
  function Ie() {
    return ++Yd;
  }
  const un = class {
    constructor(t, e, i, s) {
      (this.left = t), (this.top = e), (this.right = i), (this.bottom = s);
    }
    get width() {
      return this.right - this.left;
    }
    get height() {
      return this.bottom - this.top;
    }
    isEmpty() {
      return this.left === this.right || this.top === this.bottom;
    }
  };
  un.EMPTY = new un(0, 0, 0, 0);
  let cn = un;
  const dn = {},
    Rt = Object.create(null),
    Dt = Object.create(null);
  function qd() {
    let r;
    for (r in Rt) Rt[r].destroy();
    for (r in Dt) Dt[r].destroy();
  }
  function Kd() {
    let r;
    for (r in Rt) delete Rt[r];
    for (r in Dt) delete Dt[r];
  }
  class Vo {
    constructor(t, e, i) {
      (this._canvas = B.ADAPTER.createCanvas()),
        (this._context = this._canvas.getContext("2d")),
        (this.resolution = i || B.RESOLUTION),
        this.resize(t, e);
    }
    clear() {
      this._checkDestroyed(),
        this._context.setTransform(1, 0, 0, 1, 0, 0),
        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
    resize(t, e) {
      this._checkDestroyed(),
        (this._canvas.width = Math.round(t * this.resolution)),
        (this._canvas.height = Math.round(e * this.resolution));
    }
    destroy() {
      (this._context = null), (this._canvas = null);
    }
    get width() {
      return this._checkDestroyed(), this._canvas.width;
    }
    set width(t) {
      this._checkDestroyed(), (this._canvas.width = Math.round(t));
    }
    get height() {
      return this._checkDestroyed(), this._canvas.height;
    }
    set height(t) {
      this._checkDestroyed(), (this._canvas.height = Math.round(t));
    }
    get canvas() {
      return this._checkDestroyed(), this._canvas;
    }
    get context() {
      return this._checkDestroyed(), this._context;
    }
    _checkDestroyed() {
      this._canvas;
    }
  }
  function Xo(r, t, e) {
    for (let i = 0, s = 4 * e * t; i < t; ++i, s += 4)
      if (r[s + 3] !== 0) return !1;
    return !0;
  }
  function zo(r, t, e, i, s) {
    const n = 4 * t;
    for (let a = i, o = i * n + 4 * e; a <= s; ++a, o += n)
      if (r[o + 3] !== 0) return !1;
    return !0;
  }
  function jo(r) {
    const { width: t, height: e } = r,
      i = r.getContext("2d", { willReadFrequently: !0 });
    if (i === null) throw new TypeError("Failed to get canvas 2D context");
    const s = i.getImageData(0, 0, t, e).data;
    let n = 0,
      a = 0,
      o = t - 1,
      h = e - 1;
    for (; a < e && Xo(s, t, a); ) ++a;
    if (a === e) return cn.EMPTY;
    for (; Xo(s, t, h); ) --h;
    for (; zo(s, t, n, a, h); ) ++n;
    for (; zo(s, t, o, a, h); ) --o;
    return ++o, ++h, new cn(n, a, o, h);
  }
  function Wo(r) {
    const t = jo(r),
      { width: e, height: i } = t;
    let s = null;
    if (!t.isEmpty()) {
      const n = r.getContext("2d");
      if (n === null) throw new TypeError("Failed to get canvas 2D context");
      s = n.getImageData(t.left, t.top, e, i);
    }
    return { width: e, height: i, data: s };
  }
  function Zd(r) {
    const t = $o.exec(r);
    if (t)
      return {
        mediaType: t[1] ? t[1].toLowerCase() : void 0,
        subType: t[2] ? t[2].toLowerCase() : void 0,
        charset: t[3] ? t[3].toLowerCase() : void 0,
        encoding: t[4] ? t[4].toLowerCase() : void 0,
        data: t[5],
      };
  }
  function Yo(r, t = globalThis.location) {
    if (r.startsWith("data:")) return "";
    t = t || globalThis.location;
    const e = new URL(r, document.baseURI);
    return e.hostname !== t.hostname ||
      e.port !== t.port ||
      e.protocol !== t.protocol
      ? "anonymous"
      : "";
  }
  function re(r, t = 1) {
    var e;
    const i = (e = B.RETINA_PREFIX) == null ? void 0 : e.exec(r);
    return i ? parseFloat(i[1]) : t;
  }
  var Qd = {
      __proto__: null,
      BaseTextureCache: Dt,
      BoundingBox: cn,
      CanvasRenderTarget: Vo,
      DATA_URI: $o,
      EventEmitter: Sr,
      ProgramCache: dn,
      TextureCache: Rt,
      clearTextureCache: Kd,
      correctBlendMode: on,
      createIndicesForQuads: Ho,
      decomposeDataUri: Zd,
      deprecation: xd,
      destroyTextureCache: qd,
      detectVideoAlphaMode: wo,
      determineCrossOrigin: Yo,
      earcut: _o,
      getBufferType: Li,
      getCanvasBoundingBox: jo,
      getResolutionOfUrl: re,
      hex2rgb: Ud,
      hex2string: kd,
      interleaveTypedArrays: Wd,
      isMobile: Re,
      isPow2: hn,
      isWebGLSupported: Ro,
      log2: ln,
      nextPow2: Br,
      path: yt,
      premultiplyBlendMode: an,
      premultiplyRgba: Vd,
      premultiplyTint: Xd,
      premultiplyTintToRgba: zd,
      removeItems: nr,
      rgb2hex: $d,
      sayHello: Sd,
      sign: He,
      skipHello: Ad,
      string2hex: Gd,
      trimCanvas: Wo,
      uid: Ie,
      url: yd,
    },
    Jd = Object.defineProperty,
    tf = Object.defineProperties,
    ef = Object.getOwnPropertyDescriptors,
    qo = Object.getOwnPropertySymbols,
    rf = Object.prototype.hasOwnProperty,
    sf = Object.prototype.propertyIsEnumerable,
    Ko = (r, t, e) =>
      t in r
        ? Jd(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Zo = (r, t) => {
      for (var e in t || (t = {})) rf.call(t, e) && Ko(r, e, t[e]);
      if (qo) for (var e of qo(t)) sf.call(t, e) && Ko(r, e, t[e]);
      return r;
    },
    nf = (r, t) => tf(r, ef(t)),
    D = ((r) => (
      (r.Renderer = "renderer"),
      (r.Application = "application"),
      (r.RendererSystem = "renderer-webgl-system"),
      (r.RendererPlugin = "renderer-webgl-plugin"),
      (r.CanvasRendererSystem = "renderer-canvas-system"),
      (r.CanvasRendererPlugin = "renderer-canvas-plugin"),
      (r.Asset = "asset"),
      (r.LoadParser = "load-parser"),
      (r.ResolveParser = "resolve-parser"),
      (r.CacheParser = "cache-parser"),
      (r.DetectionParser = "detection-parser"),
      r
    ))(D || {});
  const fn = (r) => {
      if (typeof r == "function" || (typeof r == "object" && r.extension)) {
        const t =
          typeof r.extension != "object" ? { type: r.extension } : r.extension;
        r = nf(Zo({}, t), { ref: r });
      }
      if (typeof r == "object") r = Zo({}, r);
      else throw new Error("Invalid extension type");
      return typeof r.type == "string" && (r.type = [r.type]), r;
    },
    Qo = (r, t) => {
      var e;
      return (e = fn(r).priority) != null ? e : t;
    },
    U = {
      _addHandlers: {},
      _removeHandlers: {},
      _queue: {},
      remove(...r) {
        return (
          r.map(fn).forEach((t) => {
            t.type.forEach((e) => {
              var i, s;
              return (s = (i = this._removeHandlers)[e]) == null
                ? void 0
                : s.call(i, t);
            });
          }),
          this
        );
      },
      add(...r) {
        return (
          r.map(fn).forEach((t) => {
            t.type.forEach((e) => {
              var i, s;
              const n = this._addHandlers,
                a = this._queue;
              n[e]
                ? (s = n[e]) == null || s.call(n, t)
                : ((a[e] = a[e] || []), (i = a[e]) == null || i.push(t));
            });
          }),
          this
        );
      },
      handle(r, t, e) {
        var i;
        const s = this._addHandlers,
          n = this._removeHandlers;
        (s[r] = t), (n[r] = e);
        const a = this._queue;
        return (
          a[r] && ((i = a[r]) == null || i.forEach((o) => t(o)), delete a[r]),
          this
        );
      },
      handleByMap(r, t) {
        return this.handle(
          r,
          (e) => {
            e.name && (t[e.name] = e.ref);
          },
          (e) => {
            e.name && delete t[e.name];
          }
        );
      },
      handleByList(r, t, e = -1) {
        return this.handle(
          r,
          (i) => {
            t.includes(i.ref) ||
              (t.push(i.ref), t.sort((s, n) => Qo(n, e) - Qo(s, e)));
          },
          (i) => {
            const s = t.indexOf(i.ref);
            s !== -1 && t.splice(s, 1);
          }
        );
      },
    };
  class Ui {
    constructor(t) {
      typeof t == "number"
        ? (this.rawBinaryData = new ArrayBuffer(t))
        : t instanceof Uint8Array
        ? (this.rawBinaryData = t.buffer)
        : (this.rawBinaryData = t),
        (this.uint32View = new Uint32Array(this.rawBinaryData)),
        (this.float32View = new Float32Array(this.rawBinaryData));
    }
    get int8View() {
      return (
        this._int8View || (this._int8View = new Int8Array(this.rawBinaryData)),
        this._int8View
      );
    }
    get uint8View() {
      return (
        this._uint8View ||
          (this._uint8View = new Uint8Array(this.rawBinaryData)),
        this._uint8View
      );
    }
    get int16View() {
      return (
        this._int16View ||
          (this._int16View = new Int16Array(this.rawBinaryData)),
        this._int16View
      );
    }
    get uint16View() {
      return (
        this._uint16View ||
          (this._uint16View = new Uint16Array(this.rawBinaryData)),
        this._uint16View
      );
    }
    get int32View() {
      return (
        this._int32View ||
          (this._int32View = new Int32Array(this.rawBinaryData)),
        this._int32View
      );
    }
    view(t) {
      return this[`${t}View`];
    }
    destroy() {
      (this.rawBinaryData = null),
        (this._int8View = null),
        (this._uint8View = null),
        (this._int16View = null),
        (this._uint16View = null),
        (this._int32View = null),
        (this.uint32View = null),
        (this.float32View = null);
    }
    static sizeOf(t) {
      switch (t) {
        case "int8":
        case "uint8":
          return 1;
        case "int16":
        case "uint16":
          return 2;
        case "int32":
        case "uint32":
        case "float32":
          return 4;
        default:
          throw new Error(`${t} isn't a valid view type`);
      }
    }
  }
  const af = [
    "precision mediump float;",
    "void main(void){",
    "float test = 0.1;",
    "%forloop%",
    "gl_FragColor = vec4(0.0);",
    "}",
  ].join(`
`);
  function of(r) {
    let t = "";
    for (let e = 0; e < r; ++e)
      e > 0 &&
        (t += `
else `),
        e < r - 1 && (t += `if(test == ${e}.0){}`);
    return t;
  }
  function Jo(r, t) {
    if (r === 0)
      throw new Error(
        "Invalid value of `0` passed to `checkMaxIfStatementsInShader`"
      );
    const e = t.createShader(t.FRAGMENT_SHADER);
    for (;;) {
      const i = af.replace(/%forloop%/gi, of(r));
      if (
        (t.shaderSource(e, i),
        t.compileShader(e),
        !t.getShaderParameter(e, t.COMPILE_STATUS))
      )
        r = (r / 2) | 0;
      else break;
    }
    return r;
  }
  const pn = 0,
    mn = 1,
    gn = 2,
    _n = 3,
    vn = 4,
    xn = 5;
  class ie {
    constructor() {
      (this.data = 0),
        (this.blendMode = X.NORMAL),
        (this.polygonOffset = 0),
        (this.blend = !0),
        (this.depthMask = !0);
    }
    get blend() {
      return !!(this.data & (1 << pn));
    }
    set blend(t) {
      !!(this.data & (1 << pn)) !== t && (this.data ^= 1 << pn);
    }
    get offsets() {
      return !!(this.data & (1 << mn));
    }
    set offsets(t) {
      !!(this.data & (1 << mn)) !== t && (this.data ^= 1 << mn);
    }
    get culling() {
      return !!(this.data & (1 << gn));
    }
    set culling(t) {
      !!(this.data & (1 << gn)) !== t && (this.data ^= 1 << gn);
    }
    get depthTest() {
      return !!(this.data & (1 << _n));
    }
    set depthTest(t) {
      !!(this.data & (1 << _n)) !== t && (this.data ^= 1 << _n);
    }
    get depthMask() {
      return !!(this.data & (1 << xn));
    }
    set depthMask(t) {
      !!(this.data & (1 << xn)) !== t && (this.data ^= 1 << xn);
    }
    get clockwiseFrontFace() {
      return !!(this.data & (1 << vn));
    }
    set clockwiseFrontFace(t) {
      !!(this.data & (1 << vn)) !== t && (this.data ^= 1 << vn);
    }
    get blendMode() {
      return this._blendMode;
    }
    set blendMode(t) {
      (this.blend = t !== X.NONE), (this._blendMode = t);
    }
    get polygonOffset() {
      return this._polygonOffset;
    }
    set polygonOffset(t) {
      (this.offsets = !!t), (this._polygonOffset = t);
    }
    static for2d() {
      const t = new ie();
      return (t.depthTest = !1), (t.blend = !0), t;
    }
  }
  const ki = [];
  function yn(r, t) {
    if (!r) return null;
    let e = "";
    if (typeof r == "string") {
      const i = /\.(\w{3,4})(?:$|\?|#)/i.exec(r);
      i && (e = i[1].toLowerCase());
    }
    for (let i = ki.length - 1; i >= 0; --i) {
      const s = ki[i];
      if (s.test && s.test(r, e)) return new s(r, t);
    }
    throw new Error("Unrecognized source type to auto-detect Resource");
  }
  class Nt {
    constructor(t) {
      (this.items = []), (this._name = t), (this._aliasCount = 0);
    }
    emit(t, e, i, s, n, a, o, h) {
      if (arguments.length > 8) throw new Error("max arguments reached");
      const { name: l, items: u } = this;
      this._aliasCount++;
      for (let c = 0, d = u.length; c < d; c++) u[c][l](t, e, i, s, n, a, o, h);
      return u === this.items && this._aliasCount--, this;
    }
    ensureNonAliasedItems() {
      this._aliasCount > 0 &&
        this.items.length > 1 &&
        ((this._aliasCount = 0), (this.items = this.items.slice(0)));
    }
    add(t) {
      return (
        t[this._name] &&
          (this.ensureNonAliasedItems(), this.remove(t), this.items.push(t)),
        this
      );
    }
    remove(t) {
      const e = this.items.indexOf(t);
      return (
        e !== -1 && (this.ensureNonAliasedItems(), this.items.splice(e, 1)),
        this
      );
    }
    contains(t) {
      return this.items.includes(t);
    }
    removeAll() {
      return this.ensureNonAliasedItems(), (this.items.length = 0), this;
    }
    destroy() {
      this.removeAll(), (this.items.length = 0), (this._name = "");
    }
    get empty() {
      return this.items.length === 0;
    }
    get name() {
      return this._name;
    }
  }
  Object.defineProperties(Nt.prototype, {
    dispatch: { value: Nt.prototype.emit },
    run: { value: Nt.prototype.emit },
  });
  class ar {
    constructor(t = 0, e = 0) {
      (this._width = t),
        (this._height = e),
        (this.destroyed = !1),
        (this.internal = !1),
        (this.onResize = new Nt("setRealSize")),
        (this.onUpdate = new Nt("update")),
        (this.onError = new Nt("onError"));
    }
    bind(t) {
      this.onResize.add(t),
        this.onUpdate.add(t),
        this.onError.add(t),
        (this._width || this._height) &&
          this.onResize.emit(this._width, this._height);
    }
    unbind(t) {
      this.onResize.remove(t), this.onUpdate.remove(t), this.onError.remove(t);
    }
    resize(t, e) {
      (t !== this._width || e !== this._height) &&
        ((this._width = t), (this._height = e), this.onResize.emit(t, e));
    }
    get valid() {
      return !!this._width && !!this._height;
    }
    update() {
      this.destroyed || this.onUpdate.emit();
    }
    load() {
      return Promise.resolve(this);
    }
    get width() {
      return this._width;
    }
    get height() {
      return this._height;
    }
    style(t, e, i) {
      return !1;
    }
    dispose() {}
    destroy() {
      this.destroyed ||
        ((this.destroyed = !0),
        this.dispose(),
        this.onError.removeAll(),
        (this.onError = null),
        this.onResize.removeAll(),
        (this.onResize = null),
        this.onUpdate.removeAll(),
        (this.onUpdate = null));
    }
    static test(t, e) {
      return !1;
    }
  }
  class Fr extends ar {
    constructor(t, e) {
      var i;
      const { width: s, height: n } = e || {};
      if (!s || !n) throw new Error("BufferResource width or height invalid");
      super(s, n),
        (this.data = t),
        (this.unpackAlignment = (i = e.unpackAlignment) != null ? i : 4);
    }
    upload(t, e, i) {
      const s = t.gl;
      s.pixelStorei(s.UNPACK_ALIGNMENT, this.unpackAlignment),
        s.pixelStorei(
          s.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
          e.alphaMode === wt.UNPACK
        );
      const n = e.realWidth,
        a = e.realHeight;
      return (
        i.width === n && i.height === a
          ? s.texSubImage2D(
              e.target,
              0,
              0,
              0,
              n,
              a,
              e.format,
              i.type,
              this.data
            )
          : ((i.width = n),
            (i.height = a),
            s.texImage2D(
              e.target,
              0,
              i.internalFormat,
              n,
              a,
              0,
              e.format,
              i.type,
              this.data
            )),
        !0
      );
    }
    dispose() {
      this.data = null;
    }
    static test(t) {
      return (
        t === null ||
        t instanceof Int8Array ||
        t instanceof Uint8Array ||
        t instanceof Uint8ClampedArray ||
        t instanceof Int16Array ||
        t instanceof Uint16Array ||
        t instanceof Int32Array ||
        t instanceof Uint32Array ||
        t instanceof Float32Array
      );
    }
  }
  var hf = Object.defineProperty,
    th = Object.getOwnPropertySymbols,
    lf = Object.prototype.hasOwnProperty,
    uf = Object.prototype.propertyIsEnumerable,
    eh = (r, t, e) =>
      t in r
        ? hf(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    cf = (r, t) => {
      for (var e in t || (t = {})) lf.call(t, e) && eh(r, e, t[e]);
      if (th) for (var e of th(t)) uf.call(t, e) && eh(r, e, t[e]);
      return r;
    };
  const df = { scaleMode: Qt.NEAREST, alphaMode: wt.NPM },
    bn = class Tr extends Sr {
      constructor(t = null, e = null) {
        super(), (e = Object.assign({}, Tr.defaultOptions, e));
        const {
          alphaMode: i,
          mipmap: s,
          anisotropicLevel: n,
          scaleMode: a,
          width: o,
          height: h,
          wrapMode: l,
          format: u,
          type: c,
          target: d,
          resolution: f,
          resourceOptions: p,
        } = e;
        t && !(t instanceof ar) && ((t = yn(t, p)), (t.internal = !0)),
          (this.resolution = f || B.RESOLUTION),
          (this.width =
            Math.round((o || 0) * this.resolution) / this.resolution),
          (this.height =
            Math.round((h || 0) * this.resolution) / this.resolution),
          (this._mipmap = s),
          (this.anisotropicLevel = n),
          (this._wrapMode = l),
          (this._scaleMode = a),
          (this.format = u),
          (this.type = c),
          (this.target = d),
          (this.alphaMode = i),
          (this.uid = Ie()),
          (this.touched = 0),
          (this.isPowerOfTwo = !1),
          this._refreshPOT(),
          (this._glTextures = {}),
          (this.dirtyId = 0),
          (this.dirtyStyleId = 0),
          (this.cacheId = null),
          (this.valid = o > 0 && h > 0),
          (this.textureCacheIds = []),
          (this.destroyed = !1),
          (this.resource = null),
          (this._batchEnabled = 0),
          (this._batchLocation = 0),
          (this.parentTextureArray = null),
          this.setResource(t);
      }
      get realWidth() {
        return Math.round(this.width * this.resolution);
      }
      get realHeight() {
        return Math.round(this.height * this.resolution);
      }
      get mipmap() {
        return this._mipmap;
      }
      set mipmap(t) {
        this._mipmap !== t && ((this._mipmap = t), this.dirtyStyleId++);
      }
      get scaleMode() {
        return this._scaleMode;
      }
      set scaleMode(t) {
        this._scaleMode !== t && ((this._scaleMode = t), this.dirtyStyleId++);
      }
      get wrapMode() {
        return this._wrapMode;
      }
      set wrapMode(t) {
        this._wrapMode !== t && ((this._wrapMode = t), this.dirtyStyleId++);
      }
      setStyle(t, e) {
        let i;
        return (
          t !== void 0 &&
            t !== this.scaleMode &&
            ((this.scaleMode = t), (i = !0)),
          e !== void 0 && e !== this.mipmap && ((this.mipmap = e), (i = !0)),
          i && this.dirtyStyleId++,
          this
        );
      }
      setSize(t, e, i) {
        return (i = i || this.resolution), this.setRealSize(t * i, e * i, i);
      }
      setRealSize(t, e, i) {
        return (
          (this.resolution = i || this.resolution),
          (this.width = Math.round(t) / this.resolution),
          (this.height = Math.round(e) / this.resolution),
          this._refreshPOT(),
          this.update(),
          this
        );
      }
      _refreshPOT() {
        this.isPowerOfTwo = hn(this.realWidth) && hn(this.realHeight);
      }
      setResolution(t) {
        const e = this.resolution;
        return e === t
          ? this
          : ((this.resolution = t),
            this.valid &&
              ((this.width = Math.round(this.width * e) / t),
              (this.height = Math.round(this.height * e) / t),
              this.emit("update", this)),
            this._refreshPOT(),
            this);
      }
      setResource(t) {
        if (this.resource === t) return this;
        if (this.resource) throw new Error("Resource can be set only once");
        return t.bind(this), (this.resource = t), this;
      }
      update() {
        this.valid
          ? (this.dirtyId++, this.dirtyStyleId++, this.emit("update", this))
          : this.width > 0 &&
            this.height > 0 &&
            ((this.valid = !0),
            this.emit("loaded", this),
            this.emit("update", this));
      }
      onError(t) {
        this.emit("error", this, t);
      }
      destroy() {
        this.resource &&
          (this.resource.unbind(this),
          this.resource.internal && this.resource.destroy(),
          (this.resource = null)),
          this.cacheId &&
            (delete Dt[this.cacheId],
            delete Rt[this.cacheId],
            (this.cacheId = null)),
          (this.valid = !1),
          this.dispose(),
          Tr.removeFromCache(this),
          (this.textureCacheIds = null),
          (this.destroyed = !0),
          this.emit("destroyed", this),
          this.removeAllListeners();
      }
      dispose() {
        this.emit("dispose", this);
      }
      castToBaseTexture() {
        return this;
      }
      static from(t, e, i = B.STRICT_TEXTURE_CACHE) {
        const s = typeof t == "string";
        let n = null;
        if (s) n = t;
        else {
          if (!t._pixiId) {
            const o = (e == null ? void 0 : e.pixiIdPrefix) || "pixiid";
            t._pixiId = `${o}_${Ie()}`;
          }
          n = t._pixiId;
        }
        let a = Dt[n];
        if (s && i && !a)
          throw new Error(
            `The cacheId "${n}" does not exist in BaseTextureCache.`
          );
        return (
          a || ((a = new Tr(t, e)), (a.cacheId = n), Tr.addToCache(a, n)), a
        );
      }
      static fromBuffer(t, e, i, s) {
        t = t || new Float32Array(e * i * 4);
        const n = new Fr(
          t,
          cf({ width: e, height: i }, s == null ? void 0 : s.resourceOptions)
        );
        let a, o;
        return (
          t instanceof Float32Array
            ? ((a = A.RGBA), (o = H.FLOAT))
            : t instanceof Int32Array
            ? ((a = A.RGBA_INTEGER), (o = H.INT))
            : t instanceof Uint32Array
            ? ((a = A.RGBA_INTEGER), (o = H.UNSIGNED_INT))
            : t instanceof Int16Array
            ? ((a = A.RGBA_INTEGER), (o = H.SHORT))
            : t instanceof Uint16Array
            ? ((a = A.RGBA_INTEGER), (o = H.UNSIGNED_SHORT))
            : t instanceof Int8Array
            ? ((a = A.RGBA), (o = H.BYTE))
            : ((a = A.RGBA), (o = H.UNSIGNED_BYTE)),
          (n.internal = !0),
          new Tr(n, Object.assign({}, df, { type: o, format: a }, s))
        );
      }
      static addToCache(t, e) {
        e &&
          (t.textureCacheIds.includes(e) || t.textureCacheIds.push(e),
          Dt[e] &&
            Dt[e] !== t &&
            console.warn(
              `BaseTexture added to the cache with an id [${e}] that already had an entry`
            ),
          (Dt[e] = t));
      }
      static removeFromCache(t) {
        if (typeof t == "string") {
          const e = Dt[t];
          if (e) {
            const i = e.textureCacheIds.indexOf(t);
            return i > -1 && e.textureCacheIds.splice(i, 1), delete Dt[t], e;
          }
        } else if (t != null && t.textureCacheIds) {
          for (let e = 0; e < t.textureCacheIds.length; ++e)
            delete Dt[t.textureCacheIds[e]];
          return (t.textureCacheIds.length = 0), t;
        }
        return null;
      }
    };
  (bn.defaultOptions = {
    mipmap: Xt.POW2,
    anisotropicLevel: 0,
    scaleMode: Qt.LINEAR,
    wrapMode: Jt.CLAMP,
    alphaMode: wt.UNPACK,
    target: ke.TEXTURE_2D,
    format: A.RGBA,
    type: H.UNSIGNED_BYTE,
  }),
    (bn._globalBatch = 0);
  let j = bn;
  class Gi {
    constructor() {
      (this.texArray = null),
        (this.blend = 0),
        (this.type = Vt.TRIANGLES),
        (this.start = 0),
        (this.size = 0),
        (this.data = null);
    }
  }
  let ff = 0;
  class nt {
    constructor(t, e = !0, i = !1) {
      (this.data = t || new Float32Array(1)),
        (this._glBuffers = {}),
        (this._updateID = 0),
        (this.index = i),
        (this.static = e),
        (this.id = ff++),
        (this.disposeRunner = new Nt("disposeBuffer"));
    }
    update(t) {
      t instanceof Array && (t = new Float32Array(t)),
        (this.data = t || this.data),
        this._updateID++;
    }
    dispose() {
      this.disposeRunner.emit(this, !1);
    }
    destroy() {
      this.dispose(), (this.data = null);
    }
    set index(t) {
      this.type = t ? jt.ELEMENT_ARRAY_BUFFER : jt.ARRAY_BUFFER;
    }
    get index() {
      return this.type === jt.ELEMENT_ARRAY_BUFFER;
    }
    static from(t) {
      return t instanceof Array && (t = new Float32Array(t)), new nt(t);
    }
  }
  class Lr {
    constructor(t, e = 0, i = !1, s = H.FLOAT, n, a, o, h = 1) {
      (this.buffer = t),
        (this.size = e),
        (this.normalized = i),
        (this.type = s),
        (this.stride = n),
        (this.start = a),
        (this.instance = o),
        (this.divisor = h);
    }
    destroy() {
      this.buffer = null;
    }
    static from(t, e, i, s, n) {
      return new Lr(t, e, i, s, n);
    }
  }
  const pf = { Float32Array, Uint32Array, Int32Array, Uint8Array };
  function mf(r, t) {
    let e = 0,
      i = 0;
    const s = {};
    for (let h = 0; h < r.length; h++) (i += t[h]), (e += r[h].length);
    const n = new ArrayBuffer(e * 4);
    let a = null,
      o = 0;
    for (let h = 0; h < r.length; h++) {
      const l = t[h],
        u = r[h],
        c = Li(u);
      s[c] || (s[c] = new pf[c](n)), (a = s[c]);
      for (let d = 0; d < u.length; d++) {
        const f = ((d / l) | 0) * i + o,
          p = d % l;
        a[f + p] = u[d];
      }
      o += l;
    }
    return new Float32Array(n);
  }
  const rh = { 5126: 4, 5123: 2, 5121: 1 };
  let gf = 0;
  const _f = { Float32Array, Uint32Array, Int32Array, Uint8Array, Uint16Array };
  class me {
    constructor(t = [], e = {}) {
      (this.buffers = t),
        (this.indexBuffer = null),
        (this.attributes = e),
        (this.glVertexArrayObjects = {}),
        (this.id = gf++),
        (this.instanced = !1),
        (this.instanceCount = 1),
        (this.disposeRunner = new Nt("disposeGeometry")),
        (this.refCount = 0);
    }
    addAttribute(t, e, i = 0, s = !1, n, a, o, h = !1) {
      if (!e)
        throw new Error("You must pass a buffer when creating an attribute");
      e instanceof nt ||
        (e instanceof Array && (e = new Float32Array(e)), (e = new nt(e)));
      const l = t.split("|");
      if (l.length > 1) {
        for (let c = 0; c < l.length; c++) this.addAttribute(l[c], e, i, s, n);
        return this;
      }
      let u = this.buffers.indexOf(e);
      return (
        u === -1 && (this.buffers.push(e), (u = this.buffers.length - 1)),
        (this.attributes[t] = new Lr(u, i, s, n, a, o, h)),
        (this.instanced = this.instanced || h),
        this
      );
    }
    getAttribute(t) {
      return this.attributes[t];
    }
    getBuffer(t) {
      return this.buffers[this.getAttribute(t).buffer];
    }
    addIndex(t) {
      return (
        t instanceof nt ||
          (t instanceof Array && (t = new Uint16Array(t)), (t = new nt(t))),
        (t.type = jt.ELEMENT_ARRAY_BUFFER),
        (this.indexBuffer = t),
        this.buffers.includes(t) || this.buffers.push(t),
        this
      );
    }
    getIndex() {
      return this.indexBuffer;
    }
    interleave() {
      if (
        this.buffers.length === 1 ||
        (this.buffers.length === 2 && this.indexBuffer)
      )
        return this;
      const t = [],
        e = [],
        i = new nt();
      let s;
      for (s in this.attributes) {
        const n = this.attributes[s],
          a = this.buffers[n.buffer];
        t.push(a.data), e.push((n.size * rh[n.type]) / 4), (n.buffer = 0);
      }
      for (i.data = mf(t, e), s = 0; s < this.buffers.length; s++)
        this.buffers[s] !== this.indexBuffer && this.buffers[s].destroy();
      return (
        (this.buffers = [i]),
        this.indexBuffer && this.buffers.push(this.indexBuffer),
        this
      );
    }
    getSize() {
      for (const t in this.attributes) {
        const e = this.attributes[t];
        return this.buffers[e.buffer].data.length / (e.stride / 4 || e.size);
      }
      return 0;
    }
    dispose() {
      this.disposeRunner.emit(this, !1);
    }
    destroy() {
      this.dispose(),
        (this.buffers = null),
        (this.indexBuffer = null),
        (this.attributes = null);
    }
    clone() {
      const t = new me();
      for (let e = 0; e < this.buffers.length; e++)
        t.buffers[e] = new nt(this.buffers[e].data.slice(0));
      for (const e in this.attributes) {
        const i = this.attributes[e];
        t.attributes[e] = new Lr(
          i.buffer,
          i.size,
          i.normalized,
          i.type,
          i.stride,
          i.start,
          i.instance
        );
      }
      return (
        this.indexBuffer &&
          ((t.indexBuffer = t.buffers[this.buffers.indexOf(this.indexBuffer)]),
          (t.indexBuffer.type = jt.ELEMENT_ARRAY_BUFFER)),
        t
      );
    }
    static merge(t) {
      const e = new me(),
        i = [],
        s = [],
        n = [];
      let a;
      for (let o = 0; o < t.length; o++) {
        a = t[o];
        for (let h = 0; h < a.buffers.length; h++)
          (s[h] = s[h] || 0), (s[h] += a.buffers[h].data.length), (n[h] = 0);
      }
      for (let o = 0; o < a.buffers.length; o++)
        (i[o] = new _f[Li(a.buffers[o].data)](s[o])),
          (e.buffers[o] = new nt(i[o]));
      for (let o = 0; o < t.length; o++) {
        a = t[o];
        for (let h = 0; h < a.buffers.length; h++)
          i[h].set(a.buffers[h].data, n[h]), (n[h] += a.buffers[h].data.length);
      }
      if (((e.attributes = a.attributes), a.indexBuffer)) {
        (e.indexBuffer = e.buffers[a.buffers.indexOf(a.indexBuffer)]),
          (e.indexBuffer.type = jt.ELEMENT_ARRAY_BUFFER);
        let o = 0,
          h = 0,
          l = 0,
          u = 0;
        for (let c = 0; c < a.buffers.length; c++)
          if (a.buffers[c] !== a.indexBuffer) {
            u = c;
            break;
          }
        for (const c in a.attributes) {
          const d = a.attributes[c];
          (d.buffer | 0) === u && (h += (d.size * rh[d.type]) / 4);
        }
        for (let c = 0; c < t.length; c++) {
          const d = t[c].indexBuffer.data;
          for (let f = 0; f < d.length; f++) e.indexBuffer.data[f + l] += o;
          (o += t[c].buffers[u].data.length / h), (l += d.length);
        }
      }
      return e;
    }
  }
  class En extends me {
    constructor(t = !1) {
      super(),
        (this._buffer = new nt(null, t, !1)),
        (this._indexBuffer = new nt(null, t, !0)),
        this.addAttribute("aVertexPosition", this._buffer, 2, !1, H.FLOAT)
          .addAttribute("aTextureCoord", this._buffer, 2, !1, H.FLOAT)
          .addAttribute("aColor", this._buffer, 4, !0, H.UNSIGNED_BYTE)
          .addAttribute("aTextureId", this._buffer, 1, !0, H.FLOAT)
          .addIndex(this._indexBuffer);
    }
  }
  const Ur = Math.PI * 2,
    ih = 180 / Math.PI,
    sh = Math.PI / 180;
  var mt = ((r) => (
    (r[(r.POLY = 0)] = "POLY"),
    (r[(r.RECT = 1)] = "RECT"),
    (r[(r.CIRC = 2)] = "CIRC"),
    (r[(r.ELIP = 3)] = "ELIP"),
    (r[(r.RREC = 4)] = "RREC"),
    r
  ))(mt || {});
  class tt {
    constructor(t = 0, e = 0) {
      (this.x = 0), (this.y = 0), (this.x = t), (this.y = e);
    }
    clone() {
      return new tt(this.x, this.y);
    }
    copyFrom(t) {
      return this.set(t.x, t.y), this;
    }
    copyTo(t) {
      return t.set(this.x, this.y), t;
    }
    equals(t) {
      return t.x === this.x && t.y === this.y;
    }
    set(t = 0, e = t) {
      return (this.x = t), (this.y = e), this;
    }
  }
  const $i = [new tt(), new tt(), new tt(), new tt()];
  class Y {
    constructor(t = 0, e = 0, i = 0, s = 0) {
      (this.x = Number(t)),
        (this.y = Number(e)),
        (this.width = Number(i)),
        (this.height = Number(s)),
        (this.type = mt.RECT);
    }
    get left() {
      return this.x;
    }
    get right() {
      return this.x + this.width;
    }
    get top() {
      return this.y;
    }
    get bottom() {
      return this.y + this.height;
    }
    static get EMPTY() {
      return new Y(0, 0, 0, 0);
    }
    clone() {
      return new Y(this.x, this.y, this.width, this.height);
    }
    copyFrom(t) {
      return (
        (this.x = t.x),
        (this.y = t.y),
        (this.width = t.width),
        (this.height = t.height),
        this
      );
    }
    copyTo(t) {
      return (
        (t.x = this.x),
        (t.y = this.y),
        (t.width = this.width),
        (t.height = this.height),
        t
      );
    }
    contains(t, e) {
      return this.width <= 0 || this.height <= 0
        ? !1
        : t >= this.x &&
            t < this.x + this.width &&
            e >= this.y &&
            e < this.y + this.height;
    }
    intersects(t, e) {
      if (!e) {
        const S = this.x < t.x ? t.x : this.x;
        if ((this.right > t.right ? t.right : this.right) <= S) return !1;
        const I = this.y < t.y ? t.y : this.y;
        return (this.bottom > t.bottom ? t.bottom : this.bottom) > I;
      }
      const i = this.left,
        s = this.right,
        n = this.top,
        a = this.bottom;
      if (s <= i || a <= n) return !1;
      const o = $i[0].set(t.left, t.top),
        h = $i[1].set(t.left, t.bottom),
        l = $i[2].set(t.right, t.top),
        u = $i[3].set(t.right, t.bottom);
      if (l.x <= o.x || h.y <= o.y) return !1;
      const c = Math.sign(e.a * e.d - e.b * e.c);
      if (
        c === 0 ||
        (e.apply(o, o),
        e.apply(h, h),
        e.apply(l, l),
        e.apply(u, u),
        Math.max(o.x, h.x, l.x, u.x) <= i ||
          Math.min(o.x, h.x, l.x, u.x) >= s ||
          Math.max(o.y, h.y, l.y, u.y) <= n ||
          Math.min(o.y, h.y, l.y, u.y) >= a)
      )
        return !1;
      const d = c * (h.y - o.y),
        f = c * (o.x - h.x),
        p = d * i + f * n,
        m = d * s + f * n,
        g = d * i + f * a,
        x = d * s + f * a;
      if (
        Math.max(p, m, g, x) <= d * o.x + f * o.y ||
        Math.min(p, m, g, x) >= d * u.x + f * u.y
      )
        return !1;
      const b = c * (o.y - l.y),
        _ = c * (l.x - o.x),
        y = b * i + _ * n,
        T = b * s + _ * n,
        C = b * i + _ * a,
        R = b * s + _ * a;
      return !(
        Math.max(y, T, C, R) <= b * o.x + _ * o.y ||
        Math.min(y, T, C, R) >= b * u.x + _ * u.y
      );
    }
    pad(t = 0, e = t) {
      return (
        (this.x -= t),
        (this.y -= e),
        (this.width += t * 2),
        (this.height += e * 2),
        this
      );
    }
    fit(t) {
      const e = Math.max(this.x, t.x),
        i = Math.min(this.x + this.width, t.x + t.width),
        s = Math.max(this.y, t.y),
        n = Math.min(this.y + this.height, t.y + t.height);
      return (
        (this.x = e),
        (this.width = Math.max(i - e, 0)),
        (this.y = s),
        (this.height = Math.max(n - s, 0)),
        this
      );
    }
    ceil(t = 1, e = 0.001) {
      const i = Math.ceil((this.x + this.width - e) * t) / t,
        s = Math.ceil((this.y + this.height - e) * t) / t;
      return (
        (this.x = Math.floor((this.x + e) * t) / t),
        (this.y = Math.floor((this.y + e) * t) / t),
        (this.width = i - this.x),
        (this.height = s - this.y),
        this
      );
    }
    enlarge(t) {
      const e = Math.min(this.x, t.x),
        i = Math.max(this.x + this.width, t.x + t.width),
        s = Math.min(this.y, t.y),
        n = Math.max(this.y + this.height, t.y + t.height);
      return (
        (this.x = e),
        (this.width = i - e),
        (this.y = s),
        (this.height = n - s),
        this
      );
    }
  }
  class Hi {
    constructor(t = 0, e = 0, i = 0) {
      (this.x = t), (this.y = e), (this.radius = i), (this.type = mt.CIRC);
    }
    clone() {
      return new Hi(this.x, this.y, this.radius);
    }
    contains(t, e) {
      if (this.radius <= 0) return !1;
      const i = this.radius * this.radius;
      let s = this.x - t,
        n = this.y - e;
      return (s *= s), (n *= n), s + n <= i;
    }
    getBounds() {
      return new Y(
        this.x - this.radius,
        this.y - this.radius,
        this.radius * 2,
        this.radius * 2
      );
    }
  }
  class Vi {
    constructor(t = 0, e = 0, i = 0, s = 0) {
      (this.x = t),
        (this.y = e),
        (this.width = i),
        (this.height = s),
        (this.type = mt.ELIP);
    }
    clone() {
      return new Vi(this.x, this.y, this.width, this.height);
    }
    contains(t, e) {
      if (this.width <= 0 || this.height <= 0) return !1;
      let i = (t - this.x) / this.width,
        s = (e - this.y) / this.height;
      return (i *= i), (s *= s), i + s <= 1;
    }
    getBounds() {
      return new Y(
        this.x - this.width,
        this.y - this.height,
        this.width,
        this.height
      );
    }
  }
  class Ve {
    constructor(...t) {
      let e = Array.isArray(t[0]) ? t[0] : t;
      if (typeof e[0] != "number") {
        const i = [];
        for (let s = 0, n = e.length; s < n; s++) i.push(e[s].x, e[s].y);
        e = i;
      }
      (this.points = e), (this.type = mt.POLY), (this.closeStroke = !0);
    }
    clone() {
      const t = this.points.slice(),
        e = new Ve(t);
      return (e.closeStroke = this.closeStroke), e;
    }
    contains(t, e) {
      let i = !1;
      const s = this.points.length / 2;
      for (let n = 0, a = s - 1; n < s; a = n++) {
        const o = this.points[n * 2],
          h = this.points[n * 2 + 1],
          l = this.points[a * 2],
          u = this.points[a * 2 + 1];
        h > e != u > e && t < (l - o) * ((e - h) / (u - h)) + o && (i = !i);
      }
      return i;
    }
  }
  class Xi {
    constructor(t = 0, e = 0, i = 0, s = 0, n = 20) {
      (this.x = t),
        (this.y = e),
        (this.width = i),
        (this.height = s),
        (this.radius = n),
        (this.type = mt.RREC);
    }
    clone() {
      return new Xi(this.x, this.y, this.width, this.height, this.radius);
    }
    contains(t, e) {
      if (this.width <= 0 || this.height <= 0) return !1;
      if (
        t >= this.x &&
        t <= this.x + this.width &&
        e >= this.y &&
        e <= this.y + this.height
      ) {
        const i = Math.max(
          0,
          Math.min(this.radius, Math.min(this.width, this.height) / 2)
        );
        if (
          (e >= this.y + i && e <= this.y + this.height - i) ||
          (t >= this.x + i && t <= this.x + this.width - i)
        )
          return !0;
        let s = t - (this.x + i),
          n = e - (this.y + i);
        const a = i * i;
        if (
          s * s + n * n <= a ||
          ((s = t - (this.x + this.width - i)), s * s + n * n <= a) ||
          ((n = e - (this.y + this.height - i)), s * s + n * n <= a) ||
          ((s = t - (this.x + i)), s * s + n * n <= a)
        )
          return !0;
      }
      return !1;
    }
  }
  class et {
    constructor(t = 1, e = 0, i = 0, s = 1, n = 0, a = 0) {
      (this.array = null),
        (this.a = t),
        (this.b = e),
        (this.c = i),
        (this.d = s),
        (this.tx = n),
        (this.ty = a);
    }
    fromArray(t) {
      (this.a = t[0]),
        (this.b = t[1]),
        (this.c = t[3]),
        (this.d = t[4]),
        (this.tx = t[2]),
        (this.ty = t[5]);
    }
    set(t, e, i, s, n, a) {
      return (
        (this.a = t),
        (this.b = e),
        (this.c = i),
        (this.d = s),
        (this.tx = n),
        (this.ty = a),
        this
      );
    }
    toArray(t, e) {
      this.array || (this.array = new Float32Array(9));
      const i = e || this.array;
      return (
        t
          ? ((i[0] = this.a),
            (i[1] = this.b),
            (i[2] = 0),
            (i[3] = this.c),
            (i[4] = this.d),
            (i[5] = 0),
            (i[6] = this.tx),
            (i[7] = this.ty),
            (i[8] = 1))
          : ((i[0] = this.a),
            (i[1] = this.c),
            (i[2] = this.tx),
            (i[3] = this.b),
            (i[4] = this.d),
            (i[5] = this.ty),
            (i[6] = 0),
            (i[7] = 0),
            (i[8] = 1)),
        i
      );
    }
    apply(t, e) {
      e = e || new tt();
      const i = t.x,
        s = t.y;
      return (
        (e.x = this.a * i + this.c * s + this.tx),
        (e.y = this.b * i + this.d * s + this.ty),
        e
      );
    }
    applyInverse(t, e) {
      e = e || new tt();
      const i = 1 / (this.a * this.d + this.c * -this.b),
        s = t.x,
        n = t.y;
      return (
        (e.x =
          this.d * i * s +
          -this.c * i * n +
          (this.ty * this.c - this.tx * this.d) * i),
        (e.y =
          this.a * i * n +
          -this.b * i * s +
          (-this.ty * this.a + this.tx * this.b) * i),
        e
      );
    }
    translate(t, e) {
      return (this.tx += t), (this.ty += e), this;
    }
    scale(t, e) {
      return (
        (this.a *= t),
        (this.d *= e),
        (this.c *= t),
        (this.b *= e),
        (this.tx *= t),
        (this.ty *= e),
        this
      );
    }
    rotate(t) {
      const e = Math.cos(t),
        i = Math.sin(t),
        s = this.a,
        n = this.c,
        a = this.tx;
      return (
        (this.a = s * e - this.b * i),
        (this.b = s * i + this.b * e),
        (this.c = n * e - this.d * i),
        (this.d = n * i + this.d * e),
        (this.tx = a * e - this.ty * i),
        (this.ty = a * i + this.ty * e),
        this
      );
    }
    append(t) {
      const e = this.a,
        i = this.b,
        s = this.c,
        n = this.d;
      return (
        (this.a = t.a * e + t.b * s),
        (this.b = t.a * i + t.b * n),
        (this.c = t.c * e + t.d * s),
        (this.d = t.c * i + t.d * n),
        (this.tx = t.tx * e + t.ty * s + this.tx),
        (this.ty = t.tx * i + t.ty * n + this.ty),
        this
      );
    }
    setTransform(t, e, i, s, n, a, o, h, l) {
      return (
        (this.a = Math.cos(o + l) * n),
        (this.b = Math.sin(o + l) * n),
        (this.c = -Math.sin(o - h) * a),
        (this.d = Math.cos(o - h) * a),
        (this.tx = t - (i * this.a + s * this.c)),
        (this.ty = e - (i * this.b + s * this.d)),
        this
      );
    }
    prepend(t) {
      const e = this.tx;
      if (t.a !== 1 || t.b !== 0 || t.c !== 0 || t.d !== 1) {
        const i = this.a,
          s = this.c;
        (this.a = i * t.a + this.b * t.c),
          (this.b = i * t.b + this.b * t.d),
          (this.c = s * t.a + this.d * t.c),
          (this.d = s * t.b + this.d * t.d);
      }
      return (
        (this.tx = e * t.a + this.ty * t.c + t.tx),
        (this.ty = e * t.b + this.ty * t.d + t.ty),
        this
      );
    }
    decompose(t) {
      const e = this.a,
        i = this.b,
        s = this.c,
        n = this.d,
        a = t.pivot,
        o = -Math.atan2(-s, n),
        h = Math.atan2(i, e),
        l = Math.abs(o + h);
      return (
        l < 1e-5 || Math.abs(Ur - l) < 1e-5
          ? ((t.rotation = h), (t.skew.x = t.skew.y = 0))
          : ((t.rotation = 0), (t.skew.x = o), (t.skew.y = h)),
        (t.scale.x = Math.sqrt(e * e + i * i)),
        (t.scale.y = Math.sqrt(s * s + n * n)),
        (t.position.x = this.tx + (a.x * e + a.y * s)),
        (t.position.y = this.ty + (a.x * i + a.y * n)),
        t
      );
    }
    invert() {
      const t = this.a,
        e = this.b,
        i = this.c,
        s = this.d,
        n = this.tx,
        a = t * s - e * i;
      return (
        (this.a = s / a),
        (this.b = -e / a),
        (this.c = -i / a),
        (this.d = t / a),
        (this.tx = (i * this.ty - s * n) / a),
        (this.ty = -(t * this.ty - e * n) / a),
        this
      );
    }
    identity() {
      return (
        (this.a = 1),
        (this.b = 0),
        (this.c = 0),
        (this.d = 1),
        (this.tx = 0),
        (this.ty = 0),
        this
      );
    }
    clone() {
      const t = new et();
      return (
        (t.a = this.a),
        (t.b = this.b),
        (t.c = this.c),
        (t.d = this.d),
        (t.tx = this.tx),
        (t.ty = this.ty),
        t
      );
    }
    copyTo(t) {
      return (
        (t.a = this.a),
        (t.b = this.b),
        (t.c = this.c),
        (t.d = this.d),
        (t.tx = this.tx),
        (t.ty = this.ty),
        t
      );
    }
    copyFrom(t) {
      return (
        (this.a = t.a),
        (this.b = t.b),
        (this.c = t.c),
        (this.d = t.d),
        (this.tx = t.tx),
        (this.ty = t.ty),
        this
      );
    }
    static get IDENTITY() {
      return new et();
    }
    static get TEMP_MATRIX() {
      return new et();
    }
  }
  const Xe = [1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1, 0, 1],
    ze = [0, 1, 1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1],
    je = [0, -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 0, -1, -1, -1],
    We = [1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 0, -1],
    Tn = [],
    nh = [],
    zi = Math.sign;
  function vf() {
    for (let r = 0; r < 16; r++) {
      const t = [];
      Tn.push(t);
      for (let e = 0; e < 16; e++) {
        const i = zi(Xe[r] * Xe[e] + je[r] * ze[e]),
          s = zi(ze[r] * Xe[e] + We[r] * ze[e]),
          n = zi(Xe[r] * je[e] + je[r] * We[e]),
          a = zi(ze[r] * je[e] + We[r] * We[e]);
        for (let o = 0; o < 16; o++)
          if (Xe[o] === i && ze[o] === s && je[o] === n && We[o] === a) {
            t.push(o);
            break;
          }
      }
    }
    for (let r = 0; r < 16; r++) {
      const t = new et();
      t.set(Xe[r], ze[r], je[r], We[r], 0, 0), nh.push(t);
    }
  }
  vf();
  const rt = {
    E: 0,
    SE: 1,
    S: 2,
    SW: 3,
    W: 4,
    NW: 5,
    N: 6,
    NE: 7,
    MIRROR_VERTICAL: 8,
    MAIN_DIAGONAL: 10,
    MIRROR_HORIZONTAL: 12,
    REVERSE_DIAGONAL: 14,
    uX: (r) => Xe[r],
    uY: (r) => ze[r],
    vX: (r) => je[r],
    vY: (r) => We[r],
    inv: (r) => (r & 8 ? r & 15 : -r & 7),
    add: (r, t) => Tn[r][t],
    sub: (r, t) => Tn[r][rt.inv(t)],
    rotate180: (r) => r ^ 4,
    isVertical: (r) => (r & 3) === 2,
    byDirection: (r, t) =>
      Math.abs(r) * 2 <= Math.abs(t)
        ? t >= 0
          ? rt.S
          : rt.N
        : Math.abs(t) * 2 <= Math.abs(r)
        ? r > 0
          ? rt.E
          : rt.W
        : t > 0
        ? r > 0
          ? rt.SE
          : rt.SW
        : r > 0
        ? rt.NE
        : rt.NW,
    matrixAppendRotationInv: (r, t, e = 0, i = 0) => {
      const s = nh[rt.inv(t)];
      (s.tx = e), (s.ty = i), r.append(s);
    },
  };
  class ge {
    constructor(t, e, i = 0, s = 0) {
      (this._x = i), (this._y = s), (this.cb = t), (this.scope = e);
    }
    clone(t = this.cb, e = this.scope) {
      return new ge(t, e, this._x, this._y);
    }
    set(t = 0, e = t) {
      return (
        (this._x !== t || this._y !== e) &&
          ((this._x = t), (this._y = e), this.cb.call(this.scope)),
        this
      );
    }
    copyFrom(t) {
      return (
        (this._x !== t.x || this._y !== t.y) &&
          ((this._x = t.x), (this._y = t.y), this.cb.call(this.scope)),
        this
      );
    }
    copyTo(t) {
      return t.set(this._x, this._y), t;
    }
    equals(t) {
      return t.x === this._x && t.y === this._y;
    }
    get x() {
      return this._x;
    }
    set x(t) {
      this._x !== t && ((this._x = t), this.cb.call(this.scope));
    }
    get y() {
      return this._y;
    }
    set y(t) {
      this._y !== t && ((this._y = t), this.cb.call(this.scope));
    }
  }
  const An = class {
    constructor() {
      (this.worldTransform = new et()),
        (this.localTransform = new et()),
        (this.position = new ge(this.onChange, this, 0, 0)),
        (this.scale = new ge(this.onChange, this, 1, 1)),
        (this.pivot = new ge(this.onChange, this, 0, 0)),
        (this.skew = new ge(this.updateSkew, this, 0, 0)),
        (this._rotation = 0),
        (this._cx = 1),
        (this._sx = 0),
        (this._cy = 0),
        (this._sy = 1),
        (this._localID = 0),
        (this._currentLocalID = 0),
        (this._worldID = 0),
        (this._parentID = 0);
    }
    onChange() {
      this._localID++;
    }
    updateSkew() {
      (this._cx = Math.cos(this._rotation + this.skew.y)),
        (this._sx = Math.sin(this._rotation + this.skew.y)),
        (this._cy = -Math.sin(this._rotation - this.skew.x)),
        (this._sy = Math.cos(this._rotation - this.skew.x)),
        this._localID++;
    }
    updateLocalTransform() {
      const t = this.localTransform;
      this._localID !== this._currentLocalID &&
        ((t.a = this._cx * this.scale.x),
        (t.b = this._sx * this.scale.x),
        (t.c = this._cy * this.scale.y),
        (t.d = this._sy * this.scale.y),
        (t.tx = this.position.x - (this.pivot.x * t.a + this.pivot.y * t.c)),
        (t.ty = this.position.y - (this.pivot.x * t.b + this.pivot.y * t.d)),
        (this._currentLocalID = this._localID),
        (this._parentID = -1));
    }
    updateTransform(t) {
      const e = this.localTransform;
      if (
        (this._localID !== this._currentLocalID &&
          ((e.a = this._cx * this.scale.x),
          (e.b = this._sx * this.scale.x),
          (e.c = this._cy * this.scale.y),
          (e.d = this._sy * this.scale.y),
          (e.tx = this.position.x - (this.pivot.x * e.a + this.pivot.y * e.c)),
          (e.ty = this.position.y - (this.pivot.x * e.b + this.pivot.y * e.d)),
          (this._currentLocalID = this._localID),
          (this._parentID = -1)),
        this._parentID !== t._worldID)
      ) {
        const i = t.worldTransform,
          s = this.worldTransform;
        (s.a = e.a * i.a + e.b * i.c),
          (s.b = e.a * i.b + e.b * i.d),
          (s.c = e.c * i.a + e.d * i.c),
          (s.d = e.c * i.b + e.d * i.d),
          (s.tx = e.tx * i.a + e.ty * i.c + i.tx),
          (s.ty = e.tx * i.b + e.ty * i.d + i.ty),
          (this._parentID = t._worldID),
          this._worldID++;
      }
    }
    setFromMatrix(t) {
      t.decompose(this), this._localID++;
    }
    get rotation() {
      return this._rotation;
    }
    set rotation(t) {
      this._rotation !== t && ((this._rotation = t), this.updateSkew());
    }
  };
  An.IDENTITY = new An();
  let ji = An;
  var xf = `varying vec2 vTextureCoord;

uniform sampler2D uSampler;

void main(void){
   gl_FragColor *= texture2D(uSampler, vTextureCoord);
}`,
    yf = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;

varying vec2 vTextureCoord;

void main(void){
   gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
   vTextureCoord = aTextureCoord;
}
`;
  function ah(r, t, e) {
    const i = r.createShader(t);
    return r.shaderSource(i, e), r.compileShader(i), i;
  }
  function Sn(r) {
    const t = new Array(r);
    for (let e = 0; e < t.length; e++) t[e] = !1;
    return t;
  }
  function oh(r, t) {
    switch (r) {
      case "float":
        return 0;
      case "vec2":
        return new Float32Array(2 * t);
      case "vec3":
        return new Float32Array(3 * t);
      case "vec4":
        return new Float32Array(4 * t);
      case "int":
      case "uint":
      case "sampler2D":
      case "sampler2DArray":
        return 0;
      case "ivec2":
        return new Int32Array(2 * t);
      case "ivec3":
        return new Int32Array(3 * t);
      case "ivec4":
        return new Int32Array(4 * t);
      case "uvec2":
        return new Uint32Array(2 * t);
      case "uvec3":
        return new Uint32Array(3 * t);
      case "uvec4":
        return new Uint32Array(4 * t);
      case "bool":
        return !1;
      case "bvec2":
        return Sn(2 * t);
      case "bvec3":
        return Sn(3 * t);
      case "bvec4":
        return Sn(4 * t);
      case "mat2":
        return new Float32Array([1, 0, 0, 1]);
      case "mat3":
        return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      case "mat4":
        return new Float32Array([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        ]);
    }
    return null;
  }
  const Ye = [
      {
        test: (r) => r.type === "float" && r.size === 1 && !r.isArray,
        code: (r) => `
            if(uv["${r}"] !== ud["${r}"].value)
            {
                ud["${r}"].value = uv["${r}"]
                gl.uniform1f(ud["${r}"].location, uv["${r}"])
            }
            `,
      },
      {
        test: (r, t) =>
          (r.type === "sampler2D" ||
            r.type === "samplerCube" ||
            r.type === "sampler2DArray") &&
          r.size === 1 &&
          !r.isArray &&
          (t == null || t.castToBaseTexture !== void 0),
        code: (r) => `t = syncData.textureCount++;

            renderer.texture.bind(uv["${r}"], t);

            if(ud["${r}"].value !== t)
            {
                ud["${r}"].value = t;
                gl.uniform1i(ud["${r}"].location, t);
; // eslint-disable-line max-len
            }`,
      },
      {
        test: (r, t) =>
          r.type === "mat3" && r.size === 1 && !r.isArray && t.a !== void 0,
        code: (r) => `
            gl.uniformMatrix3fv(ud["${r}"].location, false, uv["${r}"].toArray(true));
            `,
        codeUbo: (r) => `
                var ${r}_matrix = uv.${r}.toArray(true);

                data[offset] = ${r}_matrix[0];
                data[offset+1] = ${r}_matrix[1];
                data[offset+2] = ${r}_matrix[2];
        
                data[offset + 4] = ${r}_matrix[3];
                data[offset + 5] = ${r}_matrix[4];
                data[offset + 6] = ${r}_matrix[5];
        
                data[offset + 8] = ${r}_matrix[6];
                data[offset + 9] = ${r}_matrix[7];
                data[offset + 10] = ${r}_matrix[8];
            `,
      },
      {
        test: (r, t) =>
          r.type === "vec2" && r.size === 1 && !r.isArray && t.x !== void 0,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v.x || cv[1] !== v.y)
                {
                    cv[0] = v.x;
                    cv[1] = v.y;
                    gl.uniform2f(ud["${r}"].location, v.x, v.y);
                }`,
        codeUbo: (r) => `
                v = uv.${r};

                data[offset] = v.x;
                data[offset+1] = v.y;
            `,
      },
      {
        test: (r) => r.type === "vec2" && r.size === 1 && !r.isArray,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v[0] || cv[1] !== v[1])
                {
                    cv[0] = v[0];
                    cv[1] = v[1];
                    gl.uniform2f(ud["${r}"].location, v[0], v[1]);
                }
            `,
      },
      {
        test: (r, t) =>
          r.type === "vec4" && r.size === 1 && !r.isArray && t.width !== void 0,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v.x || cv[1] !== v.y || cv[2] !== v.width || cv[3] !== v.height)
                {
                    cv[0] = v.x;
                    cv[1] = v.y;
                    cv[2] = v.width;
                    cv[3] = v.height;
                    gl.uniform4f(ud["${r}"].location, v.x, v.y, v.width, v.height)
                }`,
        codeUbo: (r) => `
                    v = uv.${r};

                    data[offset] = v.x;
                    data[offset+1] = v.y;
                    data[offset+2] = v.width;
                    data[offset+3] = v.height;
                `,
      },
      {
        test: (r, t) =>
          r.type === "vec4" && r.size === 1 && !r.isArray && t.red !== void 0,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v.red || cv[1] !== v.green || cv[2] !== v.blue || cv[3] !== v.alpha)
                {
                    cv[0] = v.red;
                    cv[1] = v.green;
                    cv[2] = v.blue;
                    cv[3] = v.alpha;
                    gl.uniform4f(ud["${r}"].location, v.red, v.green, v.blue, v.alpha)
                }`,
        codeUbo: (r) => `
                    v = uv.${r};

                    data[offset] = v.red;
                    data[offset+1] = v.green;
                    data[offset+2] = v.blue;
                    data[offset+3] = v.alpha;
                `,
      },
      {
        test: (r, t) =>
          r.type === "vec3" && r.size === 1 && !r.isArray && t.red !== void 0,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v.red || cv[1] !== v.green || cv[2] !== v.blue || cv[3] !== v.a)
                {
                    cv[0] = v.red;
                    cv[1] = v.green;
                    cv[2] = v.blue;
    
                    gl.uniform3f(ud["${r}"].location, v.red, v.green, v.blue)
                }`,
        codeUbo: (r) => `
                    v = uv.${r};

                    data[offset] = v.red;
                    data[offset+1] = v.green;
                    data[offset+2] = v.blue;
                `,
      },
      {
        test: (r) => r.type === "vec4" && r.size === 1 && !r.isArray,
        code: (r) => `
                cv = ud["${r}"].value;
                v = uv["${r}"];

                if(cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])
                {
                    cv[0] = v[0];
                    cv[1] = v[1];
                    cv[2] = v[2];
                    cv[3] = v[3];

                    gl.uniform4f(ud["${r}"].location, v[0], v[1], v[2], v[3])
                }`,
      },
    ],
    bf = {
      float: `
    if (cv !== v)
    {
        cu.value = v;
        gl.uniform1f(location, v);
    }`,
      vec2: `
    if (cv[0] !== v[0] || cv[1] !== v[1])
    {
        cv[0] = v[0];
        cv[1] = v[1];

        gl.uniform2f(location, v[0], v[1])
    }`,
      vec3: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];

        gl.uniform3f(location, v[0], v[1], v[2])
    }`,
      vec4: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];
        cv[3] = v[3];

        gl.uniform4f(location, v[0], v[1], v[2], v[3]);
    }`,
      int: `
    if (cv !== v)
    {
        cu.value = v;

        gl.uniform1i(location, v);
    }`,
      ivec2: `
    if (cv[0] !== v[0] || cv[1] !== v[1])
    {
        cv[0] = v[0];
        cv[1] = v[1];

        gl.uniform2i(location, v[0], v[1]);
    }`,
      ivec3: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];

        gl.uniform3i(location, v[0], v[1], v[2]);
    }`,
      ivec4: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];
        cv[3] = v[3];

        gl.uniform4i(location, v[0], v[1], v[2], v[3]);
    }`,
      uint: `
    if (cv !== v)
    {
        cu.value = v;

        gl.uniform1ui(location, v);
    }`,
      uvec2: `
    if (cv[0] !== v[0] || cv[1] !== v[1])
    {
        cv[0] = v[0];
        cv[1] = v[1];

        gl.uniform2ui(location, v[0], v[1]);
    }`,
      uvec3: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];

        gl.uniform3ui(location, v[0], v[1], v[2]);
    }`,
      uvec4: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];
        cv[3] = v[3];

        gl.uniform4ui(location, v[0], v[1], v[2], v[3]);
    }`,
      bool: `
    if (cv !== v)
    {
        cu.value = v;
        gl.uniform1i(location, v);
    }`,
      bvec2: `
    if (cv[0] != v[0] || cv[1] != v[1])
    {
        cv[0] = v[0];
        cv[1] = v[1];

        gl.uniform2i(location, v[0], v[1]);
    }`,
      bvec3: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];

        gl.uniform3i(location, v[0], v[1], v[2]);
    }`,
      bvec4: `
    if (cv[0] !== v[0] || cv[1] !== v[1] || cv[2] !== v[2] || cv[3] !== v[3])
    {
        cv[0] = v[0];
        cv[1] = v[1];
        cv[2] = v[2];
        cv[3] = v[3];

        gl.uniform4i(location, v[0], v[1], v[2], v[3]);
    }`,
      mat2: "gl.uniformMatrix2fv(location, false, v)",
      mat3: "gl.uniformMatrix3fv(location, false, v)",
      mat4: "gl.uniformMatrix4fv(location, false, v)",
      sampler2D: `
    if (cv !== v)
    {
        cu.value = v;

        gl.uniform1i(location, v);
    }`,
      samplerCube: `
    if (cv !== v)
    {
        cu.value = v;

        gl.uniform1i(location, v);
    }`,
      sampler2DArray: `
    if (cv !== v)
    {
        cu.value = v;

        gl.uniform1i(location, v);
    }`,
    },
    Ef = {
      float: "gl.uniform1fv(location, v)",
      vec2: "gl.uniform2fv(location, v)",
      vec3: "gl.uniform3fv(location, v)",
      vec4: "gl.uniform4fv(location, v)",
      mat4: "gl.uniformMatrix4fv(location, false, v)",
      mat3: "gl.uniformMatrix3fv(location, false, v)",
      mat2: "gl.uniformMatrix2fv(location, false, v)",
      int: "gl.uniform1iv(location, v)",
      ivec2: "gl.uniform2iv(location, v)",
      ivec3: "gl.uniform3iv(location, v)",
      ivec4: "gl.uniform4iv(location, v)",
      uint: "gl.uniform1uiv(location, v)",
      uvec2: "gl.uniform2uiv(location, v)",
      uvec3: "gl.uniform3uiv(location, v)",
      uvec4: "gl.uniform4uiv(location, v)",
      bool: "gl.uniform1iv(location, v)",
      bvec2: "gl.uniform2iv(location, v)",
      bvec3: "gl.uniform3iv(location, v)",
      bvec4: "gl.uniform4iv(location, v)",
      sampler2D: "gl.uniform1iv(location, v)",
      samplerCube: "gl.uniform1iv(location, v)",
      sampler2DArray: "gl.uniform1iv(location, v)",
    };
  function Tf(r, t) {
    var e;
    const i = [
      `
        var v = null;
        var cv = null;
        var cu = null;
        var t = 0;
        var gl = renderer.gl;
    `,
    ];
    for (const s in r.uniforms) {
      const n = t[s];
      if (!n) {
        ((e = r.uniforms[s]) == null ? void 0 : e.group) === !0 &&
          (r.uniforms[s].ubo
            ? i.push(`
                        renderer.shader.syncUniformBufferGroup(uv.${s}, '${s}');
                    `)
            : i.push(`
                        renderer.shader.syncUniformGroup(uv.${s}, syncData);
                    `));
        continue;
      }
      const a = r.uniforms[s];
      let o = !1;
      for (let h = 0; h < Ye.length; h++)
        if (Ye[h].test(n, a)) {
          i.push(Ye[h].code(s, a)), (o = !0);
          break;
        }
      if (!o) {
        const h = (n.size === 1 && !n.isArray ? bf : Ef)[n.type].replace(
          "location",
          `ud["${s}"].location`
        );
        i.push(`
            cu = ud["${s}"];
            cv = cu.value;
            v = uv["${s}"];
            ${h};`);
      }
    }
    return new Function(
      "ud",
      "uv",
      "renderer",
      "syncData",
      i.join(`
`)
    );
  }
  const hh = {};
  let kr = hh;
  function lh() {
    if (kr === hh || (kr != null && kr.isContextLost())) {
      const r = B.ADAPTER.createCanvas();
      let t;
      B.PREFER_ENV >= we.WEBGL2 && (t = r.getContext("webgl2", {})),
        t ||
          ((t =
            r.getContext("webgl", {}) ||
            r.getContext("experimental-webgl", {})),
          t ? t.getExtension("WEBGL_draw_buffers") : (t = null)),
        (kr = t);
    }
    return kr;
  }
  let Wi;
  function Af() {
    if (!Wi) {
      Wi = Pt.MEDIUM;
      const r = lh();
      if (r && r.getShaderPrecisionFormat) {
        const t = r.getShaderPrecisionFormat(r.FRAGMENT_SHADER, r.HIGH_FLOAT);
        t && (Wi = t.precision ? Pt.HIGH : Pt.MEDIUM);
      }
    }
    return Wi;
  }
  function uh(r, t) {
    const e = r
        .getShaderSource(t)
        .split(
          `
`
        )
        .map((l, u) => `${u}: ${l}`),
      i = r.getShaderInfoLog(t),
      s = i.split(`
`),
      n = {},
      a = s
        .map((l) => parseFloat(l.replace(/^ERROR\: 0\:([\d]+)\:.*$/, "$1")))
        .filter((l) => (l && !n[l] ? ((n[l] = !0), !0) : !1)),
      o = [""];
    a.forEach((l) => {
      (e[l - 1] = `%c${e[l - 1]}%c`),
        o.push(
          "background: #FF0000; color:#FFFFFF; font-size: 10px",
          "font-size: 10px"
        );
    });
    const h = e.join(`
`);
    (o[0] = h),
      console.error(i),
      console.groupCollapsed("click to view full shader code"),
      console.warn(...o),
      console.groupEnd();
  }
  function Sf(r, t, e, i) {
    r.getProgramParameter(t, r.LINK_STATUS) ||
      (r.getShaderParameter(e, r.COMPILE_STATUS) || uh(r, e),
      r.getShaderParameter(i, r.COMPILE_STATUS) || uh(r, i),
      console.error("PixiJS Error: Could not initialize shader."),
      r.getProgramInfoLog(t) !== "" &&
        console.warn(
          "PixiJS Warning: gl.getProgramInfoLog()",
          r.getProgramInfoLog(t)
        ));
  }
  const wf = {
    float: 1,
    vec2: 2,
    vec3: 3,
    vec4: 4,
    int: 1,
    ivec2: 2,
    ivec3: 3,
    ivec4: 4,
    uint: 1,
    uvec2: 2,
    uvec3: 3,
    uvec4: 4,
    bool: 1,
    bvec2: 2,
    bvec3: 3,
    bvec4: 4,
    mat2: 4,
    mat3: 9,
    mat4: 16,
    sampler2D: 1,
  };
  function ch(r) {
    return wf[r];
  }
  let Yi = null;
  const dh = {
    FLOAT: "float",
    FLOAT_VEC2: "vec2",
    FLOAT_VEC3: "vec3",
    FLOAT_VEC4: "vec4",
    INT: "int",
    INT_VEC2: "ivec2",
    INT_VEC3: "ivec3",
    INT_VEC4: "ivec4",
    UNSIGNED_INT: "uint",
    UNSIGNED_INT_VEC2: "uvec2",
    UNSIGNED_INT_VEC3: "uvec3",
    UNSIGNED_INT_VEC4: "uvec4",
    BOOL: "bool",
    BOOL_VEC2: "bvec2",
    BOOL_VEC3: "bvec3",
    BOOL_VEC4: "bvec4",
    FLOAT_MAT2: "mat2",
    FLOAT_MAT3: "mat3",
    FLOAT_MAT4: "mat4",
    SAMPLER_2D: "sampler2D",
    INT_SAMPLER_2D: "sampler2D",
    UNSIGNED_INT_SAMPLER_2D: "sampler2D",
    SAMPLER_CUBE: "samplerCube",
    INT_SAMPLER_CUBE: "samplerCube",
    UNSIGNED_INT_SAMPLER_CUBE: "samplerCube",
    SAMPLER_2D_ARRAY: "sampler2DArray",
    INT_SAMPLER_2D_ARRAY: "sampler2DArray",
    UNSIGNED_INT_SAMPLER_2D_ARRAY: "sampler2DArray",
  };
  function fh(r, t) {
    if (!Yi) {
      const e = Object.keys(dh);
      Yi = {};
      for (let i = 0; i < e.length; ++i) {
        const s = e[i];
        Yi[r[s]] = dh[s];
      }
    }
    return Yi[t];
  }
  function ph(r, t, e) {
    if (r.substring(0, 9) !== "precision") {
      let i = t;
      return (
        t === Pt.HIGH && e !== Pt.HIGH && (i = Pt.MEDIUM),
        `precision ${i} float;
${r}`
      );
    } else if (e !== Pt.HIGH && r.substring(0, 15) === "precision highp")
      return r.replace("precision highp", "precision mediump");
    return r;
  }
  let Gr;
  function mh() {
    if (typeof Gr == "boolean") return Gr;
    try {
      Gr =
        new Function(
          "param1",
          "param2",
          "param3",
          "return param1[param2] === param3;"
        )({ a: "b" }, "a", "b") === !0;
    } catch (r) {
      Gr = !1;
    }
    return Gr;
  }
  let Rf = 0;
  const qi = {},
    wn = class Ar {
      constructor(t, e, i = "pixi-shader", s = {}) {
        (this.extra = {}),
          (this.id = Rf++),
          (this.vertexSrc = t || Ar.defaultVertexSrc),
          (this.fragmentSrc = e || Ar.defaultFragmentSrc),
          (this.vertexSrc = this.vertexSrc.trim()),
          (this.fragmentSrc = this.fragmentSrc.trim()),
          (this.extra = s),
          this.vertexSrc.substring(0, 8) !== "#version" &&
            ((i = i.replace(/\s+/g, "-")),
            qi[i] ? (qi[i]++, (i += `-${qi[i]}`)) : (qi[i] = 1),
            (this.vertexSrc = `#define SHADER_NAME ${i}
${this.vertexSrc}`),
            (this.fragmentSrc = `#define SHADER_NAME ${i}
${this.fragmentSrc}`),
            (this.vertexSrc = ph(
              this.vertexSrc,
              Ar.defaultVertexPrecision,
              Pt.HIGH
            )),
            (this.fragmentSrc = ph(
              this.fragmentSrc,
              Ar.defaultFragmentPrecision,
              Af()
            ))),
          (this.glPrograms = {}),
          (this.syncUniforms = null);
      }
      static get defaultVertexSrc() {
        return yf;
      }
      static get defaultFragmentSrc() {
        return xf;
      }
      static from(t, e, i) {
        const s = t + e;
        let n = dn[s];
        return n || (dn[s] = n = new Ar(t, e, i)), n;
      }
    };
  (wn.defaultVertexPrecision = Pt.HIGH),
    (wn.defaultFragmentPrecision = Re.apple.device ? Pt.HIGH : Pt.MEDIUM);
  let se = wn,
    If = 0;
  class Gt {
    constructor(t, e, i) {
      (this.group = !0),
        (this.syncUniforms = {}),
        (this.dirtyId = 0),
        (this.id = If++),
        (this.static = !!e),
        (this.ubo = !!i),
        t instanceof nt
          ? ((this.buffer = t),
            (this.buffer.type = jt.UNIFORM_BUFFER),
            (this.autoManage = !1),
            (this.ubo = !0))
          : ((this.uniforms = t),
            this.ubo &&
              ((this.buffer = new nt(new Float32Array(1))),
              (this.buffer.type = jt.UNIFORM_BUFFER),
              (this.autoManage = !0)));
    }
    update() {
      this.dirtyId++, !this.autoManage && this.buffer && this.buffer.update();
    }
    add(t, e, i) {
      if (!this.ubo) this.uniforms[t] = new Gt(e, i);
      else
        throw new Error(
          "[UniformGroup] uniform groups in ubo mode cannot be modified, or have uniform groups nested in them"
        );
    }
    static from(t, e, i) {
      return new Gt(t, e, i);
    }
    static uboFrom(t, e) {
      return new Gt(t, e != null ? e : !0, !0);
    }
  }
  class Yt {
    constructor(t, e) {
      (this.uniformBindCount = 0),
        (this.program = t),
        e
          ? e instanceof Gt
            ? (this.uniformGroup = e)
            : (this.uniformGroup = new Gt(e))
          : (this.uniformGroup = new Gt({})),
        (this.disposeRunner = new Nt("disposeShader"));
    }
    checkUniformExists(t, e) {
      if (e.uniforms[t]) return !0;
      for (const i in e.uniforms) {
        const s = e.uniforms[i];
        if (s.group === !0 && this.checkUniformExists(t, s)) return !0;
      }
      return !1;
    }
    destroy() {
      (this.uniformGroup = null),
        this.disposeRunner.emit(this),
        this.disposeRunner.destroy();
    }
    get uniforms() {
      return this.uniformGroup.uniforms;
    }
    static from(t, e, i) {
      const s = se.from(t, e);
      return new Yt(s, i);
    }
  }
  class gh {
    constructor(t, e) {
      if (
        ((this.vertexSrc = t),
        (this.fragTemplate = e),
        (this.programCache = {}),
        (this.defaultGroupCache = {}),
        !e.includes("%count%"))
      )
        throw new Error('Fragment template must contain "%count%".');
      if (!e.includes("%forloop%"))
        throw new Error('Fragment template must contain "%forloop%".');
    }
    generateShader(t) {
      if (!this.programCache[t]) {
        const i = new Int32Array(t);
        for (let n = 0; n < t; n++) i[n] = n;
        this.defaultGroupCache[t] = Gt.from({ uSamplers: i }, !0);
        let s = this.fragTemplate;
        (s = s.replace(/%count%/gi, `${t}`)),
          (s = s.replace(/%forloop%/gi, this.generateSampleSrc(t))),
          (this.programCache[t] = new se(this.vertexSrc, s));
      }
      const e = {
        tint: new Float32Array([1, 1, 1, 1]),
        translationMatrix: new et(),
        default: this.defaultGroupCache[t],
      };
      return new Yt(this.programCache[t], e);
    }
    generateSampleSrc(t) {
      let e = "";
      (e += `
`),
        (e += `
`);
      for (let i = 0; i < t; i++)
        i > 0 &&
          (e += `
else `),
          i < t - 1 && (e += `if(vTextureId < ${i}.5)`),
          (e += `
{`),
          (e += `
	color = texture2D(uSamplers[${i}], vTextureCoord);`),
          (e += `
}`);
      return (
        (e += `
`),
        (e += `
`),
        e
      );
    }
  }
  class Ki {
    constructor() {
      (this.elements = []), (this.ids = []), (this.count = 0);
    }
    clear() {
      for (let t = 0; t < this.count; t++) this.elements[t] = null;
      this.count = 0;
    }
  }
  function Cf() {
    return !Re.apple.device;
  }
  function Mf(r) {
    let t = !0;
    const e = B.ADAPTER.getNavigator();
    if (Re.tablet || Re.phone) {
      if (Re.apple.device) {
        const i = e.userAgent.match(/OS (\d+)_(\d+)?/);
        i && parseInt(i[1], 10) < 11 && (t = !1);
      }
      if (Re.android.device) {
        const i = e.userAgent.match(/Android\s([0-9.]*)/);
        i && parseInt(i[1], 10) < 7 && (t = !1);
      }
    }
    return t ? r : 4;
  }
  class $r {
    constructor(t) {
      this.renderer = t;
    }
    flush() {}
    destroy() {
      this.renderer = null;
    }
    start() {}
    stop() {
      this.flush();
    }
    render(t) {}
  }
  var Pf = `varying vec2 vTextureCoord;
varying vec4 vColor;
varying float vTextureId;
uniform sampler2D uSamplers[%count%];

void main(void){
    vec4 color;
    %forloop%
    gl_FragColor = color * vColor;
}
`,
    Df = `precision highp float;
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
attribute vec4 aColor;
attribute float aTextureId;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform vec4 tint;

varying vec2 vTextureCoord;
varying vec4 vColor;
varying float vTextureId;

void main(void){
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = aTextureCoord;
    vTextureId = aTextureId;
    vColor = aColor * tint;
}
`;
  const Hr = class Zt extends $r {
    constructor(t) {
      super(t),
        this.setShaderGenerator(),
        (this.geometryClass = En),
        (this.vertexSize = 6),
        (this.state = ie.for2d()),
        (this.size = Zt.defaultBatchSize * 4),
        (this._vertexCount = 0),
        (this._indexCount = 0),
        (this._bufferedElements = []),
        (this._bufferedTextures = []),
        (this._bufferSize = 0),
        (this._shader = null),
        (this._packedGeometries = []),
        (this._packedGeometryPoolSize = 2),
        (this._flushId = 0),
        (this._aBuffers = {}),
        (this._iBuffers = {}),
        (this.maxTextures = 1),
        this.renderer.on("prerender", this.onPrerender, this),
        t.runners.contextChange.add(this),
        (this._dcIndex = 0),
        (this._aIndex = 0),
        (this._iIndex = 0),
        (this._attributeBuffer = null),
        (this._indexBuffer = null),
        (this._tempBoundTextures = []);
    }
    static get defaultMaxTextures() {
      var t;
      return (
        (this._defaultMaxTextures =
          (t = this._defaultMaxTextures) != null ? t : Mf(32)),
        this._defaultMaxTextures
      );
    }
    static set defaultMaxTextures(t) {
      this._defaultMaxTextures = t;
    }
    static get canUploadSameBuffer() {
      var t;
      return (
        (this._canUploadSameBuffer =
          (t = this._canUploadSameBuffer) != null ? t : Cf()),
        this._canUploadSameBuffer
      );
    }
    static set canUploadSameBuffer(t) {
      this._canUploadSameBuffer = t;
    }
    get MAX_TEXTURES() {
      return this.maxTextures;
    }
    static get defaultVertexSrc() {
      return Df;
    }
    static get defaultFragmentTemplate() {
      return Pf;
    }
    setShaderGenerator({
      vertex: t = Zt.defaultVertexSrc,
      fragment: e = Zt.defaultFragmentTemplate,
    } = {}) {
      this.shaderGenerator = new gh(t, e);
    }
    contextChange() {
      const t = this.renderer.gl;
      B.PREFER_ENV === we.WEBGL_LEGACY
        ? (this.maxTextures = 1)
        : ((this.maxTextures = Math.min(
            t.getParameter(t.MAX_TEXTURE_IMAGE_UNITS),
            Zt.defaultMaxTextures
          )),
          (this.maxTextures = Jo(this.maxTextures, t))),
        (this._shader = this.shaderGenerator.generateShader(this.maxTextures));
      for (let e = 0; e < this._packedGeometryPoolSize; e++)
        this._packedGeometries[e] = new this.geometryClass();
      this.initFlushBuffers();
    }
    initFlushBuffers() {
      const { _drawCallPool: t, _textureArrayPool: e } = Zt,
        i = this.size / 4,
        s = Math.floor(i / this.maxTextures) + 1;
      for (; t.length < i; ) t.push(new Gi());
      for (; e.length < s; ) e.push(new Ki());
      for (let n = 0; n < this.maxTextures; n++)
        this._tempBoundTextures[n] = null;
    }
    onPrerender() {
      this._flushId = 0;
    }
    render(t) {
      t._texture.valid &&
        (this._vertexCount + t.vertexData.length / 2 > this.size &&
          this.flush(),
        (this._vertexCount += t.vertexData.length / 2),
        (this._indexCount += t.indices.length),
        (this._bufferedTextures[this._bufferSize] = t._texture.baseTexture),
        (this._bufferedElements[this._bufferSize++] = t));
    }
    buildTexturesAndDrawCalls() {
      const { _bufferedTextures: t, maxTextures: e } = this,
        i = Zt._textureArrayPool,
        s = this.renderer.batch,
        n = this._tempBoundTextures,
        a = this.renderer.textureGC.count;
      let o = ++j._globalBatch,
        h = 0,
        l = i[0],
        u = 0;
      s.copyBoundTextures(n, e);
      for (let c = 0; c < this._bufferSize; ++c) {
        const d = t[c];
        (t[c] = null),
          d._batchEnabled !== o &&
            (l.count >= e &&
              (s.boundArray(l, n, o, e),
              this.buildDrawCalls(l, u, c),
              (u = c),
              (l = i[++h]),
              ++o),
            (d._batchEnabled = o),
            (d.touched = a),
            (l.elements[l.count++] = d));
      }
      l.count > 0 &&
        (s.boundArray(l, n, o, e),
        this.buildDrawCalls(l, u, this._bufferSize),
        ++h,
        ++o);
      for (let c = 0; c < n.length; c++) n[c] = null;
      j._globalBatch = o;
    }
    buildDrawCalls(t, e, i) {
      const {
          _bufferedElements: s,
          _attributeBuffer: n,
          _indexBuffer: a,
          vertexSize: o,
        } = this,
        h = Zt._drawCallPool;
      let l = this._dcIndex,
        u = this._aIndex,
        c = this._iIndex,
        d = h[l];
      (d.start = this._iIndex), (d.texArray = t);
      for (let f = e; f < i; ++f) {
        const p = s[f],
          m = p._texture.baseTexture,
          g = an[m.alphaMode ? 1 : 0][p.blendMode];
        (s[f] = null),
          e < f &&
            d.blend !== g &&
            ((d.size = c - d.start),
            (e = f),
            (d = h[++l]),
            (d.texArray = t),
            (d.start = c)),
          this.packInterleavedGeometry(p, n, a, u, c),
          (u += (p.vertexData.length / 2) * o),
          (c += p.indices.length),
          (d.blend = g);
      }
      e < i && ((d.size = c - d.start), ++l),
        (this._dcIndex = l),
        (this._aIndex = u),
        (this._iIndex = c);
    }
    bindAndClearTexArray(t) {
      const e = this.renderer.texture;
      for (let i = 0; i < t.count; i++)
        e.bind(t.elements[i], t.ids[i]), (t.elements[i] = null);
      t.count = 0;
    }
    updateGeometry() {
      const {
        _packedGeometries: t,
        _attributeBuffer: e,
        _indexBuffer: i,
      } = this;
      Zt.canUploadSameBuffer
        ? (t[this._flushId]._buffer.update(e.rawBinaryData),
          t[this._flushId]._indexBuffer.update(i),
          this.renderer.geometry.updateBuffers())
        : (this._packedGeometryPoolSize <= this._flushId &&
            (this._packedGeometryPoolSize++,
            (t[this._flushId] = new this.geometryClass())),
          t[this._flushId]._buffer.update(e.rawBinaryData),
          t[this._flushId]._indexBuffer.update(i),
          this.renderer.geometry.bind(t[this._flushId]),
          this.renderer.geometry.updateBuffers(),
          this._flushId++);
    }
    drawBatches() {
      const t = this._dcIndex,
        { gl: e, state: i } = this.renderer,
        s = Zt._drawCallPool;
      let n = null;
      for (let a = 0; a < t; a++) {
        const { texArray: o, type: h, size: l, start: u, blend: c } = s[a];
        n !== o && ((n = o), this.bindAndClearTexArray(o)),
          (this.state.blendMode = c),
          i.set(this.state),
          e.drawElements(h, l, e.UNSIGNED_SHORT, u * 2);
      }
    }
    flush() {
      this._vertexCount !== 0 &&
        ((this._attributeBuffer = this.getAttributeBuffer(this._vertexCount)),
        (this._indexBuffer = this.getIndexBuffer(this._indexCount)),
        (this._aIndex = 0),
        (this._iIndex = 0),
        (this._dcIndex = 0),
        this.buildTexturesAndDrawCalls(),
        this.updateGeometry(),
        this.drawBatches(),
        (this._bufferSize = 0),
        (this._vertexCount = 0),
        (this._indexCount = 0));
    }
    start() {
      this.renderer.state.set(this.state),
        this.renderer.texture.ensureSamplerType(this.maxTextures),
        this.renderer.shader.bind(this._shader),
        Zt.canUploadSameBuffer &&
          this.renderer.geometry.bind(this._packedGeometries[this._flushId]);
    }
    stop() {
      this.flush();
    }
    destroy() {
      for (let t = 0; t < this._packedGeometryPoolSize; t++)
        this._packedGeometries[t] && this._packedGeometries[t].destroy();
      this.renderer.off("prerender", this.onPrerender, this),
        (this._aBuffers = null),
        (this._iBuffers = null),
        (this._packedGeometries = null),
        (this._attributeBuffer = null),
        (this._indexBuffer = null),
        this._shader && (this._shader.destroy(), (this._shader = null)),
        super.destroy();
    }
    getAttributeBuffer(t) {
      const e = Br(Math.ceil(t / 8)),
        i = ln(e),
        s = e * 8;
      this._aBuffers.length <= i && (this._iBuffers.length = i + 1);
      let n = this._aBuffers[s];
      return n || (this._aBuffers[s] = n = new Ui(s * this.vertexSize * 4)), n;
    }
    getIndexBuffer(t) {
      const e = Br(Math.ceil(t / 12)),
        i = ln(e),
        s = e * 12;
      this._iBuffers.length <= i && (this._iBuffers.length = i + 1);
      let n = this._iBuffers[i];
      return n || (this._iBuffers[i] = n = new Uint16Array(s)), n;
    }
    packInterleavedGeometry(t, e, i, s, n) {
      const { uint32View: a, float32View: o } = e,
        h = s / this.vertexSize,
        l = t.uvs,
        u = t.indices,
        c = t.vertexData,
        d = t._texture.baseTexture._batchLocation,
        f = Math.min(t.worldAlpha, 1),
        p = K.shared
          .setValue(t._tintRGB)
          .toPremultiplied(f, t._texture.baseTexture.alphaMode > 0);
      for (let m = 0; m < c.length; m += 2)
        (o[s++] = c[m]),
          (o[s++] = c[m + 1]),
          (o[s++] = l[m]),
          (o[s++] = l[m + 1]),
          (a[s++] = p),
          (o[s++] = d);
      for (let m = 0; m < u.length; m++) i[n++] = h + u[m];
    }
  };
  (Hr.defaultBatchSize = 4096),
    (Hr.extension = { name: "batch", type: D.RendererPlugin }),
    (Hr._drawCallPool = []),
    (Hr._textureArrayPool = []);
  let Ce = Hr;
  U.add(Ce);
  var Nf = `varying vec2 vTextureCoord;

uniform sampler2D uSampler;

void main(void){
   gl_FragColor = texture2D(uSampler, vTextureCoord);
}
`,
    Of = `attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;

varying vec2 vTextureCoord;

uniform vec4 inputSize;
uniform vec4 outputFrame;

vec4 filterVertexPosition( void )
{
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;

    return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aVertexPosition * (outputFrame.zw * inputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;
  const Rn = class bi extends Yt {
    constructor(t, e, i) {
      const s = se.from(t || bi.defaultVertexSrc, e || bi.defaultFragmentSrc);
      super(s, i),
        (this.padding = 0),
        (this.resolution = bi.defaultResolution),
        (this.multisample = bi.defaultMultisample),
        (this.enabled = !0),
        (this.autoFit = !0),
        (this.state = new ie());
    }
    apply(t, e, i, s, n) {
      t.applyFilter(this, e, i, s);
    }
    get blendMode() {
      return this.state.blendMode;
    }
    set blendMode(t) {
      this.state.blendMode = t;
    }
    get resolution() {
      return this._resolution;
    }
    set resolution(t) {
      this._resolution = t;
    }
    static get defaultVertexSrc() {
      return Of;
    }
    static get defaultFragmentSrc() {
      return Nf;
    }
  };
  (Rn.defaultResolution = 1), (Rn.defaultMultisample = ot.NONE);
  let Et = Rn;
  class Vr {
    constructor() {
      (this.clearBeforeRender = !0),
        (this._backgroundColor = new K(0)),
        (this.alpha = 1);
    }
    init(t) {
      this.clearBeforeRender = t.clearBeforeRender;
      const { backgroundColor: e, background: i, backgroundAlpha: s } = t,
        n = i != null ? i : e;
      n !== void 0 && (this.color = n), (this.alpha = s);
    }
    get color() {
      return this._backgroundColor.value;
    }
    set color(t) {
      this._backgroundColor.setValue(t);
    }
    get alpha() {
      return this._backgroundColor.alpha;
    }
    set alpha(t) {
      this._backgroundColor.setAlpha(t);
    }
    get backgroundColor() {
      return this._backgroundColor;
    }
    destroy() {}
  }
  (Vr.defaultOptions = {
    backgroundAlpha: 1,
    backgroundColor: 0,
    clearBeforeRender: !0,
  }),
    (Vr.extension = {
      type: [D.RendererSystem, D.CanvasRendererSystem],
      name: "background",
    }),
    U.add(Vr);
  class In {
    constructor(t) {
      (this.renderer = t),
        (this.emptyRenderer = new $r(t)),
        (this.currentRenderer = this.emptyRenderer);
    }
    setObjectRenderer(t) {
      this.currentRenderer !== t &&
        (this.currentRenderer.stop(),
        (this.currentRenderer = t),
        this.currentRenderer.start());
    }
    flush() {
      this.setObjectRenderer(this.emptyRenderer);
    }
    reset() {
      this.setObjectRenderer(this.emptyRenderer);
    }
    copyBoundTextures(t, e) {
      const { boundTextures: i } = this.renderer.texture;
      for (let s = e - 1; s >= 0; --s)
        (t[s] = i[s] || null), t[s] && (t[s]._batchLocation = s);
    }
    boundArray(t, e, i, s) {
      const { elements: n, ids: a, count: o } = t;
      let h = 0;
      for (let l = 0; l < o; l++) {
        const u = n[l],
          c = u._batchLocation;
        if (c >= 0 && c < s && e[c] === u) {
          a[l] = c;
          continue;
        }
        for (; h < s; ) {
          const d = e[h];
          if (d && d._batchEnabled === i && d._batchLocation === h) {
            h++;
            continue;
          }
          (a[l] = h), (u._batchLocation = h), (e[h] = u);
          break;
        }
      }
    }
    destroy() {
      this.renderer = null;
    }
  }
  (In.extension = { type: D.RendererSystem, name: "batch" }), U.add(In);
  let _h = 0;
  class Xr {
    constructor(t) {
      (this.renderer = t),
        (this.webGLVersion = 1),
        (this.extensions = {}),
        (this.supports = { uint32Indices: !1 }),
        (this.handleContextLost = this.handleContextLost.bind(this)),
        (this.handleContextRestored = this.handleContextRestored.bind(this));
    }
    get isLost() {
      return !this.gl || this.gl.isContextLost();
    }
    contextChange(t) {
      (this.gl = t), (this.renderer.gl = t), (this.renderer.CONTEXT_UID = _h++);
    }
    init(t) {
      if (t.context) this.initFromContext(t.context);
      else {
        const e = this.renderer.background.alpha < 1,
          i = t.premultipliedAlpha;
        (this.preserveDrawingBuffer = t.preserveDrawingBuffer),
          (this.useContextAlpha = t.useContextAlpha),
          (this.powerPreference = t.powerPreference),
          this.initFromOptions({
            alpha: e,
            premultipliedAlpha: i,
            antialias: t.antialias,
            stencil: !0,
            preserveDrawingBuffer: t.preserveDrawingBuffer,
            powerPreference: t.powerPreference,
          });
      }
    }
    initFromContext(t) {
      (this.gl = t),
        this.validateContext(t),
        (this.renderer.gl = t),
        (this.renderer.CONTEXT_UID = _h++),
        this.renderer.runners.contextChange.emit(t);
      const e = this.renderer.view;
      e.addEventListener !== void 0 &&
        (e.addEventListener("webglcontextlost", this.handleContextLost, !1),
        e.addEventListener(
          "webglcontextrestored",
          this.handleContextRestored,
          !1
        ));
    }
    initFromOptions(t) {
      const e = this.createContext(this.renderer.view, t);
      this.initFromContext(e);
    }
    createContext(t, e) {
      let i;
      if ((B.PREFER_ENV >= we.WEBGL2 && (i = t.getContext("webgl2", e)), i))
        this.webGLVersion = 2;
      else if (
        ((this.webGLVersion = 1),
        (i = t.getContext("webgl", e) || t.getContext("experimental-webgl", e)),
        !i)
      )
        throw new Error(
          "This browser does not support WebGL. Try using the canvas renderer"
        );
      return (this.gl = i), this.getExtensions(), this.gl;
    }
    getExtensions() {
      const { gl: t } = this,
        e = {
          loseContext: t.getExtension("WEBGL_lose_context"),
          anisotropicFiltering: t.getExtension(
            "EXT_texture_filter_anisotropic"
          ),
          floatTextureLinear: t.getExtension("OES_texture_float_linear"),
          s3tc: t.getExtension("WEBGL_compressed_texture_s3tc"),
          s3tc_sRGB: t.getExtension("WEBGL_compressed_texture_s3tc_srgb"),
          etc: t.getExtension("WEBGL_compressed_texture_etc"),
          etc1: t.getExtension("WEBGL_compressed_texture_etc1"),
          pvrtc:
            t.getExtension("WEBGL_compressed_texture_pvrtc") ||
            t.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),
          atc: t.getExtension("WEBGL_compressed_texture_atc"),
          astc: t.getExtension("WEBGL_compressed_texture_astc"),
          bptc: t.getExtension("EXT_texture_compression_bptc"),
        };
      this.webGLVersion === 1
        ? Object.assign(this.extensions, e, {
            drawBuffers: t.getExtension("WEBGL_draw_buffers"),
            depthTexture: t.getExtension("WEBGL_depth_texture"),
            vertexArrayObject:
              t.getExtension("OES_vertex_array_object") ||
              t.getExtension("MOZ_OES_vertex_array_object") ||
              t.getExtension("WEBKIT_OES_vertex_array_object"),
            uint32ElementIndex: t.getExtension("OES_element_index_uint"),
            floatTexture: t.getExtension("OES_texture_float"),
            floatTextureLinear: t.getExtension("OES_texture_float_linear"),
            textureHalfFloat: t.getExtension("OES_texture_half_float"),
            textureHalfFloatLinear: t.getExtension(
              "OES_texture_half_float_linear"
            ),
          })
        : this.webGLVersion === 2 &&
          Object.assign(this.extensions, e, {
            colorBufferFloat: t.getExtension("EXT_color_buffer_float"),
          });
    }
    handleContextLost(t) {
      t.preventDefault(),
        setTimeout(() => {
          this.gl.isContextLost() &&
            this.extensions.loseContext &&
            this.extensions.loseContext.restoreContext();
        }, 0);
    }
    handleContextRestored() {
      this.renderer.runners.contextChange.emit(this.gl);
    }
    destroy() {
      const t = this.renderer.view;
      (this.renderer = null),
        t.removeEventListener !== void 0 &&
          (t.removeEventListener("webglcontextlost", this.handleContextLost),
          t.removeEventListener(
            "webglcontextrestored",
            this.handleContextRestored
          )),
        this.gl.useProgram(null),
        this.extensions.loseContext &&
          this.extensions.loseContext.loseContext();
    }
    postrender() {
      this.renderer.objectRenderer.renderingToScreen && this.gl.flush();
    }
    validateContext(t) {
      const e = t.getContextAttributes(),
        i =
          "WebGL2RenderingContext" in globalThis &&
          t instanceof globalThis.WebGL2RenderingContext;
      i && (this.webGLVersion = 2),
        e &&
          !e.stencil &&
          console.warn(
            "Provided WebGL context does not have a stencil buffer, masks may not render correctly"
          );
      const s = i || !!t.getExtension("OES_element_index_uint");
      (this.supports.uint32Indices = s),
        s ||
          console.warn(
            "Provided WebGL context does not support 32 index buffer, complex graphics may not render correctly"
          );
    }
  }
  (Xr.defaultOptions = {
    context: null,
    antialias: !1,
    premultipliedAlpha: !0,
    preserveDrawingBuffer: !1,
    powerPreference: "default",
  }),
    (Xr.extension = { type: D.RendererSystem, name: "context" }),
    U.add(Xr);
  class Zi {
    constructor(t, e) {
      if (
        ((this.width = Math.round(t)),
        (this.height = Math.round(e)),
        !this.width || !this.height)
      )
        throw new Error("Framebuffer width or height is zero");
      (this.stencil = !1),
        (this.depth = !1),
        (this.dirtyId = 0),
        (this.dirtyFormat = 0),
        (this.dirtySize = 0),
        (this.depthTexture = null),
        (this.colorTextures = []),
        (this.glFramebuffers = {}),
        (this.disposeRunner = new Nt("disposeFramebuffer")),
        (this.multisample = ot.NONE);
    }
    get colorTexture() {
      return this.colorTextures[0];
    }
    addColorTexture(t = 0, e) {
      return (
        (this.colorTextures[t] =
          e ||
          new j(null, {
            scaleMode: Qt.NEAREST,
            resolution: 1,
            mipmap: Xt.OFF,
            width: this.width,
            height: this.height,
          })),
        this.dirtyId++,
        this.dirtyFormat++,
        this
      );
    }
    addDepthTexture(t) {
      return (
        (this.depthTexture =
          t ||
          new j(null, {
            scaleMode: Qt.NEAREST,
            resolution: 1,
            width: this.width,
            height: this.height,
            mipmap: Xt.OFF,
            format: A.DEPTH_COMPONENT,
            type: H.UNSIGNED_SHORT,
          })),
        this.dirtyId++,
        this.dirtyFormat++,
        this
      );
    }
    enableDepth() {
      return (this.depth = !0), this.dirtyId++, this.dirtyFormat++, this;
    }
    enableStencil() {
      return (this.stencil = !0), this.dirtyId++, this.dirtyFormat++, this;
    }
    resize(t, e) {
      if (((t = Math.round(t)), (e = Math.round(e)), !t || !e))
        throw new Error("Framebuffer width and height must not be zero");
      if (!(t === this.width && e === this.height)) {
        (this.width = t), (this.height = e), this.dirtyId++, this.dirtySize++;
        for (let i = 0; i < this.colorTextures.length; i++) {
          const s = this.colorTextures[i],
            n = s.resolution;
          s.setSize(t / n, e / n);
        }
        if (this.depthTexture) {
          const i = this.depthTexture.resolution;
          this.depthTexture.setSize(t / i, e / i);
        }
      }
    }
    dispose() {
      this.disposeRunner.emit(this, !1);
    }
    destroyDepthTexture() {
      this.depthTexture &&
        (this.depthTexture.destroy(),
        (this.depthTexture = null),
        ++this.dirtyId,
        ++this.dirtyFormat);
    }
  }
  class Cn extends j {
    constructor(t = {}) {
      var e, i, s;
      if (typeof t == "number") {
        const n = arguments[0],
          a = arguments[1],
          o = arguments[2],
          h = arguments[3];
        t = { width: n, height: a, scaleMode: o, resolution: h };
      }
      (t.width = (e = t.width) != null ? e : 100),
        (t.height = (i = t.height) != null ? i : 100),
        (s = t.multisample) != null || (t.multisample = ot.NONE),
        super(null, t),
        (this.mipmap = Xt.OFF),
        (this.valid = !0),
        (this._clear = new K([0, 0, 0, 0])),
        (this.framebuffer = new Zi(
          this.realWidth,
          this.realHeight
        ).addColorTexture(0, this)),
        (this.framebuffer.multisample = t.multisample),
        (this.maskStack = []),
        (this.filterStack = [{}]);
    }
    set clearColor(t) {
      this._clear.setValue(t);
    }
    get clearColor() {
      return this._clear.value;
    }
    get clear() {
      return this._clear;
    }
    get multisample() {
      return this.framebuffer.multisample;
    }
    set multisample(t) {
      this.framebuffer.multisample = t;
    }
    resize(t, e) {
      this.framebuffer.resize(t * this.resolution, e * this.resolution),
        this.setRealSize(this.framebuffer.width, this.framebuffer.height);
    }
    dispose() {
      this.framebuffer.dispose(), super.dispose();
    }
    destroy() {
      super.destroy(),
        this.framebuffer.destroyDepthTexture(),
        (this.framebuffer = null);
    }
  }
  class ne extends ar {
    constructor(t) {
      const e = t,
        i = e.naturalWidth || e.videoWidth || e.displayWidth || e.width,
        s = e.naturalHeight || e.videoHeight || e.displayHeight || e.height;
      super(i, s), (this.source = t), (this.noSubImage = !1);
    }
    static crossOrigin(t, e, i) {
      i === void 0 && !e.startsWith("data:")
        ? (t.crossOrigin = Yo(e))
        : i !== !1 && (t.crossOrigin = typeof i == "string" ? i : "anonymous");
    }
    upload(t, e, i, s) {
      const n = t.gl,
        a = e.realWidth,
        o = e.realHeight;
      if (
        ((s = s || this.source),
        typeof HTMLImageElement != "undefined" && s instanceof HTMLImageElement)
      ) {
        if (!s.complete || s.naturalWidth === 0) return !1;
      } else if (
        typeof HTMLVideoElement != "undefined" &&
        s instanceof HTMLVideoElement &&
        s.readyState <= 1
      )
        return !1;
      return (
        n.pixelStorei(
          n.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
          e.alphaMode === wt.UNPACK
        ),
        !this.noSubImage &&
        e.target === n.TEXTURE_2D &&
        i.width === a &&
        i.height === o
          ? n.texSubImage2D(n.TEXTURE_2D, 0, 0, 0, e.format, i.type, s)
          : ((i.width = a),
            (i.height = o),
            n.texImage2D(e.target, 0, i.internalFormat, e.format, i.type, s)),
        !0
      );
    }
    update() {
      if (this.destroyed) return;
      const t = this.source,
        e = t.naturalWidth || t.videoWidth || t.width,
        i = t.naturalHeight || t.videoHeight || t.height;
      this.resize(e, i), super.update();
    }
    dispose() {
      this.source = null;
    }
  }
  class Mn extends ne {
    constructor(t, e) {
      var i;
      if (((e = e || {}), typeof t == "string")) {
        const s = new Image();
        ne.crossOrigin(s, t, e.crossorigin), (s.src = t), (t = s);
      }
      super(t),
        !t.complete &&
          this._width &&
          this._height &&
          ((this._width = 0), (this._height = 0)),
        (this.url = t.src),
        (this._process = null),
        (this.preserveBitmap = !1),
        (this.createBitmap =
          ((i = e.createBitmap) != null ? i : B.CREATE_IMAGE_BITMAP) &&
          !!globalThis.createImageBitmap),
        (this.alphaMode = typeof e.alphaMode == "number" ? e.alphaMode : null),
        (this.bitmap = null),
        (this._load = null),
        e.autoLoad !== !1 && this.load();
    }
    load(t) {
      return this._load
        ? this._load
        : (t !== void 0 && (this.createBitmap = t),
          (this._load = new Promise((e, i) => {
            const s = this.source;
            this.url = s.src;
            const n = () => {
              this.destroyed ||
                ((s.onload = null),
                (s.onerror = null),
                this.update(),
                (this._load = null),
                this.createBitmap ? e(this.process()) : e(this));
            };
            s.complete && s.src
              ? n()
              : ((s.onload = n),
                (s.onerror = (a) => {
                  i(a), this.onError.emit(a);
                }));
          })),
          this._load);
    }
    process() {
      const t = this.source;
      if (this._process !== null) return this._process;
      if (this.bitmap !== null || !globalThis.createImageBitmap)
        return Promise.resolve(this);
      const e = globalThis.createImageBitmap,
        i = !t.crossOrigin || t.crossOrigin === "anonymous";
      return (
        (this._process = fetch(t.src, { mode: i ? "cors" : "no-cors" })
          .then((s) => s.blob())
          .then((s) =>
            e(s, 0, 0, t.width, t.height, {
              premultiplyAlpha:
                this.alphaMode === null || this.alphaMode === wt.UNPACK
                  ? "premultiply"
                  : "none",
            })
          )
          .then((s) =>
            this.destroyed
              ? Promise.reject()
              : ((this.bitmap = s),
                this.update(),
                (this._process = null),
                Promise.resolve(this))
          )),
        this._process
      );
    }
    upload(t, e, i) {
      if (
        (typeof this.alphaMode == "number" && (e.alphaMode = this.alphaMode),
        !this.createBitmap)
      )
        return super.upload(t, e, i);
      if (!this.bitmap && (this.process(), !this.bitmap)) return !1;
      if ((super.upload(t, e, i, this.bitmap), !this.preserveBitmap)) {
        let s = !0;
        const n = e._glTextures;
        for (const a in n) {
          const o = n[a];
          if (o !== i && o.dirtyId !== e.dirtyId) {
            s = !1;
            break;
          }
        }
        s && (this.bitmap.close && this.bitmap.close(), (this.bitmap = null));
      }
      return !0;
    }
    dispose() {
      (this.source.onload = null),
        (this.source.onerror = null),
        super.dispose(),
        this.bitmap && (this.bitmap.close(), (this.bitmap = null)),
        (this._process = null),
        (this._load = null);
    }
    static test(t) {
      return (
        typeof HTMLImageElement != "undefined" &&
        (typeof t == "string" || t instanceof HTMLImageElement)
      );
    }
  }
  class Pn {
    constructor() {
      (this.x0 = 0),
        (this.y0 = 0),
        (this.x1 = 1),
        (this.y1 = 0),
        (this.x2 = 1),
        (this.y2 = 1),
        (this.x3 = 0),
        (this.y3 = 1),
        (this.uvsFloat32 = new Float32Array(8));
    }
    set(t, e, i) {
      const s = e.width,
        n = e.height;
      if (i) {
        const a = t.width / 2 / s,
          o = t.height / 2 / n,
          h = t.x / s + a,
          l = t.y / n + o;
        (i = rt.add(i, rt.NW)),
          (this.x0 = h + a * rt.uX(i)),
          (this.y0 = l + o * rt.uY(i)),
          (i = rt.add(i, 2)),
          (this.x1 = h + a * rt.uX(i)),
          (this.y1 = l + o * rt.uY(i)),
          (i = rt.add(i, 2)),
          (this.x2 = h + a * rt.uX(i)),
          (this.y2 = l + o * rt.uY(i)),
          (i = rt.add(i, 2)),
          (this.x3 = h + a * rt.uX(i)),
          (this.y3 = l + o * rt.uY(i));
      } else
        (this.x0 = t.x / s),
          (this.y0 = t.y / n),
          (this.x1 = (t.x + t.width) / s),
          (this.y1 = t.y / n),
          (this.x2 = (t.x + t.width) / s),
          (this.y2 = (t.y + t.height) / n),
          (this.x3 = t.x / s),
          (this.y3 = (t.y + t.height) / n);
      (this.uvsFloat32[0] = this.x0),
        (this.uvsFloat32[1] = this.y0),
        (this.uvsFloat32[2] = this.x1),
        (this.uvsFloat32[3] = this.y1),
        (this.uvsFloat32[4] = this.x2),
        (this.uvsFloat32[5] = this.y2),
        (this.uvsFloat32[6] = this.x3),
        (this.uvsFloat32[7] = this.y3);
    }
  }
  const vh = new Pn();
  function Qi(r) {
    (r.destroy = function () {}),
      (r.on = function () {}),
      (r.once = function () {}),
      (r.emit = function () {});
  }
  class O extends Sr {
    constructor(t, e, i, s, n, a, o) {
      if (
        (super(),
        (this.noFrame = !1),
        e || ((this.noFrame = !0), (e = new Y(0, 0, 1, 1))),
        t instanceof O && (t = t.baseTexture),
        (this.baseTexture = t),
        (this._frame = e),
        (this.trim = s),
        (this.valid = !1),
        (this.destroyed = !1),
        (this._uvs = vh),
        (this.uvMatrix = null),
        (this.orig = i || e),
        (this._rotate = Number(n || 0)),
        n === !0)
      )
        this._rotate = 2;
      else if (this._rotate % 2 !== 0)
        throw new Error(
          "attempt to use diamond-shaped UVs. If you are sure, set rotation manually"
        );
      (this.defaultAnchor = a ? new tt(a.x, a.y) : new tt(0, 0)),
        (this.defaultBorders = o),
        (this._updateID = 0),
        (this.textureCacheIds = []),
        t.valid
          ? this.noFrame
            ? t.valid && this.onBaseTextureUpdated(t)
            : (this.frame = e)
          : t.once("loaded", this.onBaseTextureUpdated, this),
        this.noFrame && t.on("update", this.onBaseTextureUpdated, this);
    }
    update() {
      this.baseTexture.resource && this.baseTexture.resource.update();
    }
    onBaseTextureUpdated(t) {
      if (this.noFrame) {
        if (!this.baseTexture.valid) return;
        (this._frame.width = t.width),
          (this._frame.height = t.height),
          (this.valid = !0),
          this.updateUvs();
      } else this.frame = this._frame;
      this.emit("update", this);
    }
    destroy(t) {
      if (this.baseTexture) {
        if (t) {
          const { resource: e } = this.baseTexture;
          e != null && e.url && Rt[e.url] && O.removeFromCache(e.url),
            this.baseTexture.destroy();
        }
        this.baseTexture.off("loaded", this.onBaseTextureUpdated, this),
          this.baseTexture.off("update", this.onBaseTextureUpdated, this),
          (this.baseTexture = null);
      }
      (this._frame = null),
        (this._uvs = null),
        (this.trim = null),
        (this.orig = null),
        (this.valid = !1),
        O.removeFromCache(this),
        (this.textureCacheIds = null),
        (this.destroyed = !0),
        this.emit("destroyed", this),
        this.removeAllListeners();
    }
    clone() {
      var t;
      const e = this._frame.clone(),
        i = this._frame === this.orig ? e : this.orig.clone(),
        s = new O(
          this.baseTexture,
          !this.noFrame && e,
          i,
          (t = this.trim) == null ? void 0 : t.clone(),
          this.rotate,
          this.defaultAnchor,
          this.defaultBorders
        );
      return this.noFrame && (s._frame = e), s;
    }
    updateUvs() {
      this._uvs === vh && (this._uvs = new Pn()),
        this._uvs.set(this._frame, this.baseTexture, this.rotate),
        this._updateID++;
    }
    static from(t, e = {}, i = B.STRICT_TEXTURE_CACHE) {
      const s = typeof t == "string";
      let n = null;
      if (s) n = t;
      else if (t instanceof j) {
        if (!t.cacheId) {
          const o = (e == null ? void 0 : e.pixiIdPrefix) || "pixiid";
          (t.cacheId = `${o}-${Ie()}`), j.addToCache(t, t.cacheId);
        }
        n = t.cacheId;
      } else {
        if (!t._pixiId) {
          const o = (e == null ? void 0 : e.pixiIdPrefix) || "pixiid";
          t._pixiId = `${o}_${Ie()}`;
        }
        n = t._pixiId;
      }
      let a = Rt[n];
      if (s && i && !a)
        throw new Error(`The cacheId "${n}" does not exist in TextureCache.`);
      return (
        !a && !(t instanceof j)
          ? (e.resolution || (e.resolution = re(t)),
            (a = new O(new j(t, e))),
            (a.baseTexture.cacheId = n),
            j.addToCache(a.baseTexture, n),
            O.addToCache(a, n))
          : !a && t instanceof j && ((a = new O(t)), O.addToCache(a, n)),
        a
      );
    }
    static fromURL(t, e) {
      const i = Object.assign(
          { autoLoad: !1 },
          e == null ? void 0 : e.resourceOptions
        ),
        s = O.from(t, Object.assign({ resourceOptions: i }, e), !1),
        n = s.baseTexture.resource;
      return s.baseTexture.valid
        ? Promise.resolve(s)
        : n.load().then(() => Promise.resolve(s));
    }
    static fromBuffer(t, e, i, s) {
      return new O(j.fromBuffer(t, e, i, s));
    }
    static fromLoader(t, e, i, s) {
      const n = new j(
          t,
          Object.assign(
            { scaleMode: j.defaultOptions.scaleMode, resolution: re(e) },
            s
          )
        ),
        { resource: a } = n;
      a instanceof Mn && (a.url = e);
      const o = new O(n);
      return (
        i || (i = e),
        j.addToCache(o.baseTexture, i),
        O.addToCache(o, i),
        i !== e && (j.addToCache(o.baseTexture, e), O.addToCache(o, e)),
        o.baseTexture.valid
          ? Promise.resolve(o)
          : new Promise((h) => {
              o.baseTexture.once("loaded", () => h(o));
            })
      );
    }
    static addToCache(t, e) {
      e &&
        (t.textureCacheIds.includes(e) || t.textureCacheIds.push(e),
        Rt[e] &&
          Rt[e] !== t &&
          console.warn(
            `Texture added to the cache with an id [${e}] that already had an entry`
          ),
        (Rt[e] = t));
    }
    static removeFromCache(t) {
      if (typeof t == "string") {
        const e = Rt[t];
        if (e) {
          const i = e.textureCacheIds.indexOf(t);
          return i > -1 && e.textureCacheIds.splice(i, 1), delete Rt[t], e;
        }
      } else if (t != null && t.textureCacheIds) {
        for (let e = 0; e < t.textureCacheIds.length; ++e)
          Rt[t.textureCacheIds[e]] === t && delete Rt[t.textureCacheIds[e]];
        return (t.textureCacheIds.length = 0), t;
      }
      return null;
    }
    get resolution() {
      return this.baseTexture.resolution;
    }
    get frame() {
      return this._frame;
    }
    set frame(t) {
      (this._frame = t), (this.noFrame = !1);
      const { x: e, y: i, width: s, height: n } = t,
        a = e + s > this.baseTexture.width,
        o = i + n > this.baseTexture.height;
      if (a || o) {
        const h = a && o ? "and" : "or",
          l = `X: ${e} + ${s} = ${e + s} > ${this.baseTexture.width}`,
          u = `Y: ${i} + ${n} = ${i + n} > ${this.baseTexture.height}`;
        throw new Error(
          `Texture Error: frame does not fit inside the base Texture dimensions: ${l} ${h} ${u}`
        );
      }
      (this.valid = s && n && this.baseTexture.valid),
        !this.trim && !this.rotate && (this.orig = t),
        this.valid && this.updateUvs();
    }
    get rotate() {
      return this._rotate;
    }
    set rotate(t) {
      (this._rotate = t), this.valid && this.updateUvs();
    }
    get width() {
      return this.orig.width;
    }
    get height() {
      return this.orig.height;
    }
    castToBaseTexture() {
      return this.baseTexture;
    }
    static get EMPTY() {
      return (
        O._EMPTY ||
          ((O._EMPTY = new O(new j())), Qi(O._EMPTY), Qi(O._EMPTY.baseTexture)),
        O._EMPTY
      );
    }
    static get WHITE() {
      if (!O._WHITE) {
        const t = B.ADAPTER.createCanvas(16, 16),
          e = t.getContext("2d");
        (t.width = 16),
          (t.height = 16),
          (e.fillStyle = "white"),
          e.fillRect(0, 0, 16, 16),
          (O._WHITE = new O(j.from(t))),
          Qi(O._WHITE),
          Qi(O._WHITE.baseTexture);
      }
      return O._WHITE;
    }
  }
  class Me extends O {
    constructor(t, e) {
      super(t, e),
        (this.valid = !0),
        (this.filterFrame = null),
        (this.filterPoolKey = null),
        this.updateUvs();
    }
    get framebuffer() {
      return this.baseTexture.framebuffer;
    }
    get multisample() {
      return this.framebuffer.multisample;
    }
    set multisample(t) {
      this.framebuffer.multisample = t;
    }
    resize(t, e, i = !0) {
      const s = this.baseTexture.resolution,
        n = Math.round(t * s) / s,
        a = Math.round(e * s) / s;
      (this.valid = n > 0 && a > 0),
        (this._frame.width = this.orig.width = n),
        (this._frame.height = this.orig.height = a),
        i && this.baseTexture.resize(n, a),
        this.updateUvs();
    }
    setResolution(t) {
      const { baseTexture: e } = this;
      e.resolution !== t &&
        (e.setResolution(t), this.resize(e.width, e.height, !1));
    }
    static create(t) {
      return new Me(new Cn(t));
    }
  }
  class Dn {
    constructor(t) {
      (this.texturePool = {}),
        (this.textureOptions = t || {}),
        (this.enableFullScreen = !1),
        (this._pixelsWidth = 0),
        (this._pixelsHeight = 0);
    }
    createTexture(t, e, i = ot.NONE) {
      const s = new Cn(
        Object.assign(
          { width: t, height: e, resolution: 1, multisample: i },
          this.textureOptions
        )
      );
      return new Me(s);
    }
    getOptimalTexture(t, e, i = 1, s = ot.NONE) {
      let n;
      (t = Math.max(Math.ceil(t * i - 1e-6), 1)),
        (e = Math.max(Math.ceil(e * i - 1e-6), 1)),
        !this.enableFullScreen ||
        t !== this._pixelsWidth ||
        e !== this._pixelsHeight
          ? ((t = Br(t)),
            (e = Br(e)),
            (n = (((t & 65535) << 16) | (e & 65535)) >>> 0),
            s > 1 && (n += s * 4294967296))
          : (n = s > 1 ? -s : -1),
        this.texturePool[n] || (this.texturePool[n] = []);
      let a = this.texturePool[n].pop();
      return (
        a || (a = this.createTexture(t, e, s)),
        (a.filterPoolKey = n),
        a.setResolution(i),
        a
      );
    }
    getFilterTexture(t, e, i) {
      const s = this.getOptimalTexture(
        t.width,
        t.height,
        e || t.resolution,
        i || ot.NONE
      );
      return (s.filterFrame = t.filterFrame), s;
    }
    returnTexture(t) {
      const e = t.filterPoolKey;
      (t.filterFrame = null), this.texturePool[e].push(t);
    }
    returnFilterTexture(t) {
      this.returnTexture(t);
    }
    clear(t) {
      if (((t = t !== !1), t))
        for (const e in this.texturePool) {
          const i = this.texturePool[e];
          if (i) for (let s = 0; s < i.length; s++) i[s].destroy(!0);
        }
      this.texturePool = {};
    }
    setScreenSize(t) {
      if (!(t.width === this._pixelsWidth && t.height === this._pixelsHeight)) {
        this.enableFullScreen = t.width > 0 && t.height > 0;
        for (const e in this.texturePool) {
          if (!(Number(e) < 0)) continue;
          const i = this.texturePool[e];
          if (i) for (let s = 0; s < i.length; s++) i[s].destroy(!0);
          this.texturePool[e] = [];
        }
        (this._pixelsWidth = t.width), (this._pixelsHeight = t.height);
      }
    }
  }
  Dn.SCREEN_KEY = -1;
  class xh extends me {
    constructor() {
      super(),
        this.addAttribute(
          "aVertexPosition",
          new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
        ).addIndex([0, 1, 3, 2]);
    }
  }
  class Nn extends me {
    constructor() {
      super(),
        (this.vertices = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1])),
        (this.uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])),
        (this.vertexBuffer = new nt(this.vertices)),
        (this.uvBuffer = new nt(this.uvs)),
        this.addAttribute("aVertexPosition", this.vertexBuffer)
          .addAttribute("aTextureCoord", this.uvBuffer)
          .addIndex([0, 1, 2, 0, 2, 3]);
    }
    map(t, e) {
      let i = 0,
        s = 0;
      return (
        (this.uvs[0] = i),
        (this.uvs[1] = s),
        (this.uvs[2] = i + e.width / t.width),
        (this.uvs[3] = s),
        (this.uvs[4] = i + e.width / t.width),
        (this.uvs[5] = s + e.height / t.height),
        (this.uvs[6] = i),
        (this.uvs[7] = s + e.height / t.height),
        (i = e.x),
        (s = e.y),
        (this.vertices[0] = i),
        (this.vertices[1] = s),
        (this.vertices[2] = i + e.width),
        (this.vertices[3] = s),
        (this.vertices[4] = i + e.width),
        (this.vertices[5] = s + e.height),
        (this.vertices[6] = i),
        (this.vertices[7] = s + e.height),
        this.invalidate(),
        this
      );
    }
    invalidate() {
      return this.vertexBuffer._updateID++, this.uvBuffer._updateID++, this;
    }
  }
  class yh {
    constructor() {
      (this.renderTexture = null),
        (this.target = null),
        (this.legacy = !1),
        (this.resolution = 1),
        (this.multisample = ot.NONE),
        (this.sourceFrame = new Y()),
        (this.destinationFrame = new Y()),
        (this.bindingSourceFrame = new Y()),
        (this.bindingDestinationFrame = new Y()),
        (this.filters = []),
        (this.transform = null);
    }
    clear() {
      (this.target = null), (this.filters = null), (this.renderTexture = null);
    }
  }
  const Ji = [new tt(), new tt(), new tt(), new tt()],
    On = new et();
  class Bn {
    constructor(t) {
      (this.renderer = t),
        (this.defaultFilterStack = [{}]),
        (this.texturePool = new Dn()),
        (this.statePool = []),
        (this.quad = new xh()),
        (this.quadUv = new Nn()),
        (this.tempRect = new Y()),
        (this.activeState = {}),
        (this.globalUniforms = new Gt(
          {
            outputFrame: new Y(),
            inputSize: new Float32Array(4),
            inputPixel: new Float32Array(4),
            inputClamp: new Float32Array(4),
            resolution: 1,
            filterArea: new Float32Array(4),
            filterClamp: new Float32Array(4),
          },
          !0
        )),
        (this.forceClear = !1),
        (this.useMaxPadding = !1);
    }
    init() {
      this.texturePool.setScreenSize(this.renderer.view);
    }
    push(t, e) {
      var i, s, n, a;
      const o = this.renderer,
        h = this.defaultFilterStack,
        l = this.statePool.pop() || new yh(),
        u = o.renderTexture;
      let c, d;
      if (u.current) {
        const y = u.current;
        (c = y.resolution), (d = y.multisample);
      } else (c = o.resolution), (d = o.multisample);
      let f = e[0].resolution || c,
        p = (i = e[0].multisample) != null ? i : d,
        m = e[0].padding,
        g = e[0].autoFit,
        x = (s = e[0].legacy) != null ? s : !0;
      for (let y = 1; y < e.length; y++) {
        const T = e[y];
        (f = Math.min(f, T.resolution || c)),
          (p = Math.min(p, (n = T.multisample) != null ? n : d)),
          (m = this.useMaxPadding ? Math.max(m, T.padding) : m + T.padding),
          (g = g && T.autoFit),
          (x = x || ((a = T.legacy) != null ? a : !0));
      }
      h.length === 1 && (this.defaultFilterStack[0].renderTexture = u.current),
        h.push(l),
        (l.resolution = f),
        (l.multisample = p),
        (l.legacy = x),
        (l.target = t),
        l.sourceFrame.copyFrom(t.filterArea || t.getBounds(!0)),
        l.sourceFrame.pad(m);
      const b = this.tempRect.copyFrom(u.sourceFrame);
      o.projection.transform &&
        this.transformAABB(On.copyFrom(o.projection.transform).invert(), b),
        g
          ? (l.sourceFrame.fit(b),
            (l.sourceFrame.width <= 0 || l.sourceFrame.height <= 0) &&
              ((l.sourceFrame.width = 0), (l.sourceFrame.height = 0)))
          : l.sourceFrame.intersects(b) ||
            ((l.sourceFrame.width = 0), (l.sourceFrame.height = 0)),
        this.roundFrame(
          l.sourceFrame,
          u.current ? u.current.resolution : o.resolution,
          u.sourceFrame,
          u.destinationFrame,
          o.projection.transform
        ),
        (l.renderTexture = this.getOptimalFilterTexture(
          l.sourceFrame.width,
          l.sourceFrame.height,
          f,
          p
        )),
        (l.filters = e),
        (l.destinationFrame.width = l.renderTexture.width),
        (l.destinationFrame.height = l.renderTexture.height);
      const _ = this.tempRect;
      (_.x = 0),
        (_.y = 0),
        (_.width = l.sourceFrame.width),
        (_.height = l.sourceFrame.height),
        (l.renderTexture.filterFrame = l.sourceFrame),
        l.bindingSourceFrame.copyFrom(u.sourceFrame),
        l.bindingDestinationFrame.copyFrom(u.destinationFrame),
        (l.transform = o.projection.transform),
        (o.projection.transform = null),
        u.bind(l.renderTexture, l.sourceFrame, _),
        o.framebuffer.clear(0, 0, 0, 0);
    }
    pop() {
      const t = this.defaultFilterStack,
        e = t.pop(),
        i = e.filters;
      this.activeState = e;
      const s = this.globalUniforms.uniforms;
      (s.outputFrame = e.sourceFrame), (s.resolution = e.resolution);
      const n = s.inputSize,
        a = s.inputPixel,
        o = s.inputClamp;
      if (
        ((n[0] = e.destinationFrame.width),
        (n[1] = e.destinationFrame.height),
        (n[2] = 1 / n[0]),
        (n[3] = 1 / n[1]),
        (a[0] = Math.round(n[0] * e.resolution)),
        (a[1] = Math.round(n[1] * e.resolution)),
        (a[2] = 1 / a[0]),
        (a[3] = 1 / a[1]),
        (o[0] = 0.5 * a[2]),
        (o[1] = 0.5 * a[3]),
        (o[2] = e.sourceFrame.width * n[2] - 0.5 * a[2]),
        (o[3] = e.sourceFrame.height * n[3] - 0.5 * a[3]),
        e.legacy)
      ) {
        const l = s.filterArea;
        (l[0] = e.destinationFrame.width),
          (l[1] = e.destinationFrame.height),
          (l[2] = e.sourceFrame.x),
          (l[3] = e.sourceFrame.y),
          (s.filterClamp = s.inputClamp);
      }
      this.globalUniforms.update();
      const h = t[t.length - 1];
      if ((this.renderer.framebuffer.blit(), i.length === 1))
        i[0].apply(this, e.renderTexture, h.renderTexture, zt.BLEND, e),
          this.returnFilterTexture(e.renderTexture);
      else {
        let l = e.renderTexture,
          u = this.getOptimalFilterTexture(l.width, l.height, e.resolution);
        u.filterFrame = l.filterFrame;
        let c = 0;
        for (c = 0; c < i.length - 1; ++c) {
          c === 1 &&
            e.multisample > 1 &&
            ((u = this.getOptimalFilterTexture(
              l.width,
              l.height,
              e.resolution
            )),
            (u.filterFrame = l.filterFrame)),
            i[c].apply(this, l, u, zt.CLEAR, e);
          const d = l;
          (l = u), (u = d);
        }
        i[c].apply(this, l, h.renderTexture, zt.BLEND, e),
          c > 1 &&
            e.multisample > 1 &&
            this.returnFilterTexture(e.renderTexture),
          this.returnFilterTexture(l),
          this.returnFilterTexture(u);
      }
      e.clear(), this.statePool.push(e);
    }
    bindAndClear(t, e = zt.CLEAR) {
      const { renderTexture: i, state: s } = this.renderer;
      if (
        (t ===
        this.defaultFilterStack[this.defaultFilterStack.length - 1]
          .renderTexture
          ? (this.renderer.projection.transform = this.activeState.transform)
          : (this.renderer.projection.transform = null),
        t != null && t.filterFrame)
      ) {
        const a = this.tempRect;
        (a.x = 0),
          (a.y = 0),
          (a.width = t.filterFrame.width),
          (a.height = t.filterFrame.height),
          i.bind(t, t.filterFrame, a);
      } else
        t !==
        this.defaultFilterStack[this.defaultFilterStack.length - 1]
          .renderTexture
          ? i.bind(t)
          : this.renderer.renderTexture.bind(
              t,
              this.activeState.bindingSourceFrame,
              this.activeState.bindingDestinationFrame
            );
      const n = s.stateId & 1 || this.forceClear;
      (e === zt.CLEAR || (e === zt.BLIT && n)) &&
        this.renderer.framebuffer.clear(0, 0, 0, 0);
    }
    applyFilter(t, e, i, s) {
      const n = this.renderer;
      n.state.set(t.state),
        this.bindAndClear(i, s),
        (t.uniforms.uSampler = e),
        (t.uniforms.filterGlobals = this.globalUniforms),
        n.shader.bind(t),
        (t.legacy = !!t.program.attributeData.aTextureCoord),
        t.legacy
          ? (this.quadUv.map(e._frame, e.filterFrame),
            n.geometry.bind(this.quadUv),
            n.geometry.draw(Vt.TRIANGLES))
          : (n.geometry.bind(this.quad), n.geometry.draw(Vt.TRIANGLE_STRIP));
    }
    calculateSpriteMatrix(t, e) {
      const { sourceFrame: i, destinationFrame: s } = this.activeState,
        { orig: n } = e._texture,
        a = t.set(s.width, 0, 0, s.height, i.x, i.y),
        o = e.worldTransform.copyTo(et.TEMP_MATRIX);
      return (
        o.invert(),
        a.prepend(o),
        a.scale(1 / n.width, 1 / n.height),
        a.translate(e.anchor.x, e.anchor.y),
        a
      );
    }
    destroy() {
      (this.renderer = null), this.texturePool.clear(!1);
    }
    getOptimalFilterTexture(t, e, i = 1, s = ot.NONE) {
      return this.texturePool.getOptimalTexture(t, e, i, s);
    }
    getFilterTexture(t, e, i) {
      if (typeof t == "number") {
        const n = t;
        (t = e), (e = n);
      }
      t = t || this.activeState.renderTexture;
      const s = this.texturePool.getOptimalTexture(
        t.width,
        t.height,
        e || t.resolution,
        i || ot.NONE
      );
      return (s.filterFrame = t.filterFrame), s;
    }
    returnFilterTexture(t) {
      this.texturePool.returnTexture(t);
    }
    emptyPool() {
      this.texturePool.clear(!0);
    }
    resize() {
      this.texturePool.setScreenSize(this.renderer.view);
    }
    transformAABB(t, e) {
      const i = Ji[0],
        s = Ji[1],
        n = Ji[2],
        a = Ji[3];
      i.set(e.left, e.top),
        s.set(e.left, e.bottom),
        n.set(e.right, e.top),
        a.set(e.right, e.bottom),
        t.apply(i, i),
        t.apply(s, s),
        t.apply(n, n),
        t.apply(a, a);
      const o = Math.min(i.x, s.x, n.x, a.x),
        h = Math.min(i.y, s.y, n.y, a.y),
        l = Math.max(i.x, s.x, n.x, a.x),
        u = Math.max(i.y, s.y, n.y, a.y);
      (e.x = o), (e.y = h), (e.width = l - o), (e.height = u - h);
    }
    roundFrame(t, e, i, s, n) {
      if (!(t.width <= 0 || t.height <= 0 || i.width <= 0 || i.height <= 0)) {
        if (n) {
          const { a, b: o, c: h, d: l } = n;
          if (
            (Math.abs(o) > 1e-4 || Math.abs(h) > 1e-4) &&
            (Math.abs(a) > 1e-4 || Math.abs(l) > 1e-4)
          )
            return;
        }
        (n = n ? On.copyFrom(n) : On.identity()),
          n
            .translate(-i.x, -i.y)
            .scale(s.width / i.width, s.height / i.height)
            .translate(s.x, s.y),
          this.transformAABB(n, t),
          t.ceil(e),
          this.transformAABB(n.invert(), t);
      }
    }
  }
  (Bn.extension = { type: D.RendererSystem, name: "filter" }), U.add(Bn);
  class bh {
    constructor(t) {
      (this.framebuffer = t),
        (this.stencil = null),
        (this.dirtyId = -1),
        (this.dirtyFormat = -1),
        (this.dirtySize = -1),
        (this.multisample = ot.NONE),
        (this.msaaBuffer = null),
        (this.blitFramebuffer = null),
        (this.mipLevel = 0);
    }
  }
  const Bf = new Y();
  class Fn {
    constructor(t) {
      (this.renderer = t),
        (this.managedFramebuffers = []),
        (this.unknownFramebuffer = new Zi(10, 10)),
        (this.msaaSamples = null);
    }
    contextChange() {
      this.disposeAll(!0);
      const t = (this.gl = this.renderer.gl);
      if (
        ((this.CONTEXT_UID = this.renderer.CONTEXT_UID),
        (this.current = this.unknownFramebuffer),
        (this.viewport = new Y()),
        (this.hasMRT = !0),
        (this.writeDepthTexture = !0),
        this.renderer.context.webGLVersion === 1)
      ) {
        let e = this.renderer.context.extensions.drawBuffers,
          i = this.renderer.context.extensions.depthTexture;
        B.PREFER_ENV === we.WEBGL_LEGACY && ((e = null), (i = null)),
          e
            ? (t.drawBuffers = (s) => e.drawBuffersWEBGL(s))
            : ((this.hasMRT = !1), (t.drawBuffers = () => {})),
          i || (this.writeDepthTexture = !1);
      } else
        this.msaaSamples = t.getInternalformatParameter(
          t.RENDERBUFFER,
          t.RGBA8,
          t.SAMPLES
        );
    }
    bind(t, e, i = 0) {
      const { gl: s } = this;
      if (t) {
        const n = t.glFramebuffers[this.CONTEXT_UID] || this.initFramebuffer(t);
        this.current !== t &&
          ((this.current = t), s.bindFramebuffer(s.FRAMEBUFFER, n.framebuffer)),
          n.mipLevel !== i && (t.dirtyId++, t.dirtyFormat++, (n.mipLevel = i)),
          n.dirtyId !== t.dirtyId &&
            ((n.dirtyId = t.dirtyId),
            n.dirtyFormat !== t.dirtyFormat
              ? ((n.dirtyFormat = t.dirtyFormat),
                (n.dirtySize = t.dirtySize),
                this.updateFramebuffer(t, i))
              : n.dirtySize !== t.dirtySize &&
                ((n.dirtySize = t.dirtySize), this.resizeFramebuffer(t)));
        for (let a = 0; a < t.colorTextures.length; a++) {
          const o = t.colorTextures[a];
          this.renderer.texture.unbind(o.parentTextureArray || o);
        }
        if (
          (t.depthTexture && this.renderer.texture.unbind(t.depthTexture), e)
        ) {
          const a = e.width >> i,
            o = e.height >> i,
            h = a / e.width;
          this.setViewport(e.x * h, e.y * h, a, o);
        } else {
          const a = t.width >> i,
            o = t.height >> i;
          this.setViewport(0, 0, a, o);
        }
      } else
        this.current &&
          ((this.current = null), s.bindFramebuffer(s.FRAMEBUFFER, null)),
          e
            ? this.setViewport(e.x, e.y, e.width, e.height)
            : this.setViewport(0, 0, this.renderer.width, this.renderer.height);
    }
    setViewport(t, e, i, s) {
      const n = this.viewport;
      (t = Math.round(t)),
        (e = Math.round(e)),
        (i = Math.round(i)),
        (s = Math.round(s)),
        (n.width !== i || n.height !== s || n.x !== t || n.y !== e) &&
          ((n.x = t),
          (n.y = e),
          (n.width = i),
          (n.height = s),
          this.gl.viewport(t, e, i, s));
    }
    get size() {
      return this.current
        ? { x: 0, y: 0, width: this.current.width, height: this.current.height }
        : {
            x: 0,
            y: 0,
            width: this.renderer.width,
            height: this.renderer.height,
          };
    }
    clear(t, e, i, s, n = wi.COLOR | wi.DEPTH) {
      const { gl: a } = this;
      a.clearColor(t, e, i, s), a.clear(n);
    }
    initFramebuffer(t) {
      const { gl: e } = this,
        i = new bh(e.createFramebuffer());
      return (
        (i.multisample = this.detectSamples(t.multisample)),
        (t.glFramebuffers[this.CONTEXT_UID] = i),
        this.managedFramebuffers.push(t),
        t.disposeRunner.add(this),
        i
      );
    }
    resizeFramebuffer(t) {
      const { gl: e } = this,
        i = t.glFramebuffers[this.CONTEXT_UID];
      if (i.stencil) {
        e.bindRenderbuffer(e.RENDERBUFFER, i.stencil);
        let a;
        this.renderer.context.webGLVersion === 1
          ? (a = e.DEPTH_STENCIL)
          : t.depth && t.stencil
          ? (a = e.DEPTH24_STENCIL8)
          : t.depth
          ? (a = e.DEPTH_COMPONENT24)
          : (a = e.STENCIL_INDEX8),
          i.msaaBuffer
            ? e.renderbufferStorageMultisample(
                e.RENDERBUFFER,
                i.multisample,
                a,
                t.width,
                t.height
              )
            : e.renderbufferStorage(e.RENDERBUFFER, a, t.width, t.height);
      }
      const s = t.colorTextures;
      let n = s.length;
      e.drawBuffers || (n = Math.min(n, 1));
      for (let a = 0; a < n; a++) {
        const o = s[a],
          h = o.parentTextureArray || o;
        this.renderer.texture.bind(h, 0),
          a === 0 &&
            i.msaaBuffer &&
            (e.bindRenderbuffer(e.RENDERBUFFER, i.msaaBuffer),
            e.renderbufferStorageMultisample(
              e.RENDERBUFFER,
              i.multisample,
              h._glTextures[this.CONTEXT_UID].internalFormat,
              t.width,
              t.height
            ));
      }
      t.depthTexture &&
        this.writeDepthTexture &&
        this.renderer.texture.bind(t.depthTexture, 0);
    }
    updateFramebuffer(t, e) {
      const { gl: i } = this,
        s = t.glFramebuffers[this.CONTEXT_UID],
        n = t.colorTextures;
      let a = n.length;
      i.drawBuffers || (a = Math.min(a, 1)),
        s.multisample > 1 && this.canMultisampleFramebuffer(t)
          ? (s.msaaBuffer = s.msaaBuffer || i.createRenderbuffer())
          : s.msaaBuffer &&
            (i.deleteRenderbuffer(s.msaaBuffer),
            (s.msaaBuffer = null),
            s.blitFramebuffer &&
              (s.blitFramebuffer.dispose(), (s.blitFramebuffer = null)));
      const o = [];
      for (let h = 0; h < a; h++) {
        const l = n[h],
          u = l.parentTextureArray || l;
        this.renderer.texture.bind(u, 0),
          h === 0 && s.msaaBuffer
            ? (i.bindRenderbuffer(i.RENDERBUFFER, s.msaaBuffer),
              i.renderbufferStorageMultisample(
                i.RENDERBUFFER,
                s.multisample,
                u._glTextures[this.CONTEXT_UID].internalFormat,
                t.width,
                t.height
              ),
              i.framebufferRenderbuffer(
                i.FRAMEBUFFER,
                i.COLOR_ATTACHMENT0,
                i.RENDERBUFFER,
                s.msaaBuffer
              ))
            : (i.framebufferTexture2D(
                i.FRAMEBUFFER,
                i.COLOR_ATTACHMENT0 + h,
                l.target,
                u._glTextures[this.CONTEXT_UID].texture,
                e
              ),
              o.push(i.COLOR_ATTACHMENT0 + h));
      }
      if (
        (o.length > 1 && i.drawBuffers(o),
        t.depthTexture && this.writeDepthTexture)
      ) {
        const h = t.depthTexture;
        this.renderer.texture.bind(h, 0),
          i.framebufferTexture2D(
            i.FRAMEBUFFER,
            i.DEPTH_ATTACHMENT,
            i.TEXTURE_2D,
            h._glTextures[this.CONTEXT_UID].texture,
            e
          );
      }
      if (
        (t.stencil || t.depth) &&
        !(t.depthTexture && this.writeDepthTexture)
      ) {
        s.stencil = s.stencil || i.createRenderbuffer();
        let h, l;
        this.renderer.context.webGLVersion === 1
          ? ((h = i.DEPTH_STENCIL_ATTACHMENT), (l = i.DEPTH_STENCIL))
          : t.depth && t.stencil
          ? ((h = i.DEPTH_STENCIL_ATTACHMENT), (l = i.DEPTH24_STENCIL8))
          : t.depth
          ? ((h = i.DEPTH_ATTACHMENT), (l = i.DEPTH_COMPONENT24))
          : ((h = i.STENCIL_ATTACHMENT), (l = i.STENCIL_INDEX8)),
          i.bindRenderbuffer(i.RENDERBUFFER, s.stencil),
          s.msaaBuffer
            ? i.renderbufferStorageMultisample(
                i.RENDERBUFFER,
                s.multisample,
                l,
                t.width,
                t.height
              )
            : i.renderbufferStorage(i.RENDERBUFFER, l, t.width, t.height),
          i.framebufferRenderbuffer(
            i.FRAMEBUFFER,
            h,
            i.RENDERBUFFER,
            s.stencil
          );
      } else s.stencil && (i.deleteRenderbuffer(s.stencil), (s.stencil = null));
    }
    canMultisampleFramebuffer(t) {
      return (
        this.renderer.context.webGLVersion !== 1 &&
        t.colorTextures.length <= 1 &&
        !t.depthTexture
      );
    }
    detectSamples(t) {
      const { msaaSamples: e } = this;
      let i = ot.NONE;
      if (t <= 1 || e === null) return i;
      for (let s = 0; s < e.length; s++)
        if (e[s] <= t) {
          i = e[s];
          break;
        }
      return i === 1 && (i = ot.NONE), i;
    }
    blit(t, e, i) {
      const { current: s, renderer: n, gl: a, CONTEXT_UID: o } = this;
      if (n.context.webGLVersion !== 2 || !s) return;
      const h = s.glFramebuffers[o];
      if (!h) return;
      if (!t) {
        if (!h.msaaBuffer) return;
        const u = s.colorTextures[0];
        if (!u) return;
        h.blitFramebuffer ||
          ((h.blitFramebuffer = new Zi(s.width, s.height)),
          h.blitFramebuffer.addColorTexture(0, u)),
          (t = h.blitFramebuffer),
          t.colorTextures[0] !== u &&
            ((t.colorTextures[0] = u), t.dirtyId++, t.dirtyFormat++),
          (t.width !== s.width || t.height !== s.height) &&
            ((t.width = s.width),
            (t.height = s.height),
            t.dirtyId++,
            t.dirtySize++);
      }
      e || ((e = Bf), (e.width = s.width), (e.height = s.height)), i || (i = e);
      const l = e.width === i.width && e.height === i.height;
      this.bind(t),
        a.bindFramebuffer(a.READ_FRAMEBUFFER, h.framebuffer),
        a.blitFramebuffer(
          e.left,
          e.top,
          e.right,
          e.bottom,
          i.left,
          i.top,
          i.right,
          i.bottom,
          a.COLOR_BUFFER_BIT,
          l ? a.NEAREST : a.LINEAR
        ),
        a.bindFramebuffer(
          a.READ_FRAMEBUFFER,
          t.glFramebuffers[this.CONTEXT_UID].framebuffer
        );
    }
    disposeFramebuffer(t, e) {
      const i = t.glFramebuffers[this.CONTEXT_UID],
        s = this.gl;
      if (!i) return;
      delete t.glFramebuffers[this.CONTEXT_UID];
      const n = this.managedFramebuffers.indexOf(t);
      n >= 0 && this.managedFramebuffers.splice(n, 1),
        t.disposeRunner.remove(this),
        e ||
          (s.deleteFramebuffer(i.framebuffer),
          i.msaaBuffer && s.deleteRenderbuffer(i.msaaBuffer),
          i.stencil && s.deleteRenderbuffer(i.stencil)),
        i.blitFramebuffer && this.disposeFramebuffer(i.blitFramebuffer, e);
    }
    disposeAll(t) {
      const e = this.managedFramebuffers;
      this.managedFramebuffers = [];
      for (let i = 0; i < e.length; i++) this.disposeFramebuffer(e[i], t);
    }
    forceStencil() {
      const t = this.current;
      if (!t) return;
      const e = t.glFramebuffers[this.CONTEXT_UID];
      if (!e || (e.stencil && t.stencil)) return;
      t.stencil = !0;
      const i = t.width,
        s = t.height,
        n = this.gl,
        a = (e.stencil = n.createRenderbuffer());
      n.bindRenderbuffer(n.RENDERBUFFER, a);
      let o, h;
      this.renderer.context.webGLVersion === 1
        ? ((o = n.DEPTH_STENCIL_ATTACHMENT), (h = n.DEPTH_STENCIL))
        : t.depth
        ? ((o = n.DEPTH_STENCIL_ATTACHMENT), (h = n.DEPTH24_STENCIL8))
        : ((o = n.STENCIL_ATTACHMENT), (h = n.STENCIL_INDEX8)),
        e.msaaBuffer
          ? n.renderbufferStorageMultisample(
              n.RENDERBUFFER,
              e.multisample,
              h,
              i,
              s
            )
          : n.renderbufferStorage(n.RENDERBUFFER, h, i, s),
        n.framebufferRenderbuffer(n.FRAMEBUFFER, o, n.RENDERBUFFER, a);
    }
    reset() {
      (this.current = this.unknownFramebuffer), (this.viewport = new Y());
    }
    destroy() {
      this.renderer = null;
    }
  }
  (Fn.extension = { type: D.RendererSystem, name: "framebuffer" }), U.add(Fn);
  const Ln = { 5126: 4, 5123: 2, 5121: 1 };
  class Un {
    constructor(t) {
      (this.renderer = t),
        (this._activeGeometry = null),
        (this._activeVao = null),
        (this.hasVao = !0),
        (this.hasInstance = !0),
        (this.canUseUInt32ElementIndex = !1),
        (this.managedGeometries = {});
    }
    contextChange() {
      this.disposeAll(!0);
      const t = (this.gl = this.renderer.gl),
        e = this.renderer.context;
      if (
        ((this.CONTEXT_UID = this.renderer.CONTEXT_UID), e.webGLVersion !== 2)
      ) {
        let i = this.renderer.context.extensions.vertexArrayObject;
        B.PREFER_ENV === we.WEBGL_LEGACY && (i = null),
          i
            ? ((t.createVertexArray = () => i.createVertexArrayOES()),
              (t.bindVertexArray = (s) => i.bindVertexArrayOES(s)),
              (t.deleteVertexArray = (s) => i.deleteVertexArrayOES(s)))
            : ((this.hasVao = !1),
              (t.createVertexArray = () => null),
              (t.bindVertexArray = () => null),
              (t.deleteVertexArray = () => null));
      }
      if (e.webGLVersion !== 2) {
        const i = t.getExtension("ANGLE_instanced_arrays");
        i
          ? ((t.vertexAttribDivisor = (s, n) =>
              i.vertexAttribDivisorANGLE(s, n)),
            (t.drawElementsInstanced = (s, n, a, o, h) =>
              i.drawElementsInstancedANGLE(s, n, a, o, h)),
            (t.drawArraysInstanced = (s, n, a, o) =>
              i.drawArraysInstancedANGLE(s, n, a, o)))
          : (this.hasInstance = !1);
      }
      this.canUseUInt32ElementIndex =
        e.webGLVersion === 2 || !!e.extensions.uint32ElementIndex;
    }
    bind(t, e) {
      e = e || this.renderer.shader.shader;
      const { gl: i } = this;
      let s = t.glVertexArrayObjects[this.CONTEXT_UID],
        n = !1;
      s ||
        ((this.managedGeometries[t.id] = t),
        t.disposeRunner.add(this),
        (t.glVertexArrayObjects[this.CONTEXT_UID] = s = {}),
        (n = !0));
      const a = s[e.program.id] || this.initGeometryVao(t, e, n);
      (this._activeGeometry = t),
        this._activeVao !== a &&
          ((this._activeVao = a),
          this.hasVao ? i.bindVertexArray(a) : this.activateVao(t, e.program)),
        this.updateBuffers();
    }
    reset() {
      this.unbind();
    }
    updateBuffers() {
      const t = this._activeGeometry,
        e = this.renderer.buffer;
      for (let i = 0; i < t.buffers.length; i++) {
        const s = t.buffers[i];
        e.update(s);
      }
    }
    checkCompatibility(t, e) {
      const i = t.attributes,
        s = e.attributeData;
      for (const n in s)
        if (!i[n])
          throw new Error(
            `shader and geometry incompatible, geometry missing the "${n}" attribute`
          );
    }
    getSignature(t, e) {
      const i = t.attributes,
        s = e.attributeData,
        n = ["g", t.id];
      for (const a in i) s[a] && n.push(a, s[a].location);
      return n.join("-");
    }
    initGeometryVao(t, e, i = !0) {
      const s = this.gl,
        n = this.CONTEXT_UID,
        a = this.renderer.buffer,
        o = e.program;
      o.glPrograms[n] || this.renderer.shader.generateProgram(e),
        this.checkCompatibility(t, o);
      const h = this.getSignature(t, o),
        l = t.glVertexArrayObjects[this.CONTEXT_UID];
      let u = l[h];
      if (u) return (l[o.id] = u), u;
      const c = t.buffers,
        d = t.attributes,
        f = {},
        p = {};
      for (const m in c) (f[m] = 0), (p[m] = 0);
      for (const m in d)
        !d[m].size && o.attributeData[m]
          ? (d[m].size = o.attributeData[m].size)
          : d[m].size ||
            console.warn(
              `PIXI Geometry attribute '${m}' size cannot be determined (likely the bound shader does not have the attribute)`
            ),
          (f[d[m].buffer] += d[m].size * Ln[d[m].type]);
      for (const m in d) {
        const g = d[m],
          x = g.size;
        g.stride === void 0 &&
          (f[g.buffer] === x * Ln[g.type]
            ? (g.stride = 0)
            : (g.stride = f[g.buffer])),
          g.start === void 0 &&
            ((g.start = p[g.buffer]), (p[g.buffer] += x * Ln[g.type]));
      }
      (u = s.createVertexArray()), s.bindVertexArray(u);
      for (let m = 0; m < c.length; m++) {
        const g = c[m];
        a.bind(g), i && g._glBuffers[n].refCount++;
      }
      return (
        this.activateVao(t, o),
        (l[o.id] = u),
        (l[h] = u),
        s.bindVertexArray(null),
        a.unbind(jt.ARRAY_BUFFER),
        u
      );
    }
    disposeGeometry(t, e) {
      var i;
      if (!this.managedGeometries[t.id]) return;
      delete this.managedGeometries[t.id];
      const s = t.glVertexArrayObjects[this.CONTEXT_UID],
        n = this.gl,
        a = t.buffers,
        o = (i = this.renderer) == null ? void 0 : i.buffer;
      if ((t.disposeRunner.remove(this), !!s)) {
        if (o)
          for (let h = 0; h < a.length; h++) {
            const l = a[h]._glBuffers[this.CONTEXT_UID];
            l && (l.refCount--, l.refCount === 0 && !e && o.dispose(a[h], e));
          }
        if (!e) {
          for (const h in s)
            if (h[0] === "g") {
              const l = s[h];
              this._activeVao === l && this.unbind(), n.deleteVertexArray(l);
            }
        }
        delete t.glVertexArrayObjects[this.CONTEXT_UID];
      }
    }
    disposeAll(t) {
      const e = Object.keys(this.managedGeometries);
      for (let i = 0; i < e.length; i++)
        this.disposeGeometry(this.managedGeometries[e[i]], t);
    }
    activateVao(t, e) {
      const i = this.gl,
        s = this.CONTEXT_UID,
        n = this.renderer.buffer,
        a = t.buffers,
        o = t.attributes;
      t.indexBuffer && n.bind(t.indexBuffer);
      let h = null;
      for (const l in o) {
        const u = o[l],
          c = a[u.buffer],
          d = c._glBuffers[s];
        if (e.attributeData[l]) {
          h !== d && (n.bind(c), (h = d));
          const f = e.attributeData[l].location;
          if (
            (i.enableVertexAttribArray(f),
            i.vertexAttribPointer(
              f,
              u.size,
              u.type || i.FLOAT,
              u.normalized,
              u.stride,
              u.start
            ),
            u.instance)
          )
            if (this.hasInstance) i.vertexAttribDivisor(f, u.divisor);
            else
              throw new Error(
                "geometry error, GPU Instancing is not supported on this device"
              );
        }
      }
    }
    draw(t, e, i, s) {
      const { gl: n } = this,
        a = this._activeGeometry;
      if (a.indexBuffer) {
        const o = a.indexBuffer.data.BYTES_PER_ELEMENT,
          h = o === 2 ? n.UNSIGNED_SHORT : n.UNSIGNED_INT;
        o === 2 || (o === 4 && this.canUseUInt32ElementIndex)
          ? a.instanced
            ? n.drawElementsInstanced(
                t,
                e || a.indexBuffer.data.length,
                h,
                (i || 0) * o,
                s || 1
              )
            : n.drawElements(t, e || a.indexBuffer.data.length, h, (i || 0) * o)
          : console.warn("unsupported index buffer type: uint32");
      } else
        a.instanced
          ? n.drawArraysInstanced(t, i, e || a.getSize(), s || 1)
          : n.drawArrays(t, i, e || a.getSize());
      return this;
    }
    unbind() {
      this.gl.bindVertexArray(null),
        (this._activeVao = null),
        (this._activeGeometry = null);
    }
    destroy() {
      this.renderer = null;
    }
  }
  (Un.extension = { type: D.RendererSystem, name: "geometry" }), U.add(Un);
  const Eh = new et();
  class ts {
    constructor(t, e) {
      (this._texture = t),
        (this.mapCoord = new et()),
        (this.uClampFrame = new Float32Array(4)),
        (this.uClampOffset = new Float32Array(2)),
        (this._textureID = -1),
        (this._updateID = 0),
        (this.clampOffset = 0),
        (this.clampMargin = typeof e == "undefined" ? 0.5 : e),
        (this.isSimple = !1);
    }
    get texture() {
      return this._texture;
    }
    set texture(t) {
      (this._texture = t), (this._textureID = -1);
    }
    multiplyUvs(t, e) {
      e === void 0 && (e = t);
      const i = this.mapCoord;
      for (let s = 0; s < t.length; s += 2) {
        const n = t[s],
          a = t[s + 1];
        (e[s] = n * i.a + a * i.c + i.tx),
          (e[s + 1] = n * i.b + a * i.d + i.ty);
      }
      return e;
    }
    update(t) {
      const e = this._texture;
      if (!e || !e.valid || (!t && this._textureID === e._updateID)) return !1;
      (this._textureID = e._updateID), this._updateID++;
      const i = e._uvs;
      this.mapCoord.set(
        i.x1 - i.x0,
        i.y1 - i.y0,
        i.x3 - i.x0,
        i.y3 - i.y0,
        i.x0,
        i.y0
      );
      const s = e.orig,
        n = e.trim;
      n &&
        (Eh.set(
          s.width / n.width,
          0,
          0,
          s.height / n.height,
          -n.x / n.width,
          -n.y / n.height
        ),
        this.mapCoord.append(Eh));
      const a = e.baseTexture,
        o = this.uClampFrame,
        h = this.clampMargin / a.resolution,
        l = this.clampOffset;
      return (
        (o[0] = (e._frame.x + h + l) / a.width),
        (o[1] = (e._frame.y + h + l) / a.height),
        (o[2] = (e._frame.x + e._frame.width - h + l) / a.width),
        (o[3] = (e._frame.y + e._frame.height - h + l) / a.height),
        (this.uClampOffset[0] = l / a.realWidth),
        (this.uClampOffset[1] = l / a.realHeight),
        (this.isSimple =
          e._frame.width === a.width &&
          e._frame.height === a.height &&
          e.rotate === 0),
        !0
      );
    }
  }
  var Ff = `varying vec2 vMaskCoord;
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D mask;
uniform float alpha;
uniform float npmAlpha;
uniform vec4 maskClamp;

void main(void)
{
    float clip = step(3.5,
        step(maskClamp.x, vMaskCoord.x) +
        step(maskClamp.y, vMaskCoord.y) +
        step(vMaskCoord.x, maskClamp.z) +
        step(vMaskCoord.y, maskClamp.w));

    vec4 original = texture2D(uSampler, vTextureCoord);
    vec4 masky = texture2D(mask, vMaskCoord);
    float alphaMul = 1.0 - npmAlpha * (1.0 - masky.a);

    original *= (alphaMul * masky.r * alpha * clip);

    gl_FragColor = original;
}
`,
    Lf = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 otherMatrix;

varying vec2 vMaskCoord;
varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = aTextureCoord;
    vMaskCoord = ( otherMatrix * vec3( aTextureCoord, 1.0)  ).xy;
}
`;
  class Th extends Et {
    constructor(t, e, i) {
      let s = null;
      typeof t != "string" &&
        e === void 0 &&
        i === void 0 &&
        ((s = t), (t = void 0), (e = void 0), (i = void 0)),
        super(t || Lf, e || Ff, i),
        (this.maskSprite = s),
        (this.maskMatrix = new et());
    }
    get maskSprite() {
      return this._maskSprite;
    }
    set maskSprite(t) {
      (this._maskSprite = t),
        this._maskSprite && (this._maskSprite.renderable = !1);
    }
    apply(t, e, i, s) {
      const n = this._maskSprite,
        a = n._texture;
      a.valid &&
        (a.uvMatrix || (a.uvMatrix = new ts(a, 0)),
        a.uvMatrix.update(),
        (this.uniforms.npmAlpha = a.baseTexture.alphaMode ? 0 : 1),
        (this.uniforms.mask = a),
        (this.uniforms.otherMatrix = t
          .calculateSpriteMatrix(this.maskMatrix, n)
          .prepend(a.uvMatrix.mapCoord)),
        (this.uniforms.alpha = n.worldAlpha),
        (this.uniforms.maskClamp = a.uvMatrix.uClampFrame),
        t.applyFilter(this, e, i, s));
    }
  }
  class Ah {
    constructor(t = null) {
      (this.type = ut.NONE),
        (this.autoDetect = !0),
        (this.maskObject = t || null),
        (this.pooled = !1),
        (this.isMaskData = !0),
        (this.resolution = null),
        (this.multisample = Et.defaultMultisample),
        (this.enabled = !0),
        (this.colorMask = 15),
        (this._filters = null),
        (this._stencilCounter = 0),
        (this._scissorCounter = 0),
        (this._scissorRect = null),
        (this._scissorRectLocal = null),
        (this._colorMask = 15),
        (this._target = null);
    }
    get filter() {
      return this._filters ? this._filters[0] : null;
    }
    set filter(t) {
      t
        ? this._filters
          ? (this._filters[0] = t)
          : (this._filters = [t])
        : (this._filters = null);
    }
    reset() {
      this.pooled &&
        ((this.maskObject = null),
        (this.type = ut.NONE),
        (this.autoDetect = !0)),
        (this._target = null),
        (this._scissorRectLocal = null);
    }
    copyCountersOrReset(t) {
      t
        ? ((this._stencilCounter = t._stencilCounter),
          (this._scissorCounter = t._scissorCounter),
          (this._scissorRect = t._scissorRect))
        : ((this._stencilCounter = 0),
          (this._scissorCounter = 0),
          (this._scissorRect = null));
    }
  }
  class kn {
    constructor(t) {
      (this.renderer = t),
        (this.enableScissor = !0),
        (this.alphaMaskPool = []),
        (this.maskDataPool = []),
        (this.maskStack = []),
        (this.alphaMaskIndex = 0);
    }
    setMaskStack(t) {
      (this.maskStack = t),
        this.renderer.scissor.setMaskStack(t),
        this.renderer.stencil.setMaskStack(t);
    }
    push(t, e) {
      let i = e;
      if (!i.isMaskData) {
        const n = this.maskDataPool.pop() || new Ah();
        (n.pooled = !0), (n.maskObject = e), (i = n);
      }
      const s =
        this.maskStack.length !== 0
          ? this.maskStack[this.maskStack.length - 1]
          : null;
      if (
        (i.copyCountersOrReset(s),
        (i._colorMask = s ? s._colorMask : 15),
        i.autoDetect && this.detect(i),
        (i._target = t),
        i.type !== ut.SPRITE && this.maskStack.push(i),
        i.enabled)
      )
        switch (i.type) {
          case ut.SCISSOR:
            this.renderer.scissor.push(i);
            break;
          case ut.STENCIL:
            this.renderer.stencil.push(i);
            break;
          case ut.SPRITE:
            i.copyCountersOrReset(null), this.pushSpriteMask(i);
            break;
          case ut.COLOR:
            this.pushColorMask(i);
            break;
          default:
            break;
        }
      i.type === ut.SPRITE && this.maskStack.push(i);
    }
    pop(t) {
      const e = this.maskStack.pop();
      if (!(!e || e._target !== t)) {
        if (e.enabled)
          switch (e.type) {
            case ut.SCISSOR:
              this.renderer.scissor.pop(e);
              break;
            case ut.STENCIL:
              this.renderer.stencil.pop(e.maskObject);
              break;
            case ut.SPRITE:
              this.popSpriteMask(e);
              break;
            case ut.COLOR:
              this.popColorMask(e);
              break;
            default:
              break;
          }
        if (
          (e.reset(),
          e.pooled && this.maskDataPool.push(e),
          this.maskStack.length !== 0)
        ) {
          const i = this.maskStack[this.maskStack.length - 1];
          i.type === ut.SPRITE &&
            i._filters &&
            (i._filters[0].maskSprite = i.maskObject);
        }
      }
    }
    detect(t) {
      const e = t.maskObject;
      e
        ? e.isSprite
          ? (t.type = ut.SPRITE)
          : this.enableScissor && this.renderer.scissor.testScissor(t)
          ? (t.type = ut.SCISSOR)
          : (t.type = ut.STENCIL)
        : (t.type = ut.COLOR);
    }
    pushSpriteMask(t) {
      const { maskObject: e } = t,
        i = t._target;
      let s = t._filters;
      s ||
        ((s = this.alphaMaskPool[this.alphaMaskIndex]),
        s || (s = this.alphaMaskPool[this.alphaMaskIndex] = [new Th()])),
        (s[0].resolution = t.resolution),
        (s[0].multisample = t.multisample),
        (s[0].maskSprite = e);
      const n = i.filterArea;
      (i.filterArea = e.getBounds(!0)),
        this.renderer.filter.push(i, s),
        (i.filterArea = n),
        t._filters || this.alphaMaskIndex++;
    }
    popSpriteMask(t) {
      this.renderer.filter.pop(),
        t._filters
          ? (t._filters[0].maskSprite = null)
          : (this.alphaMaskIndex--,
            (this.alphaMaskPool[this.alphaMaskIndex][0].maskSprite = null));
    }
    pushColorMask(t) {
      const e = t._colorMask,
        i = (t._colorMask = e & t.colorMask);
      i !== e &&
        this.renderer.gl.colorMask(
          (i & 1) !== 0,
          (i & 2) !== 0,
          (i & 4) !== 0,
          (i & 8) !== 0
        );
    }
    popColorMask(t) {
      const e = t._colorMask,
        i =
          this.maskStack.length > 0
            ? this.maskStack[this.maskStack.length - 1]._colorMask
            : 15;
      i !== e &&
        this.renderer.gl.colorMask(
          (i & 1) !== 0,
          (i & 2) !== 0,
          (i & 4) !== 0,
          (i & 8) !== 0
        );
    }
    destroy() {
      this.renderer = null;
    }
  }
  (kn.extension = { type: D.RendererSystem, name: "mask" }), U.add(kn);
  class Sh {
    constructor(t) {
      (this.renderer = t), (this.maskStack = []), (this.glConst = 0);
    }
    getStackLength() {
      return this.maskStack.length;
    }
    setMaskStack(t) {
      const { gl: e } = this.renderer,
        i = this.getStackLength();
      this.maskStack = t;
      const s = this.getStackLength();
      s !== i &&
        (s === 0
          ? e.disable(this.glConst)
          : (e.enable(this.glConst), this._useCurrent()));
    }
    _useCurrent() {}
    destroy() {
      (this.renderer = null), (this.maskStack = null);
    }
  }
  const wh = new et(),
    Rh = [],
    Ih = class Us extends Sh {
      constructor(t) {
        super(t),
          (this.glConst = B.ADAPTER.getWebGLRenderingContext().SCISSOR_TEST);
      }
      getStackLength() {
        const t = this.maskStack[this.maskStack.length - 1];
        return t ? t._scissorCounter : 0;
      }
      calcScissorRect(t) {
        var e;
        if (t._scissorRectLocal) return;
        const i = t._scissorRect,
          { maskObject: s } = t,
          { renderer: n } = this,
          a = n.renderTexture,
          o = s.getBounds(!0, (e = Rh.pop()) != null ? e : new Y());
        this.roundFrameToPixels(
          o,
          a.current ? a.current.resolution : n.resolution,
          a.sourceFrame,
          a.destinationFrame,
          n.projection.transform
        ),
          i && o.fit(i),
          (t._scissorRectLocal = o);
      }
      static isMatrixRotated(t) {
        if (!t) return !1;
        const { a: e, b: i, c: s, d: n } = t;
        return (
          (Math.abs(i) > 1e-4 || Math.abs(s) > 1e-4) &&
          (Math.abs(e) > 1e-4 || Math.abs(n) > 1e-4)
        );
      }
      testScissor(t) {
        const { maskObject: e } = t;
        if (
          !e.isFastRect ||
          !e.isFastRect() ||
          Us.isMatrixRotated(e.worldTransform) ||
          Us.isMatrixRotated(this.renderer.projection.transform)
        )
          return !1;
        this.calcScissorRect(t);
        const i = t._scissorRectLocal;
        return i.width > 0 && i.height > 0;
      }
      roundFrameToPixels(t, e, i, s, n) {
        Us.isMatrixRotated(n) ||
          ((n = n ? wh.copyFrom(n) : wh.identity()),
          n
            .translate(-i.x, -i.y)
            .scale(s.width / i.width, s.height / i.height)
            .translate(s.x, s.y),
          this.renderer.filter.transformAABB(n, t),
          t.fit(s),
          (t.x = Math.round(t.x * e)),
          (t.y = Math.round(t.y * e)),
          (t.width = Math.round(t.width * e)),
          (t.height = Math.round(t.height * e)));
      }
      push(t) {
        t._scissorRectLocal || this.calcScissorRect(t);
        const { gl: e } = this.renderer;
        t._scissorRect || e.enable(e.SCISSOR_TEST),
          t._scissorCounter++,
          (t._scissorRect = t._scissorRectLocal),
          this._useCurrent();
      }
      pop(t) {
        const { gl: e } = this.renderer;
        t && Rh.push(t._scissorRectLocal),
          this.getStackLength() > 0
            ? this._useCurrent()
            : e.disable(e.SCISSOR_TEST);
      }
      _useCurrent() {
        const t = this.maskStack[this.maskStack.length - 1]._scissorRect;
        let e;
        this.renderer.renderTexture.current
          ? (e = t.y)
          : (e = this.renderer.height - t.height - t.y),
          this.renderer.gl.scissor(t.x, e, t.width, t.height);
      }
    };
  Ih.extension = { type: D.RendererSystem, name: "scissor" };
  let Ch = Ih;
  U.add(Ch);
  class Gn extends Sh {
    constructor(t) {
      super(t),
        (this.glConst = B.ADAPTER.getWebGLRenderingContext().STENCIL_TEST);
    }
    getStackLength() {
      const t = this.maskStack[this.maskStack.length - 1];
      return t ? t._stencilCounter : 0;
    }
    push(t) {
      const e = t.maskObject,
        { gl: i } = this.renderer,
        s = t._stencilCounter;
      s === 0 &&
        (this.renderer.framebuffer.forceStencil(),
        i.clearStencil(0),
        i.clear(i.STENCIL_BUFFER_BIT),
        i.enable(i.STENCIL_TEST)),
        t._stencilCounter++;
      const n = t._colorMask;
      n !== 0 && ((t._colorMask = 0), i.colorMask(!1, !1, !1, !1)),
        i.stencilFunc(i.EQUAL, s, 4294967295),
        i.stencilOp(i.KEEP, i.KEEP, i.INCR),
        (e.renderable = !0),
        e.render(this.renderer),
        this.renderer.batch.flush(),
        (e.renderable = !1),
        n !== 0 &&
          ((t._colorMask = n),
          i.colorMask(
            (n & 1) !== 0,
            (n & 2) !== 0,
            (n & 4) !== 0,
            (n & 8) !== 0
          )),
        this._useCurrent();
    }
    pop(t) {
      const e = this.renderer.gl;
      if (this.getStackLength() === 0) e.disable(e.STENCIL_TEST);
      else {
        const i =
            this.maskStack.length !== 0
              ? this.maskStack[this.maskStack.length - 1]
              : null,
          s = i ? i._colorMask : 15;
        s !== 0 && ((i._colorMask = 0), e.colorMask(!1, !1, !1, !1)),
          e.stencilOp(e.KEEP, e.KEEP, e.DECR),
          (t.renderable = !0),
          t.render(this.renderer),
          this.renderer.batch.flush(),
          (t.renderable = !1),
          s !== 0 &&
            ((i._colorMask = s),
            e.colorMask(
              (s & 1) !== 0,
              (s & 2) !== 0,
              (s & 4) !== 0,
              (s & 8) !== 0
            )),
          this._useCurrent();
      }
    }
    _useCurrent() {
      const t = this.renderer.gl;
      t.stencilFunc(t.EQUAL, this.getStackLength(), 4294967295),
        t.stencilOp(t.KEEP, t.KEEP, t.KEEP);
    }
  }
  (Gn.extension = { type: D.RendererSystem, name: "stencil" }), U.add(Gn);
  class $n {
    constructor(t) {
      (this.renderer = t), (this.plugins = {});
    }
    init() {
      const t = this.rendererPlugins;
      for (const e in t) this.plugins[e] = new t[e](this.renderer);
    }
    destroy() {
      for (const t in this.plugins)
        this.plugins[t].destroy(), (this.plugins[t] = null);
    }
  }
  ($n.extension = {
    type: [D.RendererSystem, D.CanvasRendererSystem],
    name: "_plugin",
  }),
    U.add($n);
  class Hn {
    constructor(t) {
      (this.renderer = t),
        (this.destinationFrame = null),
        (this.sourceFrame = null),
        (this.defaultFrame = null),
        (this.projectionMatrix = new et()),
        (this.transform = null);
    }
    update(t, e, i, s) {
      (this.destinationFrame = t || this.destinationFrame || this.defaultFrame),
        (this.sourceFrame = e || this.sourceFrame || t),
        this.calculateProjection(this.destinationFrame, this.sourceFrame, i, s),
        this.transform && this.projectionMatrix.append(this.transform);
      const n = this.renderer;
      (n.globalUniforms.uniforms.projectionMatrix = this.projectionMatrix),
        n.globalUniforms.update(),
        n.shader.shader &&
          n.shader.syncUniformGroup(n.shader.shader.uniforms.globals);
    }
    calculateProjection(t, e, i, s) {
      const n = this.projectionMatrix,
        a = s ? -1 : 1;
      n.identity(),
        (n.a = (1 / e.width) * 2),
        (n.d = a * ((1 / e.height) * 2)),
        (n.tx = -1 - e.x * n.a),
        (n.ty = -a - e.y * n.d);
    }
    setTransform(t) {}
    destroy() {
      this.renderer = null;
    }
  }
  (Hn.extension = { type: D.RendererSystem, name: "projection" }), U.add(Hn);
  var Mh = Object.getOwnPropertySymbols,
    Uf = Object.prototype.hasOwnProperty,
    kf = Object.prototype.propertyIsEnumerable,
    Gf = (r, t) => {
      var e = {};
      for (var i in r) Uf.call(r, i) && t.indexOf(i) < 0 && (e[i] = r[i]);
      if (r != null && Mh)
        for (var i of Mh(r)) t.indexOf(i) < 0 && kf.call(r, i) && (e[i] = r[i]);
      return e;
    };
  const $f = new ji(),
    Ph = new Y();
  class Vn {
    constructor(t) {
      (this.renderer = t), (this._tempMatrix = new et());
    }
    generateTexture(t, e) {
      var i;
      const s = e || {},
        { region: n } = s,
        a = Gf(s, ["region"]),
        o = (n == null ? void 0 : n.copyTo(Ph)) || t.getLocalBounds(Ph, !0),
        h = a.resolution || this.renderer.resolution;
      (o.width = Math.max(o.width, 1 / h)),
        (o.height = Math.max(o.height, 1 / h)),
        (a.width = o.width),
        (a.height = o.height),
        (a.resolution = h),
        (i = a.multisample) != null ||
          (a.multisample = this.renderer.multisample);
      const l = Me.create(a);
      (this._tempMatrix.tx = -o.x), (this._tempMatrix.ty = -o.y);
      const u = t.transform;
      return (
        (t.transform = $f),
        this.renderer.render(t, {
          renderTexture: l,
          transform: this._tempMatrix,
          skipUpdateTransform: !!t.parent,
          blit: !0,
        }),
        (t.transform = u),
        l
      );
    }
    destroy() {}
  }
  (Vn.extension = {
    type: [D.RendererSystem, D.CanvasRendererSystem],
    name: "textureGenerator",
  }),
    U.add(Vn);
  const qe = new Y(),
    zr = new Y();
  class Xn {
    constructor(t) {
      (this.renderer = t),
        (this.defaultMaskStack = []),
        (this.current = null),
        (this.sourceFrame = new Y()),
        (this.destinationFrame = new Y()),
        (this.viewportFrame = new Y());
    }
    contextChange() {
      var t;
      const e =
        (t = this.renderer) == null ? void 0 : t.gl.getContextAttributes();
      this._rendererPremultipliedAlpha = !!(
        e &&
        e.alpha &&
        e.premultipliedAlpha
      );
    }
    bind(t = null, e, i) {
      const s = this.renderer;
      this.current = t;
      let n, a, o;
      t
        ? ((n = t.baseTexture),
          (o = n.resolution),
          e ||
            ((qe.width = t.frame.width),
            (qe.height = t.frame.height),
            (e = qe)),
          i ||
            ((zr.x = t.frame.x),
            (zr.y = t.frame.y),
            (zr.width = e.width),
            (zr.height = e.height),
            (i = zr)),
          (a = n.framebuffer))
        : ((o = s.resolution),
          e ||
            ((qe.width = s._view.screen.width),
            (qe.height = s._view.screen.height),
            (e = qe)),
          i || ((i = qe), (i.width = e.width), (i.height = e.height)));
      const h = this.viewportFrame;
      (h.x = i.x * o),
        (h.y = i.y * o),
        (h.width = i.width * o),
        (h.height = i.height * o),
        t || (h.y = s.view.height - (h.y + h.height)),
        h.ceil(),
        this.renderer.framebuffer.bind(a, h),
        this.renderer.projection.update(i, e, o, !a),
        t
          ? this.renderer.mask.setMaskStack(n.maskStack)
          : this.renderer.mask.setMaskStack(this.defaultMaskStack),
        this.sourceFrame.copyFrom(e),
        this.destinationFrame.copyFrom(i);
    }
    clear(t, e) {
      const i = this.current
          ? this.current.baseTexture.clear
          : this.renderer.background.backgroundColor,
        s = K.shared.setValue(t || i);
      ((this.current && this.current.baseTexture.alphaMode > 0) ||
        (!this.current && this._rendererPremultipliedAlpha)) &&
        s.premultiply(s.alpha);
      const n = this.destinationFrame,
        a = this.current
          ? this.current.baseTexture
          : this.renderer._view.screen,
        o = n.width !== a.width || n.height !== a.height;
      if (o) {
        let { x: h, y: l, width: u, height: c } = this.viewportFrame;
        (h = Math.round(h)),
          (l = Math.round(l)),
          (u = Math.round(u)),
          (c = Math.round(c)),
          this.renderer.gl.enable(this.renderer.gl.SCISSOR_TEST),
          this.renderer.gl.scissor(h, l, u, c);
      }
      this.renderer.framebuffer.clear(s.red, s.green, s.blue, s.alpha, e),
        o && this.renderer.scissor.pop();
    }
    resize() {
      this.bind(null);
    }
    reset() {
      this.bind(null);
    }
    destroy() {
      this.renderer = null;
    }
  }
  (Xn.extension = { type: D.RendererSystem, name: "renderTexture" }), U.add(Xn);
  class Hf {}
  class Dh {
    constructor(t, e) {
      (this.program = t),
        (this.uniformData = e),
        (this.uniformGroups = {}),
        (this.uniformDirtyGroups = {}),
        (this.uniformBufferBindings = {});
    }
    destroy() {
      (this.uniformData = null),
        (this.uniformGroups = null),
        (this.uniformDirtyGroups = null),
        (this.uniformBufferBindings = null),
        (this.program = null);
    }
  }
  function Vf(r, t) {
    const e = {},
      i = t.getProgramParameter(r, t.ACTIVE_ATTRIBUTES);
    for (let s = 0; s < i; s++) {
      const n = t.getActiveAttrib(r, s);
      if (n.name.startsWith("gl_")) continue;
      const a = fh(t, n.type),
        o = {
          type: a,
          name: n.name,
          size: ch(a),
          location: t.getAttribLocation(r, n.name),
        };
      e[n.name] = o;
    }
    return e;
  }
  function Xf(r, t) {
    const e = {},
      i = t.getProgramParameter(r, t.ACTIVE_UNIFORMS);
    for (let s = 0; s < i; s++) {
      const n = t.getActiveUniform(r, s),
        a = n.name.replace(/\[.*?\]$/, ""),
        o = !!n.name.match(/\[.*?\]$/),
        h = fh(t, n.type);
      e[a] = {
        name: a,
        index: s,
        type: h,
        size: n.size,
        isArray: o,
        value: oh(h, n.size),
      };
    }
    return e;
  }
  function Nh(r, t) {
    var e;
    const i = ah(r, r.VERTEX_SHADER, t.vertexSrc),
      s = ah(r, r.FRAGMENT_SHADER, t.fragmentSrc),
      n = r.createProgram();
    r.attachShader(n, i), r.attachShader(n, s);
    const a = (e = t.extra) == null ? void 0 : e.transformFeedbackVaryings;
    if (
      (a &&
        (typeof r.transformFeedbackVaryings != "function" ||
          r.transformFeedbackVaryings(
            n,
            a.names,
            a.bufferMode === "separate"
              ? r.SEPARATE_ATTRIBS
              : r.INTERLEAVED_ATTRIBS
          )),
      r.linkProgram(n),
      r.getProgramParameter(n, r.LINK_STATUS) || Sf(r, n, i, s),
      (t.attributeData = Vf(n, r)),
      (t.uniformData = Xf(n, r)),
      !/^[ \t]*#[ \t]*version[ \t]+300[ \t]+es[ \t]*$/m.test(t.vertexSrc))
    ) {
      const h = Object.keys(t.attributeData);
      h.sort((l, u) => (l > u ? 1 : -1));
      for (let l = 0; l < h.length; l++)
        (t.attributeData[h[l]].location = l), r.bindAttribLocation(n, l, h[l]);
      r.linkProgram(n);
    }
    r.deleteShader(i), r.deleteShader(s);
    const o = {};
    for (const h in t.uniformData) {
      const l = t.uniformData[h];
      o[h] = {
        location: r.getUniformLocation(n, h),
        value: oh(l.type, l.size),
      };
    }
    return new Dh(n, o);
  }
  function zf(r, t, e, i, s) {
    e.buffer.update(s);
  }
  const jf = {
      float: `
        data[offset] = v;
    `,
      vec2: `
        data[offset] = v[0];
        data[offset+1] = v[1];
    `,
      vec3: `
        data[offset] = v[0];
        data[offset+1] = v[1];
        data[offset+2] = v[2];

    `,
      vec4: `
        data[offset] = v[0];
        data[offset+1] = v[1];
        data[offset+2] = v[2];
        data[offset+3] = v[3];
    `,
      mat2: `
        data[offset] = v[0];
        data[offset+1] = v[1];

        data[offset+4] = v[2];
        data[offset+5] = v[3];
    `,
      mat3: `
        data[offset] = v[0];
        data[offset+1] = v[1];
        data[offset+2] = v[2];

        data[offset + 4] = v[3];
        data[offset + 5] = v[4];
        data[offset + 6] = v[5];

        data[offset + 8] = v[6];
        data[offset + 9] = v[7];
        data[offset + 10] = v[8];
    `,
      mat4: `
        for(var i = 0; i < 16; i++)
        {
            data[offset + i] = v[i];
        }
    `,
    },
    Oh = {
      float: 4,
      vec2: 8,
      vec3: 12,
      vec4: 16,
      int: 4,
      ivec2: 8,
      ivec3: 12,
      ivec4: 16,
      uint: 4,
      uvec2: 8,
      uvec3: 12,
      uvec4: 16,
      bool: 4,
      bvec2: 8,
      bvec3: 12,
      bvec4: 16,
      mat2: 16 * 2,
      mat3: 16 * 3,
      mat4: 16 * 4,
    };
  function Bh(r) {
    const t = r.map((n) => ({ data: n, offset: 0, dataLen: 0, dirty: 0 }));
    let e = 0,
      i = 0,
      s = 0;
    for (let n = 0; n < t.length; n++) {
      const a = t[n];
      if (
        ((e = Oh[a.data.type]),
        a.data.size > 1 && (e = Math.max(e, 16) * a.data.size),
        (a.dataLen = e),
        i % e !== 0 && i < 16)
      ) {
        const o = (i % e) % 16;
        (i += o), (s += o);
      }
      i + e > 16
        ? ((s = Math.ceil(s / 16) * 16), (a.offset = s), (s += e), (i = e))
        : ((a.offset = s), (i += e), (s += e));
    }
    return (s = Math.ceil(s / 16) * 16), { uboElements: t, size: s };
  }
  function Fh(r, t) {
    const e = [];
    for (const i in r) t[i] && e.push(t[i]);
    return e.sort((i, s) => i.index - s.index), e;
  }
  function Lh(r, t) {
    if (!r.autoManage) return { size: 0, syncFunc: zf };
    const e = Fh(r.uniforms, t),
      { uboElements: i, size: s } = Bh(e),
      n = [
        `
    var v = null;
    var v2 = null;
    var cv = null;
    var t = 0;
    var gl = renderer.gl
    var index = 0;
    var data = buffer.data;
    `,
      ];
    for (let a = 0; a < i.length; a++) {
      const o = i[a],
        h = r.uniforms[o.data.name],
        l = o.data.name;
      let u = !1;
      for (let c = 0; c < Ye.length; c++) {
        const d = Ye[c];
        if (d.codeUbo && d.test(o.data, h)) {
          n.push(`offset = ${o.offset / 4};`, Ye[c].codeUbo(o.data.name, h)),
            (u = !0);
          break;
        }
      }
      if (!u)
        if (o.data.size > 1) {
          const c = ch(o.data.type),
            d = Math.max(Oh[o.data.type] / 16, 1),
            f = c / d,
            p = (4 - (f % 4)) % 4;
          n.push(`
                cv = ud.${l}.value;
                v = uv.${l};
                offset = ${o.offset / 4};

                t = 0;

                for(var i=0; i < ${o.data.size * d}; i++)
                {
                    for(var j = 0; j < ${f}; j++)
                    {
                        data[offset++] = v[t++];
                    }
                    offset += ${p};
                }

                `);
        } else {
          const c = jf[o.data.type];
          n.push(`
                cv = ud.${l}.value;
                v = uv.${l};
                offset = ${o.offset / 4};
                ${c};
                `);
        }
    }
    return (
      n.push(`
       renderer.buffer.update(buffer);
    `),
      {
        size: s,
        syncFunc: new Function(
          "ud",
          "uv",
          "renderer",
          "syncData",
          "buffer",
          n.join(`
`)
        ),
      }
    );
  }
  let Wf = 0;
  const es = { textureCount: 0, uboCount: 0 };
  class zn {
    constructor(t) {
      (this.destroyed = !1),
        (this.renderer = t),
        this.systemCheck(),
        (this.gl = null),
        (this.shader = null),
        (this.program = null),
        (this.cache = {}),
        (this._uboCache = {}),
        (this.id = Wf++);
    }
    systemCheck() {
      if (!mh())
        throw new Error(
          "Current environment does not allow unsafe-eval, please use @pixi/unsafe-eval module to enable support."
        );
    }
    contextChange(t) {
      (this.gl = t), this.reset();
    }
    bind(t, e) {
      t.disposeRunner.add(this),
        (t.uniforms.globals = this.renderer.globalUniforms);
      const i = t.program,
        s = i.glPrograms[this.renderer.CONTEXT_UID] || this.generateProgram(t);
      return (
        (this.shader = t),
        this.program !== i &&
          ((this.program = i), this.gl.useProgram(s.program)),
        e ||
          ((es.textureCount = 0),
          (es.uboCount = 0),
          this.syncUniformGroup(t.uniformGroup, es)),
        s
      );
    }
    setUniforms(t) {
      const e = this.shader.program,
        i = e.glPrograms[this.renderer.CONTEXT_UID];
      e.syncUniforms(i.uniformData, t, this.renderer);
    }
    syncUniformGroup(t, e) {
      const i = this.getGlProgram();
      (!t.static || t.dirtyId !== i.uniformDirtyGroups[t.id]) &&
        ((i.uniformDirtyGroups[t.id] = t.dirtyId), this.syncUniforms(t, i, e));
    }
    syncUniforms(t, e, i) {
      (t.syncUniforms[this.shader.program.id] || this.createSyncGroups(t))(
        e.uniformData,
        t.uniforms,
        this.renderer,
        i
      );
    }
    createSyncGroups(t) {
      const e = this.getSignature(t, this.shader.program.uniformData, "u");
      return (
        this.cache[e] ||
          (this.cache[e] = Tf(t, this.shader.program.uniformData)),
        (t.syncUniforms[this.shader.program.id] = this.cache[e]),
        t.syncUniforms[this.shader.program.id]
      );
    }
    syncUniformBufferGroup(t, e) {
      const i = this.getGlProgram();
      if (!t.static || t.dirtyId !== 0 || !i.uniformGroups[t.id]) {
        t.dirtyId = 0;
        const s = i.uniformGroups[t.id] || this.createSyncBufferGroup(t, i, e);
        t.buffer.update(),
          s(i.uniformData, t.uniforms, this.renderer, es, t.buffer);
      }
      this.renderer.buffer.bindBufferBase(t.buffer, i.uniformBufferBindings[e]);
    }
    createSyncBufferGroup(t, e, i) {
      const { gl: s } = this.renderer;
      this.renderer.buffer.bind(t.buffer);
      const n = this.gl.getUniformBlockIndex(e.program, i);
      (e.uniformBufferBindings[i] = this.shader.uniformBindCount),
        s.uniformBlockBinding(e.program, n, this.shader.uniformBindCount),
        this.shader.uniformBindCount++;
      const a = this.getSignature(t, this.shader.program.uniformData, "ubo");
      let o = this._uboCache[a];
      if (
        (o || (o = this._uboCache[a] = Lh(t, this.shader.program.uniformData)),
        t.autoManage)
      ) {
        const h = new Float32Array(o.size / 4);
        t.buffer.update(h);
      }
      return (e.uniformGroups[t.id] = o.syncFunc), e.uniformGroups[t.id];
    }
    getSignature(t, e, i) {
      const s = t.uniforms,
        n = [`${i}-`];
      for (const a in s) n.push(a), e[a] && n.push(e[a].type);
      return n.join("-");
    }
    getGlProgram() {
      return this.shader
        ? this.shader.program.glPrograms[this.renderer.CONTEXT_UID]
        : null;
    }
    generateProgram(t) {
      const e = this.gl,
        i = t.program,
        s = Nh(e, i);
      return (i.glPrograms[this.renderer.CONTEXT_UID] = s), s;
    }
    reset() {
      (this.program = null), (this.shader = null);
    }
    disposeShader(t) {
      this.shader === t && (this.shader = null);
    }
    destroy() {
      (this.renderer = null), (this.destroyed = !0);
    }
  }
  (zn.extension = { type: D.RendererSystem, name: "shader" }), U.add(zn);
  class jr {
    constructor(t) {
      this.renderer = t;
    }
    run(t) {
      const { renderer: e } = this;
      e.runners.init.emit(e.options),
        t.hello &&
          console.log(`PixiJS 7.4.3 - ${e.rendererLogId} - https://pixijs.com`),
        e.resize(e.screen.width, e.screen.height);
    }
    destroy() {}
  }
  (jr.defaultOptions = { hello: !1 }),
    (jr.extension = {
      type: [D.RendererSystem, D.CanvasRendererSystem],
      name: "startup",
    }),
    U.add(jr);
  function Yf(r, t = []) {
    return (
      (t[X.NORMAL] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.ADD] = [r.ONE, r.ONE]),
      (t[X.MULTIPLY] = [
        r.DST_COLOR,
        r.ONE_MINUS_SRC_ALPHA,
        r.ONE,
        r.ONE_MINUS_SRC_ALPHA,
      ]),
      (t[X.SCREEN] = [
        r.ONE,
        r.ONE_MINUS_SRC_COLOR,
        r.ONE,
        r.ONE_MINUS_SRC_ALPHA,
      ]),
      (t[X.OVERLAY] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.DARKEN] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.LIGHTEN] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.COLOR_DODGE] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.COLOR_BURN] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.HARD_LIGHT] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.SOFT_LIGHT] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.DIFFERENCE] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.EXCLUSION] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.HUE] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.SATURATION] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.COLOR] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.LUMINOSITY] = [r.ONE, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.NONE] = [0, 0]),
      (t[X.NORMAL_NPM] = [
        r.SRC_ALPHA,
        r.ONE_MINUS_SRC_ALPHA,
        r.ONE,
        r.ONE_MINUS_SRC_ALPHA,
      ]),
      (t[X.ADD_NPM] = [r.SRC_ALPHA, r.ONE, r.ONE, r.ONE]),
      (t[X.SCREEN_NPM] = [
        r.SRC_ALPHA,
        r.ONE_MINUS_SRC_COLOR,
        r.ONE,
        r.ONE_MINUS_SRC_ALPHA,
      ]),
      (t[X.SRC_IN] = [r.DST_ALPHA, r.ZERO]),
      (t[X.SRC_OUT] = [r.ONE_MINUS_DST_ALPHA, r.ZERO]),
      (t[X.SRC_ATOP] = [r.DST_ALPHA, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.DST_OVER] = [r.ONE_MINUS_DST_ALPHA, r.ONE]),
      (t[X.DST_IN] = [r.ZERO, r.SRC_ALPHA]),
      (t[X.DST_OUT] = [r.ZERO, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.DST_ATOP] = [r.ONE_MINUS_DST_ALPHA, r.SRC_ALPHA]),
      (t[X.XOR] = [r.ONE_MINUS_DST_ALPHA, r.ONE_MINUS_SRC_ALPHA]),
      (t[X.SUBTRACT] = [
        r.ONE,
        r.ONE,
        r.ONE,
        r.ONE,
        r.FUNC_REVERSE_SUBTRACT,
        r.FUNC_ADD,
      ]),
      t
    );
  }
  const qf = 0,
    Kf = 1,
    Zf = 2,
    Qf = 3,
    Jf = 4,
    tp = 5,
    Uh = class za {
      constructor() {
        (this.gl = null),
          (this.stateId = 0),
          (this.polygonOffset = 0),
          (this.blendMode = X.NONE),
          (this._blendEq = !1),
          (this.map = []),
          (this.map[qf] = this.setBlend),
          (this.map[Kf] = this.setOffset),
          (this.map[Zf] = this.setCullFace),
          (this.map[Qf] = this.setDepthTest),
          (this.map[Jf] = this.setFrontFace),
          (this.map[tp] = this.setDepthMask),
          (this.checks = []),
          (this.defaultState = new ie()),
          (this.defaultState.blend = !0);
      }
      contextChange(t) {
        (this.gl = t),
          (this.blendModes = Yf(t)),
          this.set(this.defaultState),
          this.reset();
      }
      set(t) {
        if (((t = t || this.defaultState), this.stateId !== t.data)) {
          let e = this.stateId ^ t.data,
            i = 0;
          for (; e; )
            e & 1 && this.map[i].call(this, !!(t.data & (1 << i))),
              (e = e >> 1),
              i++;
          this.stateId = t.data;
        }
        for (let e = 0; e < this.checks.length; e++) this.checks[e](this, t);
      }
      forceState(t) {
        t = t || this.defaultState;
        for (let e = 0; e < this.map.length; e++)
          this.map[e].call(this, !!(t.data & (1 << e)));
        for (let e = 0; e < this.checks.length; e++) this.checks[e](this, t);
        this.stateId = t.data;
      }
      setBlend(t) {
        this.updateCheck(za.checkBlendMode, t),
          this.gl[t ? "enable" : "disable"](this.gl.BLEND);
      }
      setOffset(t) {
        this.updateCheck(za.checkPolygonOffset, t),
          this.gl[t ? "enable" : "disable"](this.gl.POLYGON_OFFSET_FILL);
      }
      setDepthTest(t) {
        this.gl[t ? "enable" : "disable"](this.gl.DEPTH_TEST);
      }
      setDepthMask(t) {
        this.gl.depthMask(t);
      }
      setCullFace(t) {
        this.gl[t ? "enable" : "disable"](this.gl.CULL_FACE);
      }
      setFrontFace(t) {
        this.gl.frontFace(this.gl[t ? "CW" : "CCW"]);
      }
      setBlendMode(t) {
        if (t === this.blendMode) return;
        this.blendMode = t;
        const e = this.blendModes[t],
          i = this.gl;
        e.length === 2
          ? i.blendFunc(e[0], e[1])
          : i.blendFuncSeparate(e[0], e[1], e[2], e[3]),
          e.length === 6
            ? ((this._blendEq = !0), i.blendEquationSeparate(e[4], e[5]))
            : this._blendEq &&
              ((this._blendEq = !1),
              i.blendEquationSeparate(i.FUNC_ADD, i.FUNC_ADD));
      }
      setPolygonOffset(t, e) {
        this.gl.polygonOffset(t, e);
      }
      reset() {
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, !1),
          this.forceState(this.defaultState),
          (this._blendEq = !0),
          (this.blendMode = -1),
          this.setBlendMode(0);
      }
      updateCheck(t, e) {
        const i = this.checks.indexOf(t);
        e && i === -1
          ? this.checks.push(t)
          : !e && i !== -1 && this.checks.splice(i, 1);
      }
      static checkBlendMode(t, e) {
        t.setBlendMode(e.blendMode);
      }
      static checkPolygonOffset(t, e) {
        t.setPolygonOffset(1, e.polygonOffset);
      }
      destroy() {
        this.gl = null;
      }
    };
  Uh.extension = { type: D.RendererSystem, name: "state" };
  let kh = Uh;
  U.add(kh);
  class Gh extends Sr {
    constructor() {
      super(...arguments), (this.runners = {}), (this._systemsHash = {});
    }
    setup(t) {
      var e;
      this.addRunners(...t.runners);
      const i = ((e = t.priority) != null ? e : []).filter((n) => t.systems[n]),
        s = [...i, ...Object.keys(t.systems).filter((n) => !i.includes(n))];
      for (const n of s) this.addSystem(t.systems[n], n);
    }
    addRunners(...t) {
      t.forEach((e) => {
        this.runners[e] = new Nt(e);
      });
    }
    addSystem(t, e) {
      const i = new t(this);
      if (this[e]) throw new Error(`Whoops! The name "${e}" is already in use`);
      (this[e] = i), (this._systemsHash[e] = i);
      for (const s in this.runners) this.runners[s].add(i);
      return this;
    }
    emitWithCustomOptions(t, e) {
      const i = Object.keys(this._systemsHash);
      t.items.forEach((s) => {
        const n = i.find((a) => this._systemsHash[a] === s);
        s[t.name](e[n]);
      });
    }
    destroy() {
      Object.values(this.runners).forEach((t) => {
        t.destroy();
      }),
        (this._systemsHash = {});
    }
  }
  const Wr = class ks {
    constructor(t) {
      (this.renderer = t),
        (this.count = 0),
        (this.checkCount = 0),
        (this.maxIdle = ks.defaultMaxIdle),
        (this.checkCountMax = ks.defaultCheckCountMax),
        (this.mode = ks.defaultMode);
    }
    postrender() {
      this.renderer.objectRenderer.renderingToScreen &&
        (this.count++,
        this.mode !== Ri.MANUAL &&
          (this.checkCount++,
          this.checkCount > this.checkCountMax &&
            ((this.checkCount = 0), this.run())));
    }
    run() {
      const t = this.renderer.texture,
        e = t.managedTextures;
      let i = !1;
      for (let s = 0; s < e.length; s++) {
        const n = e[s];
        n.resource &&
          this.count - n.touched > this.maxIdle &&
          (t.destroyTexture(n, !0), (e[s] = null), (i = !0));
      }
      if (i) {
        let s = 0;
        for (let n = 0; n < e.length; n++) e[n] !== null && (e[s++] = e[n]);
        e.length = s;
      }
    }
    unload(t) {
      const e = this.renderer.texture,
        i = t._texture;
      i && !i.framebuffer && e.destroyTexture(i);
      for (let s = t.children.length - 1; s >= 0; s--)
        this.unload(t.children[s]);
    }
    destroy() {
      this.renderer = null;
    }
  };
  (Wr.defaultMode = Ri.AUTO),
    (Wr.defaultMaxIdle = 3600),
    (Wr.defaultCheckCountMax = 600),
    (Wr.extension = { type: D.RendererSystem, name: "textureGC" });
  let Pe = Wr;
  U.add(Pe);
  class rs {
    constructor(t) {
      (this.texture = t),
        (this.width = -1),
        (this.height = -1),
        (this.dirtyId = -1),
        (this.dirtyStyleId = -1),
        (this.mipmap = !1),
        (this.wrapMode = 33071),
        (this.type = H.UNSIGNED_BYTE),
        (this.internalFormat = A.RGBA),
        (this.samplerType = 0);
    }
  }
  function ep(r) {
    let t;
    return (
      "WebGL2RenderingContext" in globalThis &&
      r instanceof globalThis.WebGL2RenderingContext
        ? (t = {
            [r.RGB]: N.FLOAT,
            [r.RGBA]: N.FLOAT,
            [r.ALPHA]: N.FLOAT,
            [r.LUMINANCE]: N.FLOAT,
            [r.LUMINANCE_ALPHA]: N.FLOAT,
            [r.R8]: N.FLOAT,
            [r.R8_SNORM]: N.FLOAT,
            [r.RG8]: N.FLOAT,
            [r.RG8_SNORM]: N.FLOAT,
            [r.RGB8]: N.FLOAT,
            [r.RGB8_SNORM]: N.FLOAT,
            [r.RGB565]: N.FLOAT,
            [r.RGBA4]: N.FLOAT,
            [r.RGB5_A1]: N.FLOAT,
            [r.RGBA8]: N.FLOAT,
            [r.RGBA8_SNORM]: N.FLOAT,
            [r.RGB10_A2]: N.FLOAT,
            [r.RGB10_A2UI]: N.FLOAT,
            [r.SRGB8]: N.FLOAT,
            [r.SRGB8_ALPHA8]: N.FLOAT,
            [r.R16F]: N.FLOAT,
            [r.RG16F]: N.FLOAT,
            [r.RGB16F]: N.FLOAT,
            [r.RGBA16F]: N.FLOAT,
            [r.R32F]: N.FLOAT,
            [r.RG32F]: N.FLOAT,
            [r.RGB32F]: N.FLOAT,
            [r.RGBA32F]: N.FLOAT,
            [r.R11F_G11F_B10F]: N.FLOAT,
            [r.RGB9_E5]: N.FLOAT,
            [r.R8I]: N.INT,
            [r.R8UI]: N.UINT,
            [r.R16I]: N.INT,
            [r.R16UI]: N.UINT,
            [r.R32I]: N.INT,
            [r.R32UI]: N.UINT,
            [r.RG8I]: N.INT,
            [r.RG8UI]: N.UINT,
            [r.RG16I]: N.INT,
            [r.RG16UI]: N.UINT,
            [r.RG32I]: N.INT,
            [r.RG32UI]: N.UINT,
            [r.RGB8I]: N.INT,
            [r.RGB8UI]: N.UINT,
            [r.RGB16I]: N.INT,
            [r.RGB16UI]: N.UINT,
            [r.RGB32I]: N.INT,
            [r.RGB32UI]: N.UINT,
            [r.RGBA8I]: N.INT,
            [r.RGBA8UI]: N.UINT,
            [r.RGBA16I]: N.INT,
            [r.RGBA16UI]: N.UINT,
            [r.RGBA32I]: N.INT,
            [r.RGBA32UI]: N.UINT,
            [r.DEPTH_COMPONENT16]: N.FLOAT,
            [r.DEPTH_COMPONENT24]: N.FLOAT,
            [r.DEPTH_COMPONENT32F]: N.FLOAT,
            [r.DEPTH_STENCIL]: N.FLOAT,
            [r.DEPTH24_STENCIL8]: N.FLOAT,
            [r.DEPTH32F_STENCIL8]: N.FLOAT,
          })
        : (t = {
            [r.RGB]: N.FLOAT,
            [r.RGBA]: N.FLOAT,
            [r.ALPHA]: N.FLOAT,
            [r.LUMINANCE]: N.FLOAT,
            [r.LUMINANCE_ALPHA]: N.FLOAT,
            [r.DEPTH_STENCIL]: N.FLOAT,
          }),
      t
    );
  }
  function rp(r) {
    let t;
    return (
      "WebGL2RenderingContext" in globalThis &&
      r instanceof globalThis.WebGL2RenderingContext
        ? (t = {
            [H.UNSIGNED_BYTE]: {
              [A.RGBA]: r.RGBA8,
              [A.RGB]: r.RGB8,
              [A.RG]: r.RG8,
              [A.RED]: r.R8,
              [A.RGBA_INTEGER]: r.RGBA8UI,
              [A.RGB_INTEGER]: r.RGB8UI,
              [A.RG_INTEGER]: r.RG8UI,
              [A.RED_INTEGER]: r.R8UI,
              [A.ALPHA]: r.ALPHA,
              [A.LUMINANCE]: r.LUMINANCE,
              [A.LUMINANCE_ALPHA]: r.LUMINANCE_ALPHA,
            },
            [H.BYTE]: {
              [A.RGBA]: r.RGBA8_SNORM,
              [A.RGB]: r.RGB8_SNORM,
              [A.RG]: r.RG8_SNORM,
              [A.RED]: r.R8_SNORM,
              [A.RGBA_INTEGER]: r.RGBA8I,
              [A.RGB_INTEGER]: r.RGB8I,
              [A.RG_INTEGER]: r.RG8I,
              [A.RED_INTEGER]: r.R8I,
            },
            [H.UNSIGNED_SHORT]: {
              [A.RGBA_INTEGER]: r.RGBA16UI,
              [A.RGB_INTEGER]: r.RGB16UI,
              [A.RG_INTEGER]: r.RG16UI,
              [A.RED_INTEGER]: r.R16UI,
              [A.DEPTH_COMPONENT]: r.DEPTH_COMPONENT16,
            },
            [H.SHORT]: {
              [A.RGBA_INTEGER]: r.RGBA16I,
              [A.RGB_INTEGER]: r.RGB16I,
              [A.RG_INTEGER]: r.RG16I,
              [A.RED_INTEGER]: r.R16I,
            },
            [H.UNSIGNED_INT]: {
              [A.RGBA_INTEGER]: r.RGBA32UI,
              [A.RGB_INTEGER]: r.RGB32UI,
              [A.RG_INTEGER]: r.RG32UI,
              [A.RED_INTEGER]: r.R32UI,
              [A.DEPTH_COMPONENT]: r.DEPTH_COMPONENT24,
            },
            [H.INT]: {
              [A.RGBA_INTEGER]: r.RGBA32I,
              [A.RGB_INTEGER]: r.RGB32I,
              [A.RG_INTEGER]: r.RG32I,
              [A.RED_INTEGER]: r.R32I,
            },
            [H.FLOAT]: {
              [A.RGBA]: r.RGBA32F,
              [A.RGB]: r.RGB32F,
              [A.RG]: r.RG32F,
              [A.RED]: r.R32F,
              [A.DEPTH_COMPONENT]: r.DEPTH_COMPONENT32F,
            },
            [H.HALF_FLOAT]: {
              [A.RGBA]: r.RGBA16F,
              [A.RGB]: r.RGB16F,
              [A.RG]: r.RG16F,
              [A.RED]: r.R16F,
            },
            [H.UNSIGNED_SHORT_5_6_5]: { [A.RGB]: r.RGB565 },
            [H.UNSIGNED_SHORT_4_4_4_4]: { [A.RGBA]: r.RGBA4 },
            [H.UNSIGNED_SHORT_5_5_5_1]: { [A.RGBA]: r.RGB5_A1 },
            [H.UNSIGNED_INT_2_10_10_10_REV]: {
              [A.RGBA]: r.RGB10_A2,
              [A.RGBA_INTEGER]: r.RGB10_A2UI,
            },
            [H.UNSIGNED_INT_10F_11F_11F_REV]: { [A.RGB]: r.R11F_G11F_B10F },
            [H.UNSIGNED_INT_5_9_9_9_REV]: { [A.RGB]: r.RGB9_E5 },
            [H.UNSIGNED_INT_24_8]: { [A.DEPTH_STENCIL]: r.DEPTH24_STENCIL8 },
            [H.FLOAT_32_UNSIGNED_INT_24_8_REV]: {
              [A.DEPTH_STENCIL]: r.DEPTH32F_STENCIL8,
            },
          })
        : (t = {
            [H.UNSIGNED_BYTE]: {
              [A.RGBA]: r.RGBA,
              [A.RGB]: r.RGB,
              [A.ALPHA]: r.ALPHA,
              [A.LUMINANCE]: r.LUMINANCE,
              [A.LUMINANCE_ALPHA]: r.LUMINANCE_ALPHA,
            },
            [H.UNSIGNED_SHORT_5_6_5]: { [A.RGB]: r.RGB },
            [H.UNSIGNED_SHORT_4_4_4_4]: { [A.RGBA]: r.RGBA },
            [H.UNSIGNED_SHORT_5_5_5_1]: { [A.RGBA]: r.RGBA },
          }),
      t
    );
  }
  class jn {
    constructor(t) {
      (this.renderer = t),
        (this.boundTextures = []),
        (this.currentLocation = -1),
        (this.managedTextures = []),
        (this._unknownBoundTextures = !1),
        (this.unknownTexture = new j()),
        (this.hasIntegerTextures = !1);
    }
    contextChange() {
      const t = (this.gl = this.renderer.gl);
      (this.CONTEXT_UID = this.renderer.CONTEXT_UID),
        (this.webGLVersion = this.renderer.context.webGLVersion),
        (this.internalFormats = rp(t)),
        (this.samplerTypes = ep(t));
      const e = t.getParameter(t.MAX_TEXTURE_IMAGE_UNITS);
      this.boundTextures.length = e;
      for (let s = 0; s < e; s++) this.boundTextures[s] = null;
      this.emptyTextures = {};
      const i = new rs(t.createTexture());
      t.bindTexture(t.TEXTURE_2D, i.texture),
        t.texImage2D(
          t.TEXTURE_2D,
          0,
          t.RGBA,
          1,
          1,
          0,
          t.RGBA,
          t.UNSIGNED_BYTE,
          new Uint8Array(4)
        ),
        (this.emptyTextures[t.TEXTURE_2D] = i),
        (this.emptyTextures[t.TEXTURE_CUBE_MAP] = new rs(t.createTexture())),
        t.bindTexture(
          t.TEXTURE_CUBE_MAP,
          this.emptyTextures[t.TEXTURE_CUBE_MAP].texture
        );
      for (let s = 0; s < 6; s++)
        t.texImage2D(
          t.TEXTURE_CUBE_MAP_POSITIVE_X + s,
          0,
          t.RGBA,
          1,
          1,
          0,
          t.RGBA,
          t.UNSIGNED_BYTE,
          null
        );
      t.texParameteri(t.TEXTURE_CUBE_MAP, t.TEXTURE_MAG_FILTER, t.LINEAR),
        t.texParameteri(t.TEXTURE_CUBE_MAP, t.TEXTURE_MIN_FILTER, t.LINEAR);
      for (let s = 0; s < this.boundTextures.length; s++) this.bind(null, s);
    }
    bind(t, e = 0) {
      const { gl: i } = this;
      if (
        ((t = t == null ? void 0 : t.castToBaseTexture()),
        t != null && t.valid && !t.parentTextureArray)
      ) {
        t.touched = this.renderer.textureGC.count;
        const s = t._glTextures[this.CONTEXT_UID] || this.initTexture(t);
        this.boundTextures[e] !== t &&
          (this.currentLocation !== e &&
            ((this.currentLocation = e), i.activeTexture(i.TEXTURE0 + e)),
          i.bindTexture(t.target, s.texture)),
          s.dirtyId !== t.dirtyId
            ? (this.currentLocation !== e &&
                ((this.currentLocation = e), i.activeTexture(i.TEXTURE0 + e)),
              this.updateTexture(t))
            : s.dirtyStyleId !== t.dirtyStyleId && this.updateTextureStyle(t),
          (this.boundTextures[e] = t);
      } else
        this.currentLocation !== e &&
          ((this.currentLocation = e), i.activeTexture(i.TEXTURE0 + e)),
          i.bindTexture(i.TEXTURE_2D, this.emptyTextures[i.TEXTURE_2D].texture),
          (this.boundTextures[e] = null);
    }
    reset() {
      (this._unknownBoundTextures = !0),
        (this.hasIntegerTextures = !1),
        (this.currentLocation = -1);
      for (let t = 0; t < this.boundTextures.length; t++)
        this.boundTextures[t] = this.unknownTexture;
    }
    unbind(t) {
      const { gl: e, boundTextures: i } = this;
      if (this._unknownBoundTextures) {
        this._unknownBoundTextures = !1;
        for (let s = 0; s < i.length; s++)
          i[s] === this.unknownTexture && this.bind(null, s);
      }
      for (let s = 0; s < i.length; s++)
        i[s] === t &&
          (this.currentLocation !== s &&
            (e.activeTexture(e.TEXTURE0 + s), (this.currentLocation = s)),
          e.bindTexture(t.target, this.emptyTextures[t.target].texture),
          (i[s] = null));
    }
    ensureSamplerType(t) {
      const { boundTextures: e, hasIntegerTextures: i, CONTEXT_UID: s } = this;
      if (i)
        for (let n = t - 1; n >= 0; --n) {
          const a = e[n];
          a &&
            a._glTextures[s].samplerType !== N.FLOAT &&
            this.renderer.texture.unbind(a);
        }
    }
    initTexture(t) {
      const e = new rs(this.gl.createTexture());
      return (
        (e.dirtyId = -1),
        (t._glTextures[this.CONTEXT_UID] = e),
        this.managedTextures.push(t),
        t.on("dispose", this.destroyTexture, this),
        e
      );
    }
    initTextureType(t, e) {
      var i, s, n;
      (e.internalFormat =
        (s =
          (i = this.internalFormats[t.type]) == null ? void 0 : i[t.format]) !=
        null
          ? s
          : t.format),
        (e.samplerType =
          (n = this.samplerTypes[e.internalFormat]) != null ? n : N.FLOAT),
        this.webGLVersion === 2 && t.type === H.HALF_FLOAT
          ? (e.type = this.gl.HALF_FLOAT)
          : (e.type = t.type);
    }
    updateTexture(t) {
      var e;
      const i = t._glTextures[this.CONTEXT_UID];
      if (!i) return;
      const s = this.renderer;
      if (
        (this.initTextureType(t, i),
        (e = t.resource) != null && e.upload(s, t, i))
      )
        i.samplerType !== N.FLOAT && (this.hasIntegerTextures = !0);
      else {
        const n = t.realWidth,
          a = t.realHeight,
          o = s.gl;
        (i.width !== n || i.height !== a || i.dirtyId < 0) &&
          ((i.width = n),
          (i.height = a),
          o.texImage2D(
            t.target,
            0,
            i.internalFormat,
            n,
            a,
            0,
            t.format,
            i.type,
            null
          ));
      }
      t.dirtyStyleId !== i.dirtyStyleId && this.updateTextureStyle(t),
        (i.dirtyId = t.dirtyId);
    }
    destroyTexture(t, e) {
      const { gl: i } = this;
      if (
        ((t = t.castToBaseTexture()),
        t._glTextures[this.CONTEXT_UID] &&
          (this.unbind(t),
          i.deleteTexture(t._glTextures[this.CONTEXT_UID].texture),
          t.off("dispose", this.destroyTexture, this),
          delete t._glTextures[this.CONTEXT_UID],
          !e))
      ) {
        const s = this.managedTextures.indexOf(t);
        s !== -1 && nr(this.managedTextures, s, 1);
      }
    }
    updateTextureStyle(t) {
      var e;
      const i = t._glTextures[this.CONTEXT_UID];
      i &&
        ((t.mipmap === Xt.POW2 || this.webGLVersion !== 2) && !t.isPowerOfTwo
          ? (i.mipmap = !1)
          : (i.mipmap = t.mipmap >= 1),
        this.webGLVersion !== 2 && !t.isPowerOfTwo
          ? (i.wrapMode = Jt.CLAMP)
          : (i.wrapMode = t.wrapMode),
        ((e = t.resource) != null && e.style(this.renderer, t, i)) ||
          this.setStyle(t, i),
        (i.dirtyStyleId = t.dirtyStyleId));
    }
    setStyle(t, e) {
      const i = this.gl;
      if (
        (e.mipmap && t.mipmap !== Xt.ON_MANUAL && i.generateMipmap(t.target),
        i.texParameteri(t.target, i.TEXTURE_WRAP_S, e.wrapMode),
        i.texParameteri(t.target, i.TEXTURE_WRAP_T, e.wrapMode),
        e.mipmap)
      ) {
        i.texParameteri(
          t.target,
          i.TEXTURE_MIN_FILTER,
          t.scaleMode === Qt.LINEAR
            ? i.LINEAR_MIPMAP_LINEAR
            : i.NEAREST_MIPMAP_NEAREST
        );
        const s = this.renderer.context.extensions.anisotropicFiltering;
        if (s && t.anisotropicLevel > 0 && t.scaleMode === Qt.LINEAR) {
          const n = Math.min(
            t.anisotropicLevel,
            i.getParameter(s.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
          );
          i.texParameterf(t.target, s.TEXTURE_MAX_ANISOTROPY_EXT, n);
        }
      } else
        i.texParameteri(
          t.target,
          i.TEXTURE_MIN_FILTER,
          t.scaleMode === Qt.LINEAR ? i.LINEAR : i.NEAREST
        );
      i.texParameteri(
        t.target,
        i.TEXTURE_MAG_FILTER,
        t.scaleMode === Qt.LINEAR ? i.LINEAR : i.NEAREST
      );
    }
    destroy() {
      this.renderer = null;
    }
  }
  (jn.extension = { type: D.RendererSystem, name: "texture" }), U.add(jn);
  class Wn {
    constructor(t) {
      this.renderer = t;
    }
    contextChange() {
      (this.gl = this.renderer.gl),
        (this.CONTEXT_UID = this.renderer.CONTEXT_UID);
    }
    bind(t) {
      const { gl: e, CONTEXT_UID: i } = this,
        s = t._glTransformFeedbacks[i] || this.createGLTransformFeedback(t);
      e.bindTransformFeedback(e.TRANSFORM_FEEDBACK, s);
    }
    unbind() {
      const { gl: t } = this;
      t.bindTransformFeedback(t.TRANSFORM_FEEDBACK, null);
    }
    beginTransformFeedback(t, e) {
      const { gl: i, renderer: s } = this;
      e && s.shader.bind(e), i.beginTransformFeedback(t);
    }
    endTransformFeedback() {
      const { gl: t } = this;
      t.endTransformFeedback();
    }
    createGLTransformFeedback(t) {
      const { gl: e, renderer: i, CONTEXT_UID: s } = this,
        n = e.createTransformFeedback();
      (t._glTransformFeedbacks[s] = n),
        e.bindTransformFeedback(e.TRANSFORM_FEEDBACK, n);
      for (let a = 0; a < t.buffers.length; a++) {
        const o = t.buffers[a];
        o &&
          (i.buffer.update(o),
          o._glBuffers[s].refCount++,
          e.bindBufferBase(
            e.TRANSFORM_FEEDBACK_BUFFER,
            a,
            o._glBuffers[s].buffer || null
          ));
      }
      return (
        e.bindTransformFeedback(e.TRANSFORM_FEEDBACK, null),
        t.disposeRunner.add(this),
        n
      );
    }
    disposeTransformFeedback(t, e) {
      const i = t._glTransformFeedbacks[this.CONTEXT_UID],
        s = this.gl;
      t.disposeRunner.remove(this);
      const n = this.renderer.buffer;
      if (n)
        for (let a = 0; a < t.buffers.length; a++) {
          const o = t.buffers[a];
          if (!o) continue;
          const h = o._glBuffers[this.CONTEXT_UID];
          h && (h.refCount--, h.refCount === 0 && !e && n.dispose(o, e));
        }
      i &&
        (e || s.deleteTransformFeedback(i),
        delete t._glTransformFeedbacks[this.CONTEXT_UID]);
    }
    destroy() {
      this.renderer = null;
    }
  }
  (Wn.extension = { type: D.RendererSystem, name: "transformFeedback" }),
    U.add(Wn);
  class Yr {
    constructor(t) {
      this.renderer = t;
    }
    init(t) {
      (this.screen = new Y(0, 0, t.width, t.height)),
        (this.element = t.view || B.ADAPTER.createCanvas()),
        (this.resolution = t.resolution || B.RESOLUTION),
        (this.autoDensity = !!t.autoDensity);
    }
    resizeView(t, e) {
      (this.element.width = Math.round(t * this.resolution)),
        (this.element.height = Math.round(e * this.resolution));
      const i = this.element.width / this.resolution,
        s = this.element.height / this.resolution;
      (this.screen.width = i),
        (this.screen.height = s),
        this.autoDensity &&
          ((this.element.style.width = `${i}px`),
          (this.element.style.height = `${s}px`)),
        this.renderer.emit("resize", i, s),
        this.renderer.runners.resize.emit(
          this.screen.width,
          this.screen.height
        );
    }
    destroy(t) {
      var e;
      t &&
        ((e = this.element.parentNode) == null || e.removeChild(this.element)),
        (this.renderer = null),
        (this.element = null),
        (this.screen = null);
    }
  }
  (Yr.defaultOptions = {
    width: 800,
    height: 600,
    resolution: void 0,
    autoDensity: !1,
  }),
    (Yr.extension = {
      type: [D.RendererSystem, D.CanvasRendererSystem],
      name: "_view",
    }),
    U.add(Yr);
  var ip = Object.defineProperty,
    $h = Object.getOwnPropertySymbols,
    sp = Object.prototype.hasOwnProperty,
    np = Object.prototype.propertyIsEnumerable,
    Hh = (r, t, e) =>
      t in r
        ? ip(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    is = (r, t) => {
      for (var e in t || (t = {})) sp.call(t, e) && Hh(r, e, t[e]);
      if ($h) for (var e of $h(t)) np.call(t, e) && Hh(r, e, t[e]);
      return r;
    };
  (B.PREFER_ENV = we.WEBGL2),
    (B.STRICT_TEXTURE_CACHE = !1),
    (B.RENDER_OPTIONS = is(
      is(is(is({}, Xr.defaultOptions), Vr.defaultOptions), Yr.defaultOptions),
      jr.defaultOptions
    )),
    Object.defineProperties(B, {
      WRAP_MODE: {
        get() {
          return j.defaultOptions.wrapMode;
        },
        set(r) {
          j.defaultOptions.wrapMode = r;
        },
      },
      SCALE_MODE: {
        get() {
          return j.defaultOptions.scaleMode;
        },
        set(r) {
          j.defaultOptions.scaleMode = r;
        },
      },
      MIPMAP_TEXTURES: {
        get() {
          return j.defaultOptions.mipmap;
        },
        set(r) {
          j.defaultOptions.mipmap = r;
        },
      },
      ANISOTROPIC_LEVEL: {
        get() {
          return j.defaultOptions.anisotropicLevel;
        },
        set(r) {
          j.defaultOptions.anisotropicLevel = r;
        },
      },
      FILTER_RESOLUTION: {
        get() {
          return Et.defaultResolution;
        },
        set(r) {
          Et.defaultResolution = r;
        },
      },
      FILTER_MULTISAMPLE: {
        get() {
          return Et.defaultMultisample;
        },
        set(r) {
          Et.defaultMultisample = r;
        },
      },
      SPRITE_MAX_TEXTURES: {
        get() {
          return Ce.defaultMaxTextures;
        },
        set(r) {
          Ce.defaultMaxTextures = r;
        },
      },
      SPRITE_BATCH_SIZE: {
        get() {
          return Ce.defaultBatchSize;
        },
        set(r) {
          Ce.defaultBatchSize = r;
        },
      },
      CAN_UPLOAD_SAME_BUFFER: {
        get() {
          return Ce.canUploadSameBuffer;
        },
        set(r) {
          Ce.canUploadSameBuffer = r;
        },
      },
      GC_MODE: {
        get() {
          return Pe.defaultMode;
        },
        set(r) {
          Pe.defaultMode = r;
        },
      },
      GC_MAX_IDLE: {
        get() {
          return Pe.defaultMaxIdle;
        },
        set(r) {
          Pe.defaultMaxIdle = r;
        },
      },
      GC_MAX_CHECK_COUNT: {
        get() {
          return Pe.defaultCheckCountMax;
        },
        set(r) {
          Pe.defaultCheckCountMax = r;
        },
      },
      PRECISION_VERTEX: {
        get() {
          return se.defaultVertexPrecision;
        },
        set(r) {
          se.defaultVertexPrecision = r;
        },
      },
      PRECISION_FRAGMENT: {
        get() {
          return se.defaultFragmentPrecision;
        },
        set(r) {
          se.defaultFragmentPrecision = r;
        },
      },
    });
  var De = ((r) => (
    (r[(r.INTERACTION = 50)] = "INTERACTION"),
    (r[(r.HIGH = 25)] = "HIGH"),
    (r[(r.NORMAL = 0)] = "NORMAL"),
    (r[(r.LOW = -25)] = "LOW"),
    (r[(r.UTILITY = -50)] = "UTILITY"),
    r
  ))(De || {});
  class Yn {
    constructor(t, e = null, i = 0, s = !1) {
      (this.next = null),
        (this.previous = null),
        (this._destroyed = !1),
        (this.fn = t),
        (this.context = e),
        (this.priority = i),
        (this.once = s);
    }
    match(t, e = null) {
      return this.fn === t && this.context === e;
    }
    emit(t) {
      this.fn && (this.context ? this.fn.call(this.context, t) : this.fn(t));
      const e = this.next;
      return (
        this.once && this.destroy(!0), this._destroyed && (this.next = null), e
      );
    }
    connect(t) {
      (this.previous = t),
        t.next && (t.next.previous = this),
        (this.next = t.next),
        (t.next = this);
    }
    destroy(t = !1) {
      (this._destroyed = !0),
        (this.fn = null),
        (this.context = null),
        this.previous && (this.previous.next = this.next),
        this.next && (this.next.previous = this.previous);
      const e = this.next;
      return (this.next = t ? null : e), (this.previous = null), e;
    }
  }
  const Vh = class Lt {
    constructor() {
      (this.autoStart = !1),
        (this.deltaTime = 1),
        (this.lastTime = -1),
        (this.speed = 1),
        (this.started = !1),
        (this._requestId = null),
        (this._maxElapsedMS = 100),
        (this._minElapsedMS = 0),
        (this._protected = !1),
        (this._lastFrame = -1),
        (this._head = new Yn(null, null, 1 / 0)),
        (this.deltaMS = 1 / Lt.targetFPMS),
        (this.elapsedMS = 1 / Lt.targetFPMS),
        (this._tick = (t) => {
          (this._requestId = null),
            this.started &&
              (this.update(t),
              this.started &&
                this._requestId === null &&
                this._head.next &&
                (this._requestId = requestAnimationFrame(this._tick)));
        });
    }
    _requestIfNeeded() {
      this._requestId === null &&
        this._head.next &&
        ((this.lastTime = performance.now()),
        (this._lastFrame = this.lastTime),
        (this._requestId = requestAnimationFrame(this._tick)));
    }
    _cancelIfNeeded() {
      this._requestId !== null &&
        (cancelAnimationFrame(this._requestId), (this._requestId = null));
    }
    _startIfPossible() {
      this.started ? this._requestIfNeeded() : this.autoStart && this.start();
    }
    add(t, e, i = De.NORMAL) {
      return this._addListener(new Yn(t, e, i));
    }
    addOnce(t, e, i = De.NORMAL) {
      return this._addListener(new Yn(t, e, i, !0));
    }
    _addListener(t) {
      let e = this._head.next,
        i = this._head;
      if (!e) t.connect(i);
      else {
        for (; e; ) {
          if (t.priority > e.priority) {
            t.connect(i);
            break;
          }
          (i = e), (e = e.next);
        }
        t.previous || t.connect(i);
      }
      return this._startIfPossible(), this;
    }
    remove(t, e) {
      let i = this._head.next;
      for (; i; ) i.match(t, e) ? (i = i.destroy()) : (i = i.next);
      return this._head.next || this._cancelIfNeeded(), this;
    }
    get count() {
      if (!this._head) return 0;
      let t = 0,
        e = this._head;
      for (; (e = e.next); ) t++;
      return t;
    }
    start() {
      this.started || ((this.started = !0), this._requestIfNeeded());
    }
    stop() {
      this.started && ((this.started = !1), this._cancelIfNeeded());
    }
    destroy() {
      if (!this._protected) {
        this.stop();
        let t = this._head.next;
        for (; t; ) t = t.destroy(!0);
        this._head.destroy(), (this._head = null);
      }
    }
    update(t = performance.now()) {
      let e;
      if (t > this.lastTime) {
        if (
          ((e = this.elapsedMS = t - this.lastTime),
          e > this._maxElapsedMS && (e = this._maxElapsedMS),
          (e *= this.speed),
          this._minElapsedMS)
        ) {
          const n = (t - this._lastFrame) | 0;
          if (n < this._minElapsedMS) return;
          this._lastFrame = t - (n % this._minElapsedMS);
        }
        (this.deltaMS = e), (this.deltaTime = this.deltaMS * Lt.targetFPMS);
        const i = this._head;
        let s = i.next;
        for (; s; ) s = s.emit(this.deltaTime);
        i.next || this._cancelIfNeeded();
      } else this.deltaTime = this.deltaMS = this.elapsedMS = 0;
      this.lastTime = t;
    }
    get FPS() {
      return 1e3 / this.elapsedMS;
    }
    get minFPS() {
      return 1e3 / this._maxElapsedMS;
    }
    set minFPS(t) {
      const e = Math.min(this.maxFPS, t),
        i = Math.min(Math.max(0, e) / 1e3, Lt.targetFPMS);
      this._maxElapsedMS = 1 / i;
    }
    get maxFPS() {
      return this._minElapsedMS ? Math.round(1e3 / this._minElapsedMS) : 0;
    }
    set maxFPS(t) {
      if (t === 0) this._minElapsedMS = 0;
      else {
        const e = Math.max(this.minFPS, t);
        this._minElapsedMS = 1 / (e / 1e3);
      }
    }
    static get shared() {
      if (!Lt._shared) {
        const t = (Lt._shared = new Lt());
        (t.autoStart = !0), (t._protected = !0);
      }
      return Lt._shared;
    }
    static get system() {
      if (!Lt._system) {
        const t = (Lt._system = new Lt());
        (t.autoStart = !0), (t._protected = !0);
      }
      return Lt._system;
    }
  };
  Vh.targetFPMS = 0.06;
  let Tt = Vh;
  Object.defineProperties(B, {
    TARGET_FPMS: {
      get() {
        return Tt.targetFPMS;
      },
      set(r) {
        Tt.targetFPMS = r;
      },
    },
  });
  class qn {
    static init(t) {
      (t = Object.assign({ autoStart: !0, sharedTicker: !1 }, t)),
        Object.defineProperty(this, "ticker", {
          set(e) {
            this._ticker && this._ticker.remove(this.render, this),
              (this._ticker = e),
              e && e.add(this.render, this, De.LOW);
          },
          get() {
            return this._ticker;
          },
        }),
        (this.stop = () => {
          this._ticker.stop();
        }),
        (this.start = () => {
          this._ticker.start();
        }),
        (this._ticker = null),
        (this.ticker = t.sharedTicker ? Tt.shared : new Tt()),
        t.autoStart && this.start();
    }
    static destroy() {
      if (this._ticker) {
        const t = this._ticker;
        (this.ticker = null), t.destroy();
      }
    }
  }
  (qn.extension = D.Application), U.add(qn);
  const Xh = [];
  U.handleByList(D.Renderer, Xh);
  function zh(r) {
    for (const t of Xh) if (t.test(r)) return new t(r);
    throw new Error("Unable to auto-detect a suitable renderer.");
  }
  var ap = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;

varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
    vTextureCoord = aTextureCoord;
}`,
    op = `attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;

varying vec2 vTextureCoord;

uniform vec4 inputSize;
uniform vec4 outputFrame;

vec4 filterVertexPosition( void )
{
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;

    return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aVertexPosition * (outputFrame.zw * inputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;
  const jh = ap,
    Kn = op;
  class Zn {
    constructor(t) {
      this.renderer = t;
    }
    contextChange(t) {
      let e;
      if (this.renderer.context.webGLVersion === 1) {
        const i = t.getParameter(t.FRAMEBUFFER_BINDING);
        t.bindFramebuffer(t.FRAMEBUFFER, null),
          (e = t.getParameter(t.SAMPLES)),
          t.bindFramebuffer(t.FRAMEBUFFER, i);
      } else {
        const i = t.getParameter(t.DRAW_FRAMEBUFFER_BINDING);
        t.bindFramebuffer(t.DRAW_FRAMEBUFFER, null),
          (e = t.getParameter(t.SAMPLES)),
          t.bindFramebuffer(t.DRAW_FRAMEBUFFER, i);
      }
      e >= ot.HIGH
        ? (this.multisample = ot.HIGH)
        : e >= ot.MEDIUM
        ? (this.multisample = ot.MEDIUM)
        : e >= ot.LOW
        ? (this.multisample = ot.LOW)
        : (this.multisample = ot.NONE);
    }
    destroy() {}
  }
  (Zn.extension = { type: D.RendererSystem, name: "_multisample" }), U.add(Zn);
  class hp {
    constructor(t) {
      (this.buffer = t || null),
        (this.updateID = -1),
        (this.byteLength = -1),
        (this.refCount = 0);
    }
  }
  class Qn {
    constructor(t) {
      (this.renderer = t),
        (this.managedBuffers = {}),
        (this.boundBufferBases = {});
    }
    destroy() {
      this.renderer = null;
    }
    contextChange() {
      this.disposeAll(!0),
        (this.gl = this.renderer.gl),
        (this.CONTEXT_UID = this.renderer.CONTEXT_UID);
    }
    bind(t) {
      const { gl: e, CONTEXT_UID: i } = this,
        s = t._glBuffers[i] || this.createGLBuffer(t);
      e.bindBuffer(t.type, s.buffer);
    }
    unbind(t) {
      const { gl: e } = this;
      e.bindBuffer(t, null);
    }
    bindBufferBase(t, e) {
      const { gl: i, CONTEXT_UID: s } = this;
      if (this.boundBufferBases[e] !== t) {
        const n = t._glBuffers[s] || this.createGLBuffer(t);
        (this.boundBufferBases[e] = t),
          i.bindBufferBase(i.UNIFORM_BUFFER, e, n.buffer);
      }
    }
    bindBufferRange(t, e, i) {
      const { gl: s, CONTEXT_UID: n } = this;
      i = i || 0;
      const a = t._glBuffers[n] || this.createGLBuffer(t);
      s.bindBufferRange(s.UNIFORM_BUFFER, e || 0, a.buffer, i * 256, 256);
    }
    update(t) {
      const { gl: e, CONTEXT_UID: i } = this,
        s = t._glBuffers[i] || this.createGLBuffer(t);
      if (t._updateID !== s.updateID)
        if (
          ((s.updateID = t._updateID),
          e.bindBuffer(t.type, s.buffer),
          s.byteLength >= t.data.byteLength)
        )
          e.bufferSubData(t.type, 0, t.data);
        else {
          const n = t.static ? e.STATIC_DRAW : e.DYNAMIC_DRAW;
          (s.byteLength = t.data.byteLength), e.bufferData(t.type, t.data, n);
        }
    }
    dispose(t, e) {
      if (!this.managedBuffers[t.id]) return;
      delete this.managedBuffers[t.id];
      const i = t._glBuffers[this.CONTEXT_UID],
        s = this.gl;
      t.disposeRunner.remove(this),
        i &&
          (e || s.deleteBuffer(i.buffer),
          delete t._glBuffers[this.CONTEXT_UID]);
    }
    disposeAll(t) {
      const e = Object.keys(this.managedBuffers);
      for (let i = 0; i < e.length; i++)
        this.dispose(this.managedBuffers[e[i]], t);
    }
    createGLBuffer(t) {
      const { CONTEXT_UID: e, gl: i } = this;
      return (
        (t._glBuffers[e] = new hp(i.createBuffer())),
        (this.managedBuffers[t.id] = t),
        t.disposeRunner.add(this),
        t._glBuffers[e]
      );
    }
  }
  (Qn.extension = { type: D.RendererSystem, name: "buffer" }), U.add(Qn);
  class Jn {
    constructor(t) {
      this.renderer = t;
    }
    render(t, e) {
      const i = this.renderer;
      let s, n, a, o;
      if (
        (e &&
          ((s = e.renderTexture),
          (n = e.clear),
          (a = e.transform),
          (o = e.skipUpdateTransform)),
        (this.renderingToScreen = !s),
        i.runners.prerender.emit(),
        i.emit("prerender"),
        (i.projection.transform = a),
        !i.context.isLost)
      ) {
        if ((s || (this.lastObjectRendered = t), !o)) {
          const h = t.enableTempParent();
          t.updateTransform(), t.disableTempParent(h);
        }
        i.renderTexture.bind(s),
          i.batch.currentRenderer.start(),
          (n != null ? n : i.background.clearBeforeRender) &&
            i.renderTexture.clear(),
          t.render(i),
          i.batch.currentRenderer.flush(),
          s && (e.blit && i.framebuffer.blit(), s.baseTexture.update()),
          i.runners.postrender.emit(),
          (i.projection.transform = null),
          i.emit("postrender");
      }
    }
    destroy() {
      (this.renderer = null), (this.lastObjectRendered = null);
    }
  }
  (Jn.extension = { type: D.RendererSystem, name: "objectRenderer" }),
    U.add(Jn);
  const ss = class ja extends Gh {
    constructor(t) {
      super(),
        (this.type = Hs.WEBGL),
        (t = Object.assign({}, B.RENDER_OPTIONS, t)),
        (this.gl = null),
        (this.CONTEXT_UID = 0),
        (this.globalUniforms = new Gt({ projectionMatrix: new et() }, !0));
      const e = {
        runners: [
          "init",
          "destroy",
          "contextChange",
          "resolutionChange",
          "reset",
          "update",
          "postrender",
          "prerender",
          "resize",
        ],
        systems: ja.__systems,
        priority: [
          "_view",
          "textureGenerator",
          "background",
          "_plugin",
          "startup",
          "context",
          "state",
          "texture",
          "buffer",
          "geometry",
          "framebuffer",
          "transformFeedback",
          "mask",
          "scissor",
          "stencil",
          "projection",
          "textureGC",
          "filter",
          "renderTexture",
          "batch",
          "objectRenderer",
          "_multisample",
        ],
      };
      this.setup(e),
        "useContextAlpha" in t &&
          ((t.premultipliedAlpha =
            t.useContextAlpha && t.useContextAlpha !== "notMultiplied"),
          (t.backgroundAlpha =
            t.useContextAlpha === !1 ? 1 : t.backgroundAlpha)),
        (this._plugin.rendererPlugins = ja.__plugins),
        (this.options = t),
        this.startup.run(this.options);
    }
    static test(t) {
      return t != null && t.forceCanvas ? !1 : Ro();
    }
    render(t, e) {
      this.objectRenderer.render(t, e);
    }
    resize(t, e) {
      this._view.resizeView(t, e);
    }
    reset() {
      return this.runners.reset.emit(), this;
    }
    clear() {
      this.renderTexture.bind(), this.renderTexture.clear();
    }
    destroy(t = !1) {
      this.runners.destroy.items.reverse(),
        this.emitWithCustomOptions(this.runners.destroy, { _view: t }),
        super.destroy();
    }
    get plugins() {
      return this._plugin.plugins;
    }
    get multisample() {
      return this._multisample.multisample;
    }
    get width() {
      return this._view.element.width;
    }
    get height() {
      return this._view.element.height;
    }
    get resolution() {
      return this._view.resolution;
    }
    set resolution(t) {
      (this._view.resolution = t), this.runners.resolutionChange.emit(t);
    }
    get autoDensity() {
      return this._view.autoDensity;
    }
    get view() {
      return this._view.element;
    }
    get screen() {
      return this._view.screen;
    }
    get lastObjectRendered() {
      return this.objectRenderer.lastObjectRendered;
    }
    get renderingToScreen() {
      return this.objectRenderer.renderingToScreen;
    }
    get rendererLogId() {
      return `WebGL ${this.context.webGLVersion}`;
    }
    get clearBeforeRender() {
      return this.background.clearBeforeRender;
    }
    get useContextAlpha() {
      return this.context.useContextAlpha;
    }
    get preserveDrawingBuffer() {
      return this.context.preserveDrawingBuffer;
    }
    get backgroundColor() {
      return this.background.color;
    }
    set backgroundColor(t) {
      this.background.color = t;
    }
    get backgroundAlpha() {
      return this.background.alpha;
    }
    set backgroundAlpha(t) {
      this.background.alpha = t;
    }
    get powerPreference() {
      return this.context.powerPreference;
    }
    generateTexture(t, e) {
      return this.textureGenerator.generateTexture(t, e);
    }
  };
  (ss.extension = { type: D.Renderer, priority: 1 }),
    (ss.__plugins = {}),
    (ss.__systems = {});
  let ns = ss;
  U.handleByMap(D.RendererPlugin, ns.__plugins),
    U.handleByMap(D.RendererSystem, ns.__systems),
    U.add(ns);
  class ta extends ar {
    constructor(t, e) {
      const { width: i, height: s } = e || {};
      super(i, s), (this.items = []), (this.itemDirtyIds = []);
      for (let n = 0; n < t; n++) {
        const a = new j();
        this.items.push(a), this.itemDirtyIds.push(-2);
      }
      (this.length = t), (this._load = null), (this.baseTexture = null);
    }
    initFromArray(t, e) {
      for (let i = 0; i < this.length; i++)
        t[i] &&
          (t[i].castToBaseTexture
            ? this.addBaseTextureAt(t[i].castToBaseTexture(), i)
            : t[i] instanceof ar
            ? this.addResourceAt(t[i], i)
            : this.addResourceAt(yn(t[i], e), i));
    }
    dispose() {
      for (let t = 0, e = this.length; t < e; t++) this.items[t].destroy();
      (this.items = null), (this.itemDirtyIds = null), (this._load = null);
    }
    addResourceAt(t, e) {
      if (!this.items[e]) throw new Error(`Index ${e} is out of bounds`);
      return (
        t.valid && !this.valid && this.resize(t.width, t.height),
        this.items[e].setResource(t),
        this
      );
    }
    bind(t) {
      if (this.baseTexture !== null)
        throw new Error("Only one base texture per TextureArray is allowed");
      super.bind(t);
      for (let e = 0; e < this.length; e++)
        (this.items[e].parentTextureArray = t),
          this.items[e].on("update", t.update, t);
    }
    unbind(t) {
      super.unbind(t);
      for (let e = 0; e < this.length; e++)
        (this.items[e].parentTextureArray = null),
          this.items[e].off("update", t.update, t);
    }
    load() {
      if (this._load) return this._load;
      const t = this.items
        .map((e) => e.resource)
        .filter((e) => e)
        .map((e) => e.load());
      return (
        (this._load = Promise.all(t).then(() => {
          const { realWidth: e, realHeight: i } = this.items[0];
          return this.resize(e, i), this.update(), Promise.resolve(this);
        })),
        this._load
      );
    }
  }
  class Wh extends ta {
    constructor(t, e) {
      const { width: i, height: s } = e || {};
      let n, a;
      Array.isArray(t) ? ((n = t), (a = t.length)) : (a = t),
        super(a, { width: i, height: s }),
        n && this.initFromArray(n, e);
    }
    addBaseTextureAt(t, e) {
      if (t.resource) this.addResourceAt(t.resource, e);
      else throw new Error("ArrayResource does not support RenderTexture");
      return this;
    }
    bind(t) {
      super.bind(t), (t.target = ke.TEXTURE_2D_ARRAY);
    }
    upload(t, e, i) {
      const { length: s, itemDirtyIds: n, items: a } = this,
        { gl: o } = t;
      i.dirtyId < 0 &&
        o.texImage3D(
          o.TEXTURE_2D_ARRAY,
          0,
          i.internalFormat,
          this._width,
          this._height,
          s,
          0,
          e.format,
          i.type,
          null
        );
      for (let h = 0; h < s; h++) {
        const l = a[h];
        n[h] < l.dirtyId &&
          ((n[h] = l.dirtyId),
          l.valid &&
            o.texSubImage3D(
              o.TEXTURE_2D_ARRAY,
              0,
              0,
              0,
              h,
              l.resource.width,
              l.resource.height,
              1,
              e.format,
              i.type,
              l.resource.source
            ));
      }
      return !0;
    }
  }
  class Yh extends ne {
    constructor(t) {
      super(t);
    }
    static test(t) {
      const { OffscreenCanvas: e } = globalThis;
      return e && t instanceof e
        ? !0
        : globalThis.HTMLCanvasElement && t instanceof HTMLCanvasElement;
    }
  }
  const qh = class Ei extends ta {
    constructor(t, e) {
      const { width: i, height: s, autoLoad: n, linkBaseTexture: a } = e || {};
      if (t && t.length !== Ei.SIDES)
        throw new Error(`Invalid length. Got ${t.length}, expected 6`);
      super(6, { width: i, height: s });
      for (let o = 0; o < Ei.SIDES; o++)
        this.items[o].target = ke.TEXTURE_CUBE_MAP_POSITIVE_X + o;
      (this.linkBaseTexture = a !== !1),
        t && this.initFromArray(t, e),
        n !== !1 && this.load();
    }
    bind(t) {
      super.bind(t), (t.target = ke.TEXTURE_CUBE_MAP);
    }
    addBaseTextureAt(t, e, i) {
      if ((i === void 0 && (i = this.linkBaseTexture), !this.items[e]))
        throw new Error(`Index ${e} is out of bounds`);
      if (
        !this.linkBaseTexture ||
        t.parentTextureArray ||
        Object.keys(t._glTextures).length > 0
      )
        if (t.resource) this.addResourceAt(t.resource, e);
        else
          throw new Error(
            "CubeResource does not support copying of renderTexture."
          );
      else
        (t.target = ke.TEXTURE_CUBE_MAP_POSITIVE_X + e),
          (t.parentTextureArray = this.baseTexture),
          (this.items[e] = t);
      return (
        t.valid && !this.valid && this.resize(t.realWidth, t.realHeight),
        (this.items[e] = t),
        this
      );
    }
    upload(t, e, i) {
      const s = this.itemDirtyIds;
      for (let n = 0; n < Ei.SIDES; n++) {
        const a = this.items[n];
        (s[n] < a.dirtyId || i.dirtyId < e.dirtyId) &&
          (a.valid && a.resource
            ? (a.resource.upload(t, a, i), (s[n] = a.dirtyId))
            : s[n] < -1 &&
              (t.gl.texImage2D(
                a.target,
                0,
                i.internalFormat,
                e.realWidth,
                e.realHeight,
                0,
                e.format,
                i.type,
                null
              ),
              (s[n] = -1)));
      }
      return !0;
    }
    static test(t) {
      return Array.isArray(t) && t.length === Ei.SIDES;
    }
  };
  qh.SIDES = 6;
  let Kh = qh;
  class Ke extends ne {
    constructor(t, e) {
      var i, s;
      e = e || {};
      let n, a, o;
      typeof t == "string"
        ? ((n = Ke.EMPTY), (a = t), (o = !0))
        : ((n = t), (a = null), (o = !1)),
        super(n),
        (this.url = a),
        (this.crossOrigin = (i = e.crossOrigin) != null ? i : !0),
        (this.alphaMode = typeof e.alphaMode == "number" ? e.alphaMode : null),
        (this.ownsImageBitmap = (s = e.ownsImageBitmap) != null ? s : o),
        (this._load = null),
        e.autoLoad !== !1 && this.load();
    }
    load() {
      return this._load
        ? this._load
        : ((this._load = new Promise(async (t, e) => {
            if (this.url === null) {
              t(this);
              return;
            }
            try {
              const i = await B.ADAPTER.fetch(this.url, {
                mode: this.crossOrigin ? "cors" : "no-cors",
              });
              if (this.destroyed) return;
              const s = await i.blob();
              if (this.destroyed) return;
              const n = await createImageBitmap(s, {
                premultiplyAlpha:
                  this.alphaMode === null || this.alphaMode === wt.UNPACK
                    ? "premultiply"
                    : "none",
              });
              if (this.destroyed) {
                n.close();
                return;
              }
              (this.source = n), this.update(), t(this);
            } catch (i) {
              if (this.destroyed) return;
              e(i), this.onError.emit(i);
            }
          })),
          this._load);
    }
    upload(t, e, i) {
      return this.source instanceof ImageBitmap
        ? (typeof this.alphaMode == "number" && (e.alphaMode = this.alphaMode),
          super.upload(t, e, i))
        : (this.load(), !1);
    }
    dispose() {
      this.ownsImageBitmap &&
        this.source instanceof ImageBitmap &&
        this.source.close(),
        super.dispose(),
        (this._load = null);
    }
    static test(t) {
      return (
        !!globalThis.createImageBitmap &&
        typeof ImageBitmap != "undefined" &&
        (typeof t == "string" || t instanceof ImageBitmap)
      );
    }
    static get EMPTY() {
      var t;
      return (
        (Ke._EMPTY =
          (t = Ke._EMPTY) != null ? t : B.ADAPTER.createCanvas(0, 0)),
        Ke._EMPTY
      );
    }
  }
  const ea = class Gs extends ne {
    constructor(t, e) {
      (e = e || {}),
        super(B.ADAPTER.createCanvas()),
        (this._width = 0),
        (this._height = 0),
        (this.svg = t),
        (this.scale = e.scale || 1),
        (this._overrideWidth = e.width),
        (this._overrideHeight = e.height),
        (this._resolve = null),
        (this._crossorigin = e.crossorigin),
        (this._load = null),
        e.autoLoad !== !1 && this.load();
    }
    load() {
      return this._load
        ? this._load
        : ((this._load = new Promise((t) => {
            if (
              ((this._resolve = () => {
                this.update(), t(this);
              }),
              Gs.SVG_XML.test(this.svg.trim()))
            ) {
              if (!btoa)
                throw new Error(
                  "Your browser doesn't support base64 conversions."
                );
              this.svg = `data:image/svg+xml;base64,${btoa(
                unescape(encodeURIComponent(this.svg))
              )}`;
            }
            this._loadSvg();
          })),
          this._load);
    }
    _loadSvg() {
      const t = new Image();
      ne.crossOrigin(t, this.svg, this._crossorigin),
        (t.src = this.svg),
        (t.onerror = (e) => {
          this._resolve && ((t.onerror = null), this.onError.emit(e));
        }),
        (t.onload = () => {
          if (!this._resolve) return;
          const e = t.width,
            i = t.height;
          if (!e || !i)
            throw new Error(
              "The SVG image must have width and height defined (in pixels), canvas API needs them."
            );
          let s = e * this.scale,
            n = i * this.scale;
          (this._overrideWidth || this._overrideHeight) &&
            ((s = this._overrideWidth || (this._overrideHeight / i) * e),
            (n = this._overrideHeight || (this._overrideWidth / e) * i)),
            (s = Math.round(s)),
            (n = Math.round(n));
          const a = this.source;
          (a.width = s),
            (a.height = n),
            (a._pixiId = `canvas_${Ie()}`),
            a.getContext("2d").drawImage(t, 0, 0, e, i, 0, 0, s, n),
            this._resolve(),
            (this._resolve = null);
        });
    }
    static getSize(t) {
      const e = Gs.SVG_SIZE.exec(t),
        i = {};
      return (
        e &&
          ((i[e[1]] = Math.round(parseFloat(e[3]))),
          (i[e[5]] = Math.round(parseFloat(e[7])))),
        i
      );
    }
    dispose() {
      super.dispose(), (this._resolve = null), (this._crossorigin = null);
    }
    static test(t, e) {
      return (
        e === "svg" ||
        (typeof t == "string" && t.startsWith("data:image/svg+xml")) ||
        (typeof t == "string" && Gs.SVG_XML.test(t))
      );
    }
  };
  (ea.SVG_XML = /^(<\?xml[^?]+\?>)?\s*(<!--[^(-->)]*-->)?\s*\<svg/m),
    (ea.SVG_SIZE =
      /<svg[^>]*(?:\s(width|height)=('|")(\d*(?:\.\d+)?)(?:px)?('|"))[^>]*(?:\s(width|height)=('|")(\d*(?:\.\d+)?)(?:px)?('|"))[^>]*>/i);
  let as = ea;
  class lp extends ne {
    constructor(t) {
      super(t);
    }
    static test(t) {
      return !!globalThis.VideoFrame && t instanceof globalThis.VideoFrame;
    }
  }
  const ra = class Wa extends ne {
    constructor(t, e) {
      if (((e = e || {}), !(t instanceof HTMLVideoElement))) {
        const i = document.createElement("video");
        e.autoLoad !== !1 && i.setAttribute("preload", "auto"),
          e.playsinline !== !1 &&
            (i.setAttribute("webkit-playsinline", ""),
            i.setAttribute("playsinline", "")),
          e.muted === !0 && (i.setAttribute("muted", ""), (i.muted = !0)),
          e.loop === !0 && i.setAttribute("loop", ""),
          e.autoPlay !== !1 && i.setAttribute("autoplay", ""),
          typeof t == "string" && (t = [t]);
        const s = t[0].src || t[0];
        ne.crossOrigin(i, s, e.crossorigin);
        for (let n = 0; n < t.length; ++n) {
          const a = document.createElement("source");
          let { src: o, mime: h } = t[n];
          if (((o = o || t[n]), o.startsWith("data:")))
            h = o.slice(5, o.indexOf(";"));
          else if (!o.startsWith("blob:")) {
            const l = o.split("?").shift().toLowerCase(),
              u = l.slice(l.lastIndexOf(".") + 1);
            h = h || Wa.MIME_TYPES[u] || `video/${u}`;
          }
          (a.src = o), h && (a.type = h), i.appendChild(a);
        }
        t = i;
      }
      super(t),
        (this.noSubImage = !0),
        (this._autoUpdate = !0),
        (this._isConnectedToTicker = !1),
        (this._updateFPS = e.updateFPS || 0),
        (this._msToNextUpdate = 0),
        (this.autoPlay = e.autoPlay !== !1),
        (this._videoFrameRequestCallback =
          this._videoFrameRequestCallback.bind(this)),
        (this._videoFrameRequestCallbackHandle = null),
        (this._load = null),
        (this._resolve = null),
        (this._reject = null),
        (this._onCanPlay = this._onCanPlay.bind(this)),
        (this._onError = this._onError.bind(this)),
        (this._onPlayStart = this._onPlayStart.bind(this)),
        (this._onPlayStop = this._onPlayStop.bind(this)),
        (this._onSeeked = this._onSeeked.bind(this)),
        e.autoLoad !== !1 && this.load();
    }
    update(t = 0) {
      if (!this.destroyed) {
        if (this._updateFPS) {
          const e = Tt.shared.elapsedMS * this.source.playbackRate;
          this._msToNextUpdate = Math.floor(this._msToNextUpdate - e);
        }
        (!this._updateFPS || this._msToNextUpdate <= 0) &&
          (super.update(),
          (this._msToNextUpdate = this._updateFPS
            ? Math.floor(1e3 / this._updateFPS)
            : 0));
      }
    }
    _videoFrameRequestCallback() {
      this.update(),
        this.destroyed
          ? (this._videoFrameRequestCallbackHandle = null)
          : (this._videoFrameRequestCallbackHandle =
              this.source.requestVideoFrameCallback(
                this._videoFrameRequestCallback
              ));
    }
    load() {
      if (this._load) return this._load;
      const t = this.source;
      return (
        (t.readyState === t.HAVE_ENOUGH_DATA ||
          t.readyState === t.HAVE_FUTURE_DATA) &&
          t.width &&
          t.height &&
          (t.complete = !0),
        t.addEventListener("play", this._onPlayStart),
        t.addEventListener("pause", this._onPlayStop),
        t.addEventListener("seeked", this._onSeeked),
        this._isSourceReady()
          ? this._onCanPlay()
          : (t.addEventListener("canplay", this._onCanPlay),
            t.addEventListener("canplaythrough", this._onCanPlay),
            t.addEventListener("error", this._onError, !0)),
        (this._load = new Promise((e, i) => {
          this.valid
            ? e(this)
            : ((this._resolve = e), (this._reject = i), t.load());
        })),
        this._load
      );
    }
    _onError(t) {
      this.source.removeEventListener("error", this._onError, !0),
        this.onError.emit(t),
        this._reject &&
          (this._reject(t), (this._reject = null), (this._resolve = null));
    }
    _isSourcePlaying() {
      const t = this.source;
      return !t.paused && !t.ended;
    }
    _isSourceReady() {
      return this.source.readyState > 2;
    }
    _onPlayStart() {
      this.valid || this._onCanPlay(), this._configureAutoUpdate();
    }
    _onPlayStop() {
      this._configureAutoUpdate();
    }
    _onSeeked() {
      this._autoUpdate &&
        !this._isSourcePlaying() &&
        ((this._msToNextUpdate = 0), this.update(), (this._msToNextUpdate = 0));
    }
    _onCanPlay() {
      const t = this.source;
      t.removeEventListener("canplay", this._onCanPlay),
        t.removeEventListener("canplaythrough", this._onCanPlay);
      const e = this.valid;
      (this._msToNextUpdate = 0),
        this.update(),
        (this._msToNextUpdate = 0),
        !e &&
          this._resolve &&
          (this._resolve(this), (this._resolve = null), (this._reject = null)),
        this._isSourcePlaying()
          ? this._onPlayStart()
          : this.autoPlay && t.play();
    }
    dispose() {
      this._configureAutoUpdate();
      const t = this.source;
      t &&
        (t.removeEventListener("play", this._onPlayStart),
        t.removeEventListener("pause", this._onPlayStop),
        t.removeEventListener("seeked", this._onSeeked),
        t.removeEventListener("canplay", this._onCanPlay),
        t.removeEventListener("canplaythrough", this._onCanPlay),
        t.removeEventListener("error", this._onError, !0),
        t.pause(),
        (t.src = ""),
        t.load()),
        super.dispose();
    }
    get autoUpdate() {
      return this._autoUpdate;
    }
    set autoUpdate(t) {
      t !== this._autoUpdate &&
        ((this._autoUpdate = t), this._configureAutoUpdate());
    }
    get updateFPS() {
      return this._updateFPS;
    }
    set updateFPS(t) {
      t !== this._updateFPS &&
        ((this._updateFPS = t), this._configureAutoUpdate());
    }
    _configureAutoUpdate() {
      this._autoUpdate && this._isSourcePlaying()
        ? !this._updateFPS && this.source.requestVideoFrameCallback
          ? (this._isConnectedToTicker &&
              (Tt.shared.remove(this.update, this),
              (this._isConnectedToTicker = !1),
              (this._msToNextUpdate = 0)),
            this._videoFrameRequestCallbackHandle === null &&
              (this._videoFrameRequestCallbackHandle =
                this.source.requestVideoFrameCallback(
                  this._videoFrameRequestCallback
                )))
          : (this._videoFrameRequestCallbackHandle !== null &&
              (this.source.cancelVideoFrameCallback(
                this._videoFrameRequestCallbackHandle
              ),
              (this._videoFrameRequestCallbackHandle = null)),
            this._isConnectedToTicker ||
              (Tt.shared.add(this.update, this),
              (this._isConnectedToTicker = !0),
              (this._msToNextUpdate = 0)))
        : (this._videoFrameRequestCallbackHandle !== null &&
            (this.source.cancelVideoFrameCallback(
              this._videoFrameRequestCallbackHandle
            ),
            (this._videoFrameRequestCallbackHandle = null)),
          this._isConnectedToTicker &&
            (Tt.shared.remove(this.update, this),
            (this._isConnectedToTicker = !1),
            (this._msToNextUpdate = 0)));
    }
    static test(t, e) {
      return (
        (globalThis.HTMLVideoElement && t instanceof HTMLVideoElement) ||
        Wa.TYPES.includes(e)
      );
    }
  };
  (ra.TYPES = ["mp4", "m4v", "webm", "ogg", "ogv", "h264", "avi", "mov"]),
    (ra.MIME_TYPES = {
      ogv: "video/ogg",
      mov: "video/quicktime",
      m4v: "video/mp4",
    });
  let ia = ra;
  ki.push(Ke, Mn, Yh, ia, lp, as, Fr, Kh, Wh);
  class up {
    constructor() {
      (this._glTransformFeedbacks = {}),
        (this.buffers = []),
        (this.disposeRunner = new Nt("disposeTransformFeedback"));
    }
    bindBuffer(t, e) {
      this.buffers[t] = e;
    }
    destroy() {
      this.disposeRunner.emit(this, !1);
    }
  }
  const cp = "7.4.3";
  class qr {
    constructor() {
      (this.minX = 1 / 0),
        (this.minY = 1 / 0),
        (this.maxX = -1 / 0),
        (this.maxY = -1 / 0),
        (this.rect = null),
        (this.updateID = -1);
    }
    isEmpty() {
      return this.minX > this.maxX || this.minY > this.maxY;
    }
    clear() {
      (this.minX = 1 / 0),
        (this.minY = 1 / 0),
        (this.maxX = -1 / 0),
        (this.maxY = -1 / 0);
    }
    getRectangle(t) {
      return this.minX > this.maxX || this.minY > this.maxY
        ? Y.EMPTY
        : ((t = t || new Y(0, 0, 1, 1)),
          (t.x = this.minX),
          (t.y = this.minY),
          (t.width = this.maxX - this.minX),
          (t.height = this.maxY - this.minY),
          t);
    }
    addPoint(t) {
      (this.minX = Math.min(this.minX, t.x)),
        (this.maxX = Math.max(this.maxX, t.x)),
        (this.minY = Math.min(this.minY, t.y)),
        (this.maxY = Math.max(this.maxY, t.y));
    }
    addPointMatrix(t, e) {
      const { a: i, b: s, c: n, d: a, tx: o, ty: h } = t,
        l = i * e.x + n * e.y + o,
        u = s * e.x + a * e.y + h;
      (this.minX = Math.min(this.minX, l)),
        (this.maxX = Math.max(this.maxX, l)),
        (this.minY = Math.min(this.minY, u)),
        (this.maxY = Math.max(this.maxY, u));
    }
    addQuad(t) {
      let e = this.minX,
        i = this.minY,
        s = this.maxX,
        n = this.maxY,
        a = t[0],
        o = t[1];
      (e = a < e ? a : e),
        (i = o < i ? o : i),
        (s = a > s ? a : s),
        (n = o > n ? o : n),
        (a = t[2]),
        (o = t[3]),
        (e = a < e ? a : e),
        (i = o < i ? o : i),
        (s = a > s ? a : s),
        (n = o > n ? o : n),
        (a = t[4]),
        (o = t[5]),
        (e = a < e ? a : e),
        (i = o < i ? o : i),
        (s = a > s ? a : s),
        (n = o > n ? o : n),
        (a = t[6]),
        (o = t[7]),
        (e = a < e ? a : e),
        (i = o < i ? o : i),
        (s = a > s ? a : s),
        (n = o > n ? o : n),
        (this.minX = e),
        (this.minY = i),
        (this.maxX = s),
        (this.maxY = n);
    }
    addFrame(t, e, i, s, n) {
      this.addFrameMatrix(t.worldTransform, e, i, s, n);
    }
    addFrameMatrix(t, e, i, s, n) {
      const a = t.a,
        o = t.b,
        h = t.c,
        l = t.d,
        u = t.tx,
        c = t.ty;
      let d = this.minX,
        f = this.minY,
        p = this.maxX,
        m = this.maxY,
        g = a * e + h * i + u,
        x = o * e + l * i + c;
      (d = g < d ? g : d),
        (f = x < f ? x : f),
        (p = g > p ? g : p),
        (m = x > m ? x : m),
        (g = a * s + h * i + u),
        (x = o * s + l * i + c),
        (d = g < d ? g : d),
        (f = x < f ? x : f),
        (p = g > p ? g : p),
        (m = x > m ? x : m),
        (g = a * e + h * n + u),
        (x = o * e + l * n + c),
        (d = g < d ? g : d),
        (f = x < f ? x : f),
        (p = g > p ? g : p),
        (m = x > m ? x : m),
        (g = a * s + h * n + u),
        (x = o * s + l * n + c),
        (d = g < d ? g : d),
        (f = x < f ? x : f),
        (p = g > p ? g : p),
        (m = x > m ? x : m),
        (this.minX = d),
        (this.minY = f),
        (this.maxX = p),
        (this.maxY = m);
    }
    addVertexData(t, e, i) {
      let s = this.minX,
        n = this.minY,
        a = this.maxX,
        o = this.maxY;
      for (let h = e; h < i; h += 2) {
        const l = t[h],
          u = t[h + 1];
        (s = l < s ? l : s),
          (n = u < n ? u : n),
          (a = l > a ? l : a),
          (o = u > o ? u : o);
      }
      (this.minX = s), (this.minY = n), (this.maxX = a), (this.maxY = o);
    }
    addVertices(t, e, i, s) {
      this.addVerticesMatrix(t.worldTransform, e, i, s);
    }
    addVerticesMatrix(t, e, i, s, n = 0, a = n) {
      const o = t.a,
        h = t.b,
        l = t.c,
        u = t.d,
        c = t.tx,
        d = t.ty;
      let f = this.minX,
        p = this.minY,
        m = this.maxX,
        g = this.maxY;
      for (let x = i; x < s; x += 2) {
        const b = e[x],
          _ = e[x + 1],
          y = o * b + l * _ + c,
          T = u * _ + h * b + d;
        (f = Math.min(f, y - n)),
          (m = Math.max(m, y + n)),
          (p = Math.min(p, T - a)),
          (g = Math.max(g, T + a));
      }
      (this.minX = f), (this.minY = p), (this.maxX = m), (this.maxY = g);
    }
    addBounds(t) {
      const e = this.minX,
        i = this.minY,
        s = this.maxX,
        n = this.maxY;
      (this.minX = t.minX < e ? t.minX : e),
        (this.minY = t.minY < i ? t.minY : i),
        (this.maxX = t.maxX > s ? t.maxX : s),
        (this.maxY = t.maxY > n ? t.maxY : n);
    }
    addBoundsMask(t, e) {
      const i = t.minX > e.minX ? t.minX : e.minX,
        s = t.minY > e.minY ? t.minY : e.minY,
        n = t.maxX < e.maxX ? t.maxX : e.maxX,
        a = t.maxY < e.maxY ? t.maxY : e.maxY;
      if (i <= n && s <= a) {
        const o = this.minX,
          h = this.minY,
          l = this.maxX,
          u = this.maxY;
        (this.minX = i < o ? i : o),
          (this.minY = s < h ? s : h),
          (this.maxX = n > l ? n : l),
          (this.maxY = a > u ? a : u);
      }
    }
    addBoundsMatrix(t, e) {
      this.addFrameMatrix(e, t.minX, t.minY, t.maxX, t.maxY);
    }
    addBoundsArea(t, e) {
      const i = t.minX > e.x ? t.minX : e.x,
        s = t.minY > e.y ? t.minY : e.y,
        n = t.maxX < e.x + e.width ? t.maxX : e.x + e.width,
        a = t.maxY < e.y + e.height ? t.maxY : e.y + e.height;
      if (i <= n && s <= a) {
        const o = this.minX,
          h = this.minY,
          l = this.maxX,
          u = this.maxY;
        (this.minX = i < o ? i : o),
          (this.minY = s < h ? s : h),
          (this.maxX = n > l ? n : l),
          (this.maxY = a > u ? a : u);
      }
    }
    pad(t = 0, e = t) {
      this.isEmpty() ||
        ((this.minX -= t),
        (this.maxX += t),
        (this.minY -= e),
        (this.maxY += e));
    }
    addFramePad(t, e, i, s, n, a) {
      (t -= n),
        (e -= a),
        (i += n),
        (s += a),
        (this.minX = this.minX < t ? this.minX : t),
        (this.maxX = this.maxX > i ? this.maxX : i),
        (this.minY = this.minY < e ? this.minY : e),
        (this.maxY = this.maxY > s ? this.maxY : s);
    }
  }
  class at extends Sr {
    constructor() {
      super(),
        (this.tempDisplayObjectParent = null),
        (this.transform = new ji()),
        (this.alpha = 1),
        (this.visible = !0),
        (this.renderable = !0),
        (this.cullable = !1),
        (this.cullArea = null),
        (this.parent = null),
        (this.worldAlpha = 1),
        (this._lastSortedIndex = 0),
        (this._zIndex = 0),
        (this.filterArea = null),
        (this.filters = null),
        (this._enabledFilters = null),
        (this._bounds = new qr()),
        (this._localBounds = null),
        (this._boundsID = 0),
        (this._boundsRect = null),
        (this._localBoundsRect = null),
        (this._mask = null),
        (this._maskRefCount = 0),
        (this._destroyed = !1),
        (this.isSprite = !1),
        (this.isMask = !1);
    }
    static mixin(t) {
      const e = Object.keys(t);
      for (let i = 0; i < e.length; ++i) {
        const s = e[i];
        Object.defineProperty(
          at.prototype,
          s,
          Object.getOwnPropertyDescriptor(t, s)
        );
      }
    }
    get destroyed() {
      return this._destroyed;
    }
    _recursivePostUpdateTransform() {
      this.parent
        ? (this.parent._recursivePostUpdateTransform(),
          this.transform.updateTransform(this.parent.transform))
        : this.transform.updateTransform(
            this._tempDisplayObjectParent.transform
          );
    }
    updateTransform() {
      this._boundsID++,
        this.transform.updateTransform(this.parent.transform),
        (this.worldAlpha = this.alpha * this.parent.worldAlpha);
    }
    getBounds(t, e) {
      return (
        t ||
          (this.parent
            ? (this._recursivePostUpdateTransform(), this.updateTransform())
            : ((this.parent = this._tempDisplayObjectParent),
              this.updateTransform(),
              (this.parent = null))),
        this._bounds.updateID !== this._boundsID &&
          (this.calculateBounds(), (this._bounds.updateID = this._boundsID)),
        e ||
          (this._boundsRect || (this._boundsRect = new Y()),
          (e = this._boundsRect)),
        this._bounds.getRectangle(e)
      );
    }
    getLocalBounds(t) {
      var e;
      t ||
        (this._localBoundsRect || (this._localBoundsRect = new Y()),
        (t = this._localBoundsRect)),
        this._localBounds || (this._localBounds = new qr());
      const i = this.transform,
        s = this.parent;
      (this.parent = null),
        (this._tempDisplayObjectParent.worldAlpha =
          (e = s == null ? void 0 : s.worldAlpha) != null ? e : 1),
        (this.transform = this._tempDisplayObjectParent.transform);
      const n = this._bounds,
        a = this._boundsID;
      this._bounds = this._localBounds;
      const o = this.getBounds(!1, t);
      return (
        (this.parent = s),
        (this.transform = i),
        (this._bounds = n),
        (this._bounds.updateID += this._boundsID - a),
        o
      );
    }
    toGlobal(t, e, i = !1) {
      return (
        i ||
          (this._recursivePostUpdateTransform(),
          this.parent
            ? this.displayObjectUpdateTransform()
            : ((this.parent = this._tempDisplayObjectParent),
              this.displayObjectUpdateTransform(),
              (this.parent = null))),
        this.worldTransform.apply(t, e)
      );
    }
    toLocal(t, e, i, s) {
      return (
        e && (t = e.toGlobal(t, i, s)),
        s ||
          (this._recursivePostUpdateTransform(),
          this.parent
            ? this.displayObjectUpdateTransform()
            : ((this.parent = this._tempDisplayObjectParent),
              this.displayObjectUpdateTransform(),
              (this.parent = null))),
        this.worldTransform.applyInverse(t, i)
      );
    }
    setParent(t) {
      if (!t || !t.addChild)
        throw new Error("setParent: Argument must be a Container");
      return t.addChild(this), t;
    }
    removeFromParent() {
      var t;
      (t = this.parent) == null || t.removeChild(this);
    }
    setTransform(
      t = 0,
      e = 0,
      i = 1,
      s = 1,
      n = 0,
      a = 0,
      o = 0,
      h = 0,
      l = 0
    ) {
      return (
        (this.position.x = t),
        (this.position.y = e),
        (this.scale.x = i || 1),
        (this.scale.y = s || 1),
        (this.rotation = n),
        (this.skew.x = a),
        (this.skew.y = o),
        (this.pivot.x = h),
        (this.pivot.y = l),
        this
      );
    }
    destroy(t) {
      this.removeFromParent(),
        (this._destroyed = !0),
        (this.transform = null),
        (this.parent = null),
        (this._bounds = null),
        (this.mask = null),
        (this.cullArea = null),
        (this.filters = null),
        (this.filterArea = null),
        (this.hitArea = null),
        (this.eventMode = "auto"),
        (this.interactiveChildren = !1),
        this.emit("destroyed"),
        this.removeAllListeners();
    }
    get _tempDisplayObjectParent() {
      return (
        this.tempDisplayObjectParent === null &&
          (this.tempDisplayObjectParent = new Zh()),
        this.tempDisplayObjectParent
      );
    }
    enableTempParent() {
      const t = this.parent;
      return (this.parent = this._tempDisplayObjectParent), t;
    }
    disableTempParent(t) {
      this.parent = t;
    }
    get x() {
      return this.position.x;
    }
    set x(t) {
      this.transform.position.x = t;
    }
    get y() {
      return this.position.y;
    }
    set y(t) {
      this.transform.position.y = t;
    }
    get worldTransform() {
      return this.transform.worldTransform;
    }
    get localTransform() {
      return this.transform.localTransform;
    }
    get position() {
      return this.transform.position;
    }
    set position(t) {
      this.transform.position.copyFrom(t);
    }
    get scale() {
      return this.transform.scale;
    }
    set scale(t) {
      this.transform.scale.copyFrom(t);
    }
    get pivot() {
      return this.transform.pivot;
    }
    set pivot(t) {
      this.transform.pivot.copyFrom(t);
    }
    get skew() {
      return this.transform.skew;
    }
    set skew(t) {
      this.transform.skew.copyFrom(t);
    }
    get rotation() {
      return this.transform.rotation;
    }
    set rotation(t) {
      this.transform.rotation = t;
    }
    get angle() {
      return this.transform.rotation * ih;
    }
    set angle(t) {
      this.transform.rotation = t * sh;
    }
    get zIndex() {
      return this._zIndex;
    }
    set zIndex(t) {
      this._zIndex !== t &&
        ((this._zIndex = t), this.parent && (this.parent.sortDirty = !0));
    }
    get worldVisible() {
      let t = this;
      do {
        if (!t.visible) return !1;
        t = t.parent;
      } while (t);
      return !0;
    }
    get mask() {
      return this._mask;
    }
    set mask(t) {
      if (this._mask !== t) {
        if (this._mask) {
          const e = this._mask.isMaskData ? this._mask.maskObject : this._mask;
          e &&
            (e._maskRefCount--,
            e._maskRefCount === 0 && ((e.renderable = !0), (e.isMask = !1)));
        }
        if (((this._mask = t), this._mask)) {
          const e = this._mask.isMaskData ? this._mask.maskObject : this._mask;
          e &&
            (e._maskRefCount === 0 && ((e.renderable = !1), (e.isMask = !0)),
            e._maskRefCount++);
        }
      }
    }
  }
  class Zh extends at {
    constructor() {
      super(...arguments), (this.sortDirty = null);
    }
  }
  at.prototype.displayObjectUpdateTransform = at.prototype.updateTransform;
  const dp = new et();
  function fp(r, t) {
    return r.zIndex === t.zIndex
      ? r._lastSortedIndex - t._lastSortedIndex
      : r.zIndex - t.zIndex;
  }
  const Qh = class Ya extends at {
    constructor() {
      super(),
        (this.children = []),
        (this.sortableChildren = Ya.defaultSortableChildren),
        (this.sortDirty = !1);
    }
    onChildrenChange(t) {}
    addChild(...t) {
      if (t.length > 1) for (let e = 0; e < t.length; e++) this.addChild(t[e]);
      else {
        const e = t[0];
        e.parent && e.parent.removeChild(e),
          (e.parent = this),
          (this.sortDirty = !0),
          (e.transform._parentID = -1),
          this.children.push(e),
          this._boundsID++,
          this.onChildrenChange(this.children.length - 1),
          this.emit("childAdded", e, this, this.children.length - 1),
          e.emit("added", this);
      }
      return t[0];
    }
    addChildAt(t, e) {
      if (e < 0 || e > this.children.length)
        throw new Error(
          `${t}addChildAt: The index ${e} supplied is out of bounds ${this.children.length}`
        );
      return (
        t.parent && t.parent.removeChild(t),
        (t.parent = this),
        (this.sortDirty = !0),
        (t.transform._parentID = -1),
        this.children.splice(e, 0, t),
        this._boundsID++,
        this.onChildrenChange(e),
        t.emit("added", this),
        this.emit("childAdded", t, this, e),
        t
      );
    }
    swapChildren(t, e) {
      if (t === e) return;
      const i = this.getChildIndex(t),
        s = this.getChildIndex(e);
      (this.children[i] = e),
        (this.children[s] = t),
        this.onChildrenChange(i < s ? i : s);
    }
    getChildIndex(t) {
      const e = this.children.indexOf(t);
      if (e === -1)
        throw new Error(
          "The supplied DisplayObject must be a child of the caller"
        );
      return e;
    }
    setChildIndex(t, e) {
      if (e < 0 || e >= this.children.length)
        throw new Error(
          `The index ${e} supplied is out of bounds ${this.children.length}`
        );
      const i = this.getChildIndex(t);
      nr(this.children, i, 1),
        this.children.splice(e, 0, t),
        this.onChildrenChange(e);
    }
    getChildAt(t) {
      if (t < 0 || t >= this.children.length)
        throw new Error(`getChildAt: Index (${t}) does not exist.`);
      return this.children[t];
    }
    removeChild(...t) {
      if (t.length > 1)
        for (let e = 0; e < t.length; e++) this.removeChild(t[e]);
      else {
        const e = t[0],
          i = this.children.indexOf(e);
        if (i === -1) return null;
        (e.parent = null),
          (e.transform._parentID = -1),
          nr(this.children, i, 1),
          this._boundsID++,
          this.onChildrenChange(i),
          e.emit("removed", this),
          this.emit("childRemoved", e, this, i);
      }
      return t[0];
    }
    removeChildAt(t) {
      const e = this.getChildAt(t);
      return (
        (e.parent = null),
        (e.transform._parentID = -1),
        nr(this.children, t, 1),
        this._boundsID++,
        this.onChildrenChange(t),
        e.emit("removed", this),
        this.emit("childRemoved", e, this, t),
        e
      );
    }
    removeChildren(t = 0, e = this.children.length) {
      const i = t,
        s = e,
        n = s - i;
      let a;
      if (n > 0 && n <= s) {
        a = this.children.splice(i, n);
        for (let o = 0; o < a.length; ++o)
          (a[o].parent = null),
            a[o].transform && (a[o].transform._parentID = -1);
        this._boundsID++, this.onChildrenChange(t);
        for (let o = 0; o < a.length; ++o)
          a[o].emit("removed", this), this.emit("childRemoved", a[o], this, o);
        return a;
      } else if (n === 0 && this.children.length === 0) return [];
      throw new RangeError(
        "removeChildren: numeric values are outside the acceptable range."
      );
    }
    sortChildren() {
      let t = !1;
      for (let e = 0, i = this.children.length; e < i; ++e) {
        const s = this.children[e];
        (s._lastSortedIndex = e), !t && s.zIndex !== 0 && (t = !0);
      }
      t && this.children.length > 1 && this.children.sort(fp),
        (this.sortDirty = !1);
    }
    updateTransform() {
      this.sortableChildren && this.sortDirty && this.sortChildren(),
        this._boundsID++,
        this.transform.updateTransform(this.parent.transform),
        (this.worldAlpha = this.alpha * this.parent.worldAlpha);
      for (let t = 0, e = this.children.length; t < e; ++t) {
        const i = this.children[t];
        i.visible && i.updateTransform();
      }
    }
    calculateBounds() {
      this._bounds.clear(), this._calculateBounds();
      for (let t = 0; t < this.children.length; t++) {
        const e = this.children[t];
        if (!(!e.visible || !e.renderable))
          if ((e.calculateBounds(), e._mask)) {
            const i = e._mask.isMaskData ? e._mask.maskObject : e._mask;
            i
              ? (i.calculateBounds(),
                this._bounds.addBoundsMask(e._bounds, i._bounds))
              : this._bounds.addBounds(e._bounds);
          } else
            e.filterArea
              ? this._bounds.addBoundsArea(e._bounds, e.filterArea)
              : this._bounds.addBounds(e._bounds);
      }
      this._bounds.updateID = this._boundsID;
    }
    getLocalBounds(t, e = !1) {
      const i = super.getLocalBounds(t);
      if (!e)
        for (let s = 0, n = this.children.length; s < n; ++s) {
          const a = this.children[s];
          a.visible && a.updateTransform();
        }
      return i;
    }
    _calculateBounds() {}
    _renderWithCulling(t) {
      const e = t.renderTexture.sourceFrame;
      if (!(e.width > 0 && e.height > 0)) return;
      let i, s;
      this.cullArea
        ? ((i = this.cullArea), (s = this.worldTransform))
        : this._render !== Ya.prototype._render && (i = this.getBounds(!0));
      const n = t.projection.transform;
      if (
        (n && (s ? ((s = dp.copyFrom(s)), s.prepend(n)) : (s = n)),
        i && e.intersects(i, s))
      )
        this._render(t);
      else if (this.cullArea) return;
      for (let a = 0, o = this.children.length; a < o; ++a) {
        const h = this.children[a],
          l = h.cullable;
        (h.cullable = l || !this.cullArea), h.render(t), (h.cullable = l);
      }
    }
    render(t) {
      var e;
      if (!(!this.visible || this.worldAlpha <= 0 || !this.renderable))
        if (this._mask || ((e = this.filters) != null && e.length))
          this.renderAdvanced(t);
        else if (this.cullable) this._renderWithCulling(t);
        else {
          this._render(t);
          for (let i = 0, s = this.children.length; i < s; ++i)
            this.children[i].render(t);
        }
    }
    renderAdvanced(t) {
      var e, i, s;
      const n = this.filters,
        a = this._mask;
      if (n) {
        this._enabledFilters || (this._enabledFilters = []),
          (this._enabledFilters.length = 0);
        for (let h = 0; h < n.length; h++)
          n[h].enabled && this._enabledFilters.push(n[h]);
      }
      const o =
        (n && ((e = this._enabledFilters) == null ? void 0 : e.length)) ||
        (a &&
          (!a.isMaskData ||
            (a.enabled && (a.autoDetect || a.type !== ut.NONE))));
      if (
        (o && t.batch.flush(),
        n &&
          (i = this._enabledFilters) != null &&
          i.length &&
          t.filter.push(this, this._enabledFilters),
        a && t.mask.push(this, this._mask),
        this.cullable)
      )
        this._renderWithCulling(t);
      else {
        this._render(t);
        for (let h = 0, l = this.children.length; h < l; ++h)
          this.children[h].render(t);
      }
      o && t.batch.flush(),
        a && t.mask.pop(this),
        n && (s = this._enabledFilters) != null && s.length && t.filter.pop();
    }
    _render(t) {}
    destroy(t) {
      super.destroy(), (this.sortDirty = !1);
      const e = typeof t == "boolean" ? t : t == null ? void 0 : t.children,
        i = this.removeChildren(0, this.children.length);
      if (e) for (let s = 0; s < i.length; ++s) i[s].destroy(t);
    }
    get width() {
      return this.scale.x * this.getLocalBounds().width;
    }
    set width(t) {
      const e = this.getLocalBounds().width;
      e !== 0 ? (this.scale.x = t / e) : (this.scale.x = 1), (this._width = t);
    }
    get height() {
      return this.scale.y * this.getLocalBounds().height;
    }
    set height(t) {
      const e = this.getLocalBounds().height;
      e !== 0 ? (this.scale.y = t / e) : (this.scale.y = 1), (this._height = t);
    }
  };
  Qh.defaultSortableChildren = !1;
  let Ot = Qh;
  (Ot.prototype.containerUpdateTransform = Ot.prototype.updateTransform),
    Object.defineProperties(B, {
      SORTABLE_CHILDREN: {
        get() {
          return Ot.defaultSortableChildren;
        },
        set(r) {
          Ot.defaultSortableChildren = r;
        },
      },
    });
  const Kr = new tt(),
    pp = new Uint16Array([0, 1, 2, 0, 2, 3]);
  class Ne extends Ot {
    constructor(t) {
      super(),
        (this._anchor = new ge(
          this._onAnchorUpdate,
          this,
          t ? t.defaultAnchor.x : 0,
          t ? t.defaultAnchor.y : 0
        )),
        (this._texture = null),
        (this._width = 0),
        (this._height = 0),
        (this._tintColor = new K(16777215)),
        (this._tintRGB = null),
        (this.tint = 16777215),
        (this.blendMode = X.NORMAL),
        (this._cachedTint = 16777215),
        (this.uvs = null),
        (this.texture = t || O.EMPTY),
        (this.vertexData = new Float32Array(8)),
        (this.vertexTrimmedData = null),
        (this._transformID = -1),
        (this._textureID = -1),
        (this._transformTrimmedID = -1),
        (this._textureTrimmedID = -1),
        (this.indices = pp),
        (this.pluginName = "batch"),
        (this.isSprite = !0),
        (this._roundPixels = B.ROUND_PIXELS);
    }
    _onTextureUpdate() {
      (this._textureID = -1),
        (this._textureTrimmedID = -1),
        (this._cachedTint = 16777215),
        this._width &&
          (this.scale.x =
            (He(this.scale.x) * this._width) / this._texture.orig.width),
        this._height &&
          (this.scale.y =
            (He(this.scale.y) * this._height) / this._texture.orig.height);
    }
    _onAnchorUpdate() {
      (this._transformID = -1), (this._transformTrimmedID = -1);
    }
    calculateVertices() {
      const t = this._texture;
      if (
        this._transformID === this.transform._worldID &&
        this._textureID === t._updateID
      )
        return;
      this._textureID !== t._updateID &&
        (this.uvs = this._texture._uvs.uvsFloat32),
        (this._transformID = this.transform._worldID),
        (this._textureID = t._updateID);
      const e = this.transform.worldTransform,
        i = e.a,
        s = e.b,
        n = e.c,
        a = e.d,
        o = e.tx,
        h = e.ty,
        l = this.vertexData,
        u = t.trim,
        c = t.orig,
        d = this._anchor;
      let f = 0,
        p = 0,
        m = 0,
        g = 0;
      if (
        (u
          ? ((p = u.x - d._x * c.width),
            (f = p + u.width),
            (g = u.y - d._y * c.height),
            (m = g + u.height))
          : ((p = -d._x * c.width),
            (f = p + c.width),
            (g = -d._y * c.height),
            (m = g + c.height)),
        (l[0] = i * p + n * g + o),
        (l[1] = a * g + s * p + h),
        (l[2] = i * f + n * g + o),
        (l[3] = a * g + s * f + h),
        (l[4] = i * f + n * m + o),
        (l[5] = a * m + s * f + h),
        (l[6] = i * p + n * m + o),
        (l[7] = a * m + s * p + h),
        this._roundPixels)
      ) {
        const x = B.RESOLUTION;
        for (let b = 0; b < l.length; ++b) l[b] = Math.round(l[b] * x) / x;
      }
    }
    calculateTrimmedVertices() {
      if (!this.vertexTrimmedData) this.vertexTrimmedData = new Float32Array(8);
      else if (
        this._transformTrimmedID === this.transform._worldID &&
        this._textureTrimmedID === this._texture._updateID
      )
        return;
      (this._transformTrimmedID = this.transform._worldID),
        (this._textureTrimmedID = this._texture._updateID);
      const t = this._texture,
        e = this.vertexTrimmedData,
        i = t.orig,
        s = this._anchor,
        n = this.transform.worldTransform,
        a = n.a,
        o = n.b,
        h = n.c,
        l = n.d,
        u = n.tx,
        c = n.ty,
        d = -s._x * i.width,
        f = d + i.width,
        p = -s._y * i.height,
        m = p + i.height;
      if (
        ((e[0] = a * d + h * p + u),
        (e[1] = l * p + o * d + c),
        (e[2] = a * f + h * p + u),
        (e[3] = l * p + o * f + c),
        (e[4] = a * f + h * m + u),
        (e[5] = l * m + o * f + c),
        (e[6] = a * d + h * m + u),
        (e[7] = l * m + o * d + c),
        this._roundPixels)
      ) {
        const g = B.RESOLUTION;
        for (let x = 0; x < e.length; ++x) e[x] = Math.round(e[x] * g) / g;
      }
    }
    _render(t) {
      this.calculateVertices(),
        t.batch.setObjectRenderer(t.plugins[this.pluginName]),
        t.plugins[this.pluginName].render(this);
    }
    _calculateBounds() {
      const t = this._texture.trim,
        e = this._texture.orig;
      !t || (t.width === e.width && t.height === e.height)
        ? (this.calculateVertices(), this._bounds.addQuad(this.vertexData))
        : (this.calculateTrimmedVertices(),
          this._bounds.addQuad(this.vertexTrimmedData));
    }
    getLocalBounds(t) {
      return this.children.length === 0
        ? (this._localBounds || (this._localBounds = new qr()),
          (this._localBounds.minX =
            this._texture.orig.width * -this._anchor._x),
          (this._localBounds.minY =
            this._texture.orig.height * -this._anchor._y),
          (this._localBounds.maxX =
            this._texture.orig.width * (1 - this._anchor._x)),
          (this._localBounds.maxY =
            this._texture.orig.height * (1 - this._anchor._y)),
          t ||
            (this._localBoundsRect || (this._localBoundsRect = new Y()),
            (t = this._localBoundsRect)),
          this._localBounds.getRectangle(t))
        : super.getLocalBounds.call(this, t);
    }
    containsPoint(t) {
      this.worldTransform.applyInverse(t, Kr);
      const e = this._texture.orig.width,
        i = this._texture.orig.height,
        s = -e * this.anchor.x;
      let n = 0;
      return (
        Kr.x >= s &&
        Kr.x < s + e &&
        ((n = -i * this.anchor.y), Kr.y >= n && Kr.y < n + i)
      );
    }
    destroy(t) {
      if (
        (super.destroy(t),
        this._texture.off("update", this._onTextureUpdate, this),
        (this._anchor = null),
        typeof t == "boolean" ? t : t == null ? void 0 : t.texture)
      ) {
        const e =
          typeof t == "boolean" ? t : t == null ? void 0 : t.baseTexture;
        this._texture.destroy(!!e);
      }
      this._texture = null;
    }
    static from(t, e) {
      const i = t instanceof O ? t : O.from(t, e);
      return new Ne(i);
    }
    set roundPixels(t) {
      this._roundPixels !== t &&
        ((this._transformID = -1), (this._transformTrimmedID = -1)),
        (this._roundPixels = t);
    }
    get roundPixels() {
      return this._roundPixels;
    }
    get width() {
      return Math.abs(this.scale.x) * this._texture.orig.width;
    }
    set width(t) {
      const e = He(this.scale.x) || 1;
      (this.scale.x = (e * t) / this._texture.orig.width), (this._width = t);
    }
    get height() {
      return Math.abs(this.scale.y) * this._texture.orig.height;
    }
    set height(t) {
      const e = He(this.scale.y) || 1;
      (this.scale.y = (e * t) / this._texture.orig.height), (this._height = t);
    }
    get anchor() {
      return this._anchor;
    }
    set anchor(t) {
      this._anchor.copyFrom(t);
    }
    get tint() {
      return this._tintColor.value;
    }
    set tint(t) {
      this._tintColor.setValue(t),
        (this._tintRGB = this._tintColor.toLittleEndianNumber());
    }
    get tintValue() {
      return this._tintColor.toNumber();
    }
    get texture() {
      return this._texture;
    }
    set texture(t) {
      this._texture !== t &&
        (this._texture &&
          this._texture.off("update", this._onTextureUpdate, this),
        (this._texture = t || O.EMPTY),
        (this._cachedTint = 16777215),
        (this._textureID = -1),
        (this._textureTrimmedID = -1),
        t &&
          (t.baseTexture.valid
            ? this._onTextureUpdate()
            : t.once("update", this._onTextureUpdate, this)));
    }
  }
  const Jh = new et();
  (at.prototype._cacheAsBitmap = !1),
    (at.prototype._cacheData = null),
    (at.prototype._cacheAsBitmapResolution = null),
    (at.prototype._cacheAsBitmapMultisample = null);
  class mp {
    constructor() {
      (this.textureCacheId = null),
        (this.originalRender = null),
        (this.originalRenderCanvas = null),
        (this.originalCalculateBounds = null),
        (this.originalGetLocalBounds = null),
        (this.originalUpdateTransform = null),
        (this.originalDestroy = null),
        (this.originalMask = null),
        (this.originalFilterArea = null),
        (this.originalContainsPoint = null),
        (this.sprite = null);
    }
  }
  Object.defineProperties(at.prototype, {
    cacheAsBitmapResolution: {
      get() {
        return this._cacheAsBitmapResolution;
      },
      set(r) {
        r !== this._cacheAsBitmapResolution &&
          ((this._cacheAsBitmapResolution = r),
          this.cacheAsBitmap &&
            ((this.cacheAsBitmap = !1), (this.cacheAsBitmap = !0)));
      },
    },
    cacheAsBitmapMultisample: {
      get() {
        return this._cacheAsBitmapMultisample;
      },
      set(r) {
        r !== this._cacheAsBitmapMultisample &&
          ((this._cacheAsBitmapMultisample = r),
          this.cacheAsBitmap &&
            ((this.cacheAsBitmap = !1), (this.cacheAsBitmap = !0)));
      },
    },
    cacheAsBitmap: {
      get() {
        return this._cacheAsBitmap;
      },
      set(r) {
        if (this._cacheAsBitmap === r) return;
        this._cacheAsBitmap = r;
        let t;
        r
          ? (this._cacheData || (this._cacheData = new mp()),
            (t = this._cacheData),
            (t.originalRender = this.render),
            (t.originalRenderCanvas = this.renderCanvas),
            (t.originalUpdateTransform = this.updateTransform),
            (t.originalCalculateBounds = this.calculateBounds),
            (t.originalGetLocalBounds = this.getLocalBounds),
            (t.originalDestroy = this.destroy),
            (t.originalContainsPoint = this.containsPoint),
            (t.originalMask = this._mask),
            (t.originalFilterArea = this.filterArea),
            (this.render = this._renderCached),
            (this.renderCanvas = this._renderCachedCanvas),
            (this.destroy = this._cacheAsBitmapDestroy))
          : ((t = this._cacheData),
            t.sprite && this._destroyCachedDisplayObject(),
            (this.render = t.originalRender),
            (this.renderCanvas = t.originalRenderCanvas),
            (this.calculateBounds = t.originalCalculateBounds),
            (this.getLocalBounds = t.originalGetLocalBounds),
            (this.destroy = t.originalDestroy),
            (this.updateTransform = t.originalUpdateTransform),
            (this.containsPoint = t.originalContainsPoint),
            (this._mask = t.originalMask),
            (this.filterArea = t.originalFilterArea));
      },
    },
  }),
    (at.prototype._renderCached = function (r) {
      !this.visible ||
        this.worldAlpha <= 0 ||
        !this.renderable ||
        (this._initCachedDisplayObject(r),
        (this._cacheData.sprite.transform._worldID = this.transform._worldID),
        (this._cacheData.sprite.worldAlpha = this.worldAlpha),
        this._cacheData.sprite._render(r));
    }),
    (at.prototype._initCachedDisplayObject = function (r) {
      var t, e, i;
      if ((t = this._cacheData) != null && t.sprite) return;
      const s = this.alpha;
      (this.alpha = 1), r.batch.flush();
      const n = this.getLocalBounds(new Y(), !0);
      if ((e = this.filters) != null && e.length) {
        const m = this.filters[0].padding;
        n.pad(m);
      }
      const a = this.cacheAsBitmapResolution || r.resolution;
      n.ceil(a),
        (n.width = Math.max(n.width, 1 / a)),
        (n.height = Math.max(n.height, 1 / a));
      const o = r.renderTexture.current,
        h = r.renderTexture.sourceFrame.clone(),
        l = r.renderTexture.destinationFrame.clone(),
        u = r.projection.transform,
        c = Me.create({
          width: n.width,
          height: n.height,
          resolution: a,
          multisample:
            (i = this.cacheAsBitmapMultisample) != null ? i : r.multisample,
        }),
        d = `cacheAsBitmap_${Ie()}`;
      (this._cacheData.textureCacheId = d),
        j.addToCache(c.baseTexture, d),
        O.addToCache(c, d);
      const f = this.transform.localTransform
        .copyTo(Jh)
        .invert()
        .translate(-n.x, -n.y);
      (this.render = this._cacheData.originalRender),
        r.render(this, {
          renderTexture: c,
          clear: !0,
          transform: f,
          skipUpdateTransform: !1,
        }),
        r.framebuffer.blit(),
        (r.projection.transform = u),
        r.renderTexture.bind(o, h, l),
        (this.render = this._renderCached),
        (this.updateTransform = this.displayObjectUpdateTransform),
        (this.calculateBounds = this._calculateCachedBounds),
        (this.getLocalBounds = this._getCachedLocalBounds),
        (this._mask = null),
        (this.filterArea = null),
        (this.alpha = s);
      const p = new Ne(c);
      (p.transform.worldTransform = this.transform.worldTransform),
        (p.anchor.x = -(n.x / n.width)),
        (p.anchor.y = -(n.y / n.height)),
        (p.alpha = s),
        (p._bounds = this._bounds),
        (this._cacheData.sprite = p),
        (this.transform._parentID = -1),
        this.parent
          ? this.updateTransform()
          : (this.enableTempParent(),
            this.updateTransform(),
            this.disableTempParent(null)),
        (this.containsPoint = p.containsPoint.bind(p));
    }),
    (at.prototype._renderCachedCanvas = function (r) {
      !this.visible ||
        this.worldAlpha <= 0 ||
        !this.renderable ||
        (this._initCachedDisplayObjectCanvas(r),
        (this._cacheData.sprite.worldAlpha = this.worldAlpha),
        this._cacheData.sprite._renderCanvas(r));
    }),
    (at.prototype._initCachedDisplayObjectCanvas = function (r) {
      var t;
      if ((t = this._cacheData) != null && t.sprite) return;
      const e = this.getLocalBounds(new Y(), !0),
        i = this.alpha;
      this.alpha = 1;
      const s = r.canvasContext.activeContext,
        n = r._projTransform,
        a = this.cacheAsBitmapResolution || r.resolution;
      e.ceil(a),
        (e.width = Math.max(e.width, 1 / a)),
        (e.height = Math.max(e.height, 1 / a));
      const o = Me.create({ width: e.width, height: e.height, resolution: a }),
        h = `cacheAsBitmap_${Ie()}`;
      (this._cacheData.textureCacheId = h),
        j.addToCache(o.baseTexture, h),
        O.addToCache(o, h);
      const l = Jh;
      this.transform.localTransform.copyTo(l),
        l.invert(),
        (l.tx -= e.x),
        (l.ty -= e.y),
        (this.renderCanvas = this._cacheData.originalRenderCanvas),
        r.render(this, {
          renderTexture: o,
          clear: !0,
          transform: l,
          skipUpdateTransform: !1,
        }),
        (r.canvasContext.activeContext = s),
        (r._projTransform = n),
        (this.renderCanvas = this._renderCachedCanvas),
        (this.updateTransform = this.displayObjectUpdateTransform),
        (this.calculateBounds = this._calculateCachedBounds),
        (this.getLocalBounds = this._getCachedLocalBounds),
        (this._mask = null),
        (this.filterArea = null),
        (this.alpha = i);
      const u = new Ne(o);
      (u.transform.worldTransform = this.transform.worldTransform),
        (u.anchor.x = -(e.x / e.width)),
        (u.anchor.y = -(e.y / e.height)),
        (u.alpha = i),
        (u._bounds = this._bounds),
        (this._cacheData.sprite = u),
        (this.transform._parentID = -1),
        this.parent
          ? this.updateTransform()
          : ((this.parent = r._tempDisplayObjectParent),
            this.updateTransform(),
            (this.parent = null)),
        (this.containsPoint = u.containsPoint.bind(u));
    }),
    (at.prototype._calculateCachedBounds = function () {
      this._bounds.clear(),
        (this._cacheData.sprite.transform._worldID = this.transform._worldID),
        this._cacheData.sprite._calculateBounds(),
        (this._bounds.updateID = this._boundsID);
    }),
    (at.prototype._getCachedLocalBounds = function () {
      return this._cacheData.sprite.getLocalBounds(null);
    }),
    (at.prototype._destroyCachedDisplayObject = function () {
      this._cacheData.sprite._texture.destroy(!0),
        (this._cacheData.sprite = null),
        j.removeFromCache(this._cacheData.textureCacheId),
        O.removeFromCache(this._cacheData.textureCacheId),
        (this._cacheData.textureCacheId = null);
    }),
    (at.prototype._cacheAsBitmapDestroy = function (r) {
      (this.cacheAsBitmap = !1), this.destroy(r);
    }),
    (at.prototype.name = null),
    (Ot.prototype.getChildByName = function (r, t) {
      for (let e = 0, i = this.children.length; e < i; e++)
        if (this.children[e].name === r) return this.children[e];
      if (t)
        for (let e = 0, i = this.children.length; e < i; e++) {
          const s = this.children[e];
          if (!s.getChildByName) continue;
          const n = s.getChildByName(r, !0);
          if (n) return n;
        }
      return null;
    }),
    (at.prototype.getGlobalPosition = function (r = new tt(), t = !1) {
      return (
        this.parent
          ? this.parent.toGlobal(this.position, r, t)
          : ((r.x = this.position.x), (r.y = this.position.y)),
        r
      );
    });
  var gp = `varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform float uAlpha;

void main(void)
{
   gl_FragColor = texture2D(uSampler, vTextureCoord) * uAlpha;
}
`;
  class tl extends Et {
    constructor(t = 1) {
      super(jh, gp, { uAlpha: 1 }), (this.alpha = t);
    }
    get alpha() {
      return this.uniforms.uAlpha;
    }
    set alpha(t) {
      this.uniforms.uAlpha = t;
    }
  }
  const _p = {
      5: [0.153388, 0.221461, 0.250301],
      7: [0.071303, 0.131514, 0.189879, 0.214607],
      9: [0.028532, 0.067234, 0.124009, 0.179044, 0.20236],
      11: [0.0093, 0.028002, 0.065984, 0.121703, 0.175713, 0.198596],
      13: [
        0.002406, 0.009255, 0.027867, 0.065666, 0.121117, 0.174868, 0.197641,
      ],
      15: [
        489e-6, 0.002403, 0.009246, 0.02784, 0.065602, 0.120999, 0.174697,
        0.197448,
      ],
    },
    vp = [
      "varying vec2 vBlurTexCoords[%size%];",
      "uniform sampler2D uSampler;",
      "void main(void)",
      "{",
      "    gl_FragColor = vec4(0.0);",
      "    %blur%",
      "}",
    ].join(`
`);
  function xp(r) {
    const t = _p[r],
      e = t.length;
    let i = vp,
      s = "";
    const n =
      "gl_FragColor += texture2D(uSampler, vBlurTexCoords[%index%]) * %value%;";
    let a;
    for (let o = 0; o < r; o++) {
      let h = n.replace("%index%", o.toString());
      (a = o),
        o >= e && (a = r - o - 1),
        (h = h.replace("%value%", t[a].toString())),
        (s += h),
        (s += `
`);
    }
    return (
      (i = i.replace("%blur%", s)), (i = i.replace("%size%", r.toString())), i
    );
  }
  const yp = `
    attribute vec2 aVertexPosition;

    uniform mat3 projectionMatrix;

    uniform float strength;

    varying vec2 vBlurTexCoords[%size%];

    uniform vec4 inputSize;
    uniform vec4 outputFrame;

    vec4 filterVertexPosition( void )
    {
        vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;

        return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
    }

    vec2 filterTextureCoord( void )
    {
        return aVertexPosition * (outputFrame.zw * inputSize.zw);
    }

    void main(void)
    {
        gl_Position = filterVertexPosition();

        vec2 textureCoord = filterTextureCoord();
        %blur%
    }`;
  function bp(r, t) {
    const e = Math.ceil(r / 2);
    let i = yp,
      s = "",
      n;
    t
      ? (n =
          "vBlurTexCoords[%index%] =  textureCoord + vec2(%sampleIndex% * strength, 0.0);")
      : (n =
          "vBlurTexCoords[%index%] =  textureCoord + vec2(0.0, %sampleIndex% * strength);");
    for (let a = 0; a < r; a++) {
      let o = n.replace("%index%", a.toString());
      (o = o.replace("%sampleIndex%", `${a - (e - 1)}.0`)),
        (s += o),
        (s += `
`);
    }
    return (
      (i = i.replace("%blur%", s)), (i = i.replace("%size%", r.toString())), i
    );
  }
  class os extends Et {
    constructor(t, e = 8, i = 4, s = Et.defaultResolution, n = 5) {
      const a = bp(n, t),
        o = xp(n);
      super(a, o),
        (this.horizontal = t),
        (this.resolution = s),
        (this._quality = 0),
        (this.quality = i),
        (this.blur = e);
    }
    apply(t, e, i, s) {
      if (
        (i
          ? this.horizontal
            ? (this.uniforms.strength = (1 / i.width) * (i.width / e.width))
            : (this.uniforms.strength = (1 / i.height) * (i.height / e.height))
          : this.horizontal
          ? (this.uniforms.strength =
              (1 / t.renderer.width) * (t.renderer.width / e.width))
          : (this.uniforms.strength =
              (1 / t.renderer.height) * (t.renderer.height / e.height)),
        (this.uniforms.strength *= this.strength),
        (this.uniforms.strength /= this.passes),
        this.passes === 1)
      )
        t.applyFilter(this, e, i, s);
      else {
        const n = t.getFilterTexture(),
          a = t.renderer;
        let o = e,
          h = n;
        (this.state.blend = !1), t.applyFilter(this, o, h, zt.CLEAR);
        for (let l = 1; l < this.passes - 1; l++) {
          t.bindAndClear(o, zt.BLIT), (this.uniforms.uSampler = h);
          const u = h;
          (h = o), (o = u), a.shader.bind(this), a.geometry.draw(5);
        }
        (this.state.blend = !0),
          t.applyFilter(this, h, i, s),
          t.returnFilterTexture(n);
      }
    }
    get blur() {
      return this.strength;
    }
    set blur(t) {
      (this.padding = 1 + Math.abs(t) * 2), (this.strength = t);
    }
    get quality() {
      return this._quality;
    }
    set quality(t) {
      (this._quality = t), (this.passes = t);
    }
  }
  class el extends Et {
    constructor(t = 8, e = 4, i = Et.defaultResolution, s = 5) {
      super(),
        (this._repeatEdgePixels = !1),
        (this.blurXFilter = new os(!0, t, e, i, s)),
        (this.blurYFilter = new os(!1, t, e, i, s)),
        (this.resolution = i),
        (this.quality = e),
        (this.blur = t),
        (this.repeatEdgePixels = !1);
    }
    apply(t, e, i, s) {
      const n = Math.abs(this.blurXFilter.strength),
        a = Math.abs(this.blurYFilter.strength);
      if (n && a) {
        const o = t.getFilterTexture();
        this.blurXFilter.apply(t, e, o, zt.CLEAR),
          this.blurYFilter.apply(t, o, i, s),
          t.returnFilterTexture(o);
      } else
        a
          ? this.blurYFilter.apply(t, e, i, s)
          : this.blurXFilter.apply(t, e, i, s);
    }
    updatePadding() {
      this._repeatEdgePixels
        ? (this.padding = 0)
        : (this.padding =
            Math.max(
              Math.abs(this.blurXFilter.strength),
              Math.abs(this.blurYFilter.strength)
            ) * 2);
    }
    get blur() {
      return this.blurXFilter.blur;
    }
    set blur(t) {
      (this.blurXFilter.blur = this.blurYFilter.blur = t), this.updatePadding();
    }
    get quality() {
      return this.blurXFilter.quality;
    }
    set quality(t) {
      this.blurXFilter.quality = this.blurYFilter.quality = t;
    }
    get blurX() {
      return this.blurXFilter.blur;
    }
    set blurX(t) {
      (this.blurXFilter.blur = t), this.updatePadding();
    }
    get blurY() {
      return this.blurYFilter.blur;
    }
    set blurY(t) {
      (this.blurYFilter.blur = t), this.updatePadding();
    }
    get blendMode() {
      return this.blurYFilter.blendMode;
    }
    set blendMode(t) {
      this.blurYFilter.blendMode = t;
    }
    get repeatEdgePixels() {
      return this._repeatEdgePixels;
    }
    set repeatEdgePixels(t) {
      (this._repeatEdgePixels = t), this.updatePadding();
    }
  }
  var Ep = `varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float m[20];
uniform float uAlpha;

void main(void)
{
    vec4 c = texture2D(uSampler, vTextureCoord);

    if (uAlpha == 0.0) {
        gl_FragColor = c;
        return;
    }

    // Un-premultiply alpha before applying the color matrix. See issue #3539.
    if (c.a > 0.0) {
      c.rgb /= c.a;
    }

    vec4 result;

    result.r = (m[0] * c.r);
        result.r += (m[1] * c.g);
        result.r += (m[2] * c.b);
        result.r += (m[3] * c.a);
        result.r += m[4];

    result.g = (m[5] * c.r);
        result.g += (m[6] * c.g);
        result.g += (m[7] * c.b);
        result.g += (m[8] * c.a);
        result.g += m[9];

    result.b = (m[10] * c.r);
       result.b += (m[11] * c.g);
       result.b += (m[12] * c.b);
       result.b += (m[13] * c.a);
       result.b += m[14];

    result.a = (m[15] * c.r);
       result.a += (m[16] * c.g);
       result.a += (m[17] * c.b);
       result.a += (m[18] * c.a);
       result.a += m[19];

    vec3 rgb = mix(c.rgb, result.rgb, uAlpha);

    // Premultiply alpha again.
    rgb *= result.a;

    gl_FragColor = vec4(rgb, result.a);
}
`;
  class hs extends Et {
    constructor() {
      const t = {
        m: new Float32Array([
          1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
        ]),
        uAlpha: 1,
      };
      super(Kn, Ep, t), (this.alpha = 1);
    }
    _loadMatrix(t, e = !1) {
      let i = t;
      e && (this._multiply(i, this.uniforms.m, t), (i = this._colorMatrix(i))),
        (this.uniforms.m = i);
    }
    _multiply(t, e, i) {
      return (
        (t[0] = e[0] * i[0] + e[1] * i[5] + e[2] * i[10] + e[3] * i[15]),
        (t[1] = e[0] * i[1] + e[1] * i[6] + e[2] * i[11] + e[3] * i[16]),
        (t[2] = e[0] * i[2] + e[1] * i[7] + e[2] * i[12] + e[3] * i[17]),
        (t[3] = e[0] * i[3] + e[1] * i[8] + e[2] * i[13] + e[3] * i[18]),
        (t[4] = e[0] * i[4] + e[1] * i[9] + e[2] * i[14] + e[3] * i[19] + e[4]),
        (t[5] = e[5] * i[0] + e[6] * i[5] + e[7] * i[10] + e[8] * i[15]),
        (t[6] = e[5] * i[1] + e[6] * i[6] + e[7] * i[11] + e[8] * i[16]),
        (t[7] = e[5] * i[2] + e[6] * i[7] + e[7] * i[12] + e[8] * i[17]),
        (t[8] = e[5] * i[3] + e[6] * i[8] + e[7] * i[13] + e[8] * i[18]),
        (t[9] = e[5] * i[4] + e[6] * i[9] + e[7] * i[14] + e[8] * i[19] + e[9]),
        (t[10] = e[10] * i[0] + e[11] * i[5] + e[12] * i[10] + e[13] * i[15]),
        (t[11] = e[10] * i[1] + e[11] * i[6] + e[12] * i[11] + e[13] * i[16]),
        (t[12] = e[10] * i[2] + e[11] * i[7] + e[12] * i[12] + e[13] * i[17]),
        (t[13] = e[10] * i[3] + e[11] * i[8] + e[12] * i[13] + e[13] * i[18]),
        (t[14] =
          e[10] * i[4] + e[11] * i[9] + e[12] * i[14] + e[13] * i[19] + e[14]),
        (t[15] = e[15] * i[0] + e[16] * i[5] + e[17] * i[10] + e[18] * i[15]),
        (t[16] = e[15] * i[1] + e[16] * i[6] + e[17] * i[11] + e[18] * i[16]),
        (t[17] = e[15] * i[2] + e[16] * i[7] + e[17] * i[12] + e[18] * i[17]),
        (t[18] = e[15] * i[3] + e[16] * i[8] + e[17] * i[13] + e[18] * i[18]),
        (t[19] =
          e[15] * i[4] + e[16] * i[9] + e[17] * i[14] + e[18] * i[19] + e[19]),
        t
      );
    }
    _colorMatrix(t) {
      const e = new Float32Array(t);
      return (e[4] /= 255), (e[9] /= 255), (e[14] /= 255), (e[19] /= 255), e;
    }
    brightness(t, e) {
      const i = [t, 0, 0, 0, 0, 0, t, 0, 0, 0, 0, 0, t, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(i, e);
    }
    tint(t, e) {
      const [i, s, n] = K.shared.setValue(t).toArray(),
        a = [i, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, n, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(a, e);
    }
    greyscale(t, e) {
      const i = [t, t, t, 0, 0, t, t, t, 0, 0, t, t, t, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(i, e);
    }
    blackAndWhite(t) {
      const e = [
        0.3, 0.6, 0.1, 0, 0, 0.3, 0.6, 0.1, 0, 0, 0.3, 0.6, 0.1, 0, 0, 0, 0, 0,
        1, 0,
      ];
      this._loadMatrix(e, t);
    }
    hue(t, e) {
      t = ((t || 0) / 180) * Math.PI;
      const i = Math.cos(t),
        s = Math.sin(t),
        n = Math.sqrt,
        a = 1 / 3,
        o = n(a),
        h = i + (1 - i) * a,
        l = a * (1 - i) - o * s,
        u = a * (1 - i) + o * s,
        c = a * (1 - i) + o * s,
        d = i + a * (1 - i),
        f = a * (1 - i) - o * s,
        p = a * (1 - i) - o * s,
        m = a * (1 - i) + o * s,
        g = i + a * (1 - i),
        x = [h, l, u, 0, 0, c, d, f, 0, 0, p, m, g, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(x, e);
    }
    contrast(t, e) {
      const i = (t || 0) + 1,
        s = -0.5 * (i - 1),
        n = [i, 0, 0, 0, s, 0, i, 0, 0, s, 0, 0, i, 0, s, 0, 0, 0, 1, 0];
      this._loadMatrix(n, e);
    }
    saturate(t = 0, e) {
      const i = (t * 2) / 3 + 1,
        s = (i - 1) * -0.5,
        n = [i, s, s, 0, 0, s, i, s, 0, 0, s, s, i, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(n, e);
    }
    desaturate() {
      this.saturate(-1);
    }
    negative(t) {
      const e = [-1, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, -1, 1, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(e, t);
    }
    sepia(t) {
      const e = [
        0.393, 0.7689999, 0.18899999, 0, 0, 0.349, 0.6859999, 0.16799999, 0, 0,
        0.272, 0.5339999, 0.13099999, 0, 0, 0, 0, 0, 1, 0,
      ];
      this._loadMatrix(e, t);
    }
    technicolor(t) {
      const e = [
        1.9125277891456083, -0.8545344976951645, -0.09155508482755585, 0,
        11.793603434377337, -0.3087833385928097, 1.7658908555458428,
        -0.10601743074722245, 0, -70.35205161461398, -0.231103377548616,
        -0.7501899197440212, 1.847597816108189, 0, 30.950940869491138, 0, 0, 0,
        1, 0,
      ];
      this._loadMatrix(e, t);
    }
    polaroid(t) {
      const e = [
        1.438, -0.062, -0.062, 0, 0, -0.122, 1.378, -0.122, 0, 0, -0.016,
        -0.016, 1.483, 0, 0, 0, 0, 0, 1, 0,
      ];
      this._loadMatrix(e, t);
    }
    toBGR(t) {
      const e = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(e, t);
    }
    kodachrome(t) {
      const e = [
        1.1285582396593525, -0.3967382283601348, -0.03992559172921793, 0,
        63.72958762196502, -0.16404339962244616, 1.0835251566291304,
        -0.05498805115633132, 0, 24.732407896706203, -0.16786010706155763,
        -0.5603416277695248, 1.6014850761964943, 0, 35.62982807460946, 0, 0, 0,
        1, 0,
      ];
      this._loadMatrix(e, t);
    }
    browni(t) {
      const e = [
        0.5997023498159715, 0.34553243048391263, -0.2708298674538042, 0,
        47.43192855600873, -0.037703249837783157, 0.8609577587992641,
        0.15059552388459913, 0, -36.96841498319127, 0.24113635128153335,
        -0.07441037908422492, 0.44972182064877153, 0, -7.562075277591283, 0, 0,
        0, 1, 0,
      ];
      this._loadMatrix(e, t);
    }
    vintage(t) {
      const e = [
        0.6279345635605994, 0.3202183420819367, -0.03965408211312453, 0,
        9.651285835294123, 0.02578397704808868, 0.6441188644374771,
        0.03259127616149294, 0, 7.462829176470591, 0.0466055556782719,
        -0.0851232987247891, 0.5241648018700465, 0, 5.159190588235296, 0, 0, 0,
        1, 0,
      ];
      this._loadMatrix(e, t);
    }
    colorTone(t, e, i, s, n) {
      (t = t || 0.2), (e = e || 0.15), (i = i || 16770432), (s = s || 3375104);
      const a = K.shared,
        [o, h, l] = a.setValue(i).toArray(),
        [u, c, d] = a.setValue(s).toArray(),
        f = [
          0.3,
          0.59,
          0.11,
          0,
          0,
          o,
          h,
          l,
          t,
          0,
          u,
          c,
          d,
          e,
          0,
          o - u,
          h - c,
          l - d,
          0,
          0,
        ];
      this._loadMatrix(f, n);
    }
    night(t, e) {
      t = t || 0.1;
      const i = [
        t * -2,
        -t,
        0,
        0,
        0,
        -t,
        0,
        t,
        0,
        0,
        0,
        t,
        t * 2,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
      ];
      this._loadMatrix(i, e);
    }
    predator(t, e) {
      const i = [
        11.224130630493164 * t,
        -4.794486999511719 * t,
        -2.8746118545532227 * t,
        0 * t,
        0.40342438220977783 * t,
        -3.6330697536468506 * t,
        9.193157196044922 * t,
        -2.951810836791992 * t,
        0 * t,
        -1.316135048866272 * t,
        -3.2184197902679443 * t,
        -4.2375030517578125 * t,
        7.476448059082031 * t,
        0 * t,
        0.8044459223747253 * t,
        0,
        0,
        0,
        1,
        0,
      ];
      this._loadMatrix(i, e);
    }
    lsd(t) {
      const e = [
        2, -0.4, 0.5, 0, 0, -0.5, 2, -0.4, 0, 0, -0.4, -0.5, 3, 0, 0, 0, 0, 0,
        1, 0,
      ];
      this._loadMatrix(e, t);
    }
    reset() {
      const t = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
      this._loadMatrix(t, !1);
    }
    get matrix() {
      return this.uniforms.m;
    }
    set matrix(t) {
      this.uniforms.m = t;
    }
    get alpha() {
      return this.uniforms.uAlpha;
    }
    set alpha(t) {
      this.uniforms.uAlpha = t;
    }
  }
  hs.prototype.grayscale = hs.prototype.greyscale;
  var Tp = `varying vec2 vFilterCoord;
varying vec2 vTextureCoord;

uniform vec2 scale;
uniform mat2 rotation;
uniform sampler2D uSampler;
uniform sampler2D mapSampler;

uniform highp vec4 inputSize;
uniform vec4 inputClamp;

void main(void)
{
  vec4 map =  texture2D(mapSampler, vFilterCoord);

  map -= 0.5;
  map.xy = scale * inputSize.zw * (rotation * map.xy);

  gl_FragColor = texture2D(uSampler, clamp(vec2(vTextureCoord.x + map.x, vTextureCoord.y + map.y), inputClamp.xy, inputClamp.zw));
}
`,
    Ap = `attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;
uniform mat3 filterMatrix;

varying vec2 vTextureCoord;
varying vec2 vFilterCoord;

uniform vec4 inputSize;
uniform vec4 outputFrame;

vec4 filterVertexPosition( void )
{
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;

    return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aVertexPosition * (outputFrame.zw * inputSize.zw);
}

void main(void)
{
	gl_Position = filterVertexPosition();
	vTextureCoord = filterTextureCoord();
	vFilterCoord = ( filterMatrix * vec3( vTextureCoord, 1.0)  ).xy;
}
`;
  class rl extends Et {
    constructor(t, e) {
      const i = new et();
      (t.renderable = !1),
        super(Ap, Tp, {
          mapSampler: t._texture,
          filterMatrix: i,
          scale: { x: 1, y: 1 },
          rotation: new Float32Array([1, 0, 0, 1]),
        }),
        (this.maskSprite = t),
        (this.maskMatrix = i),
        e == null && (e = 20),
        (this.scale = new tt(e, e));
    }
    apply(t, e, i, s) {
      (this.uniforms.filterMatrix = t.calculateSpriteMatrix(
        this.maskMatrix,
        this.maskSprite
      )),
        (this.uniforms.scale.x = this.scale.x),
        (this.uniforms.scale.y = this.scale.y);
      const n = this.maskSprite.worldTransform,
        a = Math.sqrt(n.a * n.a + n.b * n.b),
        o = Math.sqrt(n.c * n.c + n.d * n.d);
      a !== 0 &&
        o !== 0 &&
        ((this.uniforms.rotation[0] = n.a / a),
        (this.uniforms.rotation[1] = n.b / a),
        (this.uniforms.rotation[2] = n.c / o),
        (this.uniforms.rotation[3] = n.d / o)),
        t.applyFilter(this, e, i, s);
    }
    get map() {
      return this.uniforms.mapSampler;
    }
    set map(t) {
      this.uniforms.mapSampler = t;
    }
  }
  var Sp = `varying vec2 v_rgbNW;
varying vec2 v_rgbNE;
varying vec2 v_rgbSW;
varying vec2 v_rgbSE;
varying vec2 v_rgbM;

varying vec2 vFragCoord;
uniform sampler2D uSampler;
uniform highp vec4 inputSize;


/**
 Basic FXAA implementation based on the code on geeks3d.com with the
 modification that the texture2DLod stuff was removed since it's
 unsupported by WebGL.

 --

 From:
 https://github.com/mitsuhiko/webgl-meincraft

 Copyright (c) 2011 by Armin Ronacher.

 Some rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions are
 met:

 * Redistributions of source code must retain the above copyright
 notice, this list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above
 copyright notice, this list of conditions and the following
 disclaimer in the documentation and/or other materials provided
 with the distribution.

 * The names of the contributors may not be used to endorse or
 promote products derived from this software without specific
 prior written permission.

 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#ifndef FXAA_REDUCE_MIN
#define FXAA_REDUCE_MIN   (1.0/ 128.0)
#endif
#ifndef FXAA_REDUCE_MUL
#define FXAA_REDUCE_MUL   (1.0 / 8.0)
#endif
#ifndef FXAA_SPAN_MAX
#define FXAA_SPAN_MAX     8.0
#endif

//optimized version for mobile, where dependent
//texture reads can be a bottleneck
vec4 fxaa(sampler2D tex, vec2 fragCoord, vec2 inverseVP,
          vec2 v_rgbNW, vec2 v_rgbNE,
          vec2 v_rgbSW, vec2 v_rgbSE,
          vec2 v_rgbM) {
    vec4 color;
    vec3 rgbNW = texture2D(tex, v_rgbNW).xyz;
    vec3 rgbNE = texture2D(tex, v_rgbNE).xyz;
    vec3 rgbSW = texture2D(tex, v_rgbSW).xyz;
    vec3 rgbSE = texture2D(tex, v_rgbSE).xyz;
    vec4 texColor = texture2D(tex, v_rgbM);
    vec3 rgbM  = texColor.xyz;
    vec3 luma = vec3(0.299, 0.587, 0.114);
    float lumaNW = dot(rgbNW, luma);
    float lumaNE = dot(rgbNE, luma);
    float lumaSW = dot(rgbSW, luma);
    float lumaSE = dot(rgbSE, luma);
    float lumaM  = dot(rgbM,  luma);
    float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

    mediump vec2 dir;
    dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
    dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));

    float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) *
                          (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);

    float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = min(vec2(FXAA_SPAN_MAX, FXAA_SPAN_MAX),
              max(vec2(-FXAA_SPAN_MAX, -FXAA_SPAN_MAX),
                  dir * rcpDirMin)) * inverseVP;

    vec3 rgbA = 0.5 * (
                       texture2D(tex, fragCoord * inverseVP + dir * (1.0 / 3.0 - 0.5)).xyz +
                       texture2D(tex, fragCoord * inverseVP + dir * (2.0 / 3.0 - 0.5)).xyz);
    vec3 rgbB = rgbA * 0.5 + 0.25 * (
                                     texture2D(tex, fragCoord * inverseVP + dir * -0.5).xyz +
                                     texture2D(tex, fragCoord * inverseVP + dir * 0.5).xyz);

    float lumaB = dot(rgbB, luma);
    if ((lumaB < lumaMin) || (lumaB > lumaMax))
        color = vec4(rgbA, texColor.a);
    else
        color = vec4(rgbB, texColor.a);
    return color;
}

void main() {

      vec4 color;

      color = fxaa(uSampler, vFragCoord, inputSize.zw, v_rgbNW, v_rgbNE, v_rgbSW, v_rgbSE, v_rgbM);

      gl_FragColor = color;
}
`,
    wp = `
attribute vec2 aVertexPosition;

uniform mat3 projectionMatrix;

varying vec2 v_rgbNW;
varying vec2 v_rgbNE;
varying vec2 v_rgbSW;
varying vec2 v_rgbSE;
varying vec2 v_rgbM;

varying vec2 vFragCoord;

uniform vec4 inputSize;
uniform vec4 outputFrame;

vec4 filterVertexPosition( void )
{
    vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.)) + outputFrame.xy;

    return vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
}

void texcoords(vec2 fragCoord, vec2 inverseVP,
               out vec2 v_rgbNW, out vec2 v_rgbNE,
               out vec2 v_rgbSW, out vec2 v_rgbSE,
               out vec2 v_rgbM) {
    v_rgbNW = (fragCoord + vec2(-1.0, -1.0)) * inverseVP;
    v_rgbNE = (fragCoord + vec2(1.0, -1.0)) * inverseVP;
    v_rgbSW = (fragCoord + vec2(-1.0, 1.0)) * inverseVP;
    v_rgbSE = (fragCoord + vec2(1.0, 1.0)) * inverseVP;
    v_rgbM = vec2(fragCoord * inverseVP);
}

void main(void) {

   gl_Position = filterVertexPosition();

   vFragCoord = aVertexPosition * outputFrame.zw;

   texcoords(vFragCoord, inputSize.zw, v_rgbNW, v_rgbNE, v_rgbSW, v_rgbSE, v_rgbM);
}
`;
  class il extends Et {
    constructor() {
      super(wp, Sp);
    }
  }
  var Rp = `precision highp float;

varying vec2 vTextureCoord;
varying vec4 vColor;

uniform float uNoise;
uniform float uSeed;
uniform sampler2D uSampler;

float rand(vec2 co)
{
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main()
{
    vec4 color = texture2D(uSampler, vTextureCoord);
    float randomValue = rand(gl_FragCoord.xy * uSeed);
    float diff = (randomValue - 0.5) * uNoise;

    // Un-premultiply alpha before applying the color matrix. See issue #3539.
    if (color.a > 0.0) {
        color.rgb /= color.a;
    }

    color.r += diff;
    color.g += diff;
    color.b += diff;

    // Premultiply alpha again.
    color.rgb *= color.a;

    gl_FragColor = color;
}
`;
  class sl extends Et {
    constructor(t = 0.5, e = Math.random()) {
      super(Kn, Rp, { uNoise: 0, uSeed: 0 }), (this.noise = t), (this.seed = e);
    }
    get noise() {
      return this.uniforms.uNoise;
    }
    set noise(t) {
      this.uniforms.uNoise = t;
    }
    get seed() {
      return this.uniforms.uSeed;
    }
    set seed(t) {
      this.uniforms.uSeed = t;
    }
  }
  const sa = {
    AlphaFilter: tl,
    BlurFilter: el,
    BlurFilterPass: os,
    ColorMatrixFilter: hs,
    DisplacementFilter: rl,
    FXAAFilter: il,
    NoiseFilter: sl,
  };
  Object.entries(sa).forEach(([r, t]) => {
    Object.defineProperty(sa, r, {
      get() {
        return t;
      },
    });
  });
  const nl = class qa {
    constructor(t) {
      (this.stage = new Ot()),
        (t = Object.assign({ forceCanvas: !1 }, t)),
        (this.renderer = zh(t)),
        qa._plugins.forEach((e) => {
          e.init.call(this, t);
        });
    }
    render() {
      this.renderer.render(this.stage);
    }
    get view() {
      var t;
      return (t = this.renderer) == null ? void 0 : t.view;
    }
    get screen() {
      var t;
      return (t = this.renderer) == null ? void 0 : t.screen;
    }
    destroy(t, e) {
      const i = qa._plugins.slice(0);
      i.reverse(),
        i.forEach((s) => {
          s.destroy.call(this);
        }),
        this.stage.destroy(e),
        (this.stage = null),
        this.renderer.destroy(t),
        (this.renderer = null);
    }
  };
  nl._plugins = [];
  let al = nl;
  U.handleByList(D.Application, al._plugins);
  class na {
    static init(t) {
      Object.defineProperty(this, "resizeTo", {
        set(e) {
          globalThis.removeEventListener("resize", this.queueResize),
            (this._resizeTo = e),
            e &&
              (globalThis.addEventListener("resize", this.queueResize),
              this.resize());
        },
        get() {
          return this._resizeTo;
        },
      }),
        (this.queueResize = () => {
          this._resizeTo &&
            (this.cancelResize(),
            (this._resizeId = requestAnimationFrame(() => this.resize())));
        }),
        (this.cancelResize = () => {
          this._resizeId &&
            (cancelAnimationFrame(this._resizeId), (this._resizeId = null));
        }),
        (this.resize = () => {
          if (!this._resizeTo) return;
          this.cancelResize();
          let e, i;
          if (this._resizeTo === globalThis.window)
            (e = globalThis.innerWidth), (i = globalThis.innerHeight);
          else {
            const { clientWidth: s, clientHeight: n } = this._resizeTo;
            (e = s), (i = n);
          }
          this.renderer.resize(e, i), this.render();
        }),
        (this._resizeId = null),
        (this._resizeTo = null),
        (this.resizeTo = t.resizeTo || null);
    }
    static destroy() {
      globalThis.removeEventListener("resize", this.queueResize),
        this.cancelResize(),
        (this.cancelResize = null),
        (this.queueResize = null),
        (this.resizeTo = null),
        (this.resize = null);
    }
  }
  (na.extension = D.Application), U.add(na);
  const ol = {
    loader: D.LoadParser,
    resolver: D.ResolveParser,
    cache: D.CacheParser,
    detection: D.DetectionParser,
  };
  U.handle(
    D.Asset,
    (r) => {
      const t = r.ref;
      Object.entries(ol)
        .filter(([e]) => !!t[e])
        .forEach(([e, i]) => {
          var s;
          return U.add(
            Object.assign(t[e], {
              extension: (s = t[e].extension) != null ? s : i,
            })
          );
        });
    },
    (r) => {
      const t = r.ref;
      Object.keys(ol)
        .filter((e) => !!t[e])
        .forEach((e) => U.remove(t[e]));
    }
  );
  class Ip {
    constructor(t, e = !1) {
      (this._loader = t),
        (this._assetList = []),
        (this._isLoading = !1),
        (this._maxConcurrent = 1),
        (this.verbose = e);
    }
    add(t) {
      t.forEach((e) => {
        this._assetList.push(e);
      }),
        this.verbose &&
          console.log("[BackgroundLoader] assets: ", this._assetList),
        this._isActive && !this._isLoading && this._next();
    }
    async _next() {
      if (this._assetList.length && this._isActive) {
        this._isLoading = !0;
        const t = [],
          e = Math.min(this._assetList.length, this._maxConcurrent);
        for (let i = 0; i < e; i++) t.push(this._assetList.pop());
        await this._loader.load(t), (this._isLoading = !1), this._next();
      }
    }
    get active() {
      return this._isActive;
    }
    set active(t) {
      this._isActive !== t &&
        ((this._isActive = t), t && !this._isLoading && this._next());
    }
  }
  function Ze(r, t) {
    if (Array.isArray(t)) {
      for (const e of t) if (r.startsWith(`data:${e}`)) return !0;
      return !1;
    }
    return r.startsWith(`data:${t}`);
  }
  function _e(r, t) {
    const e = r.split("?")[0],
      i = yt.extname(e).toLowerCase();
    return Array.isArray(t) ? t.includes(i) : i === t;
  }
  const $t = (r, t, e = !1) => (
      Array.isArray(r) || (r = [r]),
      t ? r.map((i) => (typeof i == "string" || e ? t(i) : i)) : r
    ),
    ls = (r, t) => {
      const e = t.split("?")[1];
      return e && (r += `?${e}`), r;
    };
  function hl(r, t, e, i, s) {
    const n = t[e];
    for (let a = 0; a < n.length; a++) {
      const o = n[a];
      e < t.length - 1
        ? hl(r.replace(i[e], o), t, e + 1, i, s)
        : s.push(r.replace(i[e], o));
    }
  }
  function ll(r) {
    const t = /\{(.*?)\}/g,
      e = r.match(t),
      i = [];
    if (e) {
      const s = [];
      e.forEach((n) => {
        const a = n.substring(1, n.length - 1).split(",");
        s.push(a);
      }),
        hl(r, s, 0, e, i);
    } else i.push(r);
    return i;
  }
  const Zr = (r) => !Array.isArray(r);
  let Cp = class {
    constructor() {
      (this._parsers = []),
        (this._cache = new Map()),
        (this._cacheMap = new Map());
    }
    reset() {
      this._cacheMap.clear(), this._cache.clear();
    }
    has(t) {
      return this._cache.has(t);
    }
    get(t) {
      return this._cache.get(t);
    }
    set(t, e) {
      const i = $t(t);
      let s;
      for (let o = 0; o < this.parsers.length; o++) {
        const h = this.parsers[o];
        if (h.test(e)) {
          s = h.getCacheableAssets(i, e);
          break;
        }
      }
      s ||
        ((s = {}),
        i.forEach((o) => {
          s[o] = e;
        }));
      const n = Object.keys(s),
        a = { cacheKeys: n, keys: i };
      if (
        (i.forEach((o) => {
          this._cacheMap.set(o, a);
        }),
        n.forEach((o) => {
          const h = s ? s[o] : e;
          this._cache.has(o) && this._cache.get(o), this._cache.set(o, s[o]);
        }),
        e instanceof O)
      ) {
        const o = e;
        i.forEach((h) => {
          o.baseTexture !== O.EMPTY.baseTexture &&
            j.addToCache(o.baseTexture, h),
            O.addToCache(o, h);
        });
      }
    }
    remove(t) {
      if (!this._cacheMap.has(t)) return;
      const e = this._cacheMap.get(t);
      e.cacheKeys.forEach((i) => {
        this._cache.delete(i);
      }),
        e.keys.forEach((i) => {
          this._cacheMap.delete(i);
        });
    }
    get parsers() {
      return this._parsers;
    }
  };
  const Oe = new Cp();
  var Mp = Object.defineProperty,
    Pp = Object.defineProperties,
    Dp = Object.getOwnPropertyDescriptors,
    ul = Object.getOwnPropertySymbols,
    Np = Object.prototype.hasOwnProperty,
    Op = Object.prototype.propertyIsEnumerable,
    cl = (r, t, e) =>
      t in r
        ? Mp(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Bp = (r, t) => {
      for (var e in t || (t = {})) Np.call(t, e) && cl(r, e, t[e]);
      if (ul) for (var e of ul(t)) Op.call(t, e) && cl(r, e, t[e]);
      return r;
    },
    Fp = (r, t) => Pp(r, Dp(t));
  class Lp {
    constructor() {
      (this._parsers = []),
        (this._parsersValidated = !1),
        (this.parsers = new Proxy(this._parsers, {
          set: (t, e, i) => ((this._parsersValidated = !1), (t[e] = i), !0),
        })),
        (this.promiseCache = {});
    }
    reset() {
      (this._parsersValidated = !1), (this.promiseCache = {});
    }
    _getLoadPromiseAndParser(t, e) {
      const i = { promise: null, parser: null };
      return (
        (i.promise = (async () => {
          var s, n;
          let a = null,
            o = null;
          if ((e.loadParser && (o = this._parserHash[e.loadParser]), !o)) {
            for (let h = 0; h < this.parsers.length; h++) {
              const l = this.parsers[h];
              if (l.load && (s = l.test) != null && s.call(l, t, e, this)) {
                o = l;
                break;
              }
            }
            if (!o) return null;
          }
          (a = await o.load(t, e, this)), (i.parser = o);
          for (let h = 0; h < this.parsers.length; h++) {
            const l = this.parsers[h];
            l.parse &&
              l.parse &&
              (await ((n = l.testParse) == null
                ? void 0
                : n.call(l, a, e, this))) &&
              ((a = (await l.parse(a, e, this)) || a), (i.parser = l));
          }
          return a;
        })()),
        i
      );
    }
    async load(t, e) {
      this._parsersValidated || this._validateParsers();
      let i = 0;
      const s = {},
        n = Zr(t),
        a = $t(t, (l) => ({ alias: [l], src: l })),
        o = a.length,
        h = a.map(async (l) => {
          const u = yt.toAbsolute(l.src);
          if (!s[l.src])
            try {
              this.promiseCache[u] ||
                (this.promiseCache[u] = this._getLoadPromiseAndParser(u, l)),
                (s[l.src] = await this.promiseCache[u].promise),
                e && e(++i / o);
            } catch (c) {
              throw (
                (delete this.promiseCache[u],
                delete s[l.src],
                new Error(`[Loader.load] Failed to load ${u}.
${c}`))
              );
            }
        });
      return await Promise.all(h), n ? s[a[0].src] : s;
    }
    async unload(t) {
      const e = $t(t, (i) => ({ alias: [i], src: i })).map(async (i) => {
        var s, n;
        const a = yt.toAbsolute(i.src),
          o = this.promiseCache[a];
        if (o) {
          const h = await o.promise;
          delete this.promiseCache[a],
            (n = (s = o.parser) == null ? void 0 : s.unload) == null ||
              n.call(s, h, i, this);
        }
      });
      await Promise.all(e);
    }
    _validateParsers() {
      (this._parsersValidated = !0),
        (this._parserHash = this._parsers
          .filter((t) => t.name)
          .reduce((t, e) => (t[e.name], Fp(Bp({}, t), { [e.name]: e })), {}));
    }
  }
  var Ht = ((r) => (
    (r[(r.Low = 0)] = "Low"),
    (r[(r.Normal = 1)] = "Normal"),
    (r[(r.High = 2)] = "High"),
    r
  ))(Ht || {});
  const Up = ".json",
    kp = "application/json",
    dl = {
      extension: { type: D.LoadParser, priority: Ht.Low },
      name: "loadJson",
      test(r) {
        return Ze(r, kp) || _e(r, Up);
      },
      async load(r) {
        return await (await B.ADAPTER.fetch(r)).json();
      },
    };
  U.add(dl);
  const Gp = ".txt",
    $p = "text/plain",
    fl = {
      name: "loadTxt",
      extension: { type: D.LoadParser, priority: Ht.Low },
      test(r) {
        return Ze(r, $p) || _e(r, Gp);
      },
      async load(r) {
        return await (await B.ADAPTER.fetch(r)).text();
      },
    };
  U.add(fl);
  var Hp = Object.defineProperty,
    Vp = Object.defineProperties,
    Xp = Object.getOwnPropertyDescriptors,
    pl = Object.getOwnPropertySymbols,
    zp = Object.prototype.hasOwnProperty,
    jp = Object.prototype.propertyIsEnumerable,
    ml = (r, t, e) =>
      t in r
        ? Hp(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Wp = (r, t) => {
      for (var e in t || (t = {})) zp.call(t, e) && ml(r, e, t[e]);
      if (pl) for (var e of pl(t)) jp.call(t, e) && ml(r, e, t[e]);
      return r;
    },
    Yp = (r, t) => Vp(r, Xp(t));
  const qp = [
      "normal",
      "bold",
      "100",
      "200",
      "300",
      "400",
      "500",
      "600",
      "700",
      "800",
      "900",
    ],
    Kp = [".ttf", ".otf", ".woff", ".woff2"],
    Zp = ["font/ttf", "font/otf", "font/woff", "font/woff2"],
    Qp = /^(--|-?[A-Z_])[0-9A-Z_-]*$/i;
  function gl(r) {
    const t = yt.extname(r),
      e = yt
        .basename(r, t)
        .replace(/(-|_)/g, " ")
        .toLowerCase()
        .split(" ")
        .map((n) => n.charAt(0).toUpperCase() + n.slice(1));
    let i = e.length > 0;
    for (const n of e)
      if (!n.match(Qp)) {
        i = !1;
        break;
      }
    let s = e.join(" ");
    return i || (s = `"${s.replace(/[\\"]/g, "\\$&")}"`), s;
  }
  const Jp = /^[0-9A-Za-z%:/?#\[\]@!\$&'()\*\+,;=\-._~]*$/;
  function tm(r) {
    return Jp.test(r) ? r : encodeURI(r);
  }
  const _l = {
    extension: { type: D.LoadParser, priority: Ht.Low },
    name: "loadWebFont",
    test(r) {
      return Ze(r, Zp) || _e(r, Kp);
    },
    async load(r, t) {
      var e, i, s, n, a, o;
      const h = B.ADAPTER.getFontFaceSet();
      if (h) {
        const l = [],
          u =
            (i = (e = t.data) == null ? void 0 : e.family) != null ? i : gl(r),
          c =
            (a =
              (n = (s = t.data) == null ? void 0 : s.weights) == null
                ? void 0
                : n.filter((f) => qp.includes(f))) != null
              ? a
              : ["normal"],
          d = (o = t.data) != null ? o : {};
        for (let f = 0; f < c.length; f++) {
          const p = c[f],
            m = new FontFace(u, `url(${tm(r)})`, Yp(Wp({}, d), { weight: p }));
          await m.load(), h.add(m), l.push(m);
        }
        return l.length === 1 ? l[0] : l;
      }
      return null;
    },
    unload(r) {
      (Array.isArray(r) ? r : [r]).forEach((t) =>
        B.ADAPTER.getFontFaceSet().delete(t)
      );
    },
  };
  U.add(_l);
  const em = `(function(){"use strict";const e="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";async function a(){try{if(typeof createImageBitmap!="function")return!1;const A=await(await fetch(e)).blob(),t=await createImageBitmap(A);return t.width===1&&t.height===1}catch(A){return!1}}a().then(A=>{self.postMessage(A)})})();
`;
  let or = null,
    aa = class {
      constructor() {
        or ||
          (or = URL.createObjectURL(
            new Blob([em], { type: "application/javascript" })
          )),
          (this.worker = new Worker(or));
      }
    };
  aa.revokeObjectURL = function () {
    or && (URL.revokeObjectURL(or), (or = null));
  };
  const rm =
    '(function(){"use strict";async function e(t){const a=await fetch(t);if(!a.ok)throw new Error(`[WorkerManager.loadImageBitmap] Failed to fetch ${t}: ${a.status} ${a.statusText}`);const s=await a.blob();return await createImageBitmap(s)}self.onmessage=async t=>{try{const a=await e(t.data.data[0]);self.postMessage({data:a,uuid:t.data.uuid,id:t.data.id},[a])}catch(a){self.postMessage({error:a,uuid:t.data.uuid,id:t.data.id})}}})();\n';
  let hr = null;
  class vl {
    constructor() {
      hr ||
        (hr = URL.createObjectURL(
          new Blob([rm], { type: "application/javascript" })
        )),
        (this.worker = new Worker(hr));
    }
  }
  vl.revokeObjectURL = function () {
    hr && (URL.revokeObjectURL(hr), (hr = null));
  };
  let xl = 0,
    oa,
    im = class {
      constructor() {
        (this._initialized = !1),
          (this._createdWorkers = 0),
          (this.workerPool = []),
          (this.queue = []),
          (this.resolveHash = {});
      }
      isImageBitmapSupported() {
        return this._isImageBitmapSupported !== void 0
          ? this._isImageBitmapSupported
          : ((this._isImageBitmapSupported = new Promise((t) => {
              const { worker: e } = new aa();
              e.addEventListener("message", (i) => {
                e.terminate(), aa.revokeObjectURL(), t(i.data);
              });
            })),
            this._isImageBitmapSupported);
      }
      loadImageBitmap(t) {
        return this._run("loadImageBitmap", [t]);
      }
      async _initWorkers() {
        this._initialized || (this._initialized = !0);
      }
      getWorker() {
        oa === void 0 && (oa = navigator.hardwareConcurrency || 4);
        let t = this.workerPool.pop();
        return (
          !t &&
            this._createdWorkers < oa &&
            (this._createdWorkers++,
            (t = new vl().worker),
            t.addEventListener("message", (e) => {
              this.complete(e.data), this.returnWorker(e.target), this.next();
            })),
          t
        );
      }
      returnWorker(t) {
        this.workerPool.push(t);
      }
      complete(t) {
        t.error !== void 0
          ? this.resolveHash[t.uuid].reject(t.error)
          : this.resolveHash[t.uuid].resolve(t.data),
          (this.resolveHash[t.uuid] = null);
      }
      async _run(t, e) {
        await this._initWorkers();
        const i = new Promise((s, n) => {
          this.queue.push({ id: t, arguments: e, resolve: s, reject: n });
        });
        return this.next(), i;
      }
      next() {
        if (!this.queue.length) return;
        const t = this.getWorker();
        if (!t) return;
        const e = this.queue.pop(),
          i = e.id;
        (this.resolveHash[xl] = { resolve: e.resolve, reject: e.reject }),
          t.postMessage({ data: e.arguments, uuid: xl++, id: i });
      }
    };
  const yl = new im();
  function lr(r, t, e) {
    r.resource.internal = !0;
    const i = new O(r),
      s = () => {
        delete t.promiseCache[e], Oe.has(e) && Oe.remove(e);
      };
    return (
      i.baseTexture.once("destroyed", () => {
        e in t.promiseCache &&
          (console.warn(
            "[Assets] A BaseTexture managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the BaseTexture."
          ),
          s());
      }),
      i.once("destroyed", () => {
        r.destroyed ||
          (console.warn(
            "[Assets] A Texture managed by Assets was destroyed instead of unloaded! Use Assets.unload() instead of destroying the Texture."
          ),
          s());
      }),
      i
    );
  }
  var sm = Object.defineProperty,
    bl = Object.getOwnPropertySymbols,
    nm = Object.prototype.hasOwnProperty,
    am = Object.prototype.propertyIsEnumerable,
    El = (r, t, e) =>
      t in r
        ? sm(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Tl = (r, t) => {
      for (var e in t || (t = {})) nm.call(t, e) && El(r, e, t[e]);
      if (bl) for (var e of bl(t)) am.call(t, e) && El(r, e, t[e]);
      return r;
    };
  const om = [".jpeg", ".jpg", ".png", ".webp", ".avif"],
    hm = ["image/jpeg", "image/png", "image/webp", "image/avif"];
  async function Al(r) {
    const t = await B.ADAPTER.fetch(r);
    if (!t.ok)
      throw new Error(
        `[loadImageBitmap] Failed to fetch ${r}: ${t.status} ${t.statusText}`
      );
    const e = await t.blob();
    return await createImageBitmap(e);
  }
  const Qr = {
    name: "loadTextures",
    extension: { type: D.LoadParser, priority: Ht.High },
    config: {
      preferWorkers: !0,
      preferCreateImageBitmap: !0,
      crossOrigin: "anonymous",
    },
    test(r) {
      return Ze(r, hm) || _e(r, om);
    },
    async load(r, t, e) {
      var i, s;
      const n =
        globalThis.createImageBitmap && this.config.preferCreateImageBitmap;
      let a;
      n
        ? this.config.preferWorkers && (await yl.isImageBitmapSupported())
          ? (a = await yl.loadImageBitmap(r))
          : (a = await Al(r))
        : (a = await new Promise((l, u) => {
            const c = new Image();
            (c.crossOrigin = this.config.crossOrigin),
              (c.src = r),
              c.complete
                ? l(c)
                : ((c.onload = () => l(c)), (c.onerror = (d) => u(d)));
          }));
      const o = Tl({}, t.data);
      (i = o.resolution) != null || (o.resolution = re(r)),
        n &&
          ((s = o.resourceOptions) == null ? void 0 : s.ownsImageBitmap) ===
            void 0 &&
          ((o.resourceOptions = Tl({}, o.resourceOptions)),
          (o.resourceOptions.ownsImageBitmap = !0));
      const h = new j(a, o);
      return (h.resource.src = r), lr(h, e, r);
    },
    unload(r) {
      r.destroy(!0);
    },
  };
  U.add(Qr);
  var lm = Object.defineProperty,
    Sl = Object.getOwnPropertySymbols,
    um = Object.prototype.hasOwnProperty,
    cm = Object.prototype.propertyIsEnumerable,
    wl = (r, t, e) =>
      t in r
        ? lm(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    dm = (r, t) => {
      for (var e in t || (t = {})) um.call(t, e) && wl(r, e, t[e]);
      if (Sl) for (var e of Sl(t)) cm.call(t, e) && wl(r, e, t[e]);
      return r;
    };
  const fm = ".svg",
    pm = "image/svg+xml",
    Rl = {
      extension: { type: D.LoadParser, priority: Ht.High },
      name: "loadSVG",
      test(r) {
        return Ze(r, pm) || _e(r, fm);
      },
      async testParse(r) {
        return as.test(r);
      },
      async parse(r, t, e) {
        var i;
        const s = new as(
          r,
          (i = t == null ? void 0 : t.data) == null ? void 0 : i.resourceOptions
        );
        await s.load();
        const n = new j(
          s,
          dm({ resolution: re(r) }, t == null ? void 0 : t.data)
        );
        return (n.resource.src = t.src), lr(n, e, t.src);
      },
      async load(r, t) {
        return (await B.ADAPTER.fetch(r)).text();
      },
      unload: Qr.unload,
    };
  U.add(Rl);
  var mm = Object.defineProperty,
    gm = Object.defineProperties,
    _m = Object.getOwnPropertyDescriptors,
    Il = Object.getOwnPropertySymbols,
    vm = Object.prototype.hasOwnProperty,
    xm = Object.prototype.propertyIsEnumerable,
    Cl = (r, t, e) =>
      t in r
        ? mm(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Ml = (r, t) => {
      for (var e in t || (t = {})) vm.call(t, e) && Cl(r, e, t[e]);
      if (Il) for (var e of Il(t)) xm.call(t, e) && Cl(r, e, t[e]);
      return r;
    },
    ym = (r, t) => gm(r, _m(t));
  const bm = [".mp4", ".m4v", ".webm", ".ogv"],
    Em = ["video/mp4", "video/webm", "video/ogg"],
    Pl = {
      name: "loadVideo",
      extension: { type: D.LoadParser, priority: Ht.High },
      config: {
        defaultAutoPlay: !0,
        defaultUpdateFPS: 0,
        defaultLoop: !1,
        defaultMuted: !1,
        defaultPlaysinline: !0,
      },
      test(r) {
        return Ze(r, Em) || _e(r, bm);
      },
      async load(r, t, e) {
        var i;
        let s;
        const n = await (await B.ADAPTER.fetch(r)).blob(),
          a = URL.createObjectURL(n);
        try {
          const o = ym(
              Ml(
                {
                  autoPlay: this.config.defaultAutoPlay,
                  updateFPS: this.config.defaultUpdateFPS,
                  loop: this.config.defaultLoop,
                  muted: this.config.defaultMuted,
                  playsinline: this.config.defaultPlaysinline,
                },
                (i = t == null ? void 0 : t.data) == null
                  ? void 0
                  : i.resourceOptions
              ),
              { autoLoad: !0 }
            ),
            h = new ia(a, o);
          await h.load();
          const l = new j(
            h,
            Ml(
              { alphaMode: await wo(), resolution: re(r) },
              t == null ? void 0 : t.data
            )
          );
          (l.resource.src = r),
            (s = lr(l, e, r)),
            s.baseTexture.once("destroyed", () => {
              URL.revokeObjectURL(a);
            });
        } catch (o) {
          throw (URL.revokeObjectURL(a), o);
        }
        return s;
      },
      unload(r) {
        r.destroy(!0);
      },
    };
  U.add(Pl);
  var Tm = Object.defineProperty,
    Am = Object.defineProperties,
    Sm = Object.getOwnPropertyDescriptors,
    Dl = Object.getOwnPropertySymbols,
    wm = Object.prototype.hasOwnProperty,
    Rm = Object.prototype.propertyIsEnumerable,
    Nl = (r, t, e) =>
      t in r
        ? Tm(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    ur = (r, t) => {
      for (var e in t || (t = {})) wm.call(t, e) && Nl(r, e, t[e]);
      if (Dl) for (var e of Dl(t)) Rm.call(t, e) && Nl(r, e, t[e]);
      return r;
    },
    Ol = (r, t) => Am(r, Sm(t));
  class Im {
    constructor() {
      (this._defaultBundleIdentifierOptions = {
        connector: "-",
        createBundleAssetId: (t, e) => `${t}${this._bundleIdConnector}${e}`,
        extractAssetIdFromBundle: (t, e) =>
          e.replace(`${t}${this._bundleIdConnector}`, ""),
      }),
        (this._bundleIdConnector =
          this._defaultBundleIdentifierOptions.connector),
        (this._createBundleAssetId =
          this._defaultBundleIdentifierOptions.createBundleAssetId),
        (this._extractAssetIdFromBundle =
          this._defaultBundleIdentifierOptions.extractAssetIdFromBundle),
        (this._assetMap = {}),
        (this._preferredOrder = []),
        (this._parsers = []),
        (this._resolverHash = {}),
        (this._bundles = {});
    }
    setBundleIdentifier(t) {
      var e, i, s;
      if (
        ((this._bundleIdConnector =
          (e = t.connector) != null ? e : this._bundleIdConnector),
        (this._createBundleAssetId =
          (i = t.createBundleAssetId) != null ? i : this._createBundleAssetId),
        (this._extractAssetIdFromBundle =
          (s = t.extractAssetIdFromBundle) != null
            ? s
            : this._extractAssetIdFromBundle),
        this._extractAssetIdFromBundle(
          "foo",
          this._createBundleAssetId("foo", "bar")
        ) !== "bar")
      )
        throw new Error(
          "[Resolver] GenerateBundleAssetId are not working correctly"
        );
    }
    prefer(...t) {
      t.forEach((e) => {
        this._preferredOrder.push(e),
          e.priority || (e.priority = Object.keys(e.params));
      }),
        (this._resolverHash = {});
    }
    set basePath(t) {
      this._basePath = t;
    }
    get basePath() {
      return this._basePath;
    }
    set rootPath(t) {
      this._rootPath = t;
    }
    get rootPath() {
      return this._rootPath;
    }
    get parsers() {
      return this._parsers;
    }
    reset() {
      this.setBundleIdentifier(this._defaultBundleIdentifierOptions),
        (this._assetMap = {}),
        (this._preferredOrder = []),
        (this._resolverHash = {}),
        (this._rootPath = null),
        (this._basePath = null),
        (this._manifest = null),
        (this._bundles = {}),
        (this._defaultSearchParams = null);
    }
    setDefaultSearchParams(t) {
      if (typeof t == "string") this._defaultSearchParams = t;
      else {
        const e = t;
        this._defaultSearchParams = Object.keys(e)
          .map((i) => `${encodeURIComponent(i)}=${encodeURIComponent(e[i])}`)
          .join("&");
      }
    }
    getAlias(t) {
      const { alias: e, name: i, src: s, srcs: n } = t;
      return $t(
        e || i || s || n,
        (a) => {
          var o;
          return typeof a == "string"
            ? a
            : Array.isArray(a)
            ? a.map((h) => {
                var l, u;
                return (u =
                  (l = h == null ? void 0 : h.src) != null
                    ? l
                    : h == null
                    ? void 0
                    : h.srcs) != null
                  ? u
                  : h;
              })
            : (a != null && a.src) || (a != null && a.srcs)
            ? (o = a.src) != null
              ? o
              : a.srcs
            : a;
        },
        !0
      );
    }
    addManifest(t) {
      this._manifest,
        (this._manifest = t),
        t.bundles.forEach((e) => {
          this.addBundle(e.name, e.assets);
        });
    }
    addBundle(t, e) {
      const i = [];
      Array.isArray(e)
        ? e.forEach((s) => {
            var n, a;
            const o = (n = s.src) != null ? n : s.srcs,
              h = (a = s.alias) != null ? a : s.name;
            let l;
            if (typeof h == "string") {
              const u = this._createBundleAssetId(t, h);
              i.push(u), (l = [h, u]);
            } else {
              const u = h.map((c) => this._createBundleAssetId(t, c));
              i.push(...u), (l = [...h, ...u]);
            }
            this.add(Ol(ur({}, s), { alias: l, src: o }));
          })
        : Object.keys(e).forEach((s) => {
            var n;
            const a = [s, this._createBundleAssetId(t, s)];
            if (typeof e[s] == "string") this.add({ alias: a, src: e[s] });
            else if (Array.isArray(e[s])) this.add({ alias: a, src: e[s] });
            else {
              const o = e[s],
                h = (n = o.src) != null ? n : o.srcs;
              this.add(
                Ol(ur({}, o), { alias: a, src: Array.isArray(h) ? h : [h] })
              );
            }
            i.push(...a);
          }),
        (this._bundles[t] = i);
    }
    add(t, e, i, s, n) {
      const a = [];
      typeof t == "string" || (Array.isArray(t) && typeof t[0] == "string")
        ? a.push({ alias: t, src: e, data: i, format: s, loadParser: n })
        : Array.isArray(t)
        ? a.push(...t)
        : a.push(t);
      let o;
      $t(a).forEach((h) => {
        const { src: l, srcs: u } = h;
        let { data: c, format: d, loadParser: f } = h;
        const p = $t(l || u).map((x) =>
            typeof x == "string" ? ll(x) : Array.isArray(x) ? x : [x]
          ),
          m = this.getAlias(h),
          g = [];
        p.forEach((x) => {
          x.forEach((b) => {
            var _, y, T;
            let C = {};
            if (typeof b != "object") {
              C.src = b;
              for (let R = 0; R < this._parsers.length; R++) {
                const S = this._parsers[R];
                if (S.test(b)) {
                  C = S.parse(b);
                  break;
                }
              }
            } else
              (c = (_ = b.data) != null ? _ : c),
                (d = (y = b.format) != null ? y : d),
                (f = (T = b.loadParser) != null ? T : f),
                (C = ur(ur({}, C), b));
            if (!m)
              throw new Error(
                `[Resolver] alias is undefined for this asset: ${C.src}`
              );
            (C = this.buildResolvedAsset(C, {
              aliases: m,
              data: c,
              format: d,
              loadParser: f,
            })),
              g.push(C);
          });
        }),
          m.forEach((x) => {
            this._assetMap[x] = g;
          });
      });
    }
    resolveBundle(t) {
      const e = Zr(t);
      t = $t(t);
      const i = {};
      return (
        t.forEach((s) => {
          const n = this._bundles[s];
          if (n) {
            const a = this.resolve(n),
              o = {};
            for (const h in a) {
              const l = a[h];
              o[this._extractAssetIdFromBundle(s, h)] = l;
            }
            i[s] = o;
          }
        }),
        e ? i[t[0]] : i
      );
    }
    resolveUrl(t) {
      const e = this.resolve(t);
      if (typeof t != "string") {
        const i = {};
        for (const s in e) i[s] = e[s].src;
        return i;
      }
      return e.src;
    }
    resolve(t) {
      const e = Zr(t);
      t = $t(t);
      const i = {};
      return (
        t.forEach((s) => {
          var n;
          if (!this._resolverHash[s])
            if (this._assetMap[s]) {
              let a = this._assetMap[s];
              const o = a[0],
                h = this._getPreferredOrder(a);
              h == null ||
                h.priority.forEach((l) => {
                  h.params[l].forEach((u) => {
                    const c = a.filter((d) => (d[l] ? d[l] === u : !1));
                    c.length && (a = c);
                  });
                }),
                (this._resolverHash[s] = (n = a[0]) != null ? n : o);
            } else
              this._resolverHash[s] = this.buildResolvedAsset(
                { alias: [s], src: s },
                {}
              );
          i[s] = this._resolverHash[s];
        }),
        e ? i[t[0]] : i
      );
    }
    hasKey(t) {
      return !!this._assetMap[t];
    }
    hasBundle(t) {
      return !!this._bundles[t];
    }
    _getPreferredOrder(t) {
      for (let e = 0; e < t.length; e++) {
        const i = t[0],
          s = this._preferredOrder.find((n) =>
            n.params.format.includes(i.format)
          );
        if (s) return s;
      }
      return this._preferredOrder[0];
    }
    _appendDefaultSearchParams(t) {
      if (!this._defaultSearchParams) return t;
      const e = /\?/.test(t) ? "&" : "?";
      return `${t}${e}${this._defaultSearchParams}`;
    }
    buildResolvedAsset(t, e) {
      var i, s;
      const { aliases: n, data: a, loadParser: o, format: h } = e;
      return (
        (this._basePath || this._rootPath) &&
          (t.src = yt.toAbsolute(t.src, this._basePath, this._rootPath)),
        (t.alias = (i = n != null ? n : t.alias) != null ? i : [t.src]),
        (t.src = this._appendDefaultSearchParams(t.src)),
        (t.data = ur(ur({}, a || {}), t.data)),
        (t.loadParser = o != null ? o : t.loadParser),
        (t.format =
          (s = h != null ? h : t.format) != null
            ? s
            : yt.extname(t.src).slice(1)),
        (t.srcs = t.src),
        (t.name = t.alias),
        t
      );
    }
  }
  class Bl {
    constructor() {
      (this._detections = []),
        (this._initialized = !1),
        (this.resolver = new Im()),
        (this.loader = new Lp()),
        (this.cache = Oe),
        (this._backgroundLoader = new Ip(this.loader)),
        (this._backgroundLoader.active = !0),
        this.reset();
    }
    async init(t = {}) {
      var e, i, s;
      if (this._initialized) return;
      if (
        ((this._initialized = !0),
        t.defaultSearchParams &&
          this.resolver.setDefaultSearchParams(t.defaultSearchParams),
        t.basePath && (this.resolver.basePath = t.basePath),
        t.bundleIdentifier &&
          this.resolver.setBundleIdentifier(t.bundleIdentifier),
        t.manifest)
      ) {
        let h = t.manifest;
        typeof h == "string" && (h = await this.load(h)),
          this.resolver.addManifest(h);
      }
      const n =
          (i = (e = t.texturePreference) == null ? void 0 : e.resolution) !=
          null
            ? i
            : 1,
        a = typeof n == "number" ? [n] : n,
        o = await this._detectFormats({
          preferredFormats:
            (s = t.texturePreference) == null ? void 0 : s.format,
          skipDetections: t.skipDetections,
          detections: this._detections,
        });
      this.resolver.prefer({ params: { format: o, resolution: a } }),
        t.preferences && this.setPreferences(t.preferences);
    }
    add(t, e, i, s, n) {
      this.resolver.add(t, e, i, s, n);
    }
    async load(t, e) {
      this._initialized || (await this.init());
      const i = Zr(t),
        s = $t(t).map((o) => {
          if (typeof o != "string") {
            const h = this.resolver.getAlias(o);
            return (
              h.some((l) => !this.resolver.hasKey(l)) && this.add(o),
              Array.isArray(h) ? h[0] : h
            );
          }
          return this.resolver.hasKey(o) || this.add({ alias: o, src: o }), o;
        }),
        n = this.resolver.resolve(s),
        a = await this._mapLoadToResolve(n, e);
      return i ? a[s[0]] : a;
    }
    addBundle(t, e) {
      this.resolver.addBundle(t, e);
    }
    async loadBundle(t, e) {
      this._initialized || (await this.init());
      let i = !1;
      typeof t == "string" && ((i = !0), (t = [t]));
      const s = this.resolver.resolveBundle(t),
        n = {},
        a = Object.keys(s);
      let o = 0,
        h = 0;
      const l = () => {
          e == null || e(++o / h);
        },
        u = a.map((c) => {
          const d = s[c];
          return (
            (h += Object.keys(d).length),
            this._mapLoadToResolve(d, l).then((f) => {
              n[c] = f;
            })
          );
        });
      return await Promise.all(u), i ? n[t[0]] : n;
    }
    async backgroundLoad(t) {
      this._initialized || (await this.init()),
        typeof t == "string" && (t = [t]);
      const e = this.resolver.resolve(t);
      this._backgroundLoader.add(Object.values(e));
    }
    async backgroundLoadBundle(t) {
      this._initialized || (await this.init()),
        typeof t == "string" && (t = [t]);
      const e = this.resolver.resolveBundle(t);
      Object.values(e).forEach((i) => {
        this._backgroundLoader.add(Object.values(i));
      });
    }
    reset() {
      this.resolver.reset(),
        this.loader.reset(),
        this.cache.reset(),
        (this._initialized = !1);
    }
    get(t) {
      if (typeof t == "string") return Oe.get(t);
      const e = {};
      for (let i = 0; i < t.length; i++) e[i] = Oe.get(t[i]);
      return e;
    }
    async _mapLoadToResolve(t, e) {
      const i = Object.values(t),
        s = Object.keys(t);
      this._backgroundLoader.active = !1;
      const n = await this.loader.load(i, e);
      this._backgroundLoader.active = !0;
      const a = {};
      return (
        i.forEach((o, h) => {
          const l = n[o.src],
            u = [o.src];
          o.alias && u.push(...o.alias), (a[s[h]] = l), Oe.set(u, l);
        }),
        a
      );
    }
    async unload(t) {
      this._initialized || (await this.init());
      const e = $t(t).map((s) => (typeof s != "string" ? s.src : s)),
        i = this.resolver.resolve(e);
      await this._unloadFromResolved(i);
    }
    async unloadBundle(t) {
      this._initialized || (await this.init()), (t = $t(t));
      const e = this.resolver.resolveBundle(t),
        i = Object.keys(e).map((s) => this._unloadFromResolved(e[s]));
      await Promise.all(i);
    }
    async _unloadFromResolved(t) {
      const e = Object.values(t);
      e.forEach((i) => {
        Oe.remove(i.src);
      }),
        await this.loader.unload(e);
    }
    async _detectFormats(t) {
      let e = [];
      t.preferredFormats &&
        (e = Array.isArray(t.preferredFormats)
          ? t.preferredFormats
          : [t.preferredFormats]);
      for (const i of t.detections)
        t.skipDetections || (await i.test())
          ? (e = await i.add(e))
          : t.skipDetections || (e = await i.remove(e));
      return (e = e.filter((i, s) => e.indexOf(i) === s)), e;
    }
    get detections() {
      return this._detections;
    }
    get preferWorkers() {
      return Qr.config.preferWorkers;
    }
    set preferWorkers(t) {
      this.setPreferences({ preferWorkers: t });
    }
    setPreferences(t) {
      this.loader.parsers.forEach((e) => {
        e.config &&
          Object.keys(e.config)
            .filter((i) => i in t)
            .forEach((i) => {
              e.config[i] = t[i];
            });
      });
    }
  }
  const Jr = new Bl();
  U.handleByList(D.LoadParser, Jr.loader.parsers)
    .handleByList(D.ResolveParser, Jr.resolver.parsers)
    .handleByList(D.CacheParser, Jr.cache.parsers)
    .handleByList(D.DetectionParser, Jr.detections);
  const Fl = {
    extension: D.CacheParser,
    test: (r) => Array.isArray(r) && r.every((t) => t instanceof O),
    getCacheableAssets: (r, t) => {
      const e = {};
      return (
        r.forEach((i) => {
          t.forEach((s, n) => {
            e[i + (n === 0 ? "" : n + 1)] = s;
          });
        }),
        e
      );
    },
  };
  U.add(Fl);
  async function Ll(r) {
    if ("Image" in globalThis)
      return new Promise((t) => {
        const e = new Image();
        (e.onload = () => {
          t(!0);
        }),
          (e.onerror = () => {
            t(!1);
          }),
          (e.src = r);
      });
    if ("createImageBitmap" in globalThis && "fetch" in globalThis) {
      try {
        const t = await (await fetch(r)).blob();
        await createImageBitmap(t);
      } catch (t) {
        return !1;
      }
      return !0;
    }
    return !1;
  }
  const Ul = {
    extension: { type: D.DetectionParser, priority: 1 },
    test: async () =>
      Ll(
        "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQ0MAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACVtZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A="
      ),
    add: async (r) => [...r, "avif"],
    remove: async (r) => r.filter((t) => t !== "avif"),
  };
  U.add(Ul);
  const kl = {
    extension: { type: D.DetectionParser, priority: 0 },
    test: async () =>
      Ll(
        "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA="
      ),
    add: async (r) => [...r, "webp"],
    remove: async (r) => r.filter((t) => t !== "webp"),
  };
  U.add(kl);
  const Gl = ["png", "jpg", "jpeg"],
    $l = {
      extension: { type: D.DetectionParser, priority: -1 },
      test: () => Promise.resolve(!0),
      add: async (r) => [...r, ...Gl],
      remove: async (r) => r.filter((t) => !Gl.includes(t)),
    };
  U.add($l);
  const Cm =
    "WorkerGlobalScope" in globalThis &&
    globalThis instanceof globalThis.WorkerGlobalScope;
  function ha(r) {
    return Cm ? !1 : document.createElement("video").canPlayType(r) !== "";
  }
  const Hl = {
    extension: { type: D.DetectionParser, priority: 0 },
    test: async () => ha("video/webm"),
    add: async (r) => [...r, "webm"],
    remove: async (r) => r.filter((t) => t !== "webm"),
  };
  U.add(Hl);
  const Vl = {
    extension: { type: D.DetectionParser, priority: 0 },
    test: async () => ha("video/mp4"),
    add: async (r) => [...r, "mp4", "m4v"],
    remove: async (r) => r.filter((t) => t !== "mp4" && t !== "m4v"),
  };
  U.add(Vl);
  const Xl = {
    extension: { type: D.DetectionParser, priority: 0 },
    test: async () => ha("video/ogg"),
    add: async (r) => [...r, "ogv"],
    remove: async (r) => r.filter((t) => t !== "ogv"),
  };
  U.add(Xl);
  const zl = {
    extension: D.ResolveParser,
    test: Qr.test,
    parse: (r) => {
      var t, e;
      return {
        resolution: parseFloat(
          (e = (t = B.RETINA_PREFIX.exec(r)) == null ? void 0 : t[1]) != null
            ? e
            : "1"
        ),
        format: yt.extname(r).slice(1),
        src: r,
      };
    },
  };
  U.add(zl);
  var gt = ((r) => (
    (r[(r.COMPRESSED_RGB_S3TC_DXT1_EXT = 33776)] =
      "COMPRESSED_RGB_S3TC_DXT1_EXT"),
    (r[(r.COMPRESSED_RGBA_S3TC_DXT1_EXT = 33777)] =
      "COMPRESSED_RGBA_S3TC_DXT1_EXT"),
    (r[(r.COMPRESSED_RGBA_S3TC_DXT3_EXT = 33778)] =
      "COMPRESSED_RGBA_S3TC_DXT3_EXT"),
    (r[(r.COMPRESSED_RGBA_S3TC_DXT5_EXT = 33779)] =
      "COMPRESSED_RGBA_S3TC_DXT5_EXT"),
    (r[(r.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT = 35917)] =
      "COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT"),
    (r[(r.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT = 35918)] =
      "COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT"),
    (r[(r.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT = 35919)] =
      "COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT"),
    (r[(r.COMPRESSED_SRGB_S3TC_DXT1_EXT = 35916)] =
      "COMPRESSED_SRGB_S3TC_DXT1_EXT"),
    (r[(r.COMPRESSED_R11_EAC = 37488)] = "COMPRESSED_R11_EAC"),
    (r[(r.COMPRESSED_SIGNED_R11_EAC = 37489)] = "COMPRESSED_SIGNED_R11_EAC"),
    (r[(r.COMPRESSED_RG11_EAC = 37490)] = "COMPRESSED_RG11_EAC"),
    (r[(r.COMPRESSED_SIGNED_RG11_EAC = 37491)] = "COMPRESSED_SIGNED_RG11_EAC"),
    (r[(r.COMPRESSED_RGB8_ETC2 = 37492)] = "COMPRESSED_RGB8_ETC2"),
    (r[(r.COMPRESSED_RGBA8_ETC2_EAC = 37496)] = "COMPRESSED_RGBA8_ETC2_EAC"),
    (r[(r.COMPRESSED_SRGB8_ETC2 = 37493)] = "COMPRESSED_SRGB8_ETC2"),
    (r[(r.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC = 37497)] =
      "COMPRESSED_SRGB8_ALPHA8_ETC2_EAC"),
    (r[(r.COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2 = 37494)] =
      "COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2"),
    (r[(r.COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2 = 37495)] =
      "COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2"),
    (r[(r.COMPRESSED_RGB_PVRTC_4BPPV1_IMG = 35840)] =
      "COMPRESSED_RGB_PVRTC_4BPPV1_IMG"),
    (r[(r.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG = 35842)] =
      "COMPRESSED_RGBA_PVRTC_4BPPV1_IMG"),
    (r[(r.COMPRESSED_RGB_PVRTC_2BPPV1_IMG = 35841)] =
      "COMPRESSED_RGB_PVRTC_2BPPV1_IMG"),
    (r[(r.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG = 35843)] =
      "COMPRESSED_RGBA_PVRTC_2BPPV1_IMG"),
    (r[(r.COMPRESSED_RGB_ETC1_WEBGL = 36196)] = "COMPRESSED_RGB_ETC1_WEBGL"),
    (r[(r.COMPRESSED_RGB_ATC_WEBGL = 35986)] = "COMPRESSED_RGB_ATC_WEBGL"),
    (r[(r.COMPRESSED_RGBA_ATC_EXPLICIT_ALPHA_WEBGL = 35987)] =
      "COMPRESSED_RGBA_ATC_EXPLICIT_ALPHA_WEBGL"),
    (r[(r.COMPRESSED_RGBA_ATC_INTERPOLATED_ALPHA_WEBGL = 34798)] =
      "COMPRESSED_RGBA_ATC_INTERPOLATED_ALPHA_WEBGL"),
    (r[(r.COMPRESSED_RGBA_ASTC_4x4_KHR = 37808)] =
      "COMPRESSED_RGBA_ASTC_4x4_KHR"),
    (r[(r.COMPRESSED_RGBA_BPTC_UNORM_EXT = 36492)] =
      "COMPRESSED_RGBA_BPTC_UNORM_EXT"),
    (r[(r.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT = 36493)] =
      "COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT"),
    (r[(r.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT = 36494)] =
      "COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT"),
    (r[(r.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT = 36495)] =
      "COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT"),
    r
  ))(gt || {});
  const ti = {
    33776: 0.5,
    33777: 0.5,
    33778: 1,
    33779: 1,
    35916: 0.5,
    35917: 0.5,
    35918: 1,
    35919: 1,
    37488: 0.5,
    37489: 0.5,
    37490: 1,
    37491: 1,
    37492: 0.5,
    37496: 1,
    37493: 0.5,
    37497: 1,
    37494: 0.5,
    37495: 0.5,
    35840: 0.5,
    35842: 0.5,
    35841: 0.25,
    35843: 0.25,
    36196: 0.5,
    35986: 0.5,
    35987: 1,
    34798: 1,
    37808: 1,
    36492: 1,
    36493: 1,
    36494: 1,
    36495: 1,
  };
  let ae, cr;
  function jl() {
    cr = {
      bptc: ae.getExtension("EXT_texture_compression_bptc"),
      astc: ae.getExtension("WEBGL_compressed_texture_astc"),
      etc: ae.getExtension("WEBGL_compressed_texture_etc"),
      s3tc: ae.getExtension("WEBGL_compressed_texture_s3tc"),
      s3tc_sRGB: ae.getExtension("WEBGL_compressed_texture_s3tc_srgb"),
      pvrtc:
        ae.getExtension("WEBGL_compressed_texture_pvrtc") ||
        ae.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),
      etc1: ae.getExtension("WEBGL_compressed_texture_etc1"),
      atc: ae.getExtension("WEBGL_compressed_texture_atc"),
    };
  }
  const Wl = {
    extension: { type: D.DetectionParser, priority: 2 },
    test: async () => {
      const r = B.ADAPTER.createCanvas().getContext("webgl");
      return r ? ((ae = r), !0) : !1;
    },
    add: async (r) => {
      cr || jl();
      const t = [];
      for (const e in cr) cr[e] && t.push(e);
      return [...t, ...r];
    },
    remove: async (r) => (cr || jl(), r.filter((t) => !(t in cr))),
  };
  U.add(Wl);
  class Yl extends Fr {
    constructor(t, e = { width: 1, height: 1, autoLoad: !0 }) {
      let i, s;
      typeof t == "string"
        ? ((i = t), (s = new Uint8Array()))
        : ((i = null), (s = t)),
        super(s, e),
        (this.origin = i),
        (this.buffer = s ? new Ui(s) : null),
        (this._load = null),
        (this.loaded = !1),
        this.origin !== null && e.autoLoad !== !1 && this.load(),
        this.origin === null &&
          this.buffer &&
          ((this._load = Promise.resolve(this)),
          (this.loaded = !0),
          this.onBlobLoaded(this.buffer.rawBinaryData));
    }
    onBlobLoaded(t) {}
    load() {
      return this._load
        ? this._load
        : ((this._load = fetch(this.origin)
            .then((t) => t.blob())
            .then((t) => t.arrayBuffer())
            .then(
              (t) => (
                (this.data = new Uint32Array(t)),
                (this.buffer = new Ui(t)),
                (this.loaded = !0),
                this.onBlobLoaded(t),
                this.update(),
                this
              )
            )),
          this._load);
    }
  }
  class Be extends Yl {
    constructor(t, e) {
      super(t, e),
        (this.format = e.format),
        (this.levels = e.levels || 1),
        (this._width = e.width),
        (this._height = e.height),
        (this._extension = Be._formatToExtension(this.format)),
        (e.levelBuffers || this.buffer) &&
          (this._levelBuffers =
            e.levelBuffers ||
            Be._createLevelBuffers(
              t instanceof Uint8Array ? t : this.buffer.uint8View,
              this.format,
              this.levels,
              4,
              4,
              this.width,
              this.height
            ));
    }
    upload(t, e, i) {
      const s = t.gl;
      if (!t.context.extensions[this._extension])
        throw new Error(
          `${this._extension} textures are not supported on the current machine`
        );
      if (!this._levelBuffers) return !1;
      s.pixelStorei(s.UNPACK_ALIGNMENT, 4);
      for (let n = 0, a = this.levels; n < a; n++) {
        const {
          levelID: o,
          levelWidth: h,
          levelHeight: l,
          levelBuffer: u,
        } = this._levelBuffers[n];
        s.compressedTexImage2D(s.TEXTURE_2D, o, this.format, h, l, 0, u);
      }
      return !0;
    }
    onBlobLoaded() {
      this._levelBuffers = Be._createLevelBuffers(
        this.buffer.uint8View,
        this.format,
        this.levels,
        4,
        4,
        this.width,
        this.height
      );
    }
    static _formatToExtension(t) {
      if (t >= 33776 && t <= 33779) return "s3tc";
      if (t >= 35916 && t <= 35919) return "s3tc_sRGB";
      if (t >= 37488 && t <= 37497) return "etc";
      if (t >= 35840 && t <= 35843) return "pvrtc";
      if (t === 36196) return "etc1";
      if (t === 35986 || t === 35987 || t === 34798) return "atc";
      if (t >= 36492 && t <= 36495) return "bptc";
      if (t === 37808) return "astc";
      throw new Error(`Invalid (compressed) texture format given: ${t}`);
    }
    static _createLevelBuffers(t, e, i, s, n, a, o) {
      const h = new Array(i);
      let l = t.byteOffset,
        u = a,
        c = o,
        d = (u + s - 1) & ~(s - 1),
        f = (c + n - 1) & ~(n - 1),
        p = d * f * ti[e];
      for (let m = 0; m < i; m++)
        (h[m] = {
          levelID: m,
          levelWidth: i > 1 ? u : d,
          levelHeight: i > 1 ? c : f,
          levelBuffer: new Uint8Array(t.buffer, l, p),
        }),
          (l += p),
          (u = u >> 1 || 1),
          (c = c >> 1 || 1),
          (d = (u + s - 1) & ~(s - 1)),
          (f = (c + n - 1) & ~(n - 1)),
          (p = d * f * ti[e]);
      return h;
    }
  }
  const la = 4,
    us = 124,
    Mm = 32,
    ql = 20,
    Pm = 542327876,
    cs = {
      SIZE: 1,
      FLAGS: 2,
      HEIGHT: 3,
      WIDTH: 4,
      MIPMAP_COUNT: 7,
      PIXEL_FORMAT: 19,
    },
    Dm = {
      SIZE: 0,
      FLAGS: 1,
      FOURCC: 2,
      RGB_BITCOUNT: 3,
      R_BIT_MASK: 4,
      G_BIT_MASK: 5,
      B_BIT_MASK: 6,
      A_BIT_MASK: 7,
    },
    ds = {
      DXGI_FORMAT: 0,
      RESOURCE_DIMENSION: 1,
      MISC_FLAG: 2,
      ARRAY_SIZE: 3,
      MISC_FLAGS2: 4,
    },
    Nm = 1,
    Om = 2,
    Bm = 4,
    Fm = 64,
    Lm = 512,
    Um = 131072,
    km = 827611204,
    Gm = 861165636,
    $m = 894720068,
    Hm = 808540228,
    Vm = 4,
    Xm = {
      [km]: gt.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      [Gm]: gt.COMPRESSED_RGBA_S3TC_DXT3_EXT,
      [$m]: gt.COMPRESSED_RGBA_S3TC_DXT5_EXT,
    },
    zm = {
      70: gt.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      71: gt.COMPRESSED_RGBA_S3TC_DXT1_EXT,
      73: gt.COMPRESSED_RGBA_S3TC_DXT3_EXT,
      74: gt.COMPRESSED_RGBA_S3TC_DXT3_EXT,
      76: gt.COMPRESSED_RGBA_S3TC_DXT5_EXT,
      77: gt.COMPRESSED_RGBA_S3TC_DXT5_EXT,
      72: gt.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT,
      75: gt.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT,
      78: gt.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT,
      96: gt.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT,
      95: gt.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT,
      98: gt.COMPRESSED_RGBA_BPTC_UNORM_EXT,
      99: gt.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT,
    };
  function Kl(r) {
    const t = new Uint32Array(r);
    if (t[0] !== Pm) throw new Error("Invalid DDS file magic word");
    const e = new Uint32Array(r, 0, us / Uint32Array.BYTES_PER_ELEMENT),
      i = e[cs.HEIGHT],
      s = e[cs.WIDTH],
      n = e[cs.MIPMAP_COUNT],
      a = new Uint32Array(
        r,
        cs.PIXEL_FORMAT * Uint32Array.BYTES_PER_ELEMENT,
        Mm / Uint32Array.BYTES_PER_ELEMENT
      ),
      o = a[Nm];
    if (o & Bm) {
      const h = a[Dm.FOURCC];
      if (h !== Hm) {
        const b = Xm[h],
          _ = la + us,
          y = new Uint8Array(r, _);
        return [new Be(y, { format: b, width: s, height: i, levels: n })];
      }
      const l = la + us,
        u = new Uint32Array(t.buffer, l, ql / Uint32Array.BYTES_PER_ELEMENT),
        c = u[ds.DXGI_FORMAT],
        d = u[ds.RESOURCE_DIMENSION],
        f = u[ds.MISC_FLAG],
        p = u[ds.ARRAY_SIZE],
        m = zm[c];
      if (m === void 0)
        throw new Error(
          `DDSParser cannot parse texture data with DXGI format ${c}`
        );
      if (f === Vm)
        throw new Error("DDSParser does not support cubemap textures");
      if (d === 6)
        throw new Error("DDSParser does not supported 3D texture data");
      const g = new Array(),
        x = la + us + ql;
      if (p === 1) g.push(new Uint8Array(r, x));
      else {
        const b = ti[m];
        let _ = 0,
          y = s,
          T = i;
        for (let R = 0; R < n; R++) {
          const S = Math.max(1, (y + 3) & -4),
            I = Math.max(1, (T + 3) & -4),
            $ = S * I * b;
          (_ += $), (y = y >>> 1), (T = T >>> 1);
        }
        let C = x;
        for (let R = 0; R < p; R++) g.push(new Uint8Array(r, C, _)), (C += _);
      }
      return g.map(
        (b) => new Be(b, { format: m, width: s, height: i, levels: n })
      );
    }
    throw o & Fm
      ? new Error("DDSParser does not support uncompressed texture data.")
      : o & Lm
      ? new Error("DDSParser does not supported YUV uncompressed texture data.")
      : o & Um
      ? new Error(
          "DDSParser does not support single-channel (lumninance) texture data!"
        )
      : o & Om
      ? new Error(
          "DDSParser does not support single-channel (alpha) texture data!"
        )
      : new Error(
          "DDSParser failed to load a texture file due to an unknown reason!"
        );
  }
  const Zl = [171, 75, 84, 88, 32, 49, 49, 187, 13, 10, 26, 10],
    jm = 67305985,
    qt = {
      FILE_IDENTIFIER: 0,
      ENDIANNESS: 12,
      GL_TYPE: 16,
      GL_TYPE_SIZE: 20,
      GL_FORMAT: 24,
      GL_INTERNAL_FORMAT: 28,
      GL_BASE_INTERNAL_FORMAT: 32,
      PIXEL_WIDTH: 36,
      PIXEL_HEIGHT: 40,
      PIXEL_DEPTH: 44,
      NUMBER_OF_ARRAY_ELEMENTS: 48,
      NUMBER_OF_FACES: 52,
      NUMBER_OF_MIPMAP_LEVELS: 56,
      BYTES_OF_KEY_VALUE_DATA: 60,
    },
    ua = 64,
    ca = {
      [H.UNSIGNED_BYTE]: 1,
      [H.UNSIGNED_SHORT]: 2,
      [H.INT]: 4,
      [H.UNSIGNED_INT]: 4,
      [H.FLOAT]: 4,
      [H.HALF_FLOAT]: 8,
    },
    Ql = {
      [A.RGBA]: 4,
      [A.RGB]: 3,
      [A.RG]: 2,
      [A.RED]: 1,
      [A.LUMINANCE]: 1,
      [A.LUMINANCE_ALPHA]: 2,
      [A.ALPHA]: 1,
    },
    Jl = {
      [H.UNSIGNED_SHORT_4_4_4_4]: 2,
      [H.UNSIGNED_SHORT_5_5_5_1]: 2,
      [H.UNSIGNED_SHORT_5_6_5]: 2,
    };
  function tu(r, t, e = !1) {
    const i = new DataView(t);
    if (!Wm(r, i)) return null;
    const s = i.getUint32(qt.ENDIANNESS, !0) === jm,
      n = i.getUint32(qt.GL_TYPE, s),
      a = i.getUint32(qt.GL_FORMAT, s),
      o = i.getUint32(qt.GL_INTERNAL_FORMAT, s),
      h = i.getUint32(qt.PIXEL_WIDTH, s),
      l = i.getUint32(qt.PIXEL_HEIGHT, s) || 1,
      u = i.getUint32(qt.PIXEL_DEPTH, s) || 1,
      c = i.getUint32(qt.NUMBER_OF_ARRAY_ELEMENTS, s) || 1,
      d = i.getUint32(qt.NUMBER_OF_FACES, s),
      f = i.getUint32(qt.NUMBER_OF_MIPMAP_LEVELS, s),
      p = i.getUint32(qt.BYTES_OF_KEY_VALUE_DATA, s);
    if (l === 0 || u !== 1) throw new Error("Only 2D textures are supported");
    if (d !== 1)
      throw new Error("CubeTextures are not supported by KTXLoader yet!");
    if (c !== 1) throw new Error("WebGL does not support array textures");
    const m = 4,
      g = 4,
      x = (h + 3) & -4,
      b = (l + 3) & -4,
      _ = new Array(c);
    let y = h * l;
    n === 0 && (y = x * b);
    let T;
    if (
      (n !== 0 ? (ca[n] ? (T = ca[n] * Ql[a]) : (T = Jl[n])) : (T = ti[o]),
      T === void 0)
    )
      throw new Error(
        "Unable to resolve the pixel format stored in the *.ktx file!"
      );
    const C = e ? qm(i, p, s) : null;
    let R = y * T,
      S = h,
      I = l,
      $ = x,
      z = b,
      F = ua + p;
    for (let E = 0; E < f; E++) {
      const w = i.getUint32(F, s);
      let V = F + 4;
      for (let k = 0; k < c; k++) {
        let L = _[k];
        L || (L = _[k] = new Array(f)),
          (L[E] = {
            levelID: E,
            levelWidth: f > 1 || n !== 0 ? S : $,
            levelHeight: f > 1 || n !== 0 ? I : z,
            levelBuffer: new Uint8Array(t, V, R),
          }),
          (V += R);
      }
      (F += w + 4),
        (F = F % 4 !== 0 ? F + 4 - (F % 4) : F),
        (S = S >> 1 || 1),
        (I = I >> 1 || 1),
        ($ = (S + m - 1) & ~(m - 1)),
        (z = (I + g - 1) & ~(g - 1)),
        (R = $ * z * T);
    }
    return n !== 0
      ? {
          uncompressed: _.map((E) => {
            let w = E[0].levelBuffer,
              V = !1;
            return (
              n === H.FLOAT
                ? (w = new Float32Array(
                    E[0].levelBuffer.buffer,
                    E[0].levelBuffer.byteOffset,
                    E[0].levelBuffer.byteLength / 4
                  ))
                : n === H.UNSIGNED_INT
                ? ((V = !0),
                  (w = new Uint32Array(
                    E[0].levelBuffer.buffer,
                    E[0].levelBuffer.byteOffset,
                    E[0].levelBuffer.byteLength / 4
                  )))
                : n === H.INT &&
                  ((V = !0),
                  (w = new Int32Array(
                    E[0].levelBuffer.buffer,
                    E[0].levelBuffer.byteOffset,
                    E[0].levelBuffer.byteLength / 4
                  ))),
              {
                resource: new Fr(w, {
                  width: E[0].levelWidth,
                  height: E[0].levelHeight,
                }),
                type: n,
                format: V ? Ym(a) : a,
              }
            );
          }),
          kvData: C,
        }
      : {
          compressed: _.map(
            (E) =>
              new Be(null, {
                format: o,
                width: h,
                height: l,
                levels: f,
                levelBuffers: E,
              })
          ),
          kvData: C,
        };
  }
  function Wm(r, t) {
    for (let e = 0; e < Zl.length; e++) if (t.getUint8(e) !== Zl[e]) return !1;
    return !0;
  }
  function Ym(r) {
    switch (r) {
      case A.RGBA:
        return A.RGBA_INTEGER;
      case A.RGB:
        return A.RGB_INTEGER;
      case A.RG:
        return A.RG_INTEGER;
      case A.RED:
        return A.RED_INTEGER;
      default:
        return r;
    }
  }
  function qm(r, t, e) {
    const i = new Map();
    let s = 0;
    for (; s < t; ) {
      const n = r.getUint32(ua + s, e),
        a = ua + s + 4,
        o = 3 - ((n + 3) % 4);
      if (n === 0 || n > t - s) {
        console.error("KTXLoader: keyAndValueByteSize out of bounds");
        break;
      }
      let h = 0;
      for (; h < n && r.getUint8(a + h) !== 0; h++);
      if (h === -1) {
        console.error(
          "KTXLoader: Failed to find null byte terminating kvData key"
        );
        break;
      }
      const l = new TextDecoder().decode(new Uint8Array(r.buffer, a, h)),
        u = new DataView(r.buffer, a + h + 1, n - h - 1);
      i.set(l, u), (s += 4 + n + o);
    }
    return i;
  }
  var Km = Object.defineProperty,
    eu = Object.getOwnPropertySymbols,
    Zm = Object.prototype.hasOwnProperty,
    Qm = Object.prototype.propertyIsEnumerable,
    ru = (r, t, e) =>
      t in r
        ? Km(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Jm = (r, t) => {
      for (var e in t || (t = {})) Zm.call(t, e) && ru(r, e, t[e]);
      if (eu) for (var e of eu(t)) Qm.call(t, e) && ru(r, e, t[e]);
      return r;
    };
  const iu = {
    extension: { type: D.LoadParser, priority: Ht.High },
    name: "loadDDS",
    test(r) {
      return _e(r, ".dds");
    },
    async load(r, t, e) {
      const i = await (await B.ADAPTER.fetch(r)).arrayBuffer(),
        s = Kl(i).map((n) => {
          const a = new j(
            n,
            Jm(
              {
                mipmap: Xt.OFF,
                alphaMode: wt.NO_PREMULTIPLIED_ALPHA,
                resolution: re(r),
              },
              t.data
            )
          );
          return lr(a, e, r);
        });
      return s.length === 1 ? s[0] : s;
    },
    unload(r) {
      Array.isArray(r) ? r.forEach((t) => t.destroy(!0)) : r.destroy(!0);
    },
  };
  U.add(iu);
  var tg = Object.defineProperty,
    su = Object.getOwnPropertySymbols,
    eg = Object.prototype.hasOwnProperty,
    rg = Object.prototype.propertyIsEnumerable,
    nu = (r, t, e) =>
      t in r
        ? tg(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    ig = (r, t) => {
      for (var e in t || (t = {})) eg.call(t, e) && nu(r, e, t[e]);
      if (su) for (var e of su(t)) rg.call(t, e) && nu(r, e, t[e]);
      return r;
    };
  const au = {
    extension: { type: D.LoadParser, priority: Ht.High },
    name: "loadKTX",
    test(r) {
      return _e(r, ".ktx");
    },
    async load(r, t, e) {
      const i = await (await B.ADAPTER.fetch(r)).arrayBuffer(),
        { compressed: s, uncompressed: n, kvData: a } = tu(r, i),
        o = s != null ? s : n,
        h = ig(
          {
            mipmap: Xt.OFF,
            alphaMode: wt.NO_PREMULTIPLIED_ALPHA,
            resolution: re(r),
          },
          t.data
        ),
        l = o.map((u) => {
          var c;
          o === n && Object.assign(h, { type: u.type, format: u.format });
          const d = (c = u.resource) != null ? c : u,
            f = new j(d, h);
          return (f.ktxKeyValueData = a), lr(f, e, r);
        });
      return l.length === 1 ? l[0] : l;
    },
    unload(r) {
      Array.isArray(r) ? r.forEach((t) => t.destroy(!0)) : r.destroy(!0);
    },
  };
  U.add(au);
  const sg = [
      "s3tc",
      "s3tc_sRGB",
      "etc",
      "etc1",
      "pvrtc",
      "atc",
      "astc",
      "bptc",
    ],
    ou = {
      extension: D.ResolveParser,
      test: (r) => {
        const t = yt.extname(r).slice(1);
        return ["basis", "ktx", "dds"].includes(t);
      },
      parse: (r) => {
        var t, e, i, s;
        const n = r.split("."),
          a = n.pop();
        if (["ktx", "dds"].includes(a)) {
          const o = n.pop();
          if (sg.includes(o))
            return {
              resolution: parseFloat(
                (e = (t = B.RETINA_PREFIX.exec(r)) == null ? void 0 : t[1]) !=
                  null
                  ? e
                  : "1"
              ),
              format: o,
              src: r,
            };
        }
        return {
          resolution: parseFloat(
            (s = (i = B.RETINA_PREFIX.exec(r)) == null ? void 0 : i[1]) != null
              ? s
              : "1"
          ),
          format: a,
          src: r,
        };
      },
    };
  U.add(ou);
  const fs = new Y(),
    ng = 4,
    hu = class Ti {
      constructor(t) {
        (this.renderer = t), (this._rendererPremultipliedAlpha = !1);
      }
      contextChange() {
        var t;
        const e =
          (t = this.renderer) == null ? void 0 : t.gl.getContextAttributes();
        this._rendererPremultipliedAlpha = !!(
          e &&
          e.alpha &&
          e.premultipliedAlpha
        );
      }
      async image(t, e, i, s) {
        const n = new Image();
        return (n.src = await this.base64(t, e, i, s)), n;
      }
      async base64(t, e, i, s) {
        const n = this.canvas(t, s);
        if (n.toBlob !== void 0)
          return new Promise((a, o) => {
            n.toBlob(
              (h) => {
                if (!h) {
                  o(new Error("ICanvas.toBlob failed!"));
                  return;
                }
                const l = new FileReader();
                (l.onload = () => a(l.result)),
                  (l.onerror = o),
                  l.readAsDataURL(h);
              },
              e,
              i
            );
          });
        if (n.toDataURL !== void 0) return n.toDataURL(e, i);
        if (n.convertToBlob !== void 0) {
          const a = await n.convertToBlob({ type: e, quality: i });
          return new Promise((o, h) => {
            const l = new FileReader();
            (l.onload = () => o(l.result)), (l.onerror = h), l.readAsDataURL(a);
          });
        }
        throw new Error(
          "Extract.base64() requires ICanvas.toDataURL, ICanvas.toBlob, or ICanvas.convertToBlob to be implemented"
        );
      }
      canvas(t, e) {
        const {
          pixels: i,
          width: s,
          height: n,
          flipY: a,
          premultipliedAlpha: o,
        } = this._rawPixels(t, e);
        a && Ti._flipY(i, s, n), o && Ti._unpremultiplyAlpha(i);
        const h = new Vo(s, n, 1),
          l = new ImageData(new Uint8ClampedArray(i.buffer), s, n);
        return h.context.putImageData(l, 0, 0), h.canvas;
      }
      pixels(t, e) {
        const {
          pixels: i,
          width: s,
          height: n,
          flipY: a,
          premultipliedAlpha: o,
        } = this._rawPixels(t, e);
        return a && Ti._flipY(i, s, n), o && Ti._unpremultiplyAlpha(i), i;
      }
      _rawPixels(t, e) {
        const i = this.renderer;
        if (!i) throw new Error("The Extract has already been destroyed");
        let s,
          n = !1,
          a = !1,
          o,
          h = !1;
        t &&
          (t instanceof Me
            ? (o = t)
            : ((o = i.generateTexture(t, {
                region: e,
                resolution: i.resolution,
                multisample: i.multisample,
              })),
              (h = !0),
              e && ((fs.width = e.width), (fs.height = e.height), (e = fs))));
        const l = i.gl;
        if (o) {
          if (
            ((s = o.baseTexture.resolution),
            (e = e != null ? e : o.frame),
            (n = !1),
            (a =
              o.baseTexture.alphaMode > 0 && o.baseTexture.format === A.RGBA),
            !h)
          ) {
            i.renderTexture.bind(o);
            const f = o.framebuffer.glFramebuffers[i.CONTEXT_UID];
            f.blitFramebuffer && i.framebuffer.bind(f.blitFramebuffer);
          }
        } else
          (s = i.resolution),
            e || ((e = fs), (e.width = i.width / s), (e.height = i.height / s)),
            (n = !0),
            (a = this._rendererPremultipliedAlpha),
            i.renderTexture.bind();
        const u = Math.max(Math.round(e.width * s), 1),
          c = Math.max(Math.round(e.height * s), 1),
          d = new Uint8Array(ng * u * c);
        return (
          l.readPixels(
            Math.round(e.x * s),
            Math.round(e.y * s),
            u,
            c,
            l.RGBA,
            l.UNSIGNED_BYTE,
            d
          ),
          h && (o == null || o.destroy(!0)),
          { pixels: d, width: u, height: c, flipY: n, premultipliedAlpha: a }
        );
      }
      destroy() {
        this.renderer = null;
      }
      static _flipY(t, e, i) {
        const s = e << 2,
          n = i >> 1,
          a = new Uint8Array(s);
        for (let o = 0; o < n; o++) {
          const h = o * s,
            l = (i - o - 1) * s;
          a.set(t.subarray(h, h + s)), t.copyWithin(h, l, l + s), t.set(a, l);
        }
      }
      static _unpremultiplyAlpha(t) {
        t instanceof Uint8ClampedArray && (t = new Uint8Array(t.buffer));
        const e = t.length;
        for (let i = 0; i < e; i += 4) {
          const s = t[i + 3];
          if (s !== 0) {
            const n = 255.001 / s;
            (t[i] = t[i] * n + 0.5),
              (t[i + 1] = t[i + 1] * n + 0.5),
              (t[i + 2] = t[i + 2] * n + 0.5);
          }
        }
      }
    };
  hu.extension = { name: "extract", type: D.RendererSystem };
  let lu = hu;
  U.add(lu);
  const ei = {
    build(r) {
      const t = r.points;
      let e, i, s, n, a, o;
      if (r.type === mt.CIRC) {
        const p = r.shape;
        (e = p.x), (i = p.y), (a = o = p.radius), (s = n = 0);
      } else if (r.type === mt.ELIP) {
        const p = r.shape;
        (e = p.x), (i = p.y), (a = p.width), (o = p.height), (s = n = 0);
      } else {
        const p = r.shape,
          m = p.width / 2,
          g = p.height / 2;
        (e = p.x + m),
          (i = p.y + g),
          (a = o = Math.max(0, Math.min(p.radius, Math.min(m, g)))),
          (s = m - a),
          (n = g - o);
      }
      if (!(a >= 0 && o >= 0 && s >= 0 && n >= 0)) {
        t.length = 0;
        return;
      }
      const h = Math.ceil(2.3 * Math.sqrt(a + o)),
        l = h * 8 + (s ? 4 : 0) + (n ? 4 : 0);
      if (((t.length = l), l === 0)) return;
      if (h === 0) {
        (t.length = 8),
          (t[0] = t[6] = e + s),
          (t[1] = t[3] = i + n),
          (t[2] = t[4] = e - s),
          (t[5] = t[7] = i - n);
        return;
      }
      let u = 0,
        c = h * 4 + (s ? 2 : 0) + 2,
        d = c,
        f = l;
      {
        const p = s + a,
          m = n,
          g = e + p,
          x = e - p,
          b = i + m;
        if (((t[u++] = g), (t[u++] = b), (t[--c] = b), (t[--c] = x), n)) {
          const _ = i - m;
          (t[d++] = x), (t[d++] = _), (t[--f] = _), (t[--f] = g);
        }
      }
      for (let p = 1; p < h; p++) {
        const m = (Math.PI / 2) * (p / h),
          g = s + Math.cos(m) * a,
          x = n + Math.sin(m) * o,
          b = e + g,
          _ = e - g,
          y = i + x,
          T = i - x;
        (t[u++] = b),
          (t[u++] = y),
          (t[--c] = y),
          (t[--c] = _),
          (t[d++] = _),
          (t[d++] = T),
          (t[--f] = T),
          (t[--f] = b);
      }
      {
        const p = s,
          m = n + o,
          g = e + p,
          x = e - p,
          b = i + m,
          _ = i - m;
        (t[u++] = g),
          (t[u++] = b),
          (t[--f] = _),
          (t[--f] = g),
          s && ((t[u++] = x), (t[u++] = b), (t[--f] = _), (t[--f] = x));
      }
    },
    triangulate(r, t) {
      const e = r.points,
        i = t.points,
        s = t.indices;
      if (e.length === 0) return;
      let n = i.length / 2;
      const a = n;
      let o, h;
      if (r.type !== mt.RREC) {
        const u = r.shape;
        (o = u.x), (h = u.y);
      } else {
        const u = r.shape;
        (o = u.x + u.width / 2), (h = u.y + u.height / 2);
      }
      const l = r.matrix;
      i.push(
        r.matrix ? l.a * o + l.c * h + l.tx : o,
        r.matrix ? l.b * o + l.d * h + l.ty : h
      ),
        n++,
        i.push(e[0], e[1]);
      for (let u = 2; u < e.length; u += 2)
        i.push(e[u], e[u + 1]), s.push(n++, a, n);
      s.push(a + 1, a, n);
    },
  };
  function uu(r, t = !1) {
    const e = r.length;
    if (e < 6) return;
    let i = 0;
    for (let s = 0, n = r[e - 2], a = r[e - 1]; s < e; s += 2) {
      const o = r[s],
        h = r[s + 1];
      (i += (o - n) * (h + a)), (n = o), (a = h);
    }
    if ((!t && i > 0) || (t && i <= 0)) {
      const s = e / 2;
      for (let n = s + (s % 2); n < e; n += 2) {
        const a = e - n - 2,
          o = e - n - 1,
          h = n,
          l = n + 1;
        ([r[a], r[h]] = [r[h], r[a]]), ([r[o], r[l]] = [r[l], r[o]]);
      }
    }
  }
  const da = {
      build(r) {
        r.points = r.shape.points.slice();
      },
      triangulate(r, t) {
        let e = r.points;
        const i = r.holes,
          s = t.points,
          n = t.indices;
        if (e.length >= 6) {
          uu(e, !1);
          const a = [];
          for (let l = 0; l < i.length; l++) {
            const u = i[l];
            uu(u.points, !0), a.push(e.length / 2), (e = e.concat(u.points));
          }
          const o = _o(e, a, 2);
          if (!o) return;
          const h = s.length / 2;
          for (let l = 0; l < o.length; l += 3)
            n.push(o[l] + h), n.push(o[l + 1] + h), n.push(o[l + 2] + h);
          for (let l = 0; l < e.length; l++) s.push(e[l]);
        }
      },
    },
    cu = {
      build(r) {
        const t = r.shape,
          e = t.x,
          i = t.y,
          s = t.width,
          n = t.height,
          a = r.points;
        (a.length = 0),
          s >= 0 && n >= 0 && a.push(e, i, e + s, i, e + s, i + n, e, i + n);
      },
      triangulate(r, t) {
        const e = r.points,
          i = t.points;
        if (e.length === 0) return;
        const s = i.length / 2;
        i.push(e[0], e[1], e[2], e[3], e[6], e[7], e[4], e[5]),
          t.indices.push(s, s + 1, s + 2, s + 1, s + 2, s + 3);
      },
    },
    du = {
      build(r) {
        ei.build(r);
      },
      triangulate(r, t) {
        ei.triangulate(r, t);
      },
    };
  var Bt = ((r) => (
      (r.MITER = "miter"), (r.BEVEL = "bevel"), (r.ROUND = "round"), r
    ))(Bt || {}),
    ve = ((r) => (
      (r.BUTT = "butt"), (r.ROUND = "round"), (r.SQUARE = "square"), r
    ))(ve || {});
  const Fe = {
      adaptive: !0,
      maxLength: 10,
      minSegments: 8,
      maxSegments: 2048,
      epsilon: 1e-4,
      _segmentsCount(r, t = 20) {
        if (!this.adaptive || !r || isNaN(r)) return t;
        let e = Math.ceil(r / this.maxLength);
        return (
          e < this.minSegments
            ? (e = this.minSegments)
            : e > this.maxSegments && (e = this.maxSegments),
          e
        );
      },
    },
    ag = Fe;
  class fa {
    static curveTo(t, e, i, s, n, a) {
      const o = a[a.length - 2],
        h = a[a.length - 1] - e,
        l = o - t,
        u = s - e,
        c = i - t,
        d = Math.abs(h * c - l * u);
      if (d < 1e-8 || n === 0)
        return (
          (a[a.length - 2] !== t || a[a.length - 1] !== e) && a.push(t, e), null
        );
      const f = h * h + l * l,
        p = u * u + c * c,
        m = h * u + l * c,
        g = (n * Math.sqrt(f)) / d,
        x = (n * Math.sqrt(p)) / d,
        b = (g * m) / f,
        _ = (x * m) / p,
        y = g * c + x * l,
        T = g * u + x * h,
        C = l * (x + b),
        R = h * (x + b),
        S = c * (g + _),
        I = u * (g + _),
        $ = Math.atan2(R - T, C - y),
        z = Math.atan2(I - T, S - y);
      return {
        cx: y + t,
        cy: T + e,
        radius: n,
        startAngle: $,
        endAngle: z,
        anticlockwise: l * u > c * h,
      };
    }
    static arc(t, e, i, s, n, a, o, h, l) {
      const u = o - a,
        c = Fe._segmentsCount(
          Math.abs(u) * n,
          Math.ceil(Math.abs(u) / Ur) * 40
        ),
        d = u / (c * 2),
        f = d * 2,
        p = Math.cos(d),
        m = Math.sin(d),
        g = c - 1,
        x = (g % 1) / g;
      for (let b = 0; b <= g; ++b) {
        const _ = b + x * b,
          y = d + a + f * _,
          T = Math.cos(y),
          C = -Math.sin(y);
        l.push((p * T + m * C) * n + i, (p * -C + m * T) * n + s);
      }
    }
  }
  class fu {
    constructor() {
      this.reset();
    }
    begin(t, e, i) {
      this.reset(), (this.style = t), (this.start = e), (this.attribStart = i);
    }
    end(t, e) {
      (this.attribSize = e - this.attribStart), (this.size = t - this.start);
    }
    reset() {
      (this.style = null),
        (this.size = 0),
        (this.start = 0),
        (this.attribStart = 0),
        (this.attribSize = 0);
    }
  }
  class ps {
    static curveLength(t, e, i, s, n, a, o, h) {
      let l = 0,
        u = 0,
        c = 0,
        d = 0,
        f = 0,
        p = 0,
        m = 0,
        g = 0,
        x = 0,
        b = 0,
        _ = 0,
        y = t,
        T = e;
      for (let C = 1; C <= 10; ++C)
        (u = C / 10),
          (c = u * u),
          (d = c * u),
          (f = 1 - u),
          (p = f * f),
          (m = p * f),
          (g = m * t + 3 * p * u * i + 3 * f * c * n + d * o),
          (x = m * e + 3 * p * u * s + 3 * f * c * a + d * h),
          (b = y - g),
          (_ = T - x),
          (y = g),
          (T = x),
          (l += Math.sqrt(b * b + _ * _));
      return l;
    }
    static curveTo(t, e, i, s, n, a, o) {
      const h = o[o.length - 2],
        l = o[o.length - 1];
      o.length -= 2;
      const u = Fe._segmentsCount(ps.curveLength(h, l, t, e, i, s, n, a));
      let c = 0,
        d = 0,
        f = 0,
        p = 0,
        m = 0;
      o.push(h, l);
      for (let g = 1, x = 0; g <= u; ++g)
        (x = g / u),
          (c = 1 - x),
          (d = c * c),
          (f = d * c),
          (p = x * x),
          (m = p * x),
          o.push(
            f * h + 3 * d * x * t + 3 * c * p * i + m * n,
            f * l + 3 * d * x * e + 3 * c * p * s + m * a
          );
    }
  }
  function pu(r, t, e, i, s, n, a, o) {
    const h = r - e * s,
      l = t - i * s,
      u = r + e * n,
      c = t + i * n;
    let d, f;
    a ? ((d = i), (f = -e)) : ((d = -i), (f = e));
    const p = h + d,
      m = l + f,
      g = u + d,
      x = c + f;
    return o.push(p, m, g, x), 2;
  }
  function Qe(r, t, e, i, s, n, a, o) {
    const h = e - r,
      l = i - t;
    let u = Math.atan2(h, l),
      c = Math.atan2(s - r, n - t);
    o && u < c ? (u += Math.PI * 2) : !o && u > c && (c += Math.PI * 2);
    let d = u;
    const f = c - u,
      p = Math.abs(f),
      m = Math.sqrt(h * h + l * l),
      g = (((15 * p * Math.sqrt(m)) / Math.PI) >> 0) + 1,
      x = f / g;
    if (((d += x), o)) {
      a.push(r, t, e, i);
      for (let b = 1, _ = d; b < g; b++, _ += x)
        a.push(r, t, r + Math.sin(_) * m, t + Math.cos(_) * m);
      a.push(r, t, s, n);
    } else {
      a.push(e, i, r, t);
      for (let b = 1, _ = d; b < g; b++, _ += x)
        a.push(r + Math.sin(_) * m, t + Math.cos(_) * m, r, t);
      a.push(s, n, r, t);
    }
    return g * 2;
  }
  function og(r, t) {
    const e = r.shape;
    let i = r.points || e.points.slice();
    const s = t.closePointEps;
    if (i.length === 0) return;
    const n = r.lineStyle,
      a = new tt(i[0], i[1]),
      o = new tt(i[i.length - 2], i[i.length - 1]),
      h = e.type !== mt.POLY || e.closeStroke,
      l = Math.abs(a.x - o.x) < s && Math.abs(a.y - o.y) < s;
    if (h) {
      (i = i.slice()),
        l && (i.pop(), i.pop(), o.set(i[i.length - 2], i[i.length - 1]));
      const L = (a.x + o.x) * 0.5,
        W = (o.y + a.y) * 0.5;
      i.unshift(L, W), i.push(L, W);
    }
    const u = t.points,
      c = i.length / 2;
    let d = i.length;
    const f = u.length / 2,
      p = n.width / 2,
      m = p * p,
      g = n.miterLimit * n.miterLimit;
    let x = i[0],
      b = i[1],
      _ = i[2],
      y = i[3],
      T = 0,
      C = 0,
      R = -(b - y),
      S = x - _,
      I = 0,
      $ = 0,
      z = Math.sqrt(R * R + S * S);
    (R /= z), (S /= z), (R *= p), (S *= p);
    const F = n.alignment,
      E = (1 - F) * 2,
      w = F * 2;
    h ||
      (n.cap === ve.ROUND
        ? (d +=
            Qe(
              x - R * (E - w) * 0.5,
              b - S * (E - w) * 0.5,
              x - R * E,
              b - S * E,
              x + R * w,
              b + S * w,
              u,
              !0
            ) + 2)
        : n.cap === ve.SQUARE && (d += pu(x, b, R, S, E, w, !0, u))),
      u.push(x - R * E, b - S * E, x + R * w, b + S * w);
    for (let L = 1; L < c - 1; ++L) {
      (x = i[(L - 1) * 2]),
        (b = i[(L - 1) * 2 + 1]),
        (_ = i[L * 2]),
        (y = i[L * 2 + 1]),
        (T = i[(L + 1) * 2]),
        (C = i[(L + 1) * 2 + 1]),
        (R = -(b - y)),
        (S = x - _),
        (z = Math.sqrt(R * R + S * S)),
        (R /= z),
        (S /= z),
        (R *= p),
        (S *= p),
        (I = -(y - C)),
        ($ = _ - T),
        (z = Math.sqrt(I * I + $ * $)),
        (I /= z),
        ($ /= z),
        (I *= p),
        ($ *= p);
      const W = _ - x,
        lt = b - y,
        P = _ - T,
        M = C - y,
        q = W * P + lt * M,
        Q = lt * P - M * W,
        J = Q < 0;
      if (Math.abs(Q) < 0.001 * Math.abs(q)) {
        u.push(_ - R * E, y - S * E, _ + R * w, y + S * w),
          q >= 0 &&
            (n.join === Bt.ROUND
              ? (d +=
                  Qe(_, y, _ - R * E, y - S * E, _ - I * E, y - $ * E, u, !1) +
                  4)
              : (d += 2),
            u.push(_ - I * w, y - $ * w, _ + I * E, y + $ * E));
        continue;
      }
      const vt = (-R + x) * (-S + y) - (-R + _) * (-S + b),
        ct = (-I + T) * (-$ + y) - (-I + _) * (-$ + C),
        xt = (W * ct - P * vt) / Q,
        St = (M * vt - lt * ct) / Q,
        Ft = (xt - _) * (xt - _) + (St - y) * (St - y),
        bt = _ + (xt - _) * E,
        it = y + (St - y) * E,
        dt = _ - (xt - _) * w,
        ft = y - (St - y) * w,
        ue = Math.min(W * W + lt * lt, P * P + M * M),
        ce = J ? E : w,
        yi = ue + ce * ce * m,
        y_ = Ft <= yi;
      let Fs = n.join;
      if ((Fs === Bt.MITER && Ft / m > g && (Fs = Bt.BEVEL), y_))
        switch (Fs) {
          case Bt.MITER: {
            u.push(bt, it, dt, ft);
            break;
          }
          case Bt.BEVEL: {
            J
              ? u.push(
                  bt,
                  it,
                  _ + R * w,
                  y + S * w,
                  bt,
                  it,
                  _ + I * w,
                  y + $ * w
                )
              : u.push(
                  _ - R * E,
                  y - S * E,
                  dt,
                  ft,
                  _ - I * E,
                  y - $ * E,
                  dt,
                  ft
                ),
              (d += 2);
            break;
          }
          case Bt.ROUND: {
            J
              ? (u.push(bt, it, _ + R * w, y + S * w),
                (d +=
                  Qe(_, y, _ + R * w, y + S * w, _ + I * w, y + $ * w, u, !0) +
                  4),
                u.push(bt, it, _ + I * w, y + $ * w))
              : (u.push(_ - R * E, y - S * E, dt, ft),
                (d +=
                  Qe(_, y, _ - R * E, y - S * E, _ - I * E, y - $ * E, u, !1) +
                  4),
                u.push(_ - I * E, y - $ * E, dt, ft));
            break;
          }
        }
      else {
        switch ((u.push(_ - R * E, y - S * E, _ + R * w, y + S * w), Fs)) {
          case Bt.MITER: {
            J ? u.push(dt, ft, dt, ft) : u.push(bt, it, bt, it), (d += 2);
            break;
          }
          case Bt.ROUND: {
            J
              ? (d +=
                  Qe(_, y, _ + R * w, y + S * w, _ + I * w, y + $ * w, u, !0) +
                  2)
              : (d +=
                  Qe(_, y, _ - R * E, y - S * E, _ - I * E, y - $ * E, u, !1) +
                  2);
            break;
          }
        }
        u.push(_ - I * E, y - $ * E, _ + I * w, y + $ * w), (d += 2);
      }
    }
    (x = i[(c - 2) * 2]),
      (b = i[(c - 2) * 2 + 1]),
      (_ = i[(c - 1) * 2]),
      (y = i[(c - 1) * 2 + 1]),
      (R = -(b - y)),
      (S = x - _),
      (z = Math.sqrt(R * R + S * S)),
      (R /= z),
      (S /= z),
      (R *= p),
      (S *= p),
      u.push(_ - R * E, y - S * E, _ + R * w, y + S * w),
      h ||
        (n.cap === ve.ROUND
          ? (d +=
              Qe(
                _ - R * (E - w) * 0.5,
                y - S * (E - w) * 0.5,
                _ - R * E,
                y - S * E,
                _ + R * w,
                y + S * w,
                u,
                !1
              ) + 2)
          : n.cap === ve.SQUARE && (d += pu(_, y, R, S, E, w, !1, u)));
    const V = t.indices,
      k = Fe.epsilon * Fe.epsilon;
    for (let L = f; L < d + f - 2; ++L)
      (x = u[L * 2]),
        (b = u[L * 2 + 1]),
        (_ = u[(L + 1) * 2]),
        (y = u[(L + 1) * 2 + 1]),
        (T = u[(L + 2) * 2]),
        (C = u[(L + 2) * 2 + 1]),
        !(Math.abs(x * (y - C) + _ * (C - b) + T * (b - y)) < k) &&
          V.push(L, L + 1, L + 2);
  }
  function hg(r, t) {
    let e = 0;
    const i = r.shape,
      s = r.points || i.points,
      n = i.type !== mt.POLY || i.closeStroke;
    if (s.length === 0) return;
    const a = t.points,
      o = t.indices,
      h = s.length / 2,
      l = a.length / 2;
    let u = l;
    for (a.push(s[0], s[1]), e = 1; e < h; e++)
      a.push(s[e * 2], s[e * 2 + 1]), o.push(u, u + 1), u++;
    n && o.push(u, l);
  }
  function pa(r, t) {
    r.lineStyle.native ? hg(r, t) : og(r, t);
  }
  class ms {
    static curveLength(t, e, i, s, n, a) {
      const o = t - 2 * i + n,
        h = e - 2 * s + a,
        l = 2 * i - 2 * t,
        u = 2 * s - 2 * e,
        c = 4 * (o * o + h * h),
        d = 4 * (o * l + h * u),
        f = l * l + u * u,
        p = 2 * Math.sqrt(c + d + f),
        m = Math.sqrt(c),
        g = 2 * c * m,
        x = 2 * Math.sqrt(f),
        b = d / m;
      return (
        (g * p +
          m * d * (p - x) +
          (4 * f * c - d * d) * Math.log((2 * m + b + p) / (b + x))) /
        (4 * g)
      );
    }
    static curveTo(t, e, i, s, n) {
      const a = n[n.length - 2],
        o = n[n.length - 1],
        h = Fe._segmentsCount(ms.curveLength(a, o, t, e, i, s));
      let l = 0,
        u = 0;
      for (let c = 1; c <= h; ++c) {
        const d = c / h;
        (l = a + (t - a) * d),
          (u = o + (e - o) * d),
          n.push(l + (t + (i - t) * d - l) * d, u + (e + (s - e) * d - u) * d);
      }
    }
  }
  const gs = {
      [mt.POLY]: da,
      [mt.CIRC]: ei,
      [mt.ELIP]: ei,
      [mt.RECT]: cu,
      [mt.RREC]: du,
    },
    ma = [],
    ri = [];
  class ii {
    constructor(t, e = null, i = null, s = null) {
      (this.points = []),
        (this.holes = []),
        (this.shape = t),
        (this.lineStyle = i),
        (this.fillStyle = e),
        (this.matrix = s),
        (this.type = t.type);
    }
    clone() {
      return new ii(this.shape, this.fillStyle, this.lineStyle, this.matrix);
    }
    destroy() {
      (this.shape = null),
        (this.holes.length = 0),
        (this.holes = null),
        (this.points.length = 0),
        (this.points = null),
        (this.lineStyle = null),
        (this.fillStyle = null);
    }
  }
  const dr = new tt(),
    mu = class Nc extends En {
      constructor() {
        super(),
          (this.closePointEps = 1e-4),
          (this.boundsPadding = 0),
          (this.uvsFloat32 = null),
          (this.indicesUint16 = null),
          (this.batchable = !1),
          (this.points = []),
          (this.colors = []),
          (this.uvs = []),
          (this.indices = []),
          (this.textureIds = []),
          (this.graphicsData = []),
          (this.drawCalls = []),
          (this.batchDirty = -1),
          (this.batches = []),
          (this.dirty = 0),
          (this.cacheDirty = -1),
          (this.clearDirty = 0),
          (this.shapeIndex = 0),
          (this._bounds = new qr()),
          (this.boundsDirty = -1);
      }
      get bounds() {
        return (
          this.updateBatches(),
          this.boundsDirty !== this.dirty &&
            ((this.boundsDirty = this.dirty), this.calculateBounds()),
          this._bounds
        );
      }
      invalidate() {
        (this.boundsDirty = -1),
          this.dirty++,
          this.batchDirty++,
          (this.shapeIndex = 0),
          (this.points.length = 0),
          (this.colors.length = 0),
          (this.uvs.length = 0),
          (this.indices.length = 0),
          (this.textureIds.length = 0);
        for (let t = 0; t < this.drawCalls.length; t++)
          this.drawCalls[t].texArray.clear(), ri.push(this.drawCalls[t]);
        this.drawCalls.length = 0;
        for (let t = 0; t < this.batches.length; t++) {
          const e = this.batches[t];
          e.reset(), ma.push(e);
        }
        this.batches.length = 0;
      }
      clear() {
        return (
          this.graphicsData.length > 0 &&
            (this.invalidate(),
            this.clearDirty++,
            (this.graphicsData.length = 0)),
          this
        );
      }
      drawShape(t, e = null, i = null, s = null) {
        const n = new ii(t, e, i, s);
        return this.graphicsData.push(n), this.dirty++, this;
      }
      drawHole(t, e = null) {
        if (!this.graphicsData.length) return null;
        const i = new ii(t, null, null, e),
          s = this.graphicsData[this.graphicsData.length - 1];
        return (i.lineStyle = s.lineStyle), s.holes.push(i), this.dirty++, this;
      }
      destroy() {
        super.destroy();
        for (let t = 0; t < this.graphicsData.length; ++t)
          this.graphicsData[t].destroy();
        (this.points.length = 0),
          (this.points = null),
          (this.colors.length = 0),
          (this.colors = null),
          (this.uvs.length = 0),
          (this.uvs = null),
          (this.indices.length = 0),
          (this.indices = null),
          this.indexBuffer.destroy(),
          (this.indexBuffer = null),
          (this.graphicsData.length = 0),
          (this.graphicsData = null),
          (this.drawCalls.length = 0),
          (this.drawCalls = null),
          (this.batches.length = 0),
          (this.batches = null),
          (this._bounds = null);
      }
      containsPoint(t) {
        const e = this.graphicsData;
        for (let i = 0; i < e.length; ++i) {
          const s = e[i];
          if (
            s.fillStyle.visible &&
            s.shape &&
            (s.matrix ? s.matrix.applyInverse(t, dr) : dr.copyFrom(t),
            s.shape.contains(dr.x, dr.y))
          ) {
            let n = !1;
            if (s.holes) {
              for (let a = 0; a < s.holes.length; a++)
                if (s.holes[a].shape.contains(dr.x, dr.y)) {
                  n = !0;
                  break;
                }
            }
            if (!n) return !0;
          }
        }
        return !1;
      }
      updateBatches() {
        if (!this.graphicsData.length) {
          this.batchable = !0;
          return;
        }
        if (!this.validateBatching()) return;
        this.cacheDirty = this.dirty;
        const t = this.uvs,
          e = this.graphicsData;
        let i = null,
          s = null;
        this.batches.length > 0 &&
          ((i = this.batches[this.batches.length - 1]), (s = i.style));
        for (let h = this.shapeIndex; h < e.length; h++) {
          this.shapeIndex++;
          const l = e[h],
            u = l.fillStyle,
            c = l.lineStyle;
          gs[l.type].build(l),
            l.matrix && this.transformPoints(l.points, l.matrix),
            (u.visible || c.visible) && this.processHoles(l.holes);
          for (let d = 0; d < 2; d++) {
            const f = d === 0 ? u : c;
            if (!f.visible) continue;
            const p = f.texture.baseTexture,
              m = this.indices.length,
              g = this.points.length / 2;
            (p.wrapMode = Jt.REPEAT),
              d === 0 ? this.processFill(l) : this.processLine(l);
            const x = this.points.length / 2 - g;
            x !== 0 &&
              (i && !this._compareStyles(s, f) && (i.end(m, g), (i = null)),
              i ||
                ((i = ma.pop() || new fu()),
                i.begin(f, m, g),
                this.batches.push(i),
                (s = f)),
              this.addUvs(this.points, t, f.texture, g, x, f.matrix));
          }
        }
        const n = this.indices.length,
          a = this.points.length / 2;
        if ((i && i.end(n, a), this.batches.length === 0)) {
          this.batchable = !0;
          return;
        }
        const o = a > 65535;
        this.indicesUint16 &&
        this.indices.length === this.indicesUint16.length &&
        o === this.indicesUint16.BYTES_PER_ELEMENT > 2
          ? this.indicesUint16.set(this.indices)
          : (this.indicesUint16 = o
              ? new Uint32Array(this.indices)
              : new Uint16Array(this.indices)),
          (this.batchable = this.isBatchable()),
          this.batchable ? this.packBatches() : this.buildDrawCalls();
      }
      _compareStyles(t, e) {
        return !(
          !t ||
          !e ||
          t.texture.baseTexture !== e.texture.baseTexture ||
          t.color + t.alpha !== e.color + e.alpha ||
          !!t.native != !!e.native
        );
      }
      validateBatching() {
        if (this.dirty === this.cacheDirty || !this.graphicsData.length)
          return !1;
        for (let t = 0, e = this.graphicsData.length; t < e; t++) {
          const i = this.graphicsData[t],
            s = i.fillStyle,
            n = i.lineStyle;
          if (
            (s && !s.texture.baseTexture.valid) ||
            (n && !n.texture.baseTexture.valid)
          )
            return !1;
        }
        return !0;
      }
      packBatches() {
        this.batchDirty++, (this.uvsFloat32 = new Float32Array(this.uvs));
        const t = this.batches;
        for (let e = 0, i = t.length; e < i; e++) {
          const s = t[e];
          for (let n = 0; n < s.size; n++) {
            const a = s.start + n;
            this.indicesUint16[a] = this.indicesUint16[a] - s.attribStart;
          }
        }
      }
      isBatchable() {
        if (this.points.length > 65535 * 2) return !1;
        const t = this.batches;
        for (let e = 0; e < t.length; e++) if (t[e].style.native) return !1;
        return this.points.length < Nc.BATCHABLE_SIZE * 2;
      }
      buildDrawCalls() {
        let t = ++j._globalBatch;
        for (let c = 0; c < this.drawCalls.length; c++)
          this.drawCalls[c].texArray.clear(), ri.push(this.drawCalls[c]);
        this.drawCalls.length = 0;
        const e = this.colors,
          i = this.textureIds;
        let s = ri.pop();
        s || ((s = new Gi()), (s.texArray = new Ki())),
          (s.texArray.count = 0),
          (s.start = 0),
          (s.size = 0),
          (s.type = Vt.TRIANGLES);
        let n = 0,
          a = null,
          o = 0,
          h = !1,
          l = Vt.TRIANGLES,
          u = 0;
        this.drawCalls.push(s);
        for (let c = 0; c < this.batches.length; c++) {
          const d = this.batches[c],
            f = 8,
            p = d.style,
            m = p.texture.baseTexture;
          h !== !!p.native &&
            ((h = !!p.native),
            (l = h ? Vt.LINES : Vt.TRIANGLES),
            (a = null),
            (n = f),
            t++),
            a !== m &&
              ((a = m),
              m._batchEnabled !== t &&
                (n === f &&
                  (t++,
                  (n = 0),
                  s.size > 0 &&
                    ((s = ri.pop()),
                    s || ((s = new Gi()), (s.texArray = new Ki())),
                    this.drawCalls.push(s)),
                  (s.start = u),
                  (s.size = 0),
                  (s.texArray.count = 0),
                  (s.type = l)),
                (m.touched = 1),
                (m._batchEnabled = t),
                (m._batchLocation = n),
                (m.wrapMode = Jt.REPEAT),
                (s.texArray.elements[s.texArray.count++] = m),
                n++)),
            (s.size += d.size),
            (u += d.size),
            (o = m._batchLocation),
            this.addColors(e, p.color, p.alpha, d.attribSize, d.attribStart),
            this.addTextureIds(i, o, d.attribSize, d.attribStart);
        }
        (j._globalBatch = t), this.packAttributes();
      }
      packAttributes() {
        const t = this.points,
          e = this.uvs,
          i = this.colors,
          s = this.textureIds,
          n = new ArrayBuffer(t.length * 3 * 4),
          a = new Float32Array(n),
          o = new Uint32Array(n);
        let h = 0;
        for (let l = 0; l < t.length / 2; l++)
          (a[h++] = t[l * 2]),
            (a[h++] = t[l * 2 + 1]),
            (a[h++] = e[l * 2]),
            (a[h++] = e[l * 2 + 1]),
            (o[h++] = i[l]),
            (a[h++] = s[l]);
        this._buffer.update(n), this._indexBuffer.update(this.indicesUint16);
      }
      processFill(t) {
        t.holes.length
          ? da.triangulate(t, this)
          : gs[t.type].triangulate(t, this);
      }
      processLine(t) {
        pa(t, this);
        for (let e = 0; e < t.holes.length; e++) pa(t.holes[e], this);
      }
      processHoles(t) {
        for (let e = 0; e < t.length; e++) {
          const i = t[e];
          gs[i.type].build(i),
            i.matrix && this.transformPoints(i.points, i.matrix);
        }
      }
      calculateBounds() {
        const t = this._bounds;
        t.clear(),
          t.addVertexData(this.points, 0, this.points.length),
          t.pad(this.boundsPadding, this.boundsPadding);
      }
      transformPoints(t, e) {
        for (let i = 0; i < t.length / 2; i++) {
          const s = t[i * 2],
            n = t[i * 2 + 1];
          (t[i * 2] = e.a * s + e.c * n + e.tx),
            (t[i * 2 + 1] = e.b * s + e.d * n + e.ty);
        }
      }
      addColors(t, e, i, s, n = 0) {
        const a = K.shared.setValue(e).toLittleEndianNumber(),
          o = K.shared.setValue(a).toPremultiplied(i);
        t.length = Math.max(t.length, n + s);
        for (let h = 0; h < s; h++) t[n + h] = o;
      }
      addTextureIds(t, e, i, s = 0) {
        t.length = Math.max(t.length, s + i);
        for (let n = 0; n < i; n++) t[s + n] = e;
      }
      addUvs(t, e, i, s, n, a = null) {
        let o = 0;
        const h = e.length,
          l = i.frame;
        for (; o < n; ) {
          let c = t[(s + o) * 2],
            d = t[(s + o) * 2 + 1];
          if (a) {
            const f = a.a * c + a.c * d + a.tx;
            (d = a.b * c + a.d * d + a.ty), (c = f);
          }
          o++, e.push(c / l.width, d / l.height);
        }
        const u = i.baseTexture;
        (l.width < u.width || l.height < u.height) &&
          this.adjustUvs(e, i, h, n);
      }
      adjustUvs(t, e, i, s) {
        const n = e.baseTexture,
          a = 1e-6,
          o = i + s * 2,
          h = e.frame,
          l = h.width / n.width,
          u = h.height / n.height;
        let c = h.x / h.width,
          d = h.y / h.height,
          f = Math.floor(t[i] + a),
          p = Math.floor(t[i + 1] + a);
        for (let m = i + 2; m < o; m += 2)
          (f = Math.min(f, Math.floor(t[m] + a))),
            (p = Math.min(p, Math.floor(t[m + 1] + a)));
        (c -= f), (d -= p);
        for (let m = i; m < o; m += 2)
          (t[m] = (t[m] + c) * l), (t[m + 1] = (t[m + 1] + d) * u);
      }
    };
  mu.BATCHABLE_SIZE = 100;
  let gu = mu;
  class si {
    constructor() {
      (this.color = 16777215),
        (this.alpha = 1),
        (this.texture = O.WHITE),
        (this.matrix = null),
        (this.visible = !1),
        this.reset();
    }
    clone() {
      const t = new si();
      return (
        (t.color = this.color),
        (t.alpha = this.alpha),
        (t.texture = this.texture),
        (t.matrix = this.matrix),
        (t.visible = this.visible),
        t
      );
    }
    reset() {
      (this.color = 16777215),
        (this.alpha = 1),
        (this.texture = O.WHITE),
        (this.matrix = null),
        (this.visible = !1);
    }
    destroy() {
      (this.texture = null), (this.matrix = null);
    }
  }
  class _s extends si {
    constructor() {
      super(...arguments),
        (this.width = 0),
        (this.alignment = 0.5),
        (this.native = !1),
        (this.cap = ve.BUTT),
        (this.join = Bt.MITER),
        (this.miterLimit = 10);
    }
    clone() {
      const t = new _s();
      return (
        (t.color = this.color),
        (t.alpha = this.alpha),
        (t.texture = this.texture),
        (t.matrix = this.matrix),
        (t.visible = this.visible),
        (t.width = this.width),
        (t.alignment = this.alignment),
        (t.native = this.native),
        (t.cap = this.cap),
        (t.join = this.join),
        (t.miterLimit = this.miterLimit),
        t
      );
    }
    reset() {
      super.reset(),
        (this.color = 0),
        (this.alignment = 0.5),
        (this.width = 0),
        (this.native = !1),
        (this.cap = ve.BUTT),
        (this.join = Bt.MITER),
        (this.miterLimit = 10);
    }
  }
  const ga = {},
    _a = class $s extends Ot {
      constructor(t = null) {
        super(),
          (this.shader = null),
          (this.pluginName = "batch"),
          (this.currentPath = null),
          (this.batches = []),
          (this.batchTint = -1),
          (this.batchDirty = -1),
          (this.vertexData = null),
          (this._fillStyle = new si()),
          (this._lineStyle = new _s()),
          (this._matrix = null),
          (this._holeMode = !1),
          (this.state = ie.for2d()),
          (this._geometry = t || new gu()),
          this._geometry.refCount++,
          (this._transformID = -1),
          (this._tintColor = new K(16777215)),
          (this.blendMode = X.NORMAL);
      }
      get geometry() {
        return this._geometry;
      }
      clone() {
        return this.finishPoly(), new $s(this._geometry);
      }
      set blendMode(t) {
        this.state.blendMode = t;
      }
      get blendMode() {
        return this.state.blendMode;
      }
      get tint() {
        return this._tintColor.value;
      }
      set tint(t) {
        this._tintColor.setValue(t);
      }
      get fill() {
        return this._fillStyle;
      }
      get line() {
        return this._lineStyle;
      }
      lineStyle(t = null, e = 0, i, s = 0.5, n = !1) {
        return (
          typeof t == "number" &&
            (t = { width: t, color: e, alpha: i, alignment: s, native: n }),
          this.lineTextureStyle(t)
        );
      }
      lineTextureStyle(t) {
        const e = {
          width: 0,
          texture: O.WHITE,
          color: t != null && t.texture ? 16777215 : 0,
          matrix: null,
          alignment: 0.5,
          native: !1,
          cap: ve.BUTT,
          join: Bt.MITER,
          miterLimit: 10,
        };
        (t = Object.assign(e, t)),
          this.normalizeColor(t),
          this.currentPath && this.startPoly();
        const i = t.width > 0 && t.alpha > 0;
        return (
          i
            ? (t.matrix && ((t.matrix = t.matrix.clone()), t.matrix.invert()),
              Object.assign(this._lineStyle, { visible: i }, t))
            : this._lineStyle.reset(),
          this
        );
      }
      startPoly() {
        if (this.currentPath) {
          const t = this.currentPath.points,
            e = this.currentPath.points.length;
          e > 2 &&
            (this.drawShape(this.currentPath),
            (this.currentPath = new Ve()),
            (this.currentPath.closeStroke = !1),
            this.currentPath.points.push(t[e - 2], t[e - 1]));
        } else
          (this.currentPath = new Ve()), (this.currentPath.closeStroke = !1);
      }
      finishPoly() {
        this.currentPath &&
          (this.currentPath.points.length > 2
            ? (this.drawShape(this.currentPath), (this.currentPath = null))
            : (this.currentPath.points.length = 0));
      }
      moveTo(t, e) {
        return (
          this.startPoly(),
          (this.currentPath.points[0] = t),
          (this.currentPath.points[1] = e),
          this
        );
      }
      lineTo(t, e) {
        this.currentPath || this.moveTo(0, 0);
        const i = this.currentPath.points,
          s = i[i.length - 2],
          n = i[i.length - 1];
        return (s !== t || n !== e) && i.push(t, e), this;
      }
      _initCurve(t = 0, e = 0) {
        this.currentPath
          ? this.currentPath.points.length === 0 &&
            (this.currentPath.points = [t, e])
          : this.moveTo(t, e);
      }
      quadraticCurveTo(t, e, i, s) {
        this._initCurve();
        const n = this.currentPath.points;
        return (
          n.length === 0 && this.moveTo(0, 0), ms.curveTo(t, e, i, s, n), this
        );
      }
      bezierCurveTo(t, e, i, s, n, a) {
        return (
          this._initCurve(),
          ps.curveTo(t, e, i, s, n, a, this.currentPath.points),
          this
        );
      }
      arcTo(t, e, i, s, n) {
        this._initCurve(t, e);
        const a = this.currentPath.points,
          o = fa.curveTo(t, e, i, s, n, a);
        if (o) {
          const {
            cx: h,
            cy: l,
            radius: u,
            startAngle: c,
            endAngle: d,
            anticlockwise: f,
          } = o;
          this.arc(h, l, u, c, d, f);
        }
        return this;
      }
      arc(t, e, i, s, n, a = !1) {
        if (s === n) return this;
        if ((!a && n <= s ? (n += Ur) : a && s <= n && (s += Ur), n - s === 0))
          return this;
        const o = t + Math.cos(s) * i,
          h = e + Math.sin(s) * i,
          l = this._geometry.closePointEps;
        let u = this.currentPath ? this.currentPath.points : null;
        if (u) {
          const c = Math.abs(u[u.length - 2] - o),
            d = Math.abs(u[u.length - 1] - h);
          (c < l && d < l) || u.push(o, h);
        } else this.moveTo(o, h), (u = this.currentPath.points);
        return fa.arc(o, h, t, e, i, s, n, a, u), this;
      }
      beginFill(t = 0, e) {
        return this.beginTextureFill({ texture: O.WHITE, color: t, alpha: e });
      }
      normalizeColor(t) {
        var e, i;
        const s = K.shared.setValue((e = t.color) != null ? e : 0);
        (t.color = s.toNumber()), (i = t.alpha) != null || (t.alpha = s.alpha);
      }
      beginTextureFill(t) {
        const e = { texture: O.WHITE, color: 16777215, matrix: null };
        (t = Object.assign(e, t)),
          this.normalizeColor(t),
          this.currentPath && this.startPoly();
        const i = t.alpha > 0;
        return (
          i
            ? (t.matrix && ((t.matrix = t.matrix.clone()), t.matrix.invert()),
              Object.assign(this._fillStyle, { visible: i }, t))
            : this._fillStyle.reset(),
          this
        );
      }
      endFill() {
        return this.finishPoly(), this._fillStyle.reset(), this;
      }
      drawRect(t, e, i, s) {
        return this.drawShape(new Y(t, e, i, s));
      }
      drawRoundedRect(t, e, i, s, n) {
        return this.drawShape(new Xi(t, e, i, s, n));
      }
      drawCircle(t, e, i) {
        return this.drawShape(new Hi(t, e, i));
      }
      drawEllipse(t, e, i, s) {
        return this.drawShape(new Vi(t, e, i, s));
      }
      drawPolygon(...t) {
        let e,
          i = !0;
        const s = t[0];
        s.points
          ? ((i = s.closeStroke), (e = s.points))
          : Array.isArray(t[0])
          ? (e = t[0])
          : (e = t);
        const n = new Ve(e);
        return (n.closeStroke = i), this.drawShape(n), this;
      }
      drawShape(t) {
        return (
          this._holeMode
            ? this._geometry.drawHole(t, this._matrix)
            : this._geometry.drawShape(
                t,
                this._fillStyle.clone(),
                this._lineStyle.clone(),
                this._matrix
              ),
          this
        );
      }
      clear() {
        return (
          this._geometry.clear(),
          this._lineStyle.reset(),
          this._fillStyle.reset(),
          this._boundsID++,
          (this._matrix = null),
          (this._holeMode = !1),
          (this.currentPath = null),
          this
        );
      }
      isFastRect() {
        const t = this._geometry.graphicsData;
        return (
          t.length === 1 &&
          t[0].shape.type === mt.RECT &&
          !t[0].matrix &&
          !t[0].holes.length &&
          !(t[0].lineStyle.visible && t[0].lineStyle.width)
        );
      }
      _render(t) {
        this.finishPoly();
        const e = this._geometry;
        e.updateBatches(),
          e.batchable
            ? (this.batchDirty !== e.batchDirty && this._populateBatches(),
              this._renderBatched(t))
            : (t.batch.flush(), this._renderDirect(t));
      }
      _populateBatches() {
        const t = this._geometry,
          e = this.blendMode,
          i = t.batches.length;
        (this.batchTint = -1),
          (this._transformID = -1),
          (this.batchDirty = t.batchDirty),
          (this.batches.length = i),
          (this.vertexData = new Float32Array(t.points));
        for (let s = 0; s < i; s++) {
          const n = t.batches[s],
            a = n.style.color,
            o = new Float32Array(
              this.vertexData.buffer,
              n.attribStart * 4 * 2,
              n.attribSize * 2
            ),
            h = new Float32Array(
              t.uvsFloat32.buffer,
              n.attribStart * 4 * 2,
              n.attribSize * 2
            ),
            l = new Uint16Array(t.indicesUint16.buffer, n.start * 2, n.size),
            u = {
              vertexData: o,
              blendMode: e,
              indices: l,
              uvs: h,
              _batchRGB: K.shared.setValue(a).toRgbArray(),
              _tintRGB: a,
              _texture: n.style.texture,
              alpha: n.style.alpha,
              worldAlpha: 1,
            };
          this.batches[s] = u;
        }
      }
      _renderBatched(t) {
        if (this.batches.length) {
          t.batch.setObjectRenderer(t.plugins[this.pluginName]),
            this.calculateVertices(),
            this.calculateTints();
          for (let e = 0, i = this.batches.length; e < i; e++) {
            const s = this.batches[e];
            (s.worldAlpha = this.worldAlpha * s.alpha),
              t.plugins[this.pluginName].render(s);
          }
        }
      }
      _renderDirect(t) {
        const e = this._resolveDirectShader(t),
          i = this._geometry,
          s = this.worldAlpha,
          n = e.uniforms,
          a = i.drawCalls;
        (n.translationMatrix = this.transform.worldTransform),
          K.shared.setValue(this._tintColor).premultiply(s).toArray(n.tint),
          t.shader.bind(e),
          t.geometry.bind(i, e),
          t.state.set(this.state);
        for (let o = 0, h = a.length; o < h; o++)
          this._renderDrawCallDirect(t, i.drawCalls[o]);
      }
      _renderDrawCallDirect(t, e) {
        const { texArray: i, type: s, size: n, start: a } = e,
          o = i.count;
        for (let h = 0; h < o; h++) t.texture.bind(i.elements[h], h);
        t.geometry.draw(s, n, a);
      }
      _resolveDirectShader(t) {
        let e = this.shader;
        const i = this.pluginName;
        if (!e) {
          if (!ga[i]) {
            const { maxTextures: s } = t.plugins[i],
              n = new Int32Array(s);
            for (let h = 0; h < s; h++) n[h] = h;
            const a = {
                tint: new Float32Array([1, 1, 1, 1]),
                translationMatrix: new et(),
                default: Gt.from({ uSamplers: n }, !0),
              },
              o = t.plugins[i]._shader.program;
            ga[i] = new Yt(o, a);
          }
          e = ga[i];
        }
        return e;
      }
      _calculateBounds() {
        this.finishPoly();
        const t = this._geometry;
        if (!t.graphicsData.length) return;
        const { minX: e, minY: i, maxX: s, maxY: n } = t.bounds;
        this._bounds.addFrame(this.transform, e, i, s, n);
      }
      containsPoint(t) {
        return (
          this.worldTransform.applyInverse(t, $s._TEMP_POINT),
          this._geometry.containsPoint($s._TEMP_POINT)
        );
      }
      calculateTints() {
        if (this.batchTint !== this.tint) {
          this.batchTint = this._tintColor.toNumber();
          for (let t = 0; t < this.batches.length; t++) {
            const e = this.batches[t];
            e._tintRGB = K.shared
              .setValue(this._tintColor)
              .multiply(e._batchRGB)
              .toLittleEndianNumber();
          }
        }
      }
      calculateVertices() {
        const t = this.transform._worldID;
        if (this._transformID === t) return;
        this._transformID = t;
        const e = this.transform.worldTransform,
          i = e.a,
          s = e.b,
          n = e.c,
          a = e.d,
          o = e.tx,
          h = e.ty,
          l = this._geometry.points,
          u = this.vertexData;
        let c = 0;
        for (let d = 0; d < l.length; d += 2) {
          const f = l[d],
            p = l[d + 1];
          (u[c++] = i * f + n * p + o), (u[c++] = a * p + s * f + h);
        }
      }
      closePath() {
        const t = this.currentPath;
        return t && ((t.closeStroke = !0), this.finishPoly()), this;
      }
      setMatrix(t) {
        return (this._matrix = t), this;
      }
      beginHole() {
        return this.finishPoly(), (this._holeMode = !0), this;
      }
      endHole() {
        return this.finishPoly(), (this._holeMode = !1), this;
      }
      destroy(t) {
        this._geometry.refCount--,
          this._geometry.refCount === 0 && this._geometry.dispose(),
          (this._matrix = null),
          (this.currentPath = null),
          this._lineStyle.destroy(),
          (this._lineStyle = null),
          this._fillStyle.destroy(),
          (this._fillStyle = null),
          (this._geometry = null),
          (this.shader = null),
          (this.vertexData = null),
          (this.batches.length = 0),
          (this.batches = null),
          super.destroy(t);
      }
    };
  (_a.curves = Fe), (_a._TEMP_POINT = new tt());
  let va = _a;
  const lg = {
    buildPoly: da,
    buildCircle: ei,
    buildRectangle: cu,
    buildRoundedRectangle: du,
    buildLine: pa,
    ArcUtils: fa,
    BezierUtils: ps,
    QuadraticUtils: ms,
    BatchPart: fu,
    FILL_COMMANDS: gs,
    BATCH_POOL: ma,
    DRAW_CALL_POOL: ri,
  };
  class _u {
    constructor(t, e) {
      (this.uvBuffer = t),
        (this.uvMatrix = e),
        (this.data = null),
        (this._bufferUpdateId = -1),
        (this._textureUpdateId = -1),
        (this._updateID = 0);
    }
    update(t) {
      if (
        !t &&
        this._bufferUpdateId === this.uvBuffer._updateID &&
        this._textureUpdateId === this.uvMatrix._updateID
      )
        return;
      (this._bufferUpdateId = this.uvBuffer._updateID),
        (this._textureUpdateId = this.uvMatrix._updateID);
      const e = this.uvBuffer.data;
      (!this.data || this.data.length !== e.length) &&
        (this.data = new Float32Array(e.length)),
        this.uvMatrix.multiplyUvs(e, this.data),
        this._updateID++;
    }
  }
  const xa = new tt(),
    vu = new Ve(),
    xu = class Oc extends Ot {
      constructor(t, e, i, s = Vt.TRIANGLES) {
        super(),
          (this.geometry = t),
          (this.shader = e),
          (this.state = i || ie.for2d()),
          (this.drawMode = s),
          (this.start = 0),
          (this.size = 0),
          (this.uvs = null),
          (this.indices = null),
          (this.vertexData = new Float32Array(1)),
          (this.vertexDirty = -1),
          (this._transformID = -1),
          (this._roundPixels = B.ROUND_PIXELS),
          (this.batchUvs = null);
      }
      get geometry() {
        return this._geometry;
      }
      set geometry(t) {
        this._geometry !== t &&
          (this._geometry &&
            (this._geometry.refCount--,
            this._geometry.refCount === 0 && this._geometry.dispose()),
          (this._geometry = t),
          this._geometry && this._geometry.refCount++,
          (this.vertexDirty = -1));
      }
      get uvBuffer() {
        return this.geometry.buffers[1];
      }
      get verticesBuffer() {
        return this.geometry.buffers[0];
      }
      set material(t) {
        this.shader = t;
      }
      get material() {
        return this.shader;
      }
      set blendMode(t) {
        this.state.blendMode = t;
      }
      get blendMode() {
        return this.state.blendMode;
      }
      set roundPixels(t) {
        this._roundPixels !== t && (this._transformID = -1),
          (this._roundPixels = t);
      }
      get roundPixels() {
        return this._roundPixels;
      }
      get tint() {
        return "tint" in this.shader ? this.shader.tint : null;
      }
      set tint(t) {
        this.shader.tint = t;
      }
      get tintValue() {
        return this.shader.tintValue;
      }
      get texture() {
        return "texture" in this.shader ? this.shader.texture : null;
      }
      set texture(t) {
        this.shader.texture = t;
      }
      _render(t) {
        const e = this.geometry.buffers[0].data;
        this.shader.batchable &&
        this.drawMode === Vt.TRIANGLES &&
        e.length < Oc.BATCHABLE_SIZE * 2
          ? this._renderToBatch(t)
          : this._renderDefault(t);
      }
      _renderDefault(t) {
        const e = this.shader;
        (e.alpha = this.worldAlpha),
          e.update && e.update(),
          t.batch.flush(),
          (e.uniforms.translationMatrix = this.transform.worldTransform.toArray(
            !0
          )),
          t.shader.bind(e),
          t.state.set(this.state),
          t.geometry.bind(this.geometry, e),
          t.geometry.draw(
            this.drawMode,
            this.size,
            this.start,
            this.geometry.instanceCount
          );
      }
      _renderToBatch(t) {
        const e = this.geometry,
          i = this.shader;
        i.uvMatrix && (i.uvMatrix.update(), this.calculateUvs()),
          this.calculateVertices(),
          (this.indices = e.indexBuffer.data),
          (this._tintRGB = i._tintRGB),
          (this._texture = i.texture);
        const s = this.material.pluginName;
        t.batch.setObjectRenderer(t.plugins[s]), t.plugins[s].render(this);
      }
      calculateVertices() {
        const t = this.geometry.buffers[0],
          e = t.data,
          i = t._updateID;
        if (
          i === this.vertexDirty &&
          this._transformID === this.transform._worldID
        )
          return;
        (this._transformID = this.transform._worldID),
          this.vertexData.length !== e.length &&
            (this.vertexData = new Float32Array(e.length));
        const s = this.transform.worldTransform,
          n = s.a,
          a = s.b,
          o = s.c,
          h = s.d,
          l = s.tx,
          u = s.ty,
          c = this.vertexData;
        for (let d = 0; d < c.length / 2; d++) {
          const f = e[d * 2],
            p = e[d * 2 + 1];
          (c[d * 2] = n * f + o * p + l), (c[d * 2 + 1] = a * f + h * p + u);
        }
        if (this._roundPixels) {
          const d = B.RESOLUTION;
          for (let f = 0; f < c.length; ++f) c[f] = Math.round(c[f] * d) / d;
        }
        this.vertexDirty = i;
      }
      calculateUvs() {
        const t = this.geometry.buffers[1],
          e = this.shader;
        e.uvMatrix.isSimple
          ? (this.uvs = t.data)
          : (this.batchUvs || (this.batchUvs = new _u(t, e.uvMatrix)),
            this.batchUvs.update(),
            (this.uvs = this.batchUvs.data));
      }
      _calculateBounds() {
        this.calculateVertices(),
          this._bounds.addVertexData(
            this.vertexData,
            0,
            this.vertexData.length
          );
      }
      containsPoint(t) {
        if (!this.getBounds().contains(t.x, t.y)) return !1;
        this.worldTransform.applyInverse(t, xa);
        const e = this.geometry.getBuffer("aVertexPosition").data,
          i = vu.points,
          s = this.geometry.getIndex().data,
          n = s.length,
          a = this.drawMode === 4 ? 3 : 1;
        for (let o = 0; o + 2 < n; o += a) {
          const h = s[o] * 2,
            l = s[o + 1] * 2,
            u = s[o + 2] * 2;
          if (
            ((i[0] = e[h]),
            (i[1] = e[h + 1]),
            (i[2] = e[l]),
            (i[3] = e[l + 1]),
            (i[4] = e[u]),
            (i[5] = e[u + 1]),
            vu.contains(xa.x, xa.y))
          )
            return !0;
        }
        return !1;
      }
      destroy(t) {
        super.destroy(t),
          this._cachedTexture &&
            (this._cachedTexture.destroy(), (this._cachedTexture = null)),
          (this.geometry = null),
          (this.shader = null),
          (this.state = null),
          (this.uvs = null),
          (this.indices = null),
          (this.vertexData = null);
      }
    };
  xu.BATCHABLE_SIZE = 100;
  let fr = xu;
  class ni extends me {
    constructor(t, e, i) {
      super();
      const s = new nt(t),
        n = new nt(e, !0),
        a = new nt(i, !0, !0);
      this.addAttribute("aVertexPosition", s, 2, !1, H.FLOAT)
        .addAttribute("aTextureCoord", n, 2, !1, H.FLOAT)
        .addIndex(a),
        (this._updateId = -1);
    }
    get vertexDirtyId() {
      return this.buffers[0]._updateID;
    }
  }
  var ug = `varying vec2 vTextureCoord;
uniform vec4 uColor;

uniform sampler2D uSampler;

void main(void)
{
    gl_FragColor = texture2D(uSampler, vTextureCoord) * uColor;
}
`,
    cg = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTextureMatrix;

varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = (uTextureMatrix * vec3(aTextureCoord, 1.0)).xy;
}
`;
  class pr extends Yt {
    constructor(t, e) {
      const i = {
        uSampler: t,
        alpha: 1,
        uTextureMatrix: et.IDENTITY,
        uColor: new Float32Array([1, 1, 1, 1]),
      };
      (e = Object.assign({ tint: 16777215, alpha: 1, pluginName: "batch" }, e)),
        e.uniforms && Object.assign(i, e.uniforms),
        super(e.program || se.from(cg, ug), i),
        (this._colorDirty = !1),
        (this.uvMatrix = new ts(t)),
        (this.batchable = e.program === void 0),
        (this.pluginName = e.pluginName),
        (this._tintColor = new K(e.tint)),
        (this._tintRGB = this._tintColor.toLittleEndianNumber()),
        (this._colorDirty = !0),
        (this.alpha = e.alpha);
    }
    get texture() {
      return this.uniforms.uSampler;
    }
    set texture(t) {
      this.uniforms.uSampler !== t &&
        (!this.uniforms.uSampler.baseTexture.alphaMode !=
          !t.baseTexture.alphaMode && (this._colorDirty = !0),
        (this.uniforms.uSampler = t),
        (this.uvMatrix.texture = t));
    }
    set alpha(t) {
      t !== this._alpha && ((this._alpha = t), (this._colorDirty = !0));
    }
    get alpha() {
      return this._alpha;
    }
    set tint(t) {
      t !== this.tint &&
        (this._tintColor.setValue(t),
        (this._tintRGB = this._tintColor.toLittleEndianNumber()),
        (this._colorDirty = !0));
    }
    get tint() {
      return this._tintColor.value;
    }
    get tintValue() {
      return this._tintColor.toNumber();
    }
    update() {
      if (this._colorDirty) {
        this._colorDirty = !1;
        const t = this.texture.baseTexture.alphaMode;
        K.shared
          .setValue(this._tintColor)
          .premultiply(this._alpha, t)
          .toArray(this.uniforms.uColor);
      }
      this.uvMatrix.update() &&
        (this.uniforms.uTextureMatrix = this.uvMatrix.mapCoord);
    }
  }
  class yu extends ni {
    constructor(t = 100, e = 100, i = 10, s = 10) {
      super(),
        (this.segWidth = i),
        (this.segHeight = s),
        (this.width = t),
        (this.height = e),
        this.build();
    }
    build() {
      const t = this.segWidth * this.segHeight,
        e = [],
        i = [],
        s = [],
        n = this.segWidth - 1,
        a = this.segHeight - 1,
        o = this.width / n,
        h = this.height / a;
      for (let u = 0; u < t; u++) {
        const c = u % this.segWidth,
          d = (u / this.segWidth) | 0;
        e.push(c * o, d * h), i.push(c / n, d / a);
      }
      const l = n * a;
      for (let u = 0; u < l; u++) {
        const c = u % n,
          d = (u / n) | 0,
          f = d * this.segWidth + c,
          p = d * this.segWidth + c + 1,
          m = (d + 1) * this.segWidth + c,
          g = (d + 1) * this.segWidth + c + 1;
        s.push(f, p, m, p, g, m);
      }
      (this.buffers[0].data = new Float32Array(e)),
        (this.buffers[1].data = new Float32Array(i)),
        (this.indexBuffer.data = new Uint16Array(s)),
        this.buffers[0].update(),
        this.buffers[1].update(),
        this.indexBuffer.update();
    }
  }
  class bu extends ni {
    constructor(t = 200, e, i = 0) {
      super(
        new Float32Array(e.length * 4),
        new Float32Array(e.length * 4),
        new Uint16Array((e.length - 1) * 6)
      ),
        (this.points = e),
        (this._width = t),
        (this.textureScale = i),
        this.build();
    }
    get width() {
      return this._width;
    }
    build() {
      const t = this.points;
      if (!t) return;
      const e = this.getBuffer("aVertexPosition"),
        i = this.getBuffer("aTextureCoord"),
        s = this.getIndex();
      if (t.length < 1) return;
      e.data.length / 4 !== t.length &&
        ((e.data = new Float32Array(t.length * 4)),
        (i.data = new Float32Array(t.length * 4)),
        (s.data = new Uint16Array((t.length - 1) * 6)));
      const n = i.data,
        a = s.data;
      (n[0] = 0), (n[1] = 0), (n[2] = 0), (n[3] = 1);
      let o = 0,
        h = t[0];
      const l = this._width * this.textureScale,
        u = t.length;
      for (let d = 0; d < u; d++) {
        const f = d * 4;
        if (this.textureScale > 0) {
          const p = h.x - t[d].x,
            m = h.y - t[d].y,
            g = Math.sqrt(p * p + m * m);
          (h = t[d]), (o += g / l);
        } else o = d / (u - 1);
        (n[f] = o), (n[f + 1] = 0), (n[f + 2] = o), (n[f + 3] = 1);
      }
      let c = 0;
      for (let d = 0; d < u - 1; d++) {
        const f = d * 2;
        (a[c++] = f),
          (a[c++] = f + 1),
          (a[c++] = f + 2),
          (a[c++] = f + 2),
          (a[c++] = f + 1),
          (a[c++] = f + 3);
      }
      i.update(), s.update(), this.updateVertices();
    }
    updateVertices() {
      const t = this.points;
      if (t.length < 1) return;
      let e = t[0],
        i,
        s = 0,
        n = 0;
      const a = this.buffers[0].data,
        o = t.length,
        h =
          this.textureScale > 0
            ? (this.textureScale * this._width) / 2
            : this._width / 2;
      for (let l = 0; l < o; l++) {
        const u = t[l],
          c = l * 4;
        l < t.length - 1 ? (i = t[l + 1]) : (i = u),
          (n = -(i.x - e.x)),
          (s = i.y - e.y);
        let d = (1 - l / (o - 1)) * 10;
        d > 1 && (d = 1);
        const f = Math.sqrt(s * s + n * n);
        f < 1e-6
          ? ((s = 0), (n = 0))
          : ((s /= f), (n /= f), (s *= h), (n *= h)),
          (a[c] = u.x + s),
          (a[c + 1] = u.y + n),
          (a[c + 2] = u.x - s),
          (a[c + 3] = u.y - n),
          (e = u);
      }
      this.buffers[0].update();
    }
    update() {
      this.textureScale > 0 ? this.build() : this.updateVertices();
    }
  }
  class Eu extends fr {
    constructor(t, e, i) {
      const s = new yu(t.width, t.height, e, i),
        n = new pr(O.WHITE);
      super(s, n), (this.texture = t), (this.autoResize = !0);
    }
    textureUpdated() {
      this._textureID = this.shader.texture._updateID;
      const t = this.geometry,
        { width: e, height: i } = this.shader.texture;
      this.autoResize &&
        (t.width !== e || t.height !== i) &&
        ((t.width = this.shader.texture.width),
        (t.height = this.shader.texture.height),
        t.build());
    }
    set texture(t) {
      this.shader.texture !== t &&
        ((this.shader.texture = t),
        (this._textureID = -1),
        t.baseTexture.valid
          ? this.textureUpdated()
          : t.once("update", this.textureUpdated, this));
    }
    get texture() {
      return this.shader.texture;
    }
    _render(t) {
      this._textureID !== this.shader.texture._updateID &&
        this.textureUpdated(),
        super._render(t);
    }
    destroy(t) {
      this.shader.texture.off("update", this.textureUpdated, this),
        super.destroy(t);
    }
  }
  const vs = 10;
  class dg extends Eu {
    constructor(t, e, i, s, n) {
      var a, o, h, l, u, c, d, f;
      super(O.WHITE, 4, 4),
        (this._origWidth = t.orig.width),
        (this._origHeight = t.orig.height),
        (this._width = this._origWidth),
        (this._height = this._origHeight),
        (this._leftWidth =
          (o =
            e != null ? e : (a = t.defaultBorders) == null ? void 0 : a.left) !=
          null
            ? o
            : vs),
        (this._rightWidth =
          (l =
            s != null
              ? s
              : (h = t.defaultBorders) == null
              ? void 0
              : h.right) != null
            ? l
            : vs),
        (this._topHeight =
          (c =
            i != null ? i : (u = t.defaultBorders) == null ? void 0 : u.top) !=
          null
            ? c
            : vs),
        (this._bottomHeight =
          (f =
            n != null
              ? n
              : (d = t.defaultBorders) == null
              ? void 0
              : d.bottom) != null
            ? f
            : vs),
        (this.texture = t);
    }
    textureUpdated() {
      (this._textureID = this.shader.texture._updateID), this._refresh();
    }
    get vertices() {
      return this.geometry.getBuffer("aVertexPosition").data;
    }
    set vertices(t) {
      this.geometry.getBuffer("aVertexPosition").data = t;
    }
    updateHorizontalVertices() {
      const t = this.vertices,
        e = this._getMinScale();
      (t[9] = t[11] = t[13] = t[15] = this._topHeight * e),
        (t[17] = t[19] = t[21] = t[23] = this._height - this._bottomHeight * e),
        (t[25] = t[27] = t[29] = t[31] = this._height);
    }
    updateVerticalVertices() {
      const t = this.vertices,
        e = this._getMinScale();
      (t[2] = t[10] = t[18] = t[26] = this._leftWidth * e),
        (t[4] = t[12] = t[20] = t[28] = this._width - this._rightWidth * e),
        (t[6] = t[14] = t[22] = t[30] = this._width);
    }
    _getMinScale() {
      const t = this._leftWidth + this._rightWidth,
        e = this._width > t ? 1 : this._width / t,
        i = this._topHeight + this._bottomHeight,
        s = this._height > i ? 1 : this._height / i;
      return Math.min(e, s);
    }
    get width() {
      return this._width;
    }
    set width(t) {
      (this._width = t), this._refresh();
    }
    get height() {
      return this._height;
    }
    set height(t) {
      (this._height = t), this._refresh();
    }
    get leftWidth() {
      return this._leftWidth;
    }
    set leftWidth(t) {
      (this._leftWidth = t), this._refresh();
    }
    get rightWidth() {
      return this._rightWidth;
    }
    set rightWidth(t) {
      (this._rightWidth = t), this._refresh();
    }
    get topHeight() {
      return this._topHeight;
    }
    set topHeight(t) {
      (this._topHeight = t), this._refresh();
    }
    get bottomHeight() {
      return this._bottomHeight;
    }
    set bottomHeight(t) {
      (this._bottomHeight = t), this._refresh();
    }
    _refresh() {
      const t = this.texture,
        e = this.geometry.buffers[1].data;
      (this._origWidth = t.orig.width), (this._origHeight = t.orig.height);
      const i = 1 / this._origWidth,
        s = 1 / this._origHeight;
      (e[0] = e[8] = e[16] = e[24] = 0),
        (e[1] = e[3] = e[5] = e[7] = 0),
        (e[6] = e[14] = e[22] = e[30] = 1),
        (e[25] = e[27] = e[29] = e[31] = 1),
        (e[2] = e[10] = e[18] = e[26] = i * this._leftWidth),
        (e[4] = e[12] = e[20] = e[28] = 1 - i * this._rightWidth),
        (e[9] = e[11] = e[13] = e[15] = s * this._topHeight),
        (e[17] = e[19] = e[21] = e[23] = 1 - s * this._bottomHeight),
        this.updateHorizontalVertices(),
        this.updateVerticalVertices(),
        this.geometry.buffers[0].update(),
        this.geometry.buffers[1].update();
    }
  }
  class fg extends fr {
    constructor(t = O.EMPTY, e, i, s, n) {
      const a = new ni(e, i, s);
      a.getBuffer("aVertexPosition").static = !1;
      const o = new pr(t);
      super(a, o, null, n), (this.autoUpdate = !0);
    }
    get vertices() {
      return this.geometry.getBuffer("aVertexPosition").data;
    }
    set vertices(t) {
      this.geometry.getBuffer("aVertexPosition").data = t;
    }
    _render(t) {
      this.autoUpdate && this.geometry.getBuffer("aVertexPosition").update(),
        super._render(t);
    }
  }
  class pg extends fr {
    constructor(t, e, i = 0) {
      const s = new bu(t.height, e, i),
        n = new pr(t);
      i > 0 && (t.baseTexture.wrapMode = Jt.REPEAT),
        super(s, n),
        (this.autoUpdate = !0);
    }
    _render(t) {
      const e = this.geometry;
      (this.autoUpdate || e._width !== this.shader.texture.height) &&
        ((e._width = this.shader.texture.height), e.update()),
        super._render(t);
    }
  }
  class mg extends Ot {
    constructor(t = 1500, e, i = 16384, s = !1) {
      super();
      const n = 16384;
      i > n && (i = n),
        (this._properties = [!1, !0, !1, !1, !1]),
        (this._maxSize = t),
        (this._batchSize = i),
        (this._buffers = null),
        (this._bufferUpdateIDs = []),
        (this._updateID = 0),
        (this.interactiveChildren = !1),
        (this.blendMode = X.NORMAL),
        (this.autoResize = s),
        (this.roundPixels = !0),
        (this.baseTexture = null),
        this.setProperties(e),
        (this._tintColor = new K(0)),
        (this.tintRgb = new Float32Array(3)),
        (this.tint = 16777215);
    }
    setProperties(t) {
      t &&
        ((this._properties[0] =
          "vertices" in t || "scale" in t
            ? !!t.vertices || !!t.scale
            : this._properties[0]),
        (this._properties[1] =
          "position" in t ? !!t.position : this._properties[1]),
        (this._properties[2] =
          "rotation" in t ? !!t.rotation : this._properties[2]),
        (this._properties[3] = "uvs" in t ? !!t.uvs : this._properties[3]),
        (this._properties[4] =
          "tint" in t || "alpha" in t
            ? !!t.tint || !!t.alpha
            : this._properties[4]));
    }
    updateTransform() {
      this.displayObjectUpdateTransform();
    }
    get tint() {
      return this._tintColor.value;
    }
    set tint(t) {
      this._tintColor.setValue(t), this._tintColor.toRgbArray(this.tintRgb);
    }
    render(t) {
      !this.visible ||
        this.worldAlpha <= 0 ||
        !this.children.length ||
        !this.renderable ||
        (this.baseTexture ||
          ((this.baseTexture = this.children[0]._texture.baseTexture),
          this.baseTexture.valid ||
            this.baseTexture.once("update", () => this.onChildrenChange(0))),
        t.batch.setObjectRenderer(t.plugins.particle),
        t.plugins.particle.render(this));
    }
    onChildrenChange(t) {
      const e = Math.floor(t / this._batchSize);
      for (; this._bufferUpdateIDs.length < e; ) this._bufferUpdateIDs.push(0);
      this._bufferUpdateIDs[e] = ++this._updateID;
    }
    dispose() {
      if (this._buffers) {
        for (let t = 0; t < this._buffers.length; ++t)
          this._buffers[t].destroy();
        this._buffers = null;
      }
    }
    destroy(t) {
      super.destroy(t),
        this.dispose(),
        (this._properties = null),
        (this._buffers = null),
        (this._bufferUpdateIDs = null);
    }
  }
  class Tu {
    constructor(t, e, i) {
      (this.geometry = new me()),
        (this.indexBuffer = null),
        (this.size = i),
        (this.dynamicProperties = []),
        (this.staticProperties = []);
      for (let s = 0; s < t.length; ++s) {
        let n = t[s];
        (n = {
          attributeName: n.attributeName,
          size: n.size,
          uploadFunction: n.uploadFunction,
          type: n.type || H.FLOAT,
          offset: n.offset,
        }),
          e[s] ? this.dynamicProperties.push(n) : this.staticProperties.push(n);
      }
      (this.staticStride = 0),
        (this.staticBuffer = null),
        (this.staticData = null),
        (this.staticDataUint32 = null),
        (this.dynamicStride = 0),
        (this.dynamicBuffer = null),
        (this.dynamicData = null),
        (this.dynamicDataUint32 = null),
        (this._updateID = 0),
        this.initBuffers();
    }
    initBuffers() {
      const t = this.geometry;
      let e = 0;
      (this.indexBuffer = new nt(Ho(this.size), !0, !0)),
        t.addIndex(this.indexBuffer),
        (this.dynamicStride = 0);
      for (let a = 0; a < this.dynamicProperties.length; ++a) {
        const o = this.dynamicProperties[a];
        (o.offset = e), (e += o.size), (this.dynamicStride += o.size);
      }
      const i = new ArrayBuffer(this.size * this.dynamicStride * 4 * 4);
      (this.dynamicData = new Float32Array(i)),
        (this.dynamicDataUint32 = new Uint32Array(i)),
        (this.dynamicBuffer = new nt(this.dynamicData, !1, !1));
      let s = 0;
      this.staticStride = 0;
      for (let a = 0; a < this.staticProperties.length; ++a) {
        const o = this.staticProperties[a];
        (o.offset = s), (s += o.size), (this.staticStride += o.size);
      }
      const n = new ArrayBuffer(this.size * this.staticStride * 4 * 4);
      (this.staticData = new Float32Array(n)),
        (this.staticDataUint32 = new Uint32Array(n)),
        (this.staticBuffer = new nt(this.staticData, !0, !1));
      for (let a = 0; a < this.dynamicProperties.length; ++a) {
        const o = this.dynamicProperties[a];
        t.addAttribute(
          o.attributeName,
          this.dynamicBuffer,
          0,
          o.type === H.UNSIGNED_BYTE,
          o.type,
          this.dynamicStride * 4,
          o.offset * 4
        );
      }
      for (let a = 0; a < this.staticProperties.length; ++a) {
        const o = this.staticProperties[a];
        t.addAttribute(
          o.attributeName,
          this.staticBuffer,
          0,
          o.type === H.UNSIGNED_BYTE,
          o.type,
          this.staticStride * 4,
          o.offset * 4
        );
      }
    }
    uploadDynamic(t, e, i) {
      for (let s = 0; s < this.dynamicProperties.length; s++) {
        const n = this.dynamicProperties[s];
        n.uploadFunction(
          t,
          e,
          i,
          n.type === H.UNSIGNED_BYTE
            ? this.dynamicDataUint32
            : this.dynamicData,
          this.dynamicStride,
          n.offset
        );
      }
      this.dynamicBuffer._updateID++;
    }
    uploadStatic(t, e, i) {
      for (let s = 0; s < this.staticProperties.length; s++) {
        const n = this.staticProperties[s];
        n.uploadFunction(
          t,
          e,
          i,
          n.type === H.UNSIGNED_BYTE ? this.staticDataUint32 : this.staticData,
          this.staticStride,
          n.offset
        );
      }
      this.staticBuffer._updateID++;
    }
    destroy() {
      (this.indexBuffer = null),
        (this.dynamicProperties = null),
        (this.dynamicBuffer = null),
        (this.dynamicData = null),
        (this.dynamicDataUint32 = null),
        (this.staticProperties = null),
        (this.staticBuffer = null),
        (this.staticData = null),
        (this.staticDataUint32 = null),
        this.geometry.destroy();
    }
  }
  var gg = `varying vec2 vTextureCoord;
varying vec4 vColor;

uniform sampler2D uSampler;

void main(void){
    vec4 color = texture2D(uSampler, vTextureCoord) * vColor;
    gl_FragColor = color;
}`,
    _g = `attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
attribute vec4 aColor;

attribute vec2 aPositionCoord;
attribute float aRotation;

uniform mat3 translationMatrix;
uniform vec4 uColor;

varying vec2 vTextureCoord;
varying vec4 vColor;

void main(void){
    float x = (aVertexPosition.x) * cos(aRotation) - (aVertexPosition.y) * sin(aRotation);
    float y = (aVertexPosition.x) * sin(aRotation) + (aVertexPosition.y) * cos(aRotation);

    vec2 v = vec2(x, y);
    v = v + aPositionCoord;

    gl_Position = vec4((translationMatrix * vec3(v, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = aTextureCoord;
    vColor = aColor * uColor;
}
`;
  class ya extends $r {
    constructor(t) {
      super(t),
        (this.shader = null),
        (this.properties = null),
        (this.tempMatrix = new et()),
        (this.properties = [
          {
            attributeName: "aVertexPosition",
            size: 2,
            uploadFunction: this.uploadVertices,
            offset: 0,
          },
          {
            attributeName: "aPositionCoord",
            size: 2,
            uploadFunction: this.uploadPosition,
            offset: 0,
          },
          {
            attributeName: "aRotation",
            size: 1,
            uploadFunction: this.uploadRotation,
            offset: 0,
          },
          {
            attributeName: "aTextureCoord",
            size: 2,
            uploadFunction: this.uploadUvs,
            offset: 0,
          },
          {
            attributeName: "aColor",
            size: 1,
            type: H.UNSIGNED_BYTE,
            uploadFunction: this.uploadTint,
            offset: 0,
          },
        ]),
        (this.shader = Yt.from(_g, gg, {})),
        (this.state = ie.for2d());
    }
    render(t) {
      const e = t.children,
        i = t._maxSize,
        s = t._batchSize,
        n = this.renderer;
      let a = e.length;
      if (a === 0) return;
      a > i && !t.autoResize && (a = i);
      let o = t._buffers;
      o || (o = t._buffers = this.generateBuffers(t));
      const h = e[0]._texture.baseTexture,
        l = h.alphaMode > 0;
      (this.state.blendMode = on(t.blendMode, l)), n.state.set(this.state);
      const u = n.gl,
        c = t.worldTransform.copyTo(this.tempMatrix);
      c.prepend(n.globalUniforms.uniforms.projectionMatrix),
        (this.shader.uniforms.translationMatrix = c.toArray(!0)),
        (this.shader.uniforms.uColor = K.shared
          .setValue(t.tintRgb)
          .premultiply(t.worldAlpha, l)
          .toArray(this.shader.uniforms.uColor)),
        (this.shader.uniforms.uSampler = h),
        this.renderer.shader.bind(this.shader);
      let d = !1;
      for (let f = 0, p = 0; f < a; f += s, p += 1) {
        let m = a - f;
        m > s && (m = s),
          p >= o.length && o.push(this._generateOneMoreBuffer(t));
        const g = o[p];
        g.uploadDynamic(e, f, m);
        const x = t._bufferUpdateIDs[p] || 0;
        (d = d || g._updateID < x),
          d && ((g._updateID = t._updateID), g.uploadStatic(e, f, m)),
          n.geometry.bind(g.geometry),
          u.drawElements(u.TRIANGLES, m * 6, u.UNSIGNED_SHORT, 0);
      }
    }
    generateBuffers(t) {
      const e = [],
        i = t._maxSize,
        s = t._batchSize,
        n = t._properties;
      for (let a = 0; a < i; a += s) e.push(new Tu(this.properties, n, s));
      return e;
    }
    _generateOneMoreBuffer(t) {
      const e = t._batchSize,
        i = t._properties;
      return new Tu(this.properties, i, e);
    }
    uploadVertices(t, e, i, s, n, a) {
      let o = 0,
        h = 0,
        l = 0,
        u = 0;
      for (let c = 0; c < i; ++c) {
        const d = t[e + c],
          f = d._texture,
          p = d.scale.x,
          m = d.scale.y,
          g = f.trim,
          x = f.orig;
        g
          ? ((h = g.x - d.anchor.x * x.width),
            (o = h + g.width),
            (u = g.y - d.anchor.y * x.height),
            (l = u + g.height))
          : ((o = x.width * (1 - d.anchor.x)),
            (h = x.width * -d.anchor.x),
            (l = x.height * (1 - d.anchor.y)),
            (u = x.height * -d.anchor.y)),
          (s[a] = h * p),
          (s[a + 1] = u * m),
          (s[a + n] = o * p),
          (s[a + n + 1] = u * m),
          (s[a + n * 2] = o * p),
          (s[a + n * 2 + 1] = l * m),
          (s[a + n * 3] = h * p),
          (s[a + n * 3 + 1] = l * m),
          (a += n * 4);
      }
    }
    uploadPosition(t, e, i, s, n, a) {
      for (let o = 0; o < i; o++) {
        const h = t[e + o].position;
        (s[a] = h.x),
          (s[a + 1] = h.y),
          (s[a + n] = h.x),
          (s[a + n + 1] = h.y),
          (s[a + n * 2] = h.x),
          (s[a + n * 2 + 1] = h.y),
          (s[a + n * 3] = h.x),
          (s[a + n * 3 + 1] = h.y),
          (a += n * 4);
      }
    }
    uploadRotation(t, e, i, s, n, a) {
      for (let o = 0; o < i; o++) {
        const h = t[e + o].rotation;
        (s[a] = h),
          (s[a + n] = h),
          (s[a + n * 2] = h),
          (s[a + n * 3] = h),
          (a += n * 4);
      }
    }
    uploadUvs(t, e, i, s, n, a) {
      for (let o = 0; o < i; ++o) {
        const h = t[e + o]._texture._uvs;
        h
          ? ((s[a] = h.x0),
            (s[a + 1] = h.y0),
            (s[a + n] = h.x1),
            (s[a + n + 1] = h.y1),
            (s[a + n * 2] = h.x2),
            (s[a + n * 2 + 1] = h.y2),
            (s[a + n * 3] = h.x3),
            (s[a + n * 3 + 1] = h.y3),
            (a += n * 4))
          : ((s[a] = 0),
            (s[a + 1] = 0),
            (s[a + n] = 0),
            (s[a + n + 1] = 0),
            (s[a + n * 2] = 0),
            (s[a + n * 2 + 1] = 0),
            (s[a + n * 3] = 0),
            (s[a + n * 3 + 1] = 0),
            (a += n * 4));
      }
    }
    uploadTint(t, e, i, s, n, a) {
      for (let o = 0; o < i; ++o) {
        const h = t[e + o],
          l = K.shared
            .setValue(h._tintRGB)
            .toPremultiplied(h.alpha, h.texture.baseTexture.alphaMode > 0);
        (s[a] = l),
          (s[a + n] = l),
          (s[a + n * 2] = l),
          (s[a + n * 3] = l),
          (a += n * 4);
      }
    }
    destroy() {
      super.destroy(),
        this.shader && (this.shader.destroy(), (this.shader = null)),
        (this.tempMatrix = null);
    }
  }
  (ya.extension = { name: "particle", type: D.RendererPlugin }), U.add(ya);
  var ai = ((r) => (
    (r[(r.LINEAR_VERTICAL = 0)] = "LINEAR_VERTICAL"),
    (r[(r.LINEAR_HORIZONTAL = 1)] = "LINEAR_HORIZONTAL"),
    r
  ))(ai || {});
  const xs = { willReadFrequently: !0 },
    oe = class G {
      static get experimentalLetterSpacingSupported() {
        let t = G._experimentalLetterSpacingSupported;
        if (t !== void 0) {
          const e = B.ADAPTER.getCanvasRenderingContext2D().prototype;
          t = G._experimentalLetterSpacingSupported =
            "letterSpacing" in e || "textLetterSpacing" in e;
        }
        return t;
      }
      constructor(t, e, i, s, n, a, o, h, l) {
        (this.text = t),
          (this.style = e),
          (this.width = i),
          (this.height = s),
          (this.lines = n),
          (this.lineWidths = a),
          (this.lineHeight = o),
          (this.maxLineWidth = h),
          (this.fontProperties = l);
      }
      static measureText(t, e, i, s = G._canvas) {
        i = i == null ? e.wordWrap : i;
        const n = e.toFontString(),
          a = G.measureFont(n);
        a.fontSize === 0 &&
          ((a.fontSize = e.fontSize), (a.ascent = e.fontSize));
        const o = s.getContext("2d", xs);
        o.font = n;
        const h = (i ? G.wordWrap(t, e, s) : t).split(/(?:\r\n|\r|\n)/),
          l = new Array(h.length);
        let u = 0;
        for (let p = 0; p < h.length; p++) {
          const m = G._measureText(h[p], e.letterSpacing, o);
          (l[p] = m), (u = Math.max(u, m));
        }
        let c = u + e.strokeThickness;
        e.dropShadow && (c += e.dropShadowDistance);
        const d = e.lineHeight || a.fontSize + e.strokeThickness;
        let f =
          Math.max(d, a.fontSize + e.strokeThickness * 2) +
          e.leading +
          (h.length - 1) * (d + e.leading);
        return (
          e.dropShadow && (f += e.dropShadowDistance),
          new G(t, e, c, f, h, l, d + e.leading, u, a)
        );
      }
      static _measureText(t, e, i) {
        let s = !1;
        G.experimentalLetterSpacingSupported &&
          (G.experimentalLetterSpacing
            ? ((i.letterSpacing = `${e}px`),
              (i.textLetterSpacing = `${e}px`),
              (s = !0))
            : ((i.letterSpacing = "0px"), (i.textLetterSpacing = "0px")));
        let n = i.measureText(t).width;
        return (
          n > 0 &&
            (s ? (n -= e) : (n += (G.graphemeSegmenter(t).length - 1) * e)),
          n
        );
      }
      static wordWrap(t, e, i = G._canvas) {
        const s = i.getContext("2d", xs);
        let n = 0,
          a = "",
          o = "";
        const h = Object.create(null),
          { letterSpacing: l, whiteSpace: u } = e,
          c = G.collapseSpaces(u),
          d = G.collapseNewlines(u);
        let f = !c;
        const p = e.wordWrapWidth + l,
          m = G.tokenize(t);
        for (let g = 0; g < m.length; g++) {
          let x = m[g];
          if (G.isNewline(x)) {
            if (!d) {
              (o += G.addLine(a)), (f = !c), (a = ""), (n = 0);
              continue;
            }
            x = " ";
          }
          if (c) {
            const _ = G.isBreakingSpace(x),
              y = G.isBreakingSpace(a[a.length - 1]);
            if (_ && y) continue;
          }
          const b = G.getFromCache(x, l, h, s);
          if (b > p)
            if (
              (a !== "" && ((o += G.addLine(a)), (a = ""), (n = 0)),
              G.canBreakWords(x, e.breakWords))
            ) {
              const _ = G.wordWrapSplit(x);
              for (let y = 0; y < _.length; y++) {
                let T = _[y],
                  C = T,
                  R = 1;
                for (; _[y + R]; ) {
                  const I = _[y + R];
                  if (!G.canBreakChars(C, I, x, y, e.breakWords)) T += I;
                  else break;
                  (C = I), R++;
                }
                y += R - 1;
                const S = G.getFromCache(T, l, h, s);
                S + n > p && ((o += G.addLine(a)), (f = !1), (a = ""), (n = 0)),
                  (a += T),
                  (n += S);
              }
            } else {
              a.length > 0 && ((o += G.addLine(a)), (a = ""), (n = 0));
              const _ = g === m.length - 1;
              (o += G.addLine(x, !_)), (f = !1), (a = ""), (n = 0);
            }
          else
            b + n > p && ((f = !1), (o += G.addLine(a)), (a = ""), (n = 0)),
              (a.length > 0 || !G.isBreakingSpace(x) || f) &&
                ((a += x), (n += b));
        }
        return (o += G.addLine(a, !1)), o;
      }
      static addLine(t, e = !0) {
        return (
          (t = G.trimRight(t)),
          (t = e
            ? `${t}
`
            : t),
          t
        );
      }
      static getFromCache(t, e, i, s) {
        let n = i[t];
        return (
          typeof n != "number" &&
            ((n = G._measureText(t, e, s) + e), (i[t] = n)),
          n
        );
      }
      static collapseSpaces(t) {
        return t === "normal" || t === "pre-line";
      }
      static collapseNewlines(t) {
        return t === "normal";
      }
      static trimRight(t) {
        if (typeof t != "string") return "";
        for (let e = t.length - 1; e >= 0; e--) {
          const i = t[e];
          if (!G.isBreakingSpace(i)) break;
          t = t.slice(0, -1);
        }
        return t;
      }
      static isNewline(t) {
        return typeof t != "string"
          ? !1
          : G._newlines.includes(t.charCodeAt(0));
      }
      static isBreakingSpace(t, e) {
        return typeof t != "string"
          ? !1
          : G._breakingSpaces.includes(t.charCodeAt(0));
      }
      static tokenize(t) {
        const e = [];
        let i = "";
        if (typeof t != "string") return e;
        for (let s = 0; s < t.length; s++) {
          const n = t[s],
            a = t[s + 1];
          if (G.isBreakingSpace(n, a) || G.isNewline(n)) {
            i !== "" && (e.push(i), (i = "")), e.push(n);
            continue;
          }
          i += n;
        }
        return i !== "" && e.push(i), e;
      }
      static canBreakWords(t, e) {
        return e;
      }
      static canBreakChars(t, e, i, s, n) {
        return !0;
      }
      static wordWrapSplit(t) {
        return G.graphemeSegmenter(t);
      }
      static measureFont(t) {
        if (G._fonts[t]) return G._fonts[t];
        const e = { ascent: 0, descent: 0, fontSize: 0 },
          i = G._canvas,
          s = G._context;
        s.font = t;
        const n = G.METRICS_STRING + G.BASELINE_SYMBOL,
          a = Math.ceil(s.measureText(n).width);
        let o = Math.ceil(s.measureText(G.BASELINE_SYMBOL).width);
        const h = Math.ceil(G.HEIGHT_MULTIPLIER * o);
        if (((o = (o * G.BASELINE_MULTIPLIER) | 0), a === 0 || h === 0))
          return (G._fonts[t] = e), e;
        (i.width = a),
          (i.height = h),
          (s.fillStyle = "#f00"),
          s.fillRect(0, 0, a, h),
          (s.font = t),
          (s.textBaseline = "alphabetic"),
          (s.fillStyle = "#000"),
          s.fillText(n, 0, o);
        const l = s.getImageData(0, 0, a, h).data,
          u = l.length,
          c = a * 4;
        let d = 0,
          f = 0,
          p = !1;
        for (d = 0; d < o; ++d) {
          for (let m = 0; m < c; m += 4)
            if (l[f + m] !== 255) {
              p = !0;
              break;
            }
          if (!p) f += c;
          else break;
        }
        for (e.ascent = o - d, f = u - c, p = !1, d = h; d > o; --d) {
          for (let m = 0; m < c; m += 4)
            if (l[f + m] !== 255) {
              p = !0;
              break;
            }
          if (!p) f -= c;
          else break;
        }
        return (
          (e.descent = d - o),
          (e.fontSize = e.ascent + e.descent),
          (G._fonts[t] = e),
          e
        );
      }
      static clearMetrics(t = "") {
        t ? delete G._fonts[t] : (G._fonts = {});
      }
      static get _canvas() {
        if (!G.__canvas) {
          let t;
          try {
            const e = new OffscreenCanvas(0, 0),
              i = e.getContext("2d", xs);
            if (i != null && i.measureText) return (G.__canvas = e), e;
            t = B.ADAPTER.createCanvas();
          } catch (e) {
            t = B.ADAPTER.createCanvas();
          }
          (t.width = t.height = 10), (G.__canvas = t);
        }
        return G.__canvas;
      }
      static get _context() {
        return (
          G.__context || (G.__context = G._canvas.getContext("2d", xs)),
          G.__context
        );
      }
    };
  (oe.METRICS_STRING = "|\xC9q\xC5"),
    (oe.BASELINE_SYMBOL = "M"),
    (oe.BASELINE_MULTIPLIER = 1.4),
    (oe.HEIGHT_MULTIPLIER = 2),
    (oe.graphemeSegmenter = (() => {
      if (typeof (Intl == null ? void 0 : Intl.Segmenter) == "function") {
        const r = new Intl.Segmenter();
        return (t) => [...r.segment(t)].map((e) => e.segment);
      }
      return (r) => [...r];
    })()),
    (oe.experimentalLetterSpacing = !1),
    (oe._fonts = {}),
    (oe._newlines = [10, 13]),
    (oe._breakingSpaces = [
      9, 32, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8200, 8201, 8202, 8287,
      12288,
    ]);
  let xe = oe;
  const vg = [
      "serif",
      "sans-serif",
      "monospace",
      "cursive",
      "fantasy",
      "system-ui",
    ],
    Au = class Ai {
      constructor(t) {
        (this.styleID = 0), this.reset(), Ea(this, t, t);
      }
      clone() {
        const t = {};
        return Ea(t, this, Ai.defaultStyle), new Ai(t);
      }
      reset() {
        Ea(this, Ai.defaultStyle, Ai.defaultStyle);
      }
      get align() {
        return this._align;
      }
      set align(t) {
        this._align !== t && ((this._align = t), this.styleID++);
      }
      get breakWords() {
        return this._breakWords;
      }
      set breakWords(t) {
        this._breakWords !== t && ((this._breakWords = t), this.styleID++);
      }
      get dropShadow() {
        return this._dropShadow;
      }
      set dropShadow(t) {
        this._dropShadow !== t && ((this._dropShadow = t), this.styleID++);
      }
      get dropShadowAlpha() {
        return this._dropShadowAlpha;
      }
      set dropShadowAlpha(t) {
        this._dropShadowAlpha !== t &&
          ((this._dropShadowAlpha = t), this.styleID++);
      }
      get dropShadowAngle() {
        return this._dropShadowAngle;
      }
      set dropShadowAngle(t) {
        this._dropShadowAngle !== t &&
          ((this._dropShadowAngle = t), this.styleID++);
      }
      get dropShadowBlur() {
        return this._dropShadowBlur;
      }
      set dropShadowBlur(t) {
        this._dropShadowBlur !== t &&
          ((this._dropShadowBlur = t), this.styleID++);
      }
      get dropShadowColor() {
        return this._dropShadowColor;
      }
      set dropShadowColor(t) {
        const e = ba(t);
        this._dropShadowColor !== e &&
          ((this._dropShadowColor = e), this.styleID++);
      }
      get dropShadowDistance() {
        return this._dropShadowDistance;
      }
      set dropShadowDistance(t) {
        this._dropShadowDistance !== t &&
          ((this._dropShadowDistance = t), this.styleID++);
      }
      get fill() {
        return this._fill;
      }
      set fill(t) {
        const e = ba(t);
        this._fill !== e && ((this._fill = e), this.styleID++);
      }
      get fillGradientType() {
        return this._fillGradientType;
      }
      set fillGradientType(t) {
        this._fillGradientType !== t &&
          ((this._fillGradientType = t), this.styleID++);
      }
      get fillGradientStops() {
        return this._fillGradientStops;
      }
      set fillGradientStops(t) {
        xg(this._fillGradientStops, t) ||
          ((this._fillGradientStops = t), this.styleID++);
      }
      get fontFamily() {
        return this._fontFamily;
      }
      set fontFamily(t) {
        this.fontFamily !== t && ((this._fontFamily = t), this.styleID++);
      }
      get fontSize() {
        return this._fontSize;
      }
      set fontSize(t) {
        this._fontSize !== t && ((this._fontSize = t), this.styleID++);
      }
      get fontStyle() {
        return this._fontStyle;
      }
      set fontStyle(t) {
        this._fontStyle !== t && ((this._fontStyle = t), this.styleID++);
      }
      get fontVariant() {
        return this._fontVariant;
      }
      set fontVariant(t) {
        this._fontVariant !== t && ((this._fontVariant = t), this.styleID++);
      }
      get fontWeight() {
        return this._fontWeight;
      }
      set fontWeight(t) {
        this._fontWeight !== t && ((this._fontWeight = t), this.styleID++);
      }
      get letterSpacing() {
        return this._letterSpacing;
      }
      set letterSpacing(t) {
        this._letterSpacing !== t &&
          ((this._letterSpacing = t), this.styleID++);
      }
      get lineHeight() {
        return this._lineHeight;
      }
      set lineHeight(t) {
        this._lineHeight !== t && ((this._lineHeight = t), this.styleID++);
      }
      get leading() {
        return this._leading;
      }
      set leading(t) {
        this._leading !== t && ((this._leading = t), this.styleID++);
      }
      get lineJoin() {
        return this._lineJoin;
      }
      set lineJoin(t) {
        this._lineJoin !== t && ((this._lineJoin = t), this.styleID++);
      }
      get miterLimit() {
        return this._miterLimit;
      }
      set miterLimit(t) {
        this._miterLimit !== t && ((this._miterLimit = t), this.styleID++);
      }
      get padding() {
        return this._padding;
      }
      set padding(t) {
        this._padding !== t && ((this._padding = t), this.styleID++);
      }
      get stroke() {
        return this._stroke;
      }
      set stroke(t) {
        const e = ba(t);
        this._stroke !== e && ((this._stroke = e), this.styleID++);
      }
      get strokeThickness() {
        return this._strokeThickness;
      }
      set strokeThickness(t) {
        this._strokeThickness !== t &&
          ((this._strokeThickness = t), this.styleID++);
      }
      get textBaseline() {
        return this._textBaseline;
      }
      set textBaseline(t) {
        this._textBaseline !== t && ((this._textBaseline = t), this.styleID++);
      }
      get trim() {
        return this._trim;
      }
      set trim(t) {
        this._trim !== t && ((this._trim = t), this.styleID++);
      }
      get whiteSpace() {
        return this._whiteSpace;
      }
      set whiteSpace(t) {
        this._whiteSpace !== t && ((this._whiteSpace = t), this.styleID++);
      }
      get wordWrap() {
        return this._wordWrap;
      }
      set wordWrap(t) {
        this._wordWrap !== t && ((this._wordWrap = t), this.styleID++);
      }
      get wordWrapWidth() {
        return this._wordWrapWidth;
      }
      set wordWrapWidth(t) {
        this._wordWrapWidth !== t &&
          ((this._wordWrapWidth = t), this.styleID++);
      }
      toFontString() {
        const t =
          typeof this.fontSize == "number"
            ? `${this.fontSize}px`
            : this.fontSize;
        let e = this.fontFamily;
        Array.isArray(this.fontFamily) || (e = this.fontFamily.split(","));
        for (let i = e.length - 1; i >= 0; i--) {
          let s = e[i].trim();
          !/([\"\'])[^\'\"]+\1/.test(s) && !vg.includes(s) && (s = `"${s}"`),
            (e[i] = s);
        }
        return `${this.fontStyle} ${this.fontVariant} ${
          this.fontWeight
        } ${t} ${e.join(",")}`;
      }
    };
  Au.defaultStyle = {
    align: "left",
    breakWords: !1,
    dropShadow: !1,
    dropShadowAlpha: 1,
    dropShadowAngle: Math.PI / 6,
    dropShadowBlur: 0,
    dropShadowColor: "black",
    dropShadowDistance: 5,
    fill: "black",
    fillGradientType: ai.LINEAR_VERTICAL,
    fillGradientStops: [],
    fontFamily: "Arial",
    fontSize: 26,
    fontStyle: "normal",
    fontVariant: "normal",
    fontWeight: "normal",
    leading: 0,
    letterSpacing: 0,
    lineHeight: 0,
    lineJoin: "miter",
    miterLimit: 10,
    padding: 0,
    stroke: "black",
    strokeThickness: 0,
    textBaseline: "alphabetic",
    trim: !1,
    whiteSpace: "pre",
    wordWrap: !1,
    wordWrapWidth: 100,
  };
  let Je = Au;
  function ba(r) {
    const t = K.shared,
      e = (i) => {
        const s = t.setValue(i);
        return s.alpha === 1 ? s.toHex() : s.toRgbaString();
      };
    return Array.isArray(r) ? r.map(e) : e(r);
  }
  function xg(r, t) {
    if (!Array.isArray(r) || !Array.isArray(t) || r.length !== t.length)
      return !1;
    for (let e = 0; e < r.length; ++e) if (r[e] !== t[e]) return !1;
    return !0;
  }
  function Ea(r, t, e) {
    for (const i in e)
      Array.isArray(t[i]) ? (r[i] = t[i].slice()) : (r[i] = t[i]);
  }
  const yg = { texture: !0, children: !1, baseTexture: !0 },
    Su = class Ka extends Ne {
      constructor(t, e, i) {
        var s;
        let n = !1;
        i || ((i = B.ADAPTER.createCanvas()), (n = !0)),
          (i.width = 3),
          (i.height = 3);
        const a = O.from(i);
        (a.orig = new Y()),
          (a.trim = new Y()),
          super(a),
          (this._ownCanvas = n),
          (this.canvas = i),
          (this.context = i.getContext("2d", { willReadFrequently: !0 })),
          (this._resolution =
            (s = Ka.defaultResolution) != null ? s : B.RESOLUTION),
          (this._autoResolution = Ka.defaultAutoResolution),
          (this._text = null),
          (this._style = null),
          (this._styleListener = null),
          (this._font = ""),
          (this.text = t),
          (this.style = e),
          (this.localStyleID = -1);
      }
      static get experimentalLetterSpacing() {
        return xe.experimentalLetterSpacing;
      }
      static set experimentalLetterSpacing(t) {
        xe.experimentalLetterSpacing = t;
      }
      updateText(t) {
        const e = this._style;
        if (
          (this.localStyleID !== e.styleID &&
            ((this.dirty = !0), (this.localStyleID = e.styleID)),
          !this.dirty && t)
        )
          return;
        this._font = this._style.toFontString();
        const i = this.context,
          s = xe.measureText(
            this._text || " ",
            this._style,
            this._style.wordWrap,
            this.canvas
          ),
          n = s.width,
          a = s.height,
          o = s.lines,
          h = s.lineHeight,
          l = s.lineWidths,
          u = s.maxLineWidth,
          c = s.fontProperties;
        (this.canvas.width = Math.ceil(
          Math.ceil(Math.max(1, n) + e.padding * 2) * this._resolution
        )),
          (this.canvas.height = Math.ceil(
            Math.ceil(Math.max(1, a) + e.padding * 2) * this._resolution
          )),
          i.scale(this._resolution, this._resolution),
          i.clearRect(0, 0, this.canvas.width, this.canvas.height),
          (i.font = this._font),
          (i.lineWidth = e.strokeThickness),
          (i.textBaseline = e.textBaseline),
          (i.lineJoin = e.lineJoin),
          (i.miterLimit = e.miterLimit);
        let d, f;
        const p = e.dropShadow ? 2 : 1;
        for (let m = 0; m < p; ++m) {
          const g = e.dropShadow && m === 0,
            x = g ? Math.ceil(Math.max(1, a) + e.padding * 2) : 0,
            b = x * this._resolution;
          if (g) {
            (i.fillStyle = "black"), (i.strokeStyle = "black");
            const y = e.dropShadowColor,
              T = e.dropShadowBlur * this._resolution,
              C = e.dropShadowDistance * this._resolution;
            (i.shadowColor = K.shared
              .setValue(y)
              .setAlpha(e.dropShadowAlpha)
              .toRgbaString()),
              (i.shadowBlur = T),
              (i.shadowOffsetX = Math.cos(e.dropShadowAngle) * C),
              (i.shadowOffsetY = Math.sin(e.dropShadowAngle) * C + b);
          } else
            (i.fillStyle = this._generateFillStyle(e, o, s)),
              (i.strokeStyle = e.stroke),
              (i.shadowColor = "black"),
              (i.shadowBlur = 0),
              (i.shadowOffsetX = 0),
              (i.shadowOffsetY = 0);
          let _ = (h - c.fontSize) / 2;
          h - c.fontSize < 0 && (_ = 0);
          for (let y = 0; y < o.length; y++)
            (d = e.strokeThickness / 2),
              (f = e.strokeThickness / 2 + y * h + c.ascent + _),
              e.align === "right"
                ? (d += u - l[y])
                : e.align === "center" && (d += (u - l[y]) / 2),
              e.stroke &&
                e.strokeThickness &&
                this.drawLetterSpacing(
                  o[y],
                  d + e.padding,
                  f + e.padding - x,
                  !0
                ),
              e.fill &&
                this.drawLetterSpacing(o[y], d + e.padding, f + e.padding - x);
        }
        this.updateTexture();
      }
      drawLetterSpacing(t, e, i, s = !1) {
        const n = this._style.letterSpacing;
        let a = !1;
        if (
          (xe.experimentalLetterSpacingSupported &&
            (xe.experimentalLetterSpacing
              ? ((this.context.letterSpacing = `${n}px`),
                (this.context.textLetterSpacing = `${n}px`),
                (a = !0))
              : ((this.context.letterSpacing = "0px"),
                (this.context.textLetterSpacing = "0px"))),
          n === 0 || a)
        ) {
          s ? this.context.strokeText(t, e, i) : this.context.fillText(t, e, i);
          return;
        }
        let o = e;
        const h = xe.graphemeSegmenter(t);
        let l = this.context.measureText(t).width,
          u = 0;
        for (let c = 0; c < h.length; ++c) {
          const d = h[c];
          s ? this.context.strokeText(d, o, i) : this.context.fillText(d, o, i);
          let f = "";
          for (let p = c + 1; p < h.length; ++p) f += h[p];
          (u = this.context.measureText(f).width), (o += l - u + n), (l = u);
        }
      }
      updateTexture() {
        const t = this.canvas;
        if (this._style.trim) {
          const a = Wo(t);
          a.data &&
            ((t.width = a.width),
            (t.height = a.height),
            this.context.putImageData(a.data, 0, 0));
        }
        const e = this._texture,
          i = this._style,
          s = i.trim ? 0 : i.padding,
          n = e.baseTexture;
        (e.trim.width = e._frame.width = t.width / this._resolution),
          (e.trim.height = e._frame.height = t.height / this._resolution),
          (e.trim.x = -s),
          (e.trim.y = -s),
          (e.orig.width = e._frame.width - s * 2),
          (e.orig.height = e._frame.height - s * 2),
          this._onTextureUpdate(),
          n.setRealSize(t.width, t.height, this._resolution),
          e.updateUvs(),
          (this.dirty = !1);
      }
      _render(t) {
        this._autoResolution &&
          this._resolution !== t.resolution &&
          ((this._resolution = t.resolution), (this.dirty = !0)),
          this.updateText(!0),
          super._render(t);
      }
      updateTransform() {
        this.updateText(!0), super.updateTransform();
      }
      getBounds(t, e) {
        return (
          this.updateText(!0),
          this._textureID === -1 && (t = !1),
          super.getBounds(t, e)
        );
      }
      getLocalBounds(t) {
        return this.updateText(!0), super.getLocalBounds.call(this, t);
      }
      _calculateBounds() {
        this.calculateVertices(), this._bounds.addQuad(this.vertexData);
      }
      _generateFillStyle(t, e, i) {
        const s = t.fill;
        if (Array.isArray(s)) {
          if (s.length === 1) return s[0];
        } else return s;
        let n;
        const a = t.dropShadow ? t.dropShadowDistance : 0,
          o = t.padding || 0,
          h = this.canvas.width / this._resolution - a - o * 2,
          l = this.canvas.height / this._resolution - a - o * 2,
          u = s.slice(),
          c = t.fillGradientStops.slice();
        if (!c.length) {
          const d = u.length + 1;
          for (let f = 1; f < d; ++f) c.push(f / d);
        }
        if (
          (u.unshift(s[0]),
          c.unshift(0),
          u.push(s[s.length - 1]),
          c.push(1),
          t.fillGradientType === ai.LINEAR_VERTICAL)
        ) {
          n = this.context.createLinearGradient(h / 2, o, h / 2, l + o);
          const d = i.fontProperties.fontSize + t.strokeThickness;
          for (let f = 0; f < e.length; f++) {
            const p = i.lineHeight * (f - 1) + d,
              m = i.lineHeight * f;
            let g = m;
            f > 0 && p > m && (g = (m + p) / 2);
            const x = m + d,
              b = i.lineHeight * (f + 1);
            let _ = x;
            f + 1 < e.length && b < x && (_ = (x + b) / 2);
            const y = (_ - g) / l;
            for (let T = 0; T < u.length; T++) {
              let C = 0;
              typeof c[T] == "number" ? (C = c[T]) : (C = T / u.length);
              let R = Math.min(1, Math.max(0, g / l + C * y));
              (R = Number(R.toFixed(5))), n.addColorStop(R, u[T]);
            }
          }
        } else {
          n = this.context.createLinearGradient(o, l / 2, h + o, l / 2);
          const d = u.length + 1;
          let f = 1;
          for (let p = 0; p < u.length; p++) {
            let m;
            typeof c[p] == "number" ? (m = c[p]) : (m = f / d),
              n.addColorStop(m, u[p]),
              f++;
          }
        }
        return n;
      }
      destroy(t) {
        typeof t == "boolean" && (t = { children: t }),
          (t = Object.assign({}, yg, t)),
          super.destroy(t),
          this._ownCanvas && (this.canvas.height = this.canvas.width = 0),
          (this.context = null),
          (this.canvas = null),
          (this._style = null);
      }
      get width() {
        return (
          this.updateText(!0), Math.abs(this.scale.x) * this._texture.orig.width
        );
      }
      set width(t) {
        this.updateText(!0);
        const e = He(this.scale.x) || 1;
        (this.scale.x = (e * t) / this._texture.orig.width), (this._width = t);
      }
      get height() {
        return (
          this.updateText(!0),
          Math.abs(this.scale.y) * this._texture.orig.height
        );
      }
      set height(t) {
        this.updateText(!0);
        const e = He(this.scale.y) || 1;
        (this.scale.y = (e * t) / this._texture.orig.height),
          (this._height = t);
      }
      get style() {
        return this._style;
      }
      set style(t) {
        (t = t || {}),
          t instanceof Je ? (this._style = t) : (this._style = new Je(t)),
          (this.localStyleID = -1),
          (this.dirty = !0);
      }
      get text() {
        return this._text;
      }
      set text(t) {
        (t = String(t == null ? "" : t)),
          this._text !== t && ((this._text = t), (this.dirty = !0));
      }
      get resolution() {
        return this._resolution;
      }
      set resolution(t) {
        (this._autoResolution = !1),
          this._resolution !== t && ((this._resolution = t), (this.dirty = !0));
      }
    };
  Su.defaultAutoResolution = !0;
  let Ta = Su;
  class wu {
    constructor(t) {
      (this.maxItemsPerFrame = t), (this.itemsLeft = 0);
    }
    beginFrame() {
      this.itemsLeft = this.maxItemsPerFrame;
    }
    allowedToUpload() {
      return this.itemsLeft-- > 0;
    }
  }
  function bg(r, t) {
    var e;
    let i = !1;
    if ((e = r == null ? void 0 : r._textures) != null && e.length) {
      for (let s = 0; s < r._textures.length; s++)
        if (r._textures[s] instanceof O) {
          const n = r._textures[s].baseTexture;
          t.includes(n) || (t.push(n), (i = !0));
        }
    }
    return i;
  }
  function Eg(r, t) {
    if (r.baseTexture instanceof j) {
      const e = r.baseTexture;
      return t.includes(e) || t.push(e), !0;
    }
    return !1;
  }
  function Tg(r, t) {
    if (r._texture && r._texture instanceof O) {
      const e = r._texture.baseTexture;
      return t.includes(e) || t.push(e), !0;
    }
    return !1;
  }
  function Ag(r, t) {
    return t instanceof Ta ? (t.updateText(!0), !0) : !1;
  }
  function Sg(r, t) {
    if (t instanceof Je) {
      const e = t.toFontString();
      return xe.measureFont(e), !0;
    }
    return !1;
  }
  function wg(r, t) {
    if (r instanceof Ta) {
      t.includes(r.style) || t.push(r.style), t.includes(r) || t.push(r);
      const e = r._texture.baseTexture;
      return t.includes(e) || t.push(e), !0;
    }
    return !1;
  }
  function Rg(r, t) {
    return r instanceof Je ? (t.includes(r) || t.push(r), !0) : !1;
  }
  const Ru = class Bc {
    constructor(t) {
      (this.limiter = new wu(Bc.uploadsPerFrame)),
        (this.renderer = t),
        (this.uploadHookHelper = null),
        (this.queue = []),
        (this.addHooks = []),
        (this.uploadHooks = []),
        (this.completes = []),
        (this.ticking = !1),
        (this.delayedTick = () => {
          this.queue && this.prepareItems();
        }),
        this.registerFindHook(wg),
        this.registerFindHook(Rg),
        this.registerFindHook(bg),
        this.registerFindHook(Eg),
        this.registerFindHook(Tg),
        this.registerUploadHook(Ag),
        this.registerUploadHook(Sg);
    }
    upload(t) {
      return new Promise((e) => {
        t && this.add(t),
          this.queue.length
            ? (this.completes.push(e),
              this.ticking ||
                ((this.ticking = !0),
                Tt.system.addOnce(this.tick, this, De.UTILITY)))
            : e();
      });
    }
    tick() {
      setTimeout(this.delayedTick, 0);
    }
    prepareItems() {
      for (
        this.limiter.beginFrame();
        this.queue.length && this.limiter.allowedToUpload();

      ) {
        const t = this.queue[0];
        let e = !1;
        if (t && !t._destroyed) {
          for (let i = 0, s = this.uploadHooks.length; i < s; i++)
            if (this.uploadHooks[i](this.uploadHookHelper, t)) {
              this.queue.shift(), (e = !0);
              break;
            }
        }
        e || this.queue.shift();
      }
      if (this.queue.length) Tt.system.addOnce(this.tick, this, De.UTILITY);
      else {
        this.ticking = !1;
        const t = this.completes.slice(0);
        this.completes.length = 0;
        for (let e = 0, i = t.length; e < i; e++) t[e]();
      }
    }
    registerFindHook(t) {
      return t && this.addHooks.push(t), this;
    }
    registerUploadHook(t) {
      return t && this.uploadHooks.push(t), this;
    }
    add(t) {
      for (
        let e = 0, i = this.addHooks.length;
        e < i && !this.addHooks[e](t, this.queue);
        e++
      );
      if (t instanceof Ot)
        for (let e = t.children.length - 1; e >= 0; e--)
          this.add(t.children[e]);
      return this;
    }
    destroy() {
      this.ticking && Tt.system.remove(this.tick, this),
        (this.ticking = !1),
        (this.addHooks = null),
        (this.uploadHooks = null),
        (this.renderer = null),
        (this.completes = null),
        (this.queue = null),
        (this.limiter = null),
        (this.uploadHookHelper = null);
    }
  };
  Ru.uploadsPerFrame = 4;
  let ys = Ru;
  Object.defineProperties(B, {
    UPLOADS_PER_FRAME: {
      get() {
        return ys.uploadsPerFrame;
      },
      set(r) {
        ys.uploadsPerFrame = r;
      },
    },
  });
  function Iu(r, t) {
    return t instanceof j
      ? (t._glTextures[r.CONTEXT_UID] || r.texture.bind(t), !0)
      : !1;
  }
  function Ig(r, t) {
    if (!(t instanceof va)) return !1;
    const { geometry: e } = t;
    t.finishPoly(), e.updateBatches();
    const { batches: i } = e;
    for (let s = 0; s < i.length; s++) {
      const { texture: n } = i[s].style;
      n && Iu(r, n.baseTexture);
    }
    return e.batchable || r.geometry.bind(e, t._resolveDirectShader(r)), !0;
  }
  function Cg(r, t) {
    return r instanceof va ? (t.push(r), !0) : !1;
  }
  class Aa extends ys {
    constructor(t) {
      super(t),
        (this.uploadHookHelper = this.renderer),
        this.registerFindHook(Cg),
        this.registerUploadHook(Iu),
        this.registerUploadHook(Ig);
    }
  }
  (Aa.extension = { name: "prepare", type: D.RendererSystem }), U.add(Aa);
  class Mg {
    constructor(t) {
      (this.maxMilliseconds = t), (this.frameStart = 0);
    }
    beginFrame() {
      this.frameStart = Date.now();
    }
    allowedToUpload() {
      return Date.now() - this.frameStart < this.maxMilliseconds;
    }
  }
  class bs extends Ne {
    constructor(t, e = !0) {
      super(t[0] instanceof O ? t[0] : t[0].texture),
        (this._textures = null),
        (this._durations = null),
        (this._autoUpdate = e),
        (this._isConnectedToTicker = !1),
        (this.animationSpeed = 1),
        (this.loop = !0),
        (this.updateAnchor = !1),
        (this.onComplete = null),
        (this.onFrameChange = null),
        (this.onLoop = null),
        (this._currentTime = 0),
        (this._playing = !1),
        (this._previousFrame = null),
        (this.textures = t);
    }
    stop() {
      this._playing &&
        ((this._playing = !1),
        this._autoUpdate &&
          this._isConnectedToTicker &&
          (Tt.shared.remove(this.update, this),
          (this._isConnectedToTicker = !1)));
    }
    play() {
      this._playing ||
        ((this._playing = !0),
        this._autoUpdate &&
          !this._isConnectedToTicker &&
          (Tt.shared.add(this.update, this, De.HIGH),
          (this._isConnectedToTicker = !0)));
    }
    gotoAndStop(t) {
      this.stop(), (this.currentFrame = t);
    }
    gotoAndPlay(t) {
      (this.currentFrame = t), this.play();
    }
    update(t) {
      if (!this._playing) return;
      const e = this.animationSpeed * t,
        i = this.currentFrame;
      if (this._durations !== null) {
        let s = (this._currentTime % 1) * this._durations[this.currentFrame];
        for (s += (e / 60) * 1e3; s < 0; )
          this._currentTime--, (s += this._durations[this.currentFrame]);
        const n = Math.sign(this.animationSpeed * t);
        for (
          this._currentTime = Math.floor(this._currentTime);
          s >= this._durations[this.currentFrame];

        )
          (s -= this._durations[this.currentFrame] * n),
            (this._currentTime += n);
        this._currentTime += s / this._durations[this.currentFrame];
      } else this._currentTime += e;
      this._currentTime < 0 && !this.loop
        ? (this.gotoAndStop(0), this.onComplete && this.onComplete())
        : this._currentTime >= this._textures.length && !this.loop
        ? (this.gotoAndStop(this._textures.length - 1),
          this.onComplete && this.onComplete())
        : i !== this.currentFrame &&
          (this.loop &&
            this.onLoop &&
            ((this.animationSpeed > 0 && this.currentFrame < i) ||
              (this.animationSpeed < 0 && this.currentFrame > i)) &&
            this.onLoop(),
          this.updateTexture());
    }
    updateTexture() {
      const t = this.currentFrame;
      this._previousFrame !== t &&
        ((this._previousFrame = t),
        (this._texture = this._textures[t]),
        (this._textureID = -1),
        (this._textureTrimmedID = -1),
        (this._cachedTint = 16777215),
        (this.uvs = this._texture._uvs.uvsFloat32),
        this.updateAnchor && this._anchor.copyFrom(this._texture.defaultAnchor),
        this.onFrameChange && this.onFrameChange(this.currentFrame));
    }
    destroy(t) {
      this.stop(),
        super.destroy(t),
        (this.onComplete = null),
        (this.onFrameChange = null),
        (this.onLoop = null);
    }
    static fromFrames(t) {
      const e = [];
      for (let i = 0; i < t.length; ++i) e.push(O.from(t[i]));
      return new bs(e);
    }
    static fromImages(t) {
      const e = [];
      for (let i = 0; i < t.length; ++i) e.push(O.from(t[i]));
      return new bs(e);
    }
    get totalFrames() {
      return this._textures.length;
    }
    get textures() {
      return this._textures;
    }
    set textures(t) {
      if (t[0] instanceof O) (this._textures = t), (this._durations = null);
      else {
        (this._textures = []), (this._durations = []);
        for (let e = 0; e < t.length; e++)
          this._textures.push(t[e].texture), this._durations.push(t[e].time);
      }
      (this._previousFrame = null), this.gotoAndStop(0), this.updateTexture();
    }
    get currentFrame() {
      let t = Math.floor(this._currentTime) % this._textures.length;
      return t < 0 && (t += this._textures.length), t;
    }
    set currentFrame(t) {
      if (t < 0 || t > this.totalFrames - 1)
        throw new Error(
          `[AnimatedSprite]: Invalid frame index value ${t}, expected to be between 0 and totalFrames ${this.totalFrames}.`
        );
      const e = this.currentFrame;
      (this._currentTime = t), e !== this.currentFrame && this.updateTexture();
    }
    get playing() {
      return this._playing;
    }
    get autoUpdate() {
      return this._autoUpdate;
    }
    set autoUpdate(t) {
      t !== this._autoUpdate &&
        ((this._autoUpdate = t),
        !this._autoUpdate && this._isConnectedToTicker
          ? (Tt.shared.remove(this.update, this),
            (this._isConnectedToTicker = !1))
          : this._autoUpdate &&
            !this._isConnectedToTicker &&
            this._playing &&
            (Tt.shared.add(this.update, this),
            (this._isConnectedToTicker = !0)));
    }
  }
  const oi = new tt();
  class Sa extends Ne {
    constructor(t, e = 100, i = 100) {
      super(t),
        (this.tileTransform = new ji()),
        (this._width = e),
        (this._height = i),
        (this.uvMatrix = this.texture.uvMatrix || new ts(t)),
        (this.pluginName = "tilingSprite"),
        (this.uvRespectAnchor = !1);
    }
    get clampMargin() {
      return this.uvMatrix.clampMargin;
    }
    set clampMargin(t) {
      (this.uvMatrix.clampMargin = t), this.uvMatrix.update(!0);
    }
    get tileScale() {
      return this.tileTransform.scale;
    }
    set tileScale(t) {
      this.tileTransform.scale.copyFrom(t);
    }
    get tilePosition() {
      return this.tileTransform.position;
    }
    set tilePosition(t) {
      this.tileTransform.position.copyFrom(t);
    }
    _onTextureUpdate() {
      this.uvMatrix && (this.uvMatrix.texture = this._texture),
        (this._cachedTint = 16777215);
    }
    _render(t) {
      const e = this._texture;
      !e ||
        !e.valid ||
        (this.tileTransform.updateLocalTransform(),
        this.uvMatrix.update(),
        t.batch.setObjectRenderer(t.plugins[this.pluginName]),
        t.plugins[this.pluginName].render(this));
    }
    _calculateBounds() {
      const t = this._width * -this._anchor._x,
        e = this._height * -this._anchor._y,
        i = this._width * (1 - this._anchor._x),
        s = this._height * (1 - this._anchor._y);
      this._bounds.addFrame(this.transform, t, e, i, s);
    }
    getLocalBounds(t) {
      return this.children.length === 0
        ? ((this._bounds.minX = this._width * -this._anchor._x),
          (this._bounds.minY = this._height * -this._anchor._y),
          (this._bounds.maxX = this._width * (1 - this._anchor._x)),
          (this._bounds.maxY = this._height * (1 - this._anchor._y)),
          t ||
            (this._localBoundsRect || (this._localBoundsRect = new Y()),
            (t = this._localBoundsRect)),
          this._bounds.getRectangle(t))
        : super.getLocalBounds.call(this, t);
    }
    containsPoint(t) {
      this.worldTransform.applyInverse(t, oi);
      const e = this._width,
        i = this._height,
        s = -e * this.anchor._x;
      if (oi.x >= s && oi.x < s + e) {
        const n = -i * this.anchor._y;
        if (oi.y >= n && oi.y < n + i) return !0;
      }
      return !1;
    }
    destroy(t) {
      super.destroy(t), (this.tileTransform = null), (this.uvMatrix = null);
    }
    static from(t, e) {
      const i = t instanceof O ? t : O.from(t, e);
      return new Sa(i, e.width, e.height);
    }
    get width() {
      return this._width;
    }
    set width(t) {
      this._width = t;
    }
    get height() {
      return this._height;
    }
    set height(t) {
      this._height = t;
    }
  }
  var Pg = `#version 300 es
#define SHADER_NAME Tiling-Sprite-100

precision lowp float;

in vec2 vTextureCoord;

out vec4 fragmentColor;

uniform sampler2D uSampler;
uniform vec4 uColor;
uniform mat3 uMapCoord;
uniform vec4 uClampFrame;
uniform vec2 uClampOffset;

void main(void)
{
    vec2 coord = vTextureCoord + ceil(uClampOffset - vTextureCoord);
    coord = (uMapCoord * vec3(coord, 1.0)).xy;
    vec2 unclamped = coord;
    coord = clamp(coord, uClampFrame.xy, uClampFrame.zw);

    vec4 texSample = texture(uSampler, coord, unclamped == coord ? 0.0f : -32.0f);// lod-bias very negative to force lod 0

    fragmentColor = texSample * uColor;
}
`,
    Dg = `#version 300 es
#define SHADER_NAME Tiling-Sprite-300

precision lowp float;

in vec2 aVertexPosition;
in vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTransform;

out vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = (uTransform * vec3(aTextureCoord, 1.0)).xy;
}
`,
    Ng = `#version 100
#ifdef GL_EXT_shader_texture_lod
    #extension GL_EXT_shader_texture_lod : enable
#endif
#define SHADER_NAME Tiling-Sprite-100

precision lowp float;

varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform vec4 uColor;
uniform mat3 uMapCoord;
uniform vec4 uClampFrame;
uniform vec2 uClampOffset;

void main(void)
{
    vec2 coord = vTextureCoord + ceil(uClampOffset - vTextureCoord);
    coord = (uMapCoord * vec3(coord, 1.0)).xy;
    vec2 unclamped = coord;
    coord = clamp(coord, uClampFrame.xy, uClampFrame.zw);

    #ifdef GL_EXT_shader_texture_lod
        vec4 texSample = unclamped == coord
            ? texture2D(uSampler, coord) 
            : texture2DLodEXT(uSampler, coord, 0);
    #else
        vec4 texSample = texture2D(uSampler, coord);
    #endif

    gl_FragColor = texSample * uColor;
}
`,
    Cu = `#version 100
#define SHADER_NAME Tiling-Sprite-100

precision lowp float;

attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat3 projectionMatrix;
uniform mat3 translationMatrix;
uniform mat3 uTransform;

varying vec2 vTextureCoord;

void main(void)
{
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);

    vTextureCoord = (uTransform * vec3(aTextureCoord, 1.0)).xy;
}
`,
    Og = `#version 100
#define SHADER_NAME Tiling-Sprite-Simple-100

precision lowp float;

varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform vec4 uColor;

void main(void)
{
    vec4 texSample = texture2D(uSampler, vTextureCoord);
    gl_FragColor = texSample * uColor;
}
`;
  const Es = new et();
  class wa extends $r {
    constructor(t) {
      super(t),
        t.runners.contextChange.add(this),
        (this.quad = new Nn()),
        (this.state = ie.for2d());
    }
    contextChange() {
      const t = this.renderer,
        e = { globals: t.globalUniforms };
      (this.simpleShader = Yt.from(Cu, Og, e)),
        (this.shader =
          t.context.webGLVersion > 1 ? Yt.from(Dg, Pg, e) : Yt.from(Cu, Ng, e));
    }
    render(t) {
      const e = this.renderer,
        i = this.quad;
      let s = i.vertices;
      (s[0] = s[6] = t._width * -t.anchor.x),
        (s[1] = s[3] = t._height * -t.anchor.y),
        (s[2] = s[4] = t._width * (1 - t.anchor.x)),
        (s[5] = s[7] = t._height * (1 - t.anchor.y));
      const n = t.uvRespectAnchor ? t.anchor.x : 0,
        a = t.uvRespectAnchor ? t.anchor.y : 0;
      (s = i.uvs),
        (s[0] = s[6] = -n),
        (s[1] = s[3] = -a),
        (s[2] = s[4] = 1 - n),
        (s[5] = s[7] = 1 - a),
        i.invalidate();
      const o = t._texture,
        h = o.baseTexture,
        l = h.alphaMode > 0,
        u = t.tileTransform.localTransform,
        c = t.uvMatrix;
      let d =
        h.isPowerOfTwo &&
        o.frame.width === h.width &&
        o.frame.height === h.height;
      d &&
        (h._glTextures[e.CONTEXT_UID]
          ? (d = h.wrapMode !== Jt.CLAMP)
          : h.wrapMode === Jt.CLAMP && (h.wrapMode = Jt.REPEAT));
      const f = d ? this.simpleShader : this.shader,
        p = o.width,
        m = o.height,
        g = t._width,
        x = t._height;
      Es.set(
        (u.a * p) / g,
        (u.b * p) / x,
        (u.c * m) / g,
        (u.d * m) / x,
        u.tx / g,
        u.ty / x
      ),
        Es.invert(),
        d
          ? Es.prepend(c.mapCoord)
          : ((f.uniforms.uMapCoord = c.mapCoord.toArray(!0)),
            (f.uniforms.uClampFrame = c.uClampFrame),
            (f.uniforms.uClampOffset = c.uClampOffset)),
        (f.uniforms.uTransform = Es.toArray(!0)),
        (f.uniforms.uColor = K.shared
          .setValue(t.tint)
          .premultiply(t.worldAlpha, l)
          .toArray(f.uniforms.uColor)),
        (f.uniforms.translationMatrix = t.transform.worldTransform.toArray(!0)),
        (f.uniforms.uSampler = o),
        e.shader.bind(f),
        e.geometry.bind(i),
        (this.state.blendMode = on(t.blendMode, l)),
        e.state.set(this.state),
        e.geometry.draw(this.renderer.gl.TRIANGLES, 6, 0);
    }
  }
  (wa.extension = { name: "tilingSprite", type: D.RendererPlugin }), U.add(wa);
  const Mu = class Si {
    constructor(t, e, i) {
      (this.linkedSheets = []),
        (t instanceof j || t instanceof O) &&
          (t = { texture: t, data: e, resolutionFilename: i });
      const {
        texture: s,
        data: n,
        resolutionFilename: a = null,
        cachePrefix: o = "",
      } = t;
      (this.cachePrefix = o),
        (this._texture = s instanceof O ? s : null),
        (this.baseTexture = s instanceof j ? s : this._texture.baseTexture),
        (this.textures = {}),
        (this.animations = {}),
        (this.data = n);
      const h = this.baseTexture.resource;
      (this.resolution = this._updateResolution(a || (h ? h.url : null))),
        (this._frames = this.data.frames),
        (this._frameKeys = Object.keys(this._frames)),
        (this._batchIndex = 0),
        (this._callback = null);
    }
    _updateResolution(t = null) {
      const { scale: e } = this.data.meta;
      let i = re(t, null);
      return (
        i === null &&
          (i = typeof e == "number" ? e : parseFloat(e != null ? e : "1")),
        i !== 1 && this.baseTexture.setResolution(i),
        i
      );
    }
    parse() {
      return new Promise((t) => {
        (this._callback = t),
          (this._batchIndex = 0),
          this._frameKeys.length <= Si.BATCH_SIZE
            ? (this._processFrames(0),
              this._processAnimations(),
              this._parseComplete())
            : this._nextBatch();
      });
    }
    _processFrames(t) {
      let e = t;
      const i = Si.BATCH_SIZE;
      for (; e - t < i && e < this._frameKeys.length; ) {
        const s = this._frameKeys[e],
          n = this._frames[s],
          a = n.frame;
        if (a) {
          let o = null,
            h = null;
          const l = n.trimmed !== !1 && n.sourceSize ? n.sourceSize : n.frame,
            u = new Y(
              0,
              0,
              Math.floor(l.w) / this.resolution,
              Math.floor(l.h) / this.resolution
            );
          n.rotated
            ? (o = new Y(
                Math.floor(a.x) / this.resolution,
                Math.floor(a.y) / this.resolution,
                Math.floor(a.h) / this.resolution,
                Math.floor(a.w) / this.resolution
              ))
            : (o = new Y(
                Math.floor(a.x) / this.resolution,
                Math.floor(a.y) / this.resolution,
                Math.floor(a.w) / this.resolution,
                Math.floor(a.h) / this.resolution
              )),
            n.trimmed !== !1 &&
              n.spriteSourceSize &&
              (h = new Y(
                Math.floor(n.spriteSourceSize.x) / this.resolution,
                Math.floor(n.spriteSourceSize.y) / this.resolution,
                Math.floor(a.w) / this.resolution,
                Math.floor(a.h) / this.resolution
              )),
            (this.textures[s] = new O(
              this.baseTexture,
              o,
              u,
              h,
              n.rotated ? 2 : 0,
              n.anchor,
              n.borders
            )),
            O.addToCache(this.textures[s], this.cachePrefix + s.toString());
        }
        e++;
      }
    }
    _processAnimations() {
      const t = this.data.animations || {};
      for (const e in t) {
        this.animations[e] = [];
        for (let i = 0; i < t[e].length; i++) {
          const s = t[e][i];
          this.animations[e].push(this.textures[s]);
        }
      }
    }
    _parseComplete() {
      const t = this._callback;
      (this._callback = null),
        (this._batchIndex = 0),
        t.call(this, this.textures);
    }
    _nextBatch() {
      this._processFrames(this._batchIndex * Si.BATCH_SIZE),
        this._batchIndex++,
        setTimeout(() => {
          this._batchIndex * Si.BATCH_SIZE < this._frameKeys.length
            ? this._nextBatch()
            : (this._processAnimations(), this._parseComplete());
        }, 0);
    }
    destroy(t = !1) {
      var e;
      for (const i in this.textures) this.textures[i].destroy();
      (this._frames = null),
        (this._frameKeys = null),
        (this.data = null),
        (this.textures = null),
        t &&
          ((e = this._texture) == null || e.destroy(),
          this.baseTexture.destroy()),
        (this._texture = null),
        (this.baseTexture = null),
        (this.linkedSheets = []);
    }
  };
  Mu.BATCH_SIZE = 1e3;
  let Ra = Mu;
  const Bg = [
    "jpg",
    "png",
    "jpeg",
    "avif",
    "webp",
    "s3tc",
    "s3tc_sRGB",
    "etc",
    "etc1",
    "pvrtc",
    "atc",
    "astc",
    "bptc",
  ];
  function Pu(r, t, e) {
    const i = {};
    if (
      (r.forEach((s) => {
        i[s] = t;
      }),
      Object.keys(t.textures).forEach((s) => {
        i[`${t.cachePrefix}${s}`] = t.textures[s];
      }),
      !e)
    ) {
      const s = yt.dirname(r[0]);
      t.linkedSheets.forEach((n, a) => {
        Object.assign(
          i,
          Pu([`${s}/${t.data.meta.related_multi_packs[a]}`], n, !0)
        );
      });
    }
    return i;
  }
  const Du = {
    extension: D.Asset,
    cache: {
      test: (r) => r instanceof Ra,
      getCacheableAssets: (r, t) => Pu(r, t, !1),
    },
    resolver: {
      test: (r) => {
        const t = r.split("?")[0].split("."),
          e = t.pop(),
          i = t.pop();
        return e === "json" && Bg.includes(i);
      },
      parse: (r) => {
        var t, e;
        const i = r.split(".");
        return {
          resolution: parseFloat(
            (e = (t = B.RETINA_PREFIX.exec(r)) == null ? void 0 : t[1]) != null
              ? e
              : "1"
          ),
          format: i[i.length - 2],
          src: r,
        };
      },
    },
    loader: {
      name: "spritesheetLoader",
      extension: { type: D.LoadParser, priority: Ht.Normal },
      async testParse(r, t) {
        return yt.extname(t.src).toLowerCase() === ".json" && !!r.frames;
      },
      async parse(r, t, e) {
        var i, s, n;
        const {
          texture: a,
          imageFilename: o,
          cachePrefix: h,
        } = (i = t == null ? void 0 : t.data) != null ? i : {};
        let l = yt.dirname(t.src);
        l && l.lastIndexOf("/") !== l.length - 1 && (l += "/");
        let u;
        if (a && a.baseTexture) u = a;
        else {
          const f = ls(l + (o != null ? o : r.meta.image), t.src);
          u = (await e.load([f]))[f];
        }
        const c = new Ra({
          texture: u.baseTexture,
          data: r,
          resolutionFilename: t.src,
          cachePrefix: h,
        });
        await c.parse();
        const d =
          (s = r == null ? void 0 : r.meta) == null
            ? void 0
            : s.related_multi_packs;
        if (Array.isArray(d)) {
          const f = [];
          for (const m of d) {
            if (typeof m != "string") continue;
            let g = l + m;
            ((n = t.data) != null && n.ignoreMultiPack) ||
              ((g = ls(g, t.src)),
              f.push(e.load({ src: g, data: { ignoreMultiPack: !0 } })));
          }
          const p = await Promise.all(f);
          (c.linkedSheets = p),
            p.forEach((m) => {
              m.linkedSheets = [c].concat(
                c.linkedSheets.filter((g) => g !== m)
              );
            });
        }
        return c;
      },
      unload(r) {
        r.destroy(!0);
      },
    },
  };
  U.add(Du);
  class hi {
    constructor() {
      (this.info = []),
        (this.common = []),
        (this.page = []),
        (this.char = []),
        (this.kerning = []),
        (this.distanceField = []);
    }
  }
  class li {
    static test(t) {
      return typeof t == "string" && t.startsWith("info face=");
    }
    static parse(t) {
      const e = t.match(/^[a-z]+\s+.+$/gm),
        i = {
          info: [],
          common: [],
          page: [],
          char: [],
          chars: [],
          kerning: [],
          kernings: [],
          distanceField: [],
        };
      for (const n in e) {
        const a = e[n].match(/^[a-z]+/gm)[0],
          o = e[n].match(/[a-zA-Z]+=([^\s"']+|"([^"]*)")/gm),
          h = {};
        for (const l in o) {
          const u = o[l].split("="),
            c = u[0],
            d = u[1].replace(/"/gm, ""),
            f = parseFloat(d),
            p = isNaN(f) ? d : f;
          h[c] = p;
        }
        i[a].push(h);
      }
      const s = new hi();
      return (
        i.info.forEach((n) =>
          s.info.push({ face: n.face, size: parseInt(n.size, 10) })
        ),
        i.common.forEach((n) =>
          s.common.push({ lineHeight: parseInt(n.lineHeight, 10) })
        ),
        i.page.forEach((n) =>
          s.page.push({ id: parseInt(n.id, 10), file: n.file })
        ),
        i.char.forEach((n) =>
          s.char.push({
            id: parseInt(n.id, 10),
            page: parseInt(n.page, 10),
            x: parseInt(n.x, 10),
            y: parseInt(n.y, 10),
            width: parseInt(n.width, 10),
            height: parseInt(n.height, 10),
            xoffset: parseInt(n.xoffset, 10),
            yoffset: parseInt(n.yoffset, 10),
            xadvance: parseInt(n.xadvance, 10),
          })
        ),
        i.kerning.forEach((n) =>
          s.kerning.push({
            first: parseInt(n.first, 10),
            second: parseInt(n.second, 10),
            amount: parseInt(n.amount, 10),
          })
        ),
        i.distanceField.forEach((n) =>
          s.distanceField.push({
            distanceRange: parseInt(n.distanceRange, 10),
            fieldType: n.fieldType,
          })
        ),
        s
      );
    }
  }
  class Ts {
    static test(t) {
      const e = t;
      return (
        typeof t != "string" &&
        "getElementsByTagName" in t &&
        e.getElementsByTagName("page").length &&
        e.getElementsByTagName("info")[0].getAttribute("face") !== null
      );
    }
    static parse(t) {
      const e = new hi(),
        i = t.getElementsByTagName("info"),
        s = t.getElementsByTagName("common"),
        n = t.getElementsByTagName("page"),
        a = t.getElementsByTagName("char"),
        o = t.getElementsByTagName("kerning"),
        h = t.getElementsByTagName("distanceField");
      for (let l = 0; l < i.length; l++)
        e.info.push({
          face: i[l].getAttribute("face"),
          size: parseInt(i[l].getAttribute("size"), 10),
        });
      for (let l = 0; l < s.length; l++)
        e.common.push({
          lineHeight: parseInt(s[l].getAttribute("lineHeight"), 10),
        });
      for (let l = 0; l < n.length; l++)
        e.page.push({
          id: parseInt(n[l].getAttribute("id"), 10) || 0,
          file: n[l].getAttribute("file"),
        });
      for (let l = 0; l < a.length; l++) {
        const u = a[l];
        e.char.push({
          id: parseInt(u.getAttribute("id"), 10),
          page: parseInt(u.getAttribute("page"), 10) || 0,
          x: parseInt(u.getAttribute("x"), 10),
          y: parseInt(u.getAttribute("y"), 10),
          width: parseInt(u.getAttribute("width"), 10),
          height: parseInt(u.getAttribute("height"), 10),
          xoffset: parseInt(u.getAttribute("xoffset"), 10),
          yoffset: parseInt(u.getAttribute("yoffset"), 10),
          xadvance: parseInt(u.getAttribute("xadvance"), 10),
        });
      }
      for (let l = 0; l < o.length; l++)
        e.kerning.push({
          first: parseInt(o[l].getAttribute("first"), 10),
          second: parseInt(o[l].getAttribute("second"), 10),
          amount: parseInt(o[l].getAttribute("amount"), 10),
        });
      for (let l = 0; l < h.length; l++)
        e.distanceField.push({
          fieldType: h[l].getAttribute("fieldType"),
          distanceRange: parseInt(h[l].getAttribute("distanceRange"), 10),
        });
      return e;
    }
  }
  class As {
    static test(t) {
      return typeof t == "string" && t.includes("<font>")
        ? Ts.test(B.ADAPTER.parseXML(t))
        : !1;
    }
    static parse(t) {
      return Ts.parse(B.ADAPTER.parseXML(t));
    }
  }
  const Ia = [li, Ts, As];
  function Nu(r) {
    for (let t = 0; t < Ia.length; t++) if (Ia[t].test(r)) return Ia[t];
    return null;
  }
  function Fg(r, t, e, i, s, n) {
    const a = e.fill;
    if (Array.isArray(a)) {
      if (a.length === 1) return a[0];
    } else return a;
    let o;
    const h = e.dropShadow ? e.dropShadowDistance : 0,
      l = e.padding || 0,
      u = r.width / i - h - l * 2,
      c = r.height / i - h - l * 2,
      d = a.slice(),
      f = e.fillGradientStops.slice();
    if (!f.length) {
      const p = d.length + 1;
      for (let m = 1; m < p; ++m) f.push(m / p);
    }
    if (
      (d.unshift(a[0]),
      f.unshift(0),
      d.push(a[a.length - 1]),
      f.push(1),
      e.fillGradientType === ai.LINEAR_VERTICAL)
    ) {
      o = t.createLinearGradient(u / 2, l, u / 2, c + l);
      let p = 0;
      const m = (n.fontProperties.fontSize + e.strokeThickness) / c;
      for (let g = 0; g < s.length; g++) {
        const x = n.lineHeight * g;
        for (let b = 0; b < d.length; b++) {
          let _ = 0;
          typeof f[b] == "number" ? (_ = f[b]) : (_ = b / d.length);
          const y = x / c + _ * m;
          let T = Math.max(p, y);
          (T = Math.min(T, 1)), o.addColorStop(T, d[b]), (p = T);
        }
      }
    } else {
      o = t.createLinearGradient(l, c / 2, u + l, c / 2);
      const p = d.length + 1;
      let m = 1;
      for (let g = 0; g < d.length; g++) {
        let x;
        typeof f[g] == "number" ? (x = f[g]) : (x = m / p),
          o.addColorStop(x, d[g]),
          m++;
      }
    }
    return o;
  }
  function Lg(r, t, e, i, s, n, a) {
    const o = e.text,
      h = e.fontProperties;
    t.translate(i, s), t.scale(n, n);
    const l = a.strokeThickness / 2,
      u = -(a.strokeThickness / 2);
    if (
      ((t.font = a.toFontString()),
      (t.lineWidth = a.strokeThickness),
      (t.textBaseline = a.textBaseline),
      (t.lineJoin = a.lineJoin),
      (t.miterLimit = a.miterLimit),
      (t.fillStyle = Fg(r, t, a, n, [o], e)),
      (t.strokeStyle = a.stroke),
      a.dropShadow)
    ) {
      const c = a.dropShadowColor,
        d = a.dropShadowBlur * n,
        f = a.dropShadowDistance * n;
      (t.shadowColor = K.shared
        .setValue(c)
        .setAlpha(a.dropShadowAlpha)
        .toRgbaString()),
        (t.shadowBlur = d),
        (t.shadowOffsetX = Math.cos(a.dropShadowAngle) * f),
        (t.shadowOffsetY = Math.sin(a.dropShadowAngle) * f);
    } else
      (t.shadowColor = "black"),
        (t.shadowBlur = 0),
        (t.shadowOffsetX = 0),
        (t.shadowOffsetY = 0);
    a.stroke &&
      a.strokeThickness &&
      t.strokeText(o, l, u + e.lineHeight - h.descent),
      a.fill && t.fillText(o, l, u + e.lineHeight - h.descent),
      t.setTransform(1, 0, 0, 1, 0, 0),
      (t.fillStyle = "rgba(0, 0, 0, 0)");
  }
  function Ss(r) {
    return r.codePointAt ? r.codePointAt(0) : r.charCodeAt(0);
  }
  function Ou(r) {
    return Array.from ? Array.from(r) : r.split("");
  }
  function Ug(r) {
    typeof r == "string" && (r = [r]);
    const t = [];
    for (let e = 0, i = r.length; e < i; e++) {
      const s = r[e];
      if (Array.isArray(s)) {
        if (s.length !== 2)
          throw new Error(
            `[BitmapFont]: Invalid character range length, expecting 2 got ${s.length}.`
          );
        const n = s[0].charCodeAt(0),
          a = s[1].charCodeAt(0);
        if (a < n) throw new Error("[BitmapFont]: Invalid character range.");
        for (let o = n, h = a; o <= h; o++) t.push(String.fromCharCode(o));
      } else t.push(...Ou(s));
    }
    if (t.length === 0)
      throw new Error("[BitmapFont]: Empty set when resolving characters.");
    return t;
  }
  var kg = Object.defineProperty,
    ws = Object.getOwnPropertySymbols,
    Bu = Object.prototype.hasOwnProperty,
    Fu = Object.prototype.propertyIsEnumerable,
    Lu = (r, t, e) =>
      t in r
        ? kg(r, t, { enumerable: !0, configurable: !0, writable: !0, value: e })
        : (r[t] = e),
    Gg = (r, t) => {
      for (var e in t || (t = {})) Bu.call(t, e) && Lu(r, e, t[e]);
      if (ws) for (var e of ws(t)) Fu.call(t, e) && Lu(r, e, t[e]);
      return r;
    },
    $g = (r, t) => {
      var e = {};
      for (var i in r) Bu.call(r, i) && t.indexOf(i) < 0 && (e[i] = r[i]);
      if (r != null && ws)
        for (var i of ws(r)) t.indexOf(i) < 0 && Fu.call(r, i) && (e[i] = r[i]);
      return e;
    };
  const Le = class de {
    constructor(t, e, i) {
      var s, n;
      const [a] = t.info,
        [o] = t.common,
        [h] = t.page,
        [l] = t.distanceField,
        u = re(h.file),
        c = {};
      (this._ownsTextures = i),
        (this.font = a.face),
        (this.size = a.size),
        (this.lineHeight = o.lineHeight / u),
        (this.chars = {}),
        (this.pageTextures = c);
      for (let d = 0; d < t.page.length; d++) {
        const { id: f, file: p } = t.page[d];
        (c[f] = e instanceof Array ? e[d] : e[p]),
          l != null &&
            l.fieldType &&
            l.fieldType !== "none" &&
            ((c[f].baseTexture.alphaMode = wt.NO_PREMULTIPLIED_ALPHA),
            (c[f].baseTexture.mipmap = Xt.OFF));
      }
      for (let d = 0; d < t.char.length; d++) {
        const { id: f, page: p } = t.char[d];
        let {
          x: m,
          y: g,
          width: x,
          height: b,
          xoffset: _,
          yoffset: y,
          xadvance: T,
        } = t.char[d];
        (m /= u), (g /= u), (x /= u), (b /= u), (_ /= u), (y /= u), (T /= u);
        const C = new Y(m + c[p].frame.x / u, g + c[p].frame.y / u, x, b);
        this.chars[f] = {
          xOffset: _,
          yOffset: y,
          xAdvance: T,
          kerning: {},
          texture: new O(c[p].baseTexture, C),
          page: p,
        };
      }
      for (let d = 0; d < t.kerning.length; d++) {
        let { first: f, second: p, amount: m } = t.kerning[d];
        (f /= u),
          (p /= u),
          (m /= u),
          this.chars[p] && (this.chars[p].kerning[f] = m);
      }
      (this.distanceFieldRange = l == null ? void 0 : l.distanceRange),
        (this.distanceFieldType =
          (n =
            (s = l == null ? void 0 : l.fieldType) == null
              ? void 0
              : s.toLowerCase()) != null
            ? n
            : "none");
    }
    destroy() {
      for (const t in this.chars)
        this.chars[t].texture.destroy(), (this.chars[t].texture = null);
      for (const t in this.pageTextures)
        this._ownsTextures && this.pageTextures[t].destroy(!0),
          (this.pageTextures[t] = null);
      (this.chars = null), (this.pageTextures = null);
    }
    static install(t, e, i) {
      let s;
      if (t instanceof hi) s = t;
      else {
        const a = Nu(t);
        if (!a) throw new Error("Unrecognized data format for font.");
        s = a.parse(t);
      }
      e instanceof O && (e = [e]);
      const n = new de(s, e, i);
      return (de.available[n.font] = n), n;
    }
    static uninstall(t) {
      const e = de.available[t];
      if (!e) throw new Error(`No font found named '${t}'`);
      e.destroy(), delete de.available[t];
    }
    static from(t, e, i) {
      if (!t) throw new Error("[BitmapFont] Property `name` is required.");
      const s = Object.assign({}, de.defaultOptions, i),
        {
          chars: n,
          padding: a,
          resolution: o,
          textureWidth: h,
          textureHeight: l,
        } = s,
        u = $g(s, [
          "chars",
          "padding",
          "resolution",
          "textureWidth",
          "textureHeight",
        ]),
        c = Ug(n),
        d = e instanceof Je ? e : new Je(e),
        f = h,
        p = new hi();
      (p.info[0] = { face: d.fontFamily, size: d.fontSize }),
        (p.common[0] = { lineHeight: d.fontSize });
      let m = 0,
        g = 0,
        x,
        b,
        _,
        y = 0;
      const T = [],
        C = [];
      for (let S = 0; S < c.length; S++) {
        x ||
          ((x = B.ADAPTER.createCanvas()),
          (x.width = h),
          (x.height = l),
          (b = x.getContext("2d")),
          (_ = new j(x, Gg({ resolution: o }, u))),
          T.push(_),
          C.push(new O(_)),
          p.page.push({ id: C.length - 1, file: "" }));
        const I = c[S],
          $ = xe.measureText(I, d, !1, x),
          z = $.width,
          F = Math.ceil($.height),
          E = Math.ceil((d.fontStyle === "italic" ? 2 : 1) * z);
        if (g >= l - F * o) {
          if (g === 0)
            throw new Error(
              `[BitmapFont] textureHeight ${l}px is too small (fontFamily: '${d.fontFamily}', fontSize: ${d.fontSize}px, char: '${I}')`
            );
          --S, (x = null), (b = null), (_ = null), (g = 0), (m = 0), (y = 0);
          continue;
        }
        if (((y = Math.max(F + $.fontProperties.descent, y)), E * o + m >= f)) {
          if (m === 0)
            throw new Error(
              `[BitmapFont] textureWidth ${h}px is too small (fontFamily: '${d.fontFamily}', fontSize: ${d.fontSize}px, char: '${I}')`
            );
          --S, (g += y * o), (g = Math.ceil(g)), (m = 0), (y = 0);
          continue;
        }
        Lg(x, b, $, m, g, o, d);
        const w = Ss($.text);
        p.char.push({
          id: w,
          page: C.length - 1,
          x: m / o,
          y: g / o,
          width: E,
          height: F,
          xoffset: 0,
          yoffset: 0,
          xadvance:
            z -
            (d.dropShadow ? d.dropShadowDistance : 0) -
            (d.stroke ? d.strokeThickness : 0),
        }),
          (m += (E + 2 * a) * o),
          (m = Math.ceil(m));
      }
      if (!(i != null && i.skipKerning))
        for (let S = 0, I = c.length; S < I; S++) {
          const $ = c[S];
          for (let z = 0; z < I; z++) {
            const F = c[z],
              E = b.measureText($).width,
              w = b.measureText(F).width,
              V = b.measureText($ + F).width - (E + w);
            V && p.kerning.push({ first: Ss($), second: Ss(F), amount: V });
          }
        }
      const R = new de(p, C, !0);
      return (
        de.available[t] !== void 0 && de.uninstall(t), (de.available[t] = R), R
      );
    }
  };
  (Le.ALPHA = [["a", "z"], ["A", "Z"], " "]),
    (Le.NUMERIC = [["0", "9"]]),
    (Le.ALPHANUMERIC = [["a", "z"], ["A", "Z"], ["0", "9"], " "]),
    (Le.ASCII = [[" ", "~"]]),
    (Le.defaultOptions = {
      resolution: 1,
      textureWidth: 512,
      textureHeight: 512,
      padding: 4,
      chars: Le.ALPHANUMERIC,
    }),
    (Le.available = {});
  let ye = Le;
  var Hg = `// Pixi texture info\r
varying vec2 vTextureCoord;\r
uniform sampler2D uSampler;\r
\r
// Tint\r
uniform vec4 uColor;\r
\r
// on 2D applications fwidth is screenScale / glyphAtlasScale * distanceFieldRange\r
uniform float uFWidth;\r
\r
void main(void) {\r
\r
  // To stack MSDF and SDF we need a non-pre-multiplied-alpha texture.\r
  vec4 texColor = texture2D(uSampler, vTextureCoord);\r
\r
  // MSDF\r
  float median = texColor.r + texColor.g + texColor.b -\r
                  min(texColor.r, min(texColor.g, texColor.b)) -\r
                  max(texColor.r, max(texColor.g, texColor.b));\r
  // SDF\r
  median = min(median, texColor.a);\r
\r
  float screenPxDistance = uFWidth * (median - 0.5);\r
  float alpha = clamp(screenPxDistance + 0.5, 0.0, 1.0);\r
  if (median < 0.01) {\r
    alpha = 0.0;\r
  } else if (median > 0.99) {\r
    alpha = 1.0;\r
  }\r
\r
  // Gamma correction for coverage-like alpha\r
  float luma = dot(uColor.rgb, vec3(0.299, 0.587, 0.114));\r
  float gamma = mix(1.0, 1.0 / 2.2, luma);\r
  float coverage = pow(uColor.a * alpha, gamma);  \r
\r
  // NPM Textures, NPM outputs\r
  gl_FragColor = vec4(uColor.rgb, coverage);\r
}\r
`,
    Vg = `// Mesh material default fragment\r
attribute vec2 aVertexPosition;\r
attribute vec2 aTextureCoord;\r
\r
uniform mat3 projectionMatrix;\r
uniform mat3 translationMatrix;\r
uniform mat3 uTextureMatrix;\r
\r
varying vec2 vTextureCoord;\r
\r
void main(void)\r
{\r
    gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);\r
\r
    vTextureCoord = (uTextureMatrix * vec3(aTextureCoord, 1.0)).xy;\r
}\r
`;
  const Uu = [],
    ku = [],
    Gu = [],
    $u = class Fc extends Ot {
      constructor(t, e = {}) {
        super();
        const {
          align: i,
          tint: s,
          maxWidth: n,
          letterSpacing: a,
          fontName: o,
          fontSize: h,
        } = Object.assign({}, Fc.styleDefaults, e);
        if (!ye.available[o]) throw new Error(`Missing BitmapFont "${o}"`);
        (this._activePagesMeshData = []),
          (this._textWidth = 0),
          (this._textHeight = 0),
          (this._align = i),
          (this._tintColor = new K(s)),
          (this._font = void 0),
          (this._fontName = o),
          (this._fontSize = h),
          (this.text = t),
          (this._maxWidth = n),
          (this._maxLineHeight = 0),
          (this._letterSpacing = a),
          (this._anchor = new ge(
            () => {
              this.dirty = !0;
            },
            this,
            0,
            0
          )),
          (this._roundPixels = B.ROUND_PIXELS),
          (this.dirty = !0),
          (this._resolution = B.RESOLUTION),
          (this._autoResolution = !0),
          (this._textureCache = {});
      }
      updateText() {
        var t;
        const e = ye.available[this._fontName],
          i = this.fontSize,
          s = i / e.size,
          n = new tt(),
          a = [],
          o = [],
          h = [],
          l =
            this._text.replace(
              /(?:\r\n|\r)/g,
              `
`
            ) || " ",
          u = Ou(l),
          c = (this._maxWidth * e.size) / i,
          d = e.distanceFieldType === "none" ? Uu : ku;
        let f = null,
          p = 0,
          m = 0,
          g = 0,
          x = -1,
          b = 0,
          _ = 0,
          y = 0,
          T = 0;
        for (let F = 0; F < u.length; F++) {
          const E = u[F],
            w = Ss(E);
          if (
            (/(?:\s)/.test(E) && ((x = F), (b = p), T++),
            E === "\r" ||
              E ===
                `
`)
          ) {
            o.push(p),
              h.push(-1),
              (m = Math.max(m, p)),
              ++g,
              ++_,
              (n.x = 0),
              (n.y += e.lineHeight),
              (f = null),
              (T = 0);
            continue;
          }
          const V = e.chars[w];
          if (!V) continue;
          f && V.kerning[f] && (n.x += V.kerning[f]);
          const k = Gu.pop() || {
            texture: O.EMPTY,
            line: 0,
            charCode: 0,
            prevSpaces: 0,
            position: new tt(),
          };
          (k.texture = V.texture),
            (k.line = g),
            (k.charCode = w),
            (k.position.x = Math.round(
              n.x + V.xOffset + this._letterSpacing / 2
            )),
            (k.position.y = Math.round(n.y + V.yOffset)),
            (k.prevSpaces = T),
            a.push(k),
            (p =
              k.position.x +
              Math.max(V.xAdvance - V.xOffset, V.texture.orig.width)),
            (n.x += V.xAdvance + this._letterSpacing),
            (y = Math.max(y, V.yOffset + V.texture.height)),
            (f = w),
            x !== -1 &&
              c > 0 &&
              n.x > c &&
              (++_,
              nr(a, 1 + x - _, 1 + F - x),
              (F = x),
              (x = -1),
              o.push(b),
              h.push(a.length > 0 ? a[a.length - 1].prevSpaces : 0),
              (m = Math.max(m, b)),
              g++,
              (n.x = 0),
              (n.y += e.lineHeight),
              (f = null),
              (T = 0));
        }
        const C = u[u.length - 1];
        C !== "\r" &&
          C !==
            `
` &&
          (/(?:\s)/.test(C) && (p = b),
          o.push(p),
          (m = Math.max(m, p)),
          h.push(-1));
        const R = [];
        for (let F = 0; F <= g; F++) {
          let E = 0;
          this._align === "right"
            ? (E = m - o[F])
            : this._align === "center"
            ? (E = (m - o[F]) / 2)
            : this._align === "justify" &&
              (E = h[F] < 0 ? 0 : (m - o[F]) / h[F]),
            R.push(E);
        }
        const S = a.length,
          I = {},
          $ = [],
          z = this._activePagesMeshData;
        d.push(...z);
        for (let F = 0; F < S; F++) {
          const E = a[F].texture,
            w = E.baseTexture.uid;
          if (!I[w]) {
            let V = d.pop();
            if (!V) {
              const L = new ni();
              let W, lt;
              e.distanceFieldType === "none"
                ? ((W = new pr(O.EMPTY)), (lt = X.NORMAL))
                : ((W = new pr(O.EMPTY, {
                    program: se.from(Vg, Hg),
                    uniforms: { uFWidth: 0 },
                  })),
                  (lt = X.NORMAL_NPM));
              const P = new fr(L, W);
              (P.blendMode = lt),
                (V = {
                  index: 0,
                  indexCount: 0,
                  vertexCount: 0,
                  uvsCount: 0,
                  total: 0,
                  mesh: P,
                  vertices: null,
                  uvs: null,
                  indices: null,
                });
            }
            (V.index = 0),
              (V.indexCount = 0),
              (V.vertexCount = 0),
              (V.uvsCount = 0),
              (V.total = 0);
            const { _textureCache: k } = this;
            (k[w] = k[w] || new O(E.baseTexture)),
              (V.mesh.texture = k[w]),
              (V.mesh.tint = this._tintColor.value),
              $.push(V),
              (I[w] = V);
          }
          I[w].total++;
        }
        for (let F = 0; F < z.length; F++)
          $.includes(z[F]) || this.removeChild(z[F].mesh);
        for (let F = 0; F < $.length; F++)
          $[F].mesh.parent !== this && this.addChild($[F].mesh);
        this._activePagesMeshData = $;
        for (const F in I) {
          const E = I[F],
            w = E.total;
          if (
            !(((t = E.indices) == null ? void 0 : t.length) > 6 * w) ||
            E.vertices.length < fr.BATCHABLE_SIZE * 2
          )
            (E.vertices = new Float32Array(4 * 2 * w)),
              (E.uvs = new Float32Array(4 * 2 * w)),
              (E.indices = new Uint16Array(6 * w));
          else {
            const V = E.total,
              k = E.vertices;
            for (let L = V * 4 * 2; L < k.length; L++) k[L] = 0;
          }
          E.mesh.size = 6 * w;
        }
        for (let F = 0; F < S; F++) {
          const E = a[F];
          let w =
            E.position.x +
            R[E.line] * (this._align === "justify" ? E.prevSpaces : 1);
          this._roundPixels && (w = Math.round(w));
          const V = w * s,
            k = E.position.y * s,
            L = E.texture,
            W = I[L.baseTexture.uid],
            lt = L.frame,
            P = L._uvs,
            M = W.index++;
          (W.indices[M * 6 + 0] = 0 + M * 4),
            (W.indices[M * 6 + 1] = 1 + M * 4),
            (W.indices[M * 6 + 2] = 2 + M * 4),
            (W.indices[M * 6 + 3] = 0 + M * 4),
            (W.indices[M * 6 + 4] = 2 + M * 4),
            (W.indices[M * 6 + 5] = 3 + M * 4),
            (W.vertices[M * 8 + 0] = V),
            (W.vertices[M * 8 + 1] = k),
            (W.vertices[M * 8 + 2] = V + lt.width * s),
            (W.vertices[M * 8 + 3] = k),
            (W.vertices[M * 8 + 4] = V + lt.width * s),
            (W.vertices[M * 8 + 5] = k + lt.height * s),
            (W.vertices[M * 8 + 6] = V),
            (W.vertices[M * 8 + 7] = k + lt.height * s),
            (W.uvs[M * 8 + 0] = P.x0),
            (W.uvs[M * 8 + 1] = P.y0),
            (W.uvs[M * 8 + 2] = P.x1),
            (W.uvs[M * 8 + 3] = P.y1),
            (W.uvs[M * 8 + 4] = P.x2),
            (W.uvs[M * 8 + 5] = P.y2),
            (W.uvs[M * 8 + 6] = P.x3),
            (W.uvs[M * 8 + 7] = P.y3);
        }
        (this._textWidth = m * s),
          (this._textHeight = (n.y + e.lineHeight) * s);
        for (const F in I) {
          const E = I[F];
          if (this.anchor.x !== 0 || this.anchor.y !== 0) {
            let L = 0;
            const W = this._textWidth * this.anchor.x,
              lt = this._textHeight * this.anchor.y;
            for (let P = 0; P < E.total; P++)
              (E.vertices[L++] -= W),
                (E.vertices[L++] -= lt),
                (E.vertices[L++] -= W),
                (E.vertices[L++] -= lt),
                (E.vertices[L++] -= W),
                (E.vertices[L++] -= lt),
                (E.vertices[L++] -= W),
                (E.vertices[L++] -= lt);
          }
          this._maxLineHeight = y * s;
          const w = E.mesh.geometry.getBuffer("aVertexPosition"),
            V = E.mesh.geometry.getBuffer("aTextureCoord"),
            k = E.mesh.geometry.getIndex();
          (w.data = E.vertices),
            (V.data = E.uvs),
            (k.data = E.indices),
            w.update(),
            V.update(),
            k.update();
        }
        for (let F = 0; F < a.length; F++) Gu.push(a[F]);
        (this._font = e), (this.dirty = !1);
      }
      updateTransform() {
        this.validate(), this.containerUpdateTransform();
      }
      _render(t) {
        this._autoResolution &&
          this._resolution !== t.resolution &&
          ((this._resolution = t.resolution), (this.dirty = !0));
        const {
          distanceFieldRange: e,
          distanceFieldType: i,
          size: s,
        } = ye.available[this._fontName];
        if (i !== "none") {
          const { a: n, b: a, c: o, d: h } = this.worldTransform,
            l = Math.sqrt(n * n + a * a),
            u = Math.sqrt(o * o + h * h),
            c = (Math.abs(l) + Math.abs(u)) / 2,
            d = this.fontSize / s,
            f = t._view.resolution;
          for (const p of this._activePagesMeshData)
            p.mesh.shader.uniforms.uFWidth = c * e * d * f;
        }
        super._render(t);
      }
      getLocalBounds() {
        return this.validate(), super.getLocalBounds();
      }
      validate() {
        const t = ye.available[this._fontName];
        if (!t) throw new Error(`Missing BitmapFont "${this._fontName}"`);
        this._font !== t && (this.dirty = !0), this.dirty && this.updateText();
      }
      get tint() {
        return this._tintColor.value;
      }
      set tint(t) {
        if (this.tint !== t) {
          this._tintColor.setValue(t);
          for (let e = 0; e < this._activePagesMeshData.length; e++)
            this._activePagesMeshData[e].mesh.tint = t;
        }
      }
      get align() {
        return this._align;
      }
      set align(t) {
        this._align !== t && ((this._align = t), (this.dirty = !0));
      }
      get fontName() {
        return this._fontName;
      }
      set fontName(t) {
        if (!ye.available[t]) throw new Error(`Missing BitmapFont "${t}"`);
        this._fontName !== t && ((this._fontName = t), (this.dirty = !0));
      }
      get fontSize() {
        var t;
        return (t = this._fontSize) != null
          ? t
          : ye.available[this._fontName].size;
      }
      set fontSize(t) {
        this._fontSize !== t && ((this._fontSize = t), (this.dirty = !0));
      }
      get anchor() {
        return this._anchor;
      }
      set anchor(t) {
        typeof t == "number" ? this._anchor.set(t) : this._anchor.copyFrom(t);
      }
      get text() {
        return this._text;
      }
      set text(t) {
        (t = String(t == null ? "" : t)),
          this._text !== t && ((this._text = t), (this.dirty = !0));
      }
      get maxWidth() {
        return this._maxWidth;
      }
      set maxWidth(t) {
        this._maxWidth !== t && ((this._maxWidth = t), (this.dirty = !0));
      }
      get maxLineHeight() {
        return this.validate(), this._maxLineHeight;
      }
      get textWidth() {
        return this.validate(), this._textWidth;
      }
      get letterSpacing() {
        return this._letterSpacing;
      }
      set letterSpacing(t) {
        this._letterSpacing !== t &&
          ((this._letterSpacing = t), (this.dirty = !0));
      }
      get roundPixels() {
        return this._roundPixels;
      }
      set roundPixels(t) {
        t !== this._roundPixels && ((this._roundPixels = t), (this.dirty = !0));
      }
      get textHeight() {
        return this.validate(), this._textHeight;
      }
      get resolution() {
        return this._resolution;
      }
      set resolution(t) {
        (this._autoResolution = !1),
          this._resolution !== t && ((this._resolution = t), (this.dirty = !0));
      }
      destroy(t) {
        const { _textureCache: e } = this,
          i =
            ye.available[this._fontName].distanceFieldType === "none" ? Uu : ku;
        i.push(...this._activePagesMeshData);
        for (const s of this._activePagesMeshData) this.removeChild(s.mesh);
        (this._activePagesMeshData = []),
          i
            .filter((s) => e[s.mesh.texture.baseTexture.uid])
            .forEach((s) => {
              s.mesh.texture = O.EMPTY;
            });
        for (const s in e) e[s].destroy(), delete e[s];
        (this._font = null),
          (this._tintColor = null),
          (this._textureCache = null),
          super.destroy(t);
      }
    };
  $u.styleDefaults = {
    align: "left",
    tint: 16777215,
    maxWidth: 0,
    letterSpacing: 0,
  };
  let Xg = $u;
  const zg = [".xml", ".fnt"],
    Hu = {
      extension: { type: D.LoadParser, priority: Ht.Normal },
      name: "loadBitmapFont",
      test(r) {
        return zg.includes(yt.extname(r).toLowerCase());
      },
      async testParse(r) {
        return li.test(r) || As.test(r);
      },
      async parse(r, t, e) {
        const i = li.test(r) ? li.parse(r) : As.parse(r),
          { src: s } = t,
          { page: n } = i,
          a = [];
        for (let l = 0; l < n.length; ++l) {
          const u = n[l].file;
          let c = yt.join(yt.dirname(s), u);
          (c = ls(c, s)), a.push(c);
        }
        const o = await e.load(a),
          h = a.map((l) => o[l]);
        return ye.install(i, h, !0);
      },
      async load(r, t) {
        return (await B.ADAPTER.fetch(r)).text();
      },
      unload(r) {
        r.destroy();
      },
    };
  U.add(Hu);
  var Ca = {},
    be = {},
    Ee = {};
  function jg(r, t, e) {
    if (
      (e === void 0 && (e = Array.prototype), r && typeof e.find == "function")
    )
      return e.find.call(r, t);
    for (var i = 0; i < r.length; i++)
      if (Object.prototype.hasOwnProperty.call(r, i)) {
        var s = r[i];
        if (t.call(void 0, s, i, r)) return s;
      }
  }
  function Ma(r, t) {
    return (
      t === void 0 && (t = Object),
      t && typeof t.freeze == "function" ? t.freeze(r) : r
    );
  }
  function Wg(r, t) {
    if (r === null || typeof r != "object")
      throw new TypeError("target is not an object");
    for (var e in t)
      Object.prototype.hasOwnProperty.call(t, e) && (r[e] = t[e]);
    return r;
  }
  var Vu = Ma({
      HTML: "text/html",
      isHTML: function (r) {
        return r === Vu.HTML;
      },
      XML_APPLICATION: "application/xml",
      XML_TEXT: "text/xml",
      XML_XHTML_APPLICATION: "application/xhtml+xml",
      XML_SVG_IMAGE: "image/svg+xml",
    }),
    Xu = Ma({
      HTML: "http://www.w3.org/1999/xhtml",
      isHTML: function (r) {
        return r === Xu.HTML;
      },
      SVG: "http://www.w3.org/2000/svg",
      XML: "http://www.w3.org/XML/1998/namespace",
      XMLNS: "http://www.w3.org/2000/xmlns/",
    }),
    k_ = (Ee.assign = Wg),
    G_ = (Ee.find = jg),
    $_ = (Ee.freeze = Ma),
    H_ = (Ee.MIME_TYPE = Vu),
    V_ = (Ee.NAMESPACE = Xu),
    zu = Ee,
    he = zu.find,
    ui = zu.NAMESPACE;
  function Yg(r) {
    return r !== "";
  }
  function qg(r) {
    return r ? r.split(/[\t\n\f\r ]+/).filter(Yg) : [];
  }
  function Kg(r, t) {
    return r.hasOwnProperty(t) || (r[t] = !0), r;
  }
  function ju(r) {
    if (!r) return [];
    var t = qg(r);
    return Object.keys(t.reduce(Kg, {}));
  }
  function Zg(r) {
    return function (t) {
      return r && r.indexOf(t) !== -1;
    };
  }
  function ci(r, t) {
    for (var e in r)
      Object.prototype.hasOwnProperty.call(r, e) && (t[e] = r[e]);
  }
  function It(r, t) {
    var e = r.prototype;
    if (!(e instanceof t)) {
      let i = function () {};
      (i.prototype = t.prototype),
        (i = new i()),
        ci(e, i),
        (r.prototype = e = i);
    }
    e.constructor != r &&
      (typeof r != "function" && console.error("unknown Class:" + r),
      (e.constructor = r));
  }
  var Ct = {},
    Kt = (Ct.ELEMENT_NODE = 1),
    mr = (Ct.ATTRIBUTE_NODE = 2),
    Rs = (Ct.TEXT_NODE = 3),
    Wu = (Ct.CDATA_SECTION_NODE = 4),
    Yu = (Ct.ENTITY_REFERENCE_NODE = 5),
    Qg = (Ct.ENTITY_NODE = 6),
    qu = (Ct.PROCESSING_INSTRUCTION_NODE = 7),
    Ku = (Ct.COMMENT_NODE = 8),
    Zu = (Ct.DOCUMENT_NODE = 9),
    Qu = (Ct.DOCUMENT_TYPE_NODE = 10),
    Te = (Ct.DOCUMENT_FRAGMENT_NODE = 11),
    Jg = (Ct.NOTATION_NODE = 12),
    At = {},
    _t = {},
    X_ = (At.INDEX_SIZE_ERR = ((_t[1] = "Index size error"), 1)),
    z_ = (At.DOMSTRING_SIZE_ERR = ((_t[2] = "DOMString size error"), 2)),
    Mt = (At.HIERARCHY_REQUEST_ERR = ((_t[3] = "Hierarchy request error"), 3)),
    j_ = (At.WRONG_DOCUMENT_ERR = ((_t[4] = "Wrong document"), 4)),
    W_ = (At.INVALID_CHARACTER_ERR = ((_t[5] = "Invalid character"), 5)),
    Y_ = (At.NO_DATA_ALLOWED_ERR = ((_t[6] = "No data allowed"), 6)),
    q_ = (At.NO_MODIFICATION_ALLOWED_ERR =
      ((_t[7] = "No modification allowed"), 7)),
    Ju = (At.NOT_FOUND_ERR = ((_t[8] = "Not found"), 8)),
    K_ = (At.NOT_SUPPORTED_ERR = ((_t[9] = "Not supported"), 9)),
    tc = (At.INUSE_ATTRIBUTE_ERR = ((_t[10] = "Attribute in use"), 10)),
    Z_ = (At.INVALID_STATE_ERR = ((_t[11] = "Invalid state"), 11)),
    Q_ = (At.SYNTAX_ERR = ((_t[12] = "Syntax error"), 12)),
    J_ = (At.INVALID_MODIFICATION_ERR =
      ((_t[13] = "Invalid modification"), 13)),
    t0 = (At.NAMESPACE_ERR = ((_t[14] = "Invalid namespace"), 14)),
    e0 = (At.INVALID_ACCESS_ERR = ((_t[15] = "Invalid access"), 15));
  function ht(r, t) {
    if (t instanceof Error) var e = t;
    else
      (e = this),
        Error.call(this, _t[r]),
        (this.message = _t[r]),
        Error.captureStackTrace && Error.captureStackTrace(this, ht);
    return (e.code = r), t && (this.message = this.message + ": " + t), e;
  }
  (ht.prototype = Error.prototype), ci(At, ht);
  function Ae() {}
  Ae.prototype = {
    length: 0,
    item: function (r) {
      return this[r] || null;
    },
    toString: function (r, t) {
      for (var e = [], i = 0; i < this.length; i++) _r(this[i], e, r, t);
      return e.join("");
    },
    filter: function (r) {
      return Array.prototype.filter.call(this, r);
    },
    indexOf: function (r) {
      return Array.prototype.indexOf.call(this, r);
    },
  };
  function gr(r, t) {
    (this._node = r), (this._refresh = t), Pa(this);
  }
  function Pa(r) {
    var t = r._node._inc || r._node.ownerDocument._inc;
    if (r._inc != t) {
      var e = r._refresh(r._node);
      _c(r, "length", e.length), ci(e, r), (r._inc = t);
    }
  }
  (gr.prototype.item = function (r) {
    return Pa(this), this[r];
  }),
    It(gr, Ae);
  function Is() {}
  function ec(r, t) {
    for (var e = r.length; e--; ) if (r[e] === t) return e;
  }
  function rc(r, t, e, i) {
    if ((i ? (t[ec(t, i)] = e) : (t[t.length++] = e), r)) {
      e.ownerElement = r;
      var s = r.ownerDocument;
      s && (i && ac(s, r, i), t_(s, r, e));
    }
  }
  function ic(r, t, e) {
    var i = ec(t, e);
    if (i >= 0) {
      for (var s = t.length - 1; i < s; ) t[i] = t[++i];
      if (((t.length = s), r)) {
        var n = r.ownerDocument;
        n && (ac(n, r, e), (e.ownerElement = null));
      }
    } else throw new ht(Ju, new Error(r.tagName + "@" + e));
  }
  Is.prototype = {
    length: 0,
    item: Ae.prototype.item,
    getNamedItem: function (r) {
      for (var t = this.length; t--; ) {
        var e = this[t];
        if (e.nodeName == r) return e;
      }
    },
    setNamedItem: function (r) {
      var t = r.ownerElement;
      if (t && t != this._ownerElement) throw new ht(tc);
      var e = this.getNamedItem(r.nodeName);
      return rc(this._ownerElement, this, r, e), e;
    },
    setNamedItemNS: function (r) {
      var t = r.ownerElement,
        e;
      if (t && t != this._ownerElement) throw new ht(tc);
      return (
        (e = this.getNamedItemNS(r.namespaceURI, r.localName)),
        rc(this._ownerElement, this, r, e),
        e
      );
    },
    removeNamedItem: function (r) {
      var t = this.getNamedItem(r);
      return ic(this._ownerElement, this, t), t;
    },
    removeNamedItemNS: function (r, t) {
      var e = this.getNamedItemNS(r, t);
      return ic(this._ownerElement, this, e), e;
    },
    getNamedItemNS: function (r, t) {
      for (var e = this.length; e--; ) {
        var i = this[e];
        if (i.localName == t && i.namespaceURI == r) return i;
      }
      return null;
    },
  };
  function sc() {}
  sc.prototype = {
    hasFeature: function (r, t) {
      return !0;
    },
    createDocument: function (r, t, e) {
      var i = new fi();
      if (
        ((i.implementation = this),
        (i.childNodes = new Ae()),
        (i.doctype = e || null),
        e && i.appendChild(e),
        t)
      ) {
        var s = i.createElementNS(r, t);
        i.appendChild(s);
      }
      return i;
    },
    createDocumentType: function (r, t, e) {
      var i = new Ps();
      return (
        (i.name = r),
        (i.nodeName = r),
        (i.publicId = t || ""),
        (i.systemId = e || ""),
        i
      );
    },
  };
  function Z() {}
  Z.prototype = {
    firstChild: null,
    lastChild: null,
    previousSibling: null,
    nextSibling: null,
    attributes: null,
    parentNode: null,
    childNodes: null,
    ownerDocument: null,
    nodeValue: null,
    namespaceURI: null,
    prefix: null,
    localName: null,
    insertBefore: function (r, t) {
      return Cs(this, r, t);
    },
    replaceChild: function (r, t) {
      Cs(this, r, t, uc), t && this.removeChild(t);
    },
    removeChild: function (r) {
      return oc(this, r);
    },
    appendChild: function (r) {
      return this.insertBefore(r, null);
    },
    hasChildNodes: function () {
      return this.firstChild != null;
    },
    cloneNode: function (r) {
      return Ga(this.ownerDocument || this, this, r);
    },
    normalize: function () {
      for (var r = this.firstChild; r; ) {
        var t = r.nextSibling;
        t && t.nodeType == Rs && r.nodeType == Rs
          ? (this.removeChild(t), r.appendData(t.data))
          : (r.normalize(), (r = t));
      }
    },
    isSupported: function (r, t) {
      return this.ownerDocument.implementation.hasFeature(r, t);
    },
    hasAttributes: function () {
      return this.attributes.length > 0;
    },
    lookupPrefix: function (r) {
      for (var t = this; t; ) {
        var e = t._nsMap;
        if (e) {
          for (var i in e)
            if (Object.prototype.hasOwnProperty.call(e, i) && e[i] === r)
              return i;
        }
        t = t.nodeType == mr ? t.ownerDocument : t.parentNode;
      }
      return null;
    },
    lookupNamespaceURI: function (r) {
      for (var t = this; t; ) {
        var e = t._nsMap;
        if (e && Object.prototype.hasOwnProperty.call(e, r)) return e[r];
        t = t.nodeType == mr ? t.ownerDocument : t.parentNode;
      }
      return null;
    },
    isDefaultNamespace: function (r) {
      var t = this.lookupPrefix(r);
      return t == null;
    },
  };
  function nc(r) {
    return (
      (r == "<" && "&lt;") ||
      (r == ">" && "&gt;") ||
      (r == "&" && "&amp;") ||
      (r == '"' && "&quot;") ||
      "&#" + r.charCodeAt() + ";"
    );
  }
  ci(Ct, Z), ci(Ct, Z.prototype);
  function di(r, t) {
    if (t(r)) return !0;
    if ((r = r.firstChild))
      do if (di(r, t)) return !0;
      while ((r = r.nextSibling));
  }
  function fi() {
    this.ownerDocument = this;
  }
  function t_(r, t, e) {
    r && r._inc++;
    var i = e.namespaceURI;
    i === ui.XMLNS && (t._nsMap[e.prefix ? e.localName : ""] = e.value);
  }
  function ac(r, t, e, i) {
    r && r._inc++;
    var s = e.namespaceURI;
    s === ui.XMLNS && delete t._nsMap[e.prefix ? e.localName : ""];
  }
  function Da(r, t, e) {
    if (r && r._inc) {
      r._inc++;
      var i = t.childNodes;
      if (e) i[i.length++] = e;
      else {
        for (var s = t.firstChild, n = 0; s; )
          (i[n++] = s), (s = s.nextSibling);
        (i.length = n), delete i[i.length];
      }
    }
  }
  function oc(r, t) {
    var e = t.previousSibling,
      i = t.nextSibling;
    return (
      e ? (e.nextSibling = i) : (r.firstChild = i),
      i ? (i.previousSibling = e) : (r.lastChild = e),
      (t.parentNode = null),
      (t.previousSibling = null),
      (t.nextSibling = null),
      Da(r.ownerDocument, r),
      t
    );
  }
  function e_(r) {
    return (
      r &&
      (r.nodeType === Z.DOCUMENT_NODE ||
        r.nodeType === Z.DOCUMENT_FRAGMENT_NODE ||
        r.nodeType === Z.ELEMENT_NODE)
    );
  }
  function r_(r) {
    return (
      r &&
      (le(r) ||
        Na(r) ||
        Se(r) ||
        r.nodeType === Z.DOCUMENT_FRAGMENT_NODE ||
        r.nodeType === Z.COMMENT_NODE ||
        r.nodeType === Z.PROCESSING_INSTRUCTION_NODE)
    );
  }
  function Se(r) {
    return r && r.nodeType === Z.DOCUMENT_TYPE_NODE;
  }
  function le(r) {
    return r && r.nodeType === Z.ELEMENT_NODE;
  }
  function Na(r) {
    return r && r.nodeType === Z.TEXT_NODE;
  }
  function hc(r, t) {
    var e = r.childNodes || [];
    if (he(e, le) || Se(t)) return !1;
    var i = he(e, Se);
    return !(t && i && e.indexOf(i) > e.indexOf(t));
  }
  function lc(r, t) {
    var e = r.childNodes || [];
    function i(n) {
      return le(n) && n !== t;
    }
    if (he(e, i)) return !1;
    var s = he(e, Se);
    return !(t && s && e.indexOf(s) > e.indexOf(t));
  }
  function i_(r, t, e) {
    if (!e_(r)) throw new ht(Mt, "Unexpected parent node type " + r.nodeType);
    if (e && e.parentNode !== r) throw new ht(Ju, "child not in parent");
    if (!r_(t) || (Se(t) && r.nodeType !== Z.DOCUMENT_NODE))
      throw new ht(
        Mt,
        "Unexpected node type " +
          t.nodeType +
          " for parent node type " +
          r.nodeType
      );
  }
  function s_(r, t, e) {
    var i = r.childNodes || [],
      s = t.childNodes || [];
    if (t.nodeType === Z.DOCUMENT_FRAGMENT_NODE) {
      var n = s.filter(le);
      if (n.length > 1 || he(s, Na))
        throw new ht(Mt, "More than one element or text in fragment");
      if (n.length === 1 && !hc(r, e))
        throw new ht(
          Mt,
          "Element in fragment can not be inserted before doctype"
        );
    }
    if (le(t) && !hc(r, e))
      throw new ht(Mt, "Only one element can be added and only after doctype");
    if (Se(t)) {
      if (he(i, Se)) throw new ht(Mt, "Only one doctype is allowed");
      var a = he(i, le);
      if (e && i.indexOf(a) < i.indexOf(e))
        throw new ht(Mt, "Doctype can only be inserted before an element");
      if (!e && a)
        throw new ht(
          Mt,
          "Doctype can not be appended since element is present"
        );
    }
  }
  function uc(r, t, e) {
    var i = r.childNodes || [],
      s = t.childNodes || [];
    if (t.nodeType === Z.DOCUMENT_FRAGMENT_NODE) {
      var n = s.filter(le);
      if (n.length > 1 || he(s, Na))
        throw new ht(Mt, "More than one element or text in fragment");
      if (n.length === 1 && !lc(r, e))
        throw new ht(
          Mt,
          "Element in fragment can not be inserted before doctype"
        );
    }
    if (le(t) && !lc(r, e))
      throw new ht(Mt, "Only one element can be added and only after doctype");
    if (Se(t)) {
      if (
        he(i, function (h) {
          return Se(h) && h !== e;
        })
      )
        throw new ht(Mt, "Only one doctype is allowed");
      var a = he(i, le);
      if (e && i.indexOf(a) < i.indexOf(e))
        throw new ht(Mt, "Doctype can only be inserted before an element");
    }
  }
  function Cs(r, t, e, i) {
    i_(r, t, e), r.nodeType === Z.DOCUMENT_NODE && (i || s_)(r, t, e);
    var s = t.parentNode;
    if ((s && s.removeChild(t), t.nodeType === Te)) {
      var n = t.firstChild;
      if (n == null) return t;
      var a = t.lastChild;
    } else n = a = t;
    var o = e ? e.previousSibling : r.lastChild;
    (n.previousSibling = o),
      (a.nextSibling = e),
      o ? (o.nextSibling = n) : (r.firstChild = n),
      e == null ? (r.lastChild = a) : (e.previousSibling = a);
    do n.parentNode = r;
    while (n !== a && (n = n.nextSibling));
    return (
      Da(r.ownerDocument || r, r),
      t.nodeType == Te && (t.firstChild = t.lastChild = null),
      t
    );
  }
  function n_(r, t) {
    return (
      t.parentNode && t.parentNode.removeChild(t),
      (t.parentNode = r),
      (t.previousSibling = r.lastChild),
      (t.nextSibling = null),
      t.previousSibling
        ? (t.previousSibling.nextSibling = t)
        : (r.firstChild = t),
      (r.lastChild = t),
      Da(r.ownerDocument, r, t),
      t
    );
  }
  (fi.prototype = {
    nodeName: "#document",
    nodeType: Zu,
    doctype: null,
    documentElement: null,
    _inc: 1,
    insertBefore: function (r, t) {
      if (r.nodeType == Te) {
        for (var e = r.firstChild; e; ) {
          var i = e.nextSibling;
          this.insertBefore(e, t), (e = i);
        }
        return r;
      }
      return (
        Cs(this, r, t),
        (r.ownerDocument = this),
        this.documentElement === null &&
          r.nodeType === Kt &&
          (this.documentElement = r),
        r
      );
    },
    removeChild: function (r) {
      return (
        this.documentElement == r && (this.documentElement = null), oc(this, r)
      );
    },
    replaceChild: function (r, t) {
      Cs(this, r, t, uc),
        (r.ownerDocument = this),
        t && this.removeChild(t),
        le(r) && (this.documentElement = r);
    },
    importNode: function (r, t) {
      return gc(this, r, t);
    },
    getElementById: function (r) {
      var t = null;
      return (
        di(this.documentElement, function (e) {
          if (e.nodeType == Kt && e.getAttribute("id") == r) return (t = e), !0;
        }),
        t
      );
    },
    getElementsByClassName: function (r) {
      var t = ju(r);
      return new gr(this, function (e) {
        var i = [];
        return (
          t.length > 0 &&
            di(e.documentElement, function (s) {
              if (s !== e && s.nodeType === Kt) {
                var n = s.getAttribute("class");
                if (n) {
                  var a = r === n;
                  if (!a) {
                    var o = ju(n);
                    a = t.every(Zg(o));
                  }
                  a && i.push(s);
                }
              }
            }),
          i
        );
      });
    },
    createElement: function (r) {
      var t = new tr();
      (t.ownerDocument = this),
        (t.nodeName = r),
        (t.tagName = r),
        (t.localName = r),
        (t.childNodes = new Ae());
      var e = (t.attributes = new Is());
      return (e._ownerElement = t), t;
    },
    createDocumentFragment: function () {
      var r = new Ds();
      return (r.ownerDocument = this), (r.childNodes = new Ae()), r;
    },
    createTextNode: function (r) {
      var t = new Oa();
      return (t.ownerDocument = this), t.appendData(r), t;
    },
    createComment: function (r) {
      var t = new Ba();
      return (t.ownerDocument = this), t.appendData(r), t;
    },
    createCDATASection: function (r) {
      var t = new Fa();
      return (t.ownerDocument = this), t.appendData(r), t;
    },
    createProcessingInstruction: function (r, t) {
      var e = new Ua();
      return (
        (e.ownerDocument = this),
        (e.tagName = e.target = r),
        (e.nodeValue = e.data = t),
        e
      );
    },
    createAttribute: function (r) {
      var t = new Ms();
      return (
        (t.ownerDocument = this),
        (t.name = r),
        (t.nodeName = r),
        (t.localName = r),
        (t.specified = !0),
        t
      );
    },
    createEntityReference: function (r) {
      var t = new La();
      return (t.ownerDocument = this), (t.nodeName = r), t;
    },
    createElementNS: function (r, t) {
      var e = new tr(),
        i = t.split(":"),
        s = (e.attributes = new Is());
      return (
        (e.childNodes = new Ae()),
        (e.ownerDocument = this),
        (e.nodeName = t),
        (e.tagName = t),
        (e.namespaceURI = r),
        i.length == 2
          ? ((e.prefix = i[0]), (e.localName = i[1]))
          : (e.localName = t),
        (s._ownerElement = e),
        e
      );
    },
    createAttributeNS: function (r, t) {
      var e = new Ms(),
        i = t.split(":");
      return (
        (e.ownerDocument = this),
        (e.nodeName = t),
        (e.name = t),
        (e.namespaceURI = r),
        (e.specified = !0),
        i.length == 2
          ? ((e.prefix = i[0]), (e.localName = i[1]))
          : (e.localName = t),
        e
      );
    },
  }),
    It(fi, Z);
  function tr() {
    this._nsMap = {};
  }
  (tr.prototype = {
    nodeType: Kt,
    hasAttribute: function (r) {
      return this.getAttributeNode(r) != null;
    },
    getAttribute: function (r) {
      var t = this.getAttributeNode(r);
      return (t && t.value) || "";
    },
    getAttributeNode: function (r) {
      return this.attributes.getNamedItem(r);
    },
    setAttribute: function (r, t) {
      var e = this.ownerDocument.createAttribute(r);
      (e.value = e.nodeValue = "" + t), this.setAttributeNode(e);
    },
    removeAttribute: function (r) {
      var t = this.getAttributeNode(r);
      t && this.removeAttributeNode(t);
    },
    appendChild: function (r) {
      return r.nodeType === Te ? this.insertBefore(r, null) : n_(this, r);
    },
    setAttributeNode: function (r) {
      return this.attributes.setNamedItem(r);
    },
    setAttributeNodeNS: function (r) {
      return this.attributes.setNamedItemNS(r);
    },
    removeAttributeNode: function (r) {
      return this.attributes.removeNamedItem(r.nodeName);
    },
    removeAttributeNS: function (r, t) {
      var e = this.getAttributeNodeNS(r, t);
      e && this.removeAttributeNode(e);
    },
    hasAttributeNS: function (r, t) {
      return this.getAttributeNodeNS(r, t) != null;
    },
    getAttributeNS: function (r, t) {
      var e = this.getAttributeNodeNS(r, t);
      return (e && e.value) || "";
    },
    setAttributeNS: function (r, t, e) {
      var i = this.ownerDocument.createAttributeNS(r, t);
      (i.value = i.nodeValue = "" + e), this.setAttributeNode(i);
    },
    getAttributeNodeNS: function (r, t) {
      return this.attributes.getNamedItemNS(r, t);
    },
    getElementsByTagName: function (r) {
      return new gr(this, function (t) {
        var e = [];
        return (
          di(t, function (i) {
            i !== t &&
              i.nodeType == Kt &&
              (r === "*" || i.tagName == r) &&
              e.push(i);
          }),
          e
        );
      });
    },
    getElementsByTagNameNS: function (r, t) {
      return new gr(this, function (e) {
        var i = [];
        return (
          di(e, function (s) {
            s !== e &&
              s.nodeType === Kt &&
              (r === "*" || s.namespaceURI === r) &&
              (t === "*" || s.localName == t) &&
              i.push(s);
          }),
          i
        );
      });
    },
  }),
    (fi.prototype.getElementsByTagName = tr.prototype.getElementsByTagName),
    (fi.prototype.getElementsByTagNameNS = tr.prototype.getElementsByTagNameNS),
    It(tr, Z);
  function Ms() {}
  (Ms.prototype.nodeType = mr), It(Ms, Z);
  function pi() {}
  (pi.prototype = {
    data: "",
    substringData: function (r, t) {
      return this.data.substring(r, r + t);
    },
    appendData: function (r) {
      (r = this.data + r),
        (this.nodeValue = this.data = r),
        (this.length = r.length);
    },
    insertData: function (r, t) {
      this.replaceData(r, 0, t);
    },
    appendChild: function (r) {
      throw new Error(_t[Mt]);
    },
    deleteData: function (r, t) {
      this.replaceData(r, t, "");
    },
    replaceData: function (r, t, e) {
      var i = this.data.substring(0, r),
        s = this.data.substring(r + t);
      (e = i + e + s),
        (this.nodeValue = this.data = e),
        (this.length = e.length);
    },
  }),
    It(pi, Z);
  function Oa() {}
  (Oa.prototype = {
    nodeName: "#text",
    nodeType: Rs,
    splitText: function (r) {
      var t = this.data,
        e = t.substring(r);
      (t = t.substring(0, r)),
        (this.data = this.nodeValue = t),
        (this.length = t.length);
      var i = this.ownerDocument.createTextNode(e);
      return (
        this.parentNode && this.parentNode.insertBefore(i, this.nextSibling), i
      );
    },
  }),
    It(Oa, pi);
  function Ba() {}
  (Ba.prototype = { nodeName: "#comment", nodeType: Ku }), It(Ba, pi);
  function Fa() {}
  (Fa.prototype = { nodeName: "#cdata-section", nodeType: Wu }), It(Fa, pi);
  function Ps() {}
  (Ps.prototype.nodeType = Qu), It(Ps, Z);
  function cc() {}
  (cc.prototype.nodeType = Jg), It(cc, Z);
  function dc() {}
  (dc.prototype.nodeType = Qg), It(dc, Z);
  function La() {}
  (La.prototype.nodeType = Yu), It(La, Z);
  function Ds() {}
  (Ds.prototype.nodeName = "#document-fragment"),
    (Ds.prototype.nodeType = Te),
    It(Ds, Z);
  function Ua() {}
  (Ua.prototype.nodeType = qu), It(Ua, Z);
  function fc() {}
  (fc.prototype.serializeToString = function (r, t, e) {
    return pc.call(r, t, e);
  }),
    (Z.prototype.toString = pc);
  function pc(r, t) {
    var e = [],
      i = (this.nodeType == 9 && this.documentElement) || this,
      s = i.prefix,
      n = i.namespaceURI;
    if (n && s == null) {
      var s = i.lookupPrefix(n);
      if (s == null) var a = [{ namespace: n, prefix: null }];
    }
    return _r(this, e, r, t, a), e.join("");
  }
  function mc(r, t, e) {
    var i = r.prefix || "",
      s = r.namespaceURI;
    if (!s || (i === "xml" && s === ui.XML) || s === ui.XMLNS) return !1;
    for (var n = e.length; n--; ) {
      var a = e[n];
      if (a.prefix === i) return a.namespace !== s;
    }
    return !0;
  }
  function ka(r, t, e) {
    r.push(" ", t, '="', e.replace(/[<>&"\t\n\r]/g, nc), '"');
  }
  function _r(r, t, e, i, s) {
    if ((s || (s = []), i))
      if (((r = i(r)), r)) {
        if (typeof r == "string") {
          t.push(r);
          return;
        }
      } else return;
    switch (r.nodeType) {
      case Kt:
        var n = r.attributes,
          a = n.length,
          x = r.firstChild,
          o = r.tagName;
        e = ui.isHTML(r.namespaceURI) || e;
        var h = o;
        if (!e && !r.prefix && r.namespaceURI) {
          for (var l, u = 0; u < n.length; u++)
            if (n.item(u).name === "xmlns") {
              l = n.item(u).value;
              break;
            }
          if (!l)
            for (var c = s.length - 1; c >= 0; c--) {
              var d = s[c];
              if (d.prefix === "" && d.namespace === r.namespaceURI) {
                l = d.namespace;
                break;
              }
            }
          if (l !== r.namespaceURI)
            for (var c = s.length - 1; c >= 0; c--) {
              var d = s[c];
              if (d.namespace === r.namespaceURI) {
                d.prefix && (h = d.prefix + ":" + o);
                break;
              }
            }
        }
        t.push("<", h);
        for (var f = 0; f < a; f++) {
          var p = n.item(f);
          p.prefix == "xmlns"
            ? s.push({ prefix: p.localName, namespace: p.value })
            : p.nodeName == "xmlns" &&
              s.push({ prefix: "", namespace: p.value });
        }
        for (var f = 0; f < a; f++) {
          var p = n.item(f);
          if (mc(p, e, s)) {
            var m = p.prefix || "",
              g = p.namespaceURI;
            ka(t, m ? "xmlns:" + m : "xmlns", g),
              s.push({ prefix: m, namespace: g });
          }
          _r(p, t, e, i, s);
        }
        if (o === h && mc(r, e, s)) {
          var m = r.prefix || "",
            g = r.namespaceURI;
          ka(t, m ? "xmlns:" + m : "xmlns", g),
            s.push({ prefix: m, namespace: g });
        }
        if (x || (e && !/^(?:meta|link|img|br|hr|input)$/i.test(o))) {
          if ((t.push(">"), e && /^script$/i.test(o)))
            for (; x; )
              x.data ? t.push(x.data) : _r(x, t, e, i, s.slice()),
                (x = x.nextSibling);
          else for (; x; ) _r(x, t, e, i, s.slice()), (x = x.nextSibling);
          t.push("</", h, ">");
        } else t.push("/>");
        return;
      case Zu:
      case Te:
        for (var x = r.firstChild; x; )
          _r(x, t, e, i, s.slice()), (x = x.nextSibling);
        return;
      case mr:
        return ka(t, r.name, r.value);
      case Rs:
        return t.push(r.data.replace(/[<&>]/g, nc));
      case Wu:
        return t.push("<![CDATA[", r.data, "]]>");
      case Ku:
        return t.push("<!--", r.data, "-->");
      case Qu:
        var b = r.publicId,
          _ = r.systemId;
        if ((t.push("<!DOCTYPE ", r.name), b))
          t.push(" PUBLIC ", b), _ && _ != "." && t.push(" ", _), t.push(">");
        else if (_ && _ != ".") t.push(" SYSTEM ", _, ">");
        else {
          var y = r.internalSubset;
          y && t.push(" [", y, "]"), t.push(">");
        }
        return;
      case qu:
        return t.push("<?", r.target, " ", r.data, "?>");
      case Yu:
        return t.push("&", r.nodeName, ";");
      default:
        t.push("??", r.nodeName);
    }
  }
  function gc(r, t, e) {
    var i;
    switch (t.nodeType) {
      case Kt:
        (i = t.cloneNode(!1)), (i.ownerDocument = r);
      case Te:
        break;
      case mr:
        e = !0;
        break;
    }
    if (
      (i || (i = t.cloneNode(!1)),
      (i.ownerDocument = r),
      (i.parentNode = null),
      e)
    )
      for (var s = t.firstChild; s; )
        i.appendChild(gc(r, s, e)), (s = s.nextSibling);
    return i;
  }
  function Ga(r, t, e) {
    var i = new t.constructor();
    for (var s in t)
      if (Object.prototype.hasOwnProperty.call(t, s)) {
        var n = t[s];
        typeof n != "object" && n != i[s] && (i[s] = n);
      }
    switch (
      (t.childNodes && (i.childNodes = new Ae()),
      (i.ownerDocument = r),
      i.nodeType)
    ) {
      case Kt:
        var a = t.attributes,
          o = (i.attributes = new Is()),
          h = a.length;
        o._ownerElement = i;
        for (var l = 0; l < h; l++) i.setAttributeNode(Ga(r, a.item(l), !0));
        break;
      case mr:
        e = !0;
    }
    if (e)
      for (var u = t.firstChild; u; )
        i.appendChild(Ga(r, u, e)), (u = u.nextSibling);
    return i;
  }
  function _c(r, t, e) {
    r[t] = e;
  }
  try {
    if (Object.defineProperty) {
      let r = function (t) {
        switch (t.nodeType) {
          case Kt:
          case Te:
            var e = [];
            for (t = t.firstChild; t; )
              t.nodeType !== 7 && t.nodeType !== 8 && e.push(r(t)),
                (t = t.nextSibling);
            return e.join("");
          default:
            return t.nodeValue;
        }
      };
      Object.defineProperty(gr.prototype, "length", {
        get: function () {
          return Pa(this), this.$$length;
        },
      }),
        Object.defineProperty(Z.prototype, "textContent", {
          get: function () {
            return r(this);
          },
          set: function (t) {
            switch (this.nodeType) {
              case Kt:
              case Te:
                for (; this.firstChild; ) this.removeChild(this.firstChild);
                (t || String(t)) &&
                  this.appendChild(this.ownerDocument.createTextNode(t));
                break;
              default:
                (this.data = t), (this.value = t), (this.nodeValue = t);
            }
          },
        }),
        (_c = function (t, e, i) {
          t["$$" + e] = i;
        });
    }
  } catch (r) {}
  var r0 = (be.DocumentType = Ps),
    i0 = (be.DOMException = ht),
    s0 = (be.DOMImplementation = sc),
    n0 = (be.Element = tr),
    a0 = (be.Node = Z),
    o0 = (be.NodeList = Ae),
    h0 = (be.XMLSerializer = fc),
    Ns = {},
    $a = {};
  (function (r) {
    var t = Ee.freeze;
    (r.XML_ENTITIES = t({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' })),
      (r.HTML_ENTITIES = t({
        lt: "<",
        gt: ">",
        amp: "&",
        quot: '"',
        apos: "'",
        Agrave: "\xC0",
        Aacute: "\xC1",
        Acirc: "\xC2",
        Atilde: "\xC3",
        Auml: "\xC4",
        Aring: "\xC5",
        AElig: "\xC6",
        Ccedil: "\xC7",
        Egrave: "\xC8",
        Eacute: "\xC9",
        Ecirc: "\xCA",
        Euml: "\xCB",
        Igrave: "\xCC",
        Iacute: "\xCD",
        Icirc: "\xCE",
        Iuml: "\xCF",
        ETH: "\xD0",
        Ntilde: "\xD1",
        Ograve: "\xD2",
        Oacute: "\xD3",
        Ocirc: "\xD4",
        Otilde: "\xD5",
        Ouml: "\xD6",
        Oslash: "\xD8",
        Ugrave: "\xD9",
        Uacute: "\xDA",
        Ucirc: "\xDB",
        Uuml: "\xDC",
        Yacute: "\xDD",
        THORN: "\xDE",
        szlig: "\xDF",
        agrave: "\xE0",
        aacute: "\xE1",
        acirc: "\xE2",
        atilde: "\xE3",
        auml: "\xE4",
        aring: "\xE5",
        aelig: "\xE6",
        ccedil: "\xE7",
        egrave: "\xE8",
        eacute: "\xE9",
        ecirc: "\xEA",
        euml: "\xEB",
        igrave: "\xEC",
        iacute: "\xED",
        icirc: "\xEE",
        iuml: "\xEF",
        eth: "\xF0",
        ntilde: "\xF1",
        ograve: "\xF2",
        oacute: "\xF3",
        ocirc: "\xF4",
        otilde: "\xF5",
        ouml: "\xF6",
        oslash: "\xF8",
        ugrave: "\xF9",
        uacute: "\xFA",
        ucirc: "\xFB",
        uuml: "\xFC",
        yacute: "\xFD",
        thorn: "\xFE",
        yuml: "\xFF",
        nbsp: "\xA0",
        iexcl: "\xA1",
        cent: "\xA2",
        pound: "\xA3",
        curren: "\xA4",
        yen: "\xA5",
        brvbar: "\xA6",
        sect: "\xA7",
        uml: "\xA8",
        copy: "\xA9",
        ordf: "\xAA",
        laquo: "\xAB",
        not: "\xAC",
        shy: "\xAD\xAD",
        reg: "\xAE",
        macr: "\xAF",
        deg: "\xB0",
        plusmn: "\xB1",
        sup2: "\xB2",
        sup3: "\xB3",
        acute: "\xB4",
        micro: "\xB5",
        para: "\xB6",
        middot: "\xB7",
        cedil: "\xB8",
        sup1: "\xB9",
        ordm: "\xBA",
        raquo: "\xBB",
        frac14: "\xBC",
        frac12: "\xBD",
        frac34: "\xBE",
        iquest: "\xBF",
        times: "\xD7",
        divide: "\xF7",
        forall: "\u2200",
        part: "\u2202",
        exist: "\u2203",
        empty: "\u2205",
        nabla: "\u2207",
        isin: "\u2208",
        notin: "\u2209",
        ni: "\u220B",
        prod: "\u220F",
        sum: "\u2211",
        minus: "\u2212",
        lowast: "\u2217",
        radic: "\u221A",
        prop: "\u221D",
        infin: "\u221E",
        ang: "\u2220",
        and: "\u2227",
        or: "\u2228",
        cap: "\u2229",
        cup: "\u222A",
        int: "\u222B",
        there4: "\u2234",
        sim: "\u223C",
        cong: "\u2245",
        asymp: "\u2248",
        ne: "\u2260",
        equiv: "\u2261",
        le: "\u2264",
        ge: "\u2265",
        sub: "\u2282",
        sup: "\u2283",
        nsub: "\u2284",
        sube: "\u2286",
        supe: "\u2287",
        oplus: "\u2295",
        otimes: "\u2297",
        perp: "\u22A5",
        sdot: "\u22C5",
        Alpha: "\u0391",
        Beta: "\u0392",
        Gamma: "\u0393",
        Delta: "\u0394",
        Epsilon: "\u0395",
        Zeta: "\u0396",
        Eta: "\u0397",
        Theta: "\u0398",
        Iota: "\u0399",
        Kappa: "\u039A",
        Lambda: "\u039B",
        Mu: "\u039C",
        Nu: "\u039D",
        Xi: "\u039E",
        Omicron: "\u039F",
        Pi: "\u03A0",
        Rho: "\u03A1",
        Sigma: "\u03A3",
        Tau: "\u03A4",
        Upsilon: "\u03A5",
        Phi: "\u03A6",
        Chi: "\u03A7",
        Psi: "\u03A8",
        Omega: "\u03A9",
        alpha: "\u03B1",
        beta: "\u03B2",
        gamma: "\u03B3",
        delta: "\u03B4",
        epsilon: "\u03B5",
        zeta: "\u03B6",
        eta: "\u03B7",
        theta: "\u03B8",
        iota: "\u03B9",
        kappa: "\u03BA",
        lambda: "\u03BB",
        mu: "\u03BC",
        nu: "\u03BD",
        xi: "\u03BE",
        omicron: "\u03BF",
        pi: "\u03C0",
        rho: "\u03C1",
        sigmaf: "\u03C2",
        sigma: "\u03C3",
        tau: "\u03C4",
        upsilon: "\u03C5",
        phi: "\u03C6",
        chi: "\u03C7",
        psi: "\u03C8",
        omega: "\u03C9",
        thetasym: "\u03D1",
        upsih: "\u03D2",
        piv: "\u03D6",
        OElig: "\u0152",
        oelig: "\u0153",
        Scaron: "\u0160",
        scaron: "\u0161",
        Yuml: "\u0178",
        fnof: "\u0192",
        circ: "\u02C6",
        tilde: "\u02DC",
        ensp: "\u2002",
        emsp: "\u2003",
        thinsp: "\u2009",
        zwnj: "\u200C",
        zwj: "\u200D",
        lrm: "\u200E",
        rlm: "\u200F",
        ndash: "\u2013",
        mdash: "\u2014",
        lsquo: "\u2018",
        rsquo: "\u2019",
        sbquo: "\u201A",
        ldquo: "\u201C",
        rdquo: "\u201D",
        bdquo: "\u201E",
        dagger: "\u2020",
        Dagger: "\u2021",
        bull: "\u2022",
        hellip: "\u2026",
        permil: "\u2030",
        prime: "\u2032",
        Prime: "\u2033",
        lsaquo: "\u2039",
        rsaquo: "\u203A",
        oline: "\u203E",
        euro: "\u20AC",
        trade: "\u2122",
        larr: "\u2190",
        uarr: "\u2191",
        rarr: "\u2192",
        darr: "\u2193",
        harr: "\u2194",
        crarr: "\u21B5",
        lceil: "\u2308",
        rceil: "\u2309",
        lfloor: "\u230A",
        rfloor: "\u230B",
        loz: "\u25CA",
        spades: "\u2660",
        clubs: "\u2663",
        hearts: "\u2665",
        diams: "\u2666",
      })),
      (r.entityMap = r.HTML_ENTITIES);
  })($a);
  var l0 = Ge($a),
    Ha = {},
    mi = Ee.NAMESPACE,
    Va =
      /[A-Z_a-z\xC0-\xD6\xD8-\xF6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/,
    vc = new RegExp(
      "[\\-\\.0-9" +
        Va.source.slice(1, -1) +
        "\\u00B7\\u0300-\\u036F\\u203F-\\u2040]"
    ),
    xc = new RegExp(
      "^" + Va.source + vc.source + "*(?::" + Va.source + vc.source + "*)?$"
    ),
    gi = 0,
    Ue = 1,
    vr = 2,
    _i = 3,
    xr = 4,
    yr = 5,
    vi = 6,
    Os = 7;
  function br(r, t) {
    (this.message = r),
      (this.locator = t),
      Error.captureStackTrace && Error.captureStackTrace(this, br);
  }
  (br.prototype = new Error()), (br.prototype.name = br.name);
  function yc() {}
  yc.prototype = {
    parse: function (r, t, e) {
      var i = this.domBuilder;
      i.startDocument(),
        Tc(t, (t = {})),
        a_(r, t, e, i, this.errorHandler),
        i.endDocument();
    },
  };
  function a_(r, t, e, i, s) {
    function n(k) {
      if (k > 65535) {
        k -= 65536;
        var L = 55296 + (k >> 10),
          W = 56320 + (k & 1023);
        return String.fromCharCode(L, W);
      } else return String.fromCharCode(k);
    }
    function a(k) {
      var L = k.slice(1, -1);
      return Object.hasOwnProperty.call(e, L)
        ? e[L]
        : L.charAt(0) === "#"
        ? n(parseInt(L.substr(1).replace("x", "0x")))
        : (s.error("entity not found:" + k), k);
    }
    function o(k) {
      if (k > m) {
        var L = r.substring(m, k).replace(/&#?\w+;/g, a);
        d && h(m), i.characters(L, 0, k - m), (m = k);
      }
    }
    function h(k, L) {
      for (; k >= u && (L = c.exec(r)); )
        (l = L.index), (u = l + L[0].length), d.lineNumber++;
      d.columnNumber = k - l + 1;
    }
    for (
      var l = 0,
        u = 0,
        c = /.*(?:\r\n?|\n)|.*$/g,
        d = i.locator,
        f = [{ currentNSMap: t }],
        p = {},
        m = 0;
      ;

    ) {
      try {
        var g = r.indexOf("<", m);
        if (g < 0) {
          if (!r.substr(m).match(/^\s*$/)) {
            var x = i.doc,
              b = x.createTextNode(r.substr(m));
            x.appendChild(b), (i.currentElement = b);
          }
          return;
        }
        switch ((g > m && o(g), r.charAt(g + 1))) {
          case "/":
            var z = r.indexOf(">", g + 3),
              _ = r.substring(g + 2, z).replace(/[ \t\n\r]+$/g, ""),
              y = f.pop();
            z < 0
              ? ((_ = r.substring(g + 2).replace(/[\s<].*/, "")),
                s.error("end tag name: " + _ + " is not complete:" + y.tagName),
                (z = g + 1 + _.length))
              : _.match(/\s</) &&
                ((_ = _.replace(/[\s<].*/, "")),
                s.error("end tag name: " + _ + " maybe not complete"),
                (z = g + 1 + _.length));
            var T = y.localNSMap,
              C = y.tagName == _,
              R =
                C || (y.tagName && y.tagName.toLowerCase() == _.toLowerCase());
            if (R) {
              if ((i.endElement(y.uri, y.localName, _), T))
                for (var S in T)
                  Object.prototype.hasOwnProperty.call(T, S) &&
                    i.endPrefixMapping(S);
              C ||
                s.fatalError(
                  "end tag name: " +
                    _ +
                    " is not match the current start tagName:" +
                    y.tagName
                );
            } else f.push(y);
            z++;
            break;
          case "?":
            d && h(g), (z = c_(r, g, i));
            break;
          case "!":
            d && h(g), (z = u_(r, g, i, s));
            break;
          default:
            d && h(g);
            var I = new Ac(),
              $ = f[f.length - 1].currentNSMap,
              z = o_(r, g, I, $, a, s),
              F = I.length;
            if (
              (!I.closed &&
                l_(r, z, I.tagName, p) &&
                ((I.closed = !0),
                e.nbsp || s.warning("unclosed xml attribute")),
              d && F)
            ) {
              for (var E = bc(d, {}), w = 0; w < F; w++) {
                var V = I[w];
                h(V.offset), (V.locator = bc(d, {}));
              }
              (i.locator = E), Ec(I, i, $) && f.push(I), (i.locator = d);
            } else Ec(I, i, $) && f.push(I);
            mi.isHTML(I.uri) && !I.closed
              ? (z = h_(r, z, I.tagName, a, i))
              : z++;
        }
      } catch (k) {
        if (k instanceof br) throw k;
        s.error("element parse error: " + k), (z = -1);
      }
      z > m ? (m = z) : o(Math.max(g, m) + 1);
    }
  }
  function bc(r, t) {
    return (t.lineNumber = r.lineNumber), (t.columnNumber = r.columnNumber), t;
  }
  function o_(r, t, e, i, s, n) {
    function a(f, p, m) {
      e.attributeNames.hasOwnProperty(f) &&
        n.fatalError("Attribute " + f + " redefined"),
        e.addValue(f, p.replace(/[\t\n\r]/g, " ").replace(/&#?\w+;/g, s), m);
    }
    for (var o, h, l = ++t, u = gi; ; ) {
      var c = r.charAt(l);
      switch (c) {
        case "=":
          if (u === Ue) (o = r.slice(t, l)), (u = _i);
          else if (u === vr) u = _i;
          else throw new Error("attribute equal must after attrName");
          break;
        case "'":
        case '"':
          if (u === _i || u === Ue)
            if (
              (u === Ue &&
                (n.warning('attribute value must after "="'),
                (o = r.slice(t, l))),
              (t = l + 1),
              (l = r.indexOf(c, t)),
              l > 0)
            )
              (h = r.slice(t, l)), a(o, h, t - 1), (u = yr);
            else throw new Error("attribute value no end '" + c + "' match");
          else if (u == xr)
            (h = r.slice(t, l)),
              a(o, h, t),
              n.warning('attribute "' + o + '" missed start quot(' + c + ")!!"),
              (t = l + 1),
              (u = yr);
          else throw new Error('attribute value must after "="');
          break;
        case "/":
          switch (u) {
            case gi:
              e.setTagName(r.slice(t, l));
            case yr:
            case vi:
            case Os:
              (u = Os), (e.closed = !0);
            case xr:
            case Ue:
            case vr:
              break;
            default:
              throw new Error("attribute invalid close char('/')");
          }
          break;
        case "":
          return (
            n.error("unexpected end of input"),
            u == gi && e.setTagName(r.slice(t, l)),
            l
          );
        case ">":
          switch (u) {
            case gi:
              e.setTagName(r.slice(t, l));
            case yr:
            case vi:
            case Os:
              break;
            case xr:
            case Ue:
              (h = r.slice(t, l)),
                h.slice(-1) === "/" && ((e.closed = !0), (h = h.slice(0, -1)));
            case vr:
              u === vr && (h = o),
                u == xr
                  ? (n.warning('attribute "' + h + '" missed quot(")!'),
                    a(o, h, t))
                  : ((!mi.isHTML(i[""]) ||
                      !h.match(/^(?:disabled|checked|selected)$/i)) &&
                      n.warning(
                        'attribute "' +
                          h +
                          '" missed value!! "' +
                          h +
                          '" instead!!'
                      ),
                    a(h, h, t));
              break;
            case _i:
              throw new Error("attribute value missed!!");
          }
          return l;
        case "\x80":
          c = " ";
        default:
          if (c <= " ")
            switch (u) {
              case gi:
                e.setTagName(r.slice(t, l)), (u = vi);
                break;
              case Ue:
                (o = r.slice(t, l)), (u = vr);
                break;
              case xr:
                var h = r.slice(t, l);
                n.warning('attribute "' + h + '" missed quot(")!!'), a(o, h, t);
              case yr:
                u = vi;
                break;
            }
          else
            switch (u) {
              case vr:
                var d = e.tagName;
                (!mi.isHTML(i[""]) ||
                  !o.match(/^(?:disabled|checked|selected)$/i)) &&
                  n.warning(
                    'attribute "' +
                      o +
                      '" missed value!! "' +
                      o +
                      '" instead2!!'
                  ),
                  a(o, o, t),
                  (t = l),
                  (u = Ue);
                break;
              case yr:
                n.warning('attribute space is required"' + o + '"!!');
              case vi:
                (u = Ue), (t = l);
                break;
              case _i:
                (u = xr), (t = l);
                break;
              case Os:
                throw new Error(
                  "elements closed character '/' and '>' must be connected to"
                );
            }
      }
      l++;
    }
  }
  function Ec(r, t, e) {
    for (var i = r.tagName, s = null, c = r.length; c--; ) {
      var n = r[c],
        a = n.qName,
        o = n.value,
        d = a.indexOf(":");
      if (d > 0)
        var h = (n.prefix = a.slice(0, d)),
          l = a.slice(d + 1),
          u = h === "xmlns" && l;
      else (l = a), (h = null), (u = a === "xmlns" && "");
      (n.localName = l),
        u !== !1 &&
          (s == null && ((s = {}), Tc(e, (e = {}))),
          (e[u] = s[u] = o),
          (n.uri = mi.XMLNS),
          t.startPrefixMapping(u, o));
    }
    for (var c = r.length; c--; ) {
      n = r[c];
      var h = n.prefix;
      h &&
        (h === "xml" && (n.uri = mi.XML),
        h !== "xmlns" && (n.uri = e[h || ""]));
    }
    var d = i.indexOf(":");
    d > 0
      ? ((h = r.prefix = i.slice(0, d)), (l = r.localName = i.slice(d + 1)))
      : ((h = null), (l = r.localName = i));
    var f = (r.uri = e[h || ""]);
    if ((t.startElement(f, l, i, r), r.closed)) {
      if ((t.endElement(f, l, i), s))
        for (h in s)
          Object.prototype.hasOwnProperty.call(s, h) && t.endPrefixMapping(h);
    } else return (r.currentNSMap = e), (r.localNSMap = s), !0;
  }
  function h_(r, t, e, i, s) {
    if (/^(?:script|textarea)$/i.test(e)) {
      var n = r.indexOf("</" + e + ">", t),
        a = r.substring(t + 1, n);
      if (/[&<]/.test(a))
        return /^script$/i.test(e)
          ? (s.characters(a, 0, a.length), n)
          : ((a = a.replace(/&#?\w+;/g, i)), s.characters(a, 0, a.length), n);
    }
    return t + 1;
  }
  function l_(r, t, e, i) {
    var s = i[e];
    return (
      s == null &&
        ((s = r.lastIndexOf("</" + e + ">")),
        s < t && (s = r.lastIndexOf("</" + e)),
        (i[e] = s)),
      s < t
    );
  }
  function Tc(r, t) {
    for (var e in r)
      Object.prototype.hasOwnProperty.call(r, e) && (t[e] = r[e]);
  }
  function u_(r, t, e, i) {
    var s = r.charAt(t + 2);
    switch (s) {
      case "-":
        if (r.charAt(t + 3) === "-") {
          var n = r.indexOf("-->", t + 4);
          return n > t
            ? (e.comment(r, t + 4, n - t - 4), n + 3)
            : (i.error("Unclosed comment"), -1);
        } else return -1;
      default:
        if (r.substr(t + 3, 6) == "CDATA[") {
          var n = r.indexOf("]]>", t + 9);
          return (
            e.startCDATA(),
            e.characters(r, t + 9, n - t - 9),
            e.endCDATA(),
            n + 3
          );
        }
        var a = d_(r, t),
          o = a.length;
        if (o > 1 && /!doctype/i.test(a[0][0])) {
          var h = a[1][0],
            l = !1,
            u = !1;
          o > 3 &&
            (/^public$/i.test(a[2][0])
              ? ((l = a[3][0]), (u = o > 4 && a[4][0]))
              : /^system$/i.test(a[2][0]) && (u = a[3][0]));
          var c = a[o - 1];
          return e.startDTD(h, l, u), e.endDTD(), c.index + c[0].length;
        }
    }
    return -1;
  }
  function c_(r, t, e) {
    var i = r.indexOf("?>", t);
    if (i) {
      var s = r.substring(t, i).match(/^<\?(\S*)\s*([\s\S]*?)\s*$/);
      if (s) {
        var n = s[0].length;
        return e.processingInstruction(s[1], s[2]), i + 2;
      } else return -1;
    }
    return -1;
  }
  function Ac() {
    this.attributeNames = {};
  }
  Ac.prototype = {
    setTagName: function (r) {
      if (!xc.test(r)) throw new Error("invalid tagName:" + r);
      this.tagName = r;
    },
    addValue: function (r, t, e) {
      if (!xc.test(r)) throw new Error("invalid attribute:" + r);
      (this.attributeNames[r] = this.length),
        (this[this.length++] = { qName: r, value: t, offset: e });
    },
    length: 0,
    getLocalName: function (r) {
      return this[r].localName;
    },
    getLocator: function (r) {
      return this[r].locator;
    },
    getQName: function (r) {
      return this[r].qName;
    },
    getURI: function (r) {
      return this[r].uri;
    },
    getValue: function (r) {
      return this[r].value;
    },
  };
  function d_(r, t) {
    var e,
      i = [],
      s = /'[^']+'|"[^"]+"|[^\s<>\/=]+=?|(\/?\s*>|<)/g;
    for (s.lastIndex = t, s.exec(r); (e = s.exec(r)); )
      if ((i.push(e), e[1])) return i;
  }
  var u0 = (Ha.XMLReader = yc),
    c0 = (Ha.ParseError = br),
    f_ = Ee,
    p_ = be,
    Sc = $a,
    wc = Ha,
    m_ = p_.DOMImplementation,
    Rc = f_.NAMESPACE,
    g_ = wc.ParseError,
    __ = wc.XMLReader;
  function Ic(r) {
    return r
      .replace(
        /\r[\n\u0085]/g,
        `
`
      )
      .replace(
        /[\r\u0085\u2028]/g,
        `
`
      );
  }
  function Cc(r) {
    this.options = r || { locator: {} };
  }
  Cc.prototype.parseFromString = function (r, t) {
    var e = this.options,
      i = new __(),
      s = e.domBuilder || new xi(),
      n = e.errorHandler,
      a = e.locator,
      o = e.xmlns || {},
      h = /\/x?html?$/.test(t),
      l = h ? Sc.HTML_ENTITIES : Sc.XML_ENTITIES;
    a && s.setDocumentLocator(a),
      (i.errorHandler = v_(n, s, a)),
      (i.domBuilder = e.domBuilder || s),
      h && (o[""] = Rc.HTML),
      (o.xml = o.xml || Rc.XML);
    var u = e.normalizeLineEndings || Ic;
    return (
      r && typeof r == "string"
        ? i.parse(u(r), o, l)
        : i.errorHandler.error("invalid doc source"),
      s.doc
    );
  };
  function v_(r, t, e) {
    if (!r) {
      if (t instanceof xi) return t;
      r = t;
    }
    var i = {},
      s = r instanceof Function;
    e = e || {};
    function n(a) {
      var o = r[a];
      !o &&
        s &&
        (o =
          r.length == 2
            ? function (h) {
                r(a, h);
              }
            : r),
        (i[a] =
          (o &&
            function (h) {
              o("[xmldom " + a + "]	" + h + Xa(e));
            }) ||
          function () {});
    }
    return n("warning"), n("error"), n("fatalError"), i;
  }
  function xi() {
    this.cdata = !1;
  }
  function Er(r, t) {
    (t.lineNumber = r.lineNumber), (t.columnNumber = r.columnNumber);
  }
  xi.prototype = {
    startDocument: function () {
      (this.doc = new m_().createDocument(null, null, null)),
        this.locator && (this.doc.documentURI = this.locator.systemId);
    },
    startElement: function (r, t, e, i) {
      var s = this.doc,
        n = s.createElementNS(r, e || t),
        a = i.length;
      Bs(this, n),
        (this.currentElement = n),
        this.locator && Er(this.locator, n);
      for (var o = 0; o < a; o++) {
        var r = i.getURI(o),
          h = i.getValue(o),
          e = i.getQName(o),
          l = s.createAttributeNS(r, e);
        this.locator && Er(i.getLocator(o), l),
          (l.value = l.nodeValue = h),
          n.setAttributeNode(l);
      }
    },
    endElement: function (r, t, e) {
      var i = this.currentElement,
        s = i.tagName;
      this.currentElement = i.parentNode;
    },
    startPrefixMapping: function (r, t) {},
    endPrefixMapping: function (r) {},
    processingInstruction: function (r, t) {
      var e = this.doc.createProcessingInstruction(r, t);
      this.locator && Er(this.locator, e), Bs(this, e);
    },
    ignorableWhitespace: function (r, t, e) {},
    characters: function (r, t, e) {
      if (((r = Mc.apply(this, arguments)), r)) {
        if (this.cdata) var i = this.doc.createCDATASection(r);
        else var i = this.doc.createTextNode(r);
        this.currentElement
          ? this.currentElement.appendChild(i)
          : /^\s*$/.test(r) && this.doc.appendChild(i),
          this.locator && Er(this.locator, i);
      }
    },
    skippedEntity: function (r) {},
    endDocument: function () {
      this.doc.normalize();
    },
    setDocumentLocator: function (r) {
      (this.locator = r) && (r.lineNumber = 0);
    },
    comment: function (r, t, e) {
      r = Mc.apply(this, arguments);
      var i = this.doc.createComment(r);
      this.locator && Er(this.locator, i), Bs(this, i);
    },
    startCDATA: function () {
      this.cdata = !0;
    },
    endCDATA: function () {
      this.cdata = !1;
    },
    startDTD: function (r, t, e) {
      var i = this.doc.implementation;
      if (i && i.createDocumentType) {
        var s = i.createDocumentType(r, t, e);
        this.locator && Er(this.locator, s),
          Bs(this, s),
          (this.doc.doctype = s);
      }
    },
    warning: function (r) {
      console.warn("[xmldom warning]	" + r, Xa(this.locator));
    },
    error: function (r) {
      console.error("[xmldom error]	" + r, Xa(this.locator));
    },
    fatalError: function (r) {
      throw new g_(r, this.locator);
    },
  };
  function Xa(r) {
    if (r)
      return (
        `
@` +
        (r.systemId || "") +
        "#[line:" +
        r.lineNumber +
        ",col:" +
        r.columnNumber +
        "]"
      );
  }
  function Mc(r, t, e) {
    return typeof r == "string"
      ? r.substr(t, e)
      : r.length >= t + e || t
      ? new java.lang.String(r, t, e) + ""
      : r;
  }
  "endDTD,startEntity,endEntity,attributeDecl,elementDecl,externalEntityDecl,internalEntityDecl,resolveEntity,getExternalSubset,notationDecl,unparsedEntityDecl".replace(
    /\w+/g,
    function (r) {
      xi.prototype[r] = function () {
        return null;
      };
    }
  );
  function Bs(r, t) {
    r.currentElement ? r.currentElement.appendChild(t) : r.doc.appendChild(t);
  }
  var d0 = (Ns.__DOMHandler = xi),
    f0 = (Ns.normalizeLineEndings = Ic),
    p0 = (Ns.DOMParser = Cc),
    Pc = be,
    m0 = (Ca.DOMImplementation = Pc.DOMImplementation),
    g0 = (Ca.XMLSerializer = Pc.XMLSerializer),
    x_ = (Ca.DOMParser = Ns.DOMParser);
  const Dc = {
    createCanvas: (r, t) =>
      new OffscreenCanvas(r != null ? r : 0, t != null ? t : 0),
    getCanvasRenderingContext2D: () => OffscreenCanvasRenderingContext2D,
    getWebGLRenderingContext: () => WebGLRenderingContext,
    getNavigator: () => navigator,
    getBaseUrl: () => globalThis.location.href,
    getFontFaceSet: () => globalThis.fonts,
    fetch: (r, t) => fetch(r, t),
    parseXML: (r) => new x_().parseFromString(r, "text/xml"),
  };
  return (
    (B.ADAPTER = Dc),
    (v.ALPHA_MODES = wt),
    (v.AbstractMultiResource = ta),
    (v.AlphaFilter = tl),
    (v.AnimatedSprite = bs),
    (v.Application = al),
    (v.ArrayResource = Wh),
    (v.Assets = Jr),
    (v.AssetsClass = Bl),
    (v.Attribute = Lr),
    (v.BLEND_MODES = X),
    (v.BUFFER_BITS = wi),
    (v.BUFFER_TYPE = jt),
    (v.BackgroundSystem = Vr),
    (v.BaseImageResource = ne),
    (v.BasePrepare = ys),
    (v.BaseRenderTexture = Cn),
    (v.BaseTexture = j),
    (v.BatchDrawCall = Gi),
    (v.BatchGeometry = En),
    (v.BatchRenderer = Ce),
    (v.BatchShaderGenerator = gh),
    (v.BatchSystem = In),
    (v.BatchTextureArray = Ki),
    (v.BitmapFont = ye),
    (v.BitmapFontData = hi),
    (v.BitmapText = Xg),
    (v.BlobResource = Yl),
    (v.BlurFilter = el),
    (v.BlurFilterPass = os),
    (v.Bounds = qr),
    (v.BrowserAdapter = Qa),
    (v.Buffer = nt),
    (v.BufferResource = Fr),
    (v.BufferSystem = Qn),
    (v.CLEAR_MODES = zt),
    (v.COLOR_MASK_BITS = Za),
    (v.Cache = Oe),
    (v.CanvasResource = Yh),
    (v.Circle = Hi),
    (v.Color = K),
    (v.ColorMatrixFilter = hs),
    (v.CompressedTextureResource = Be),
    (v.Container = Ot),
    (v.ContextSystem = Xr),
    (v.CountLimiter = wu),
    (v.CubeResource = Kh),
    (v.DEG_TO_RAD = sh),
    (v.DRAW_MODES = Vt),
    (v.DisplacementFilter = rl),
    (v.DisplayObject = at),
    (v.ENV = we),
    (v.Ellipse = Vi),
    (v.ExtensionType = D),
    (v.Extract = lu),
    (v.FORMATS = A),
    (v.FORMATS_TO_COMPONENTS = Ql),
    (v.FXAAFilter = il),
    (v.FillStyle = si),
    (v.Filter = Et),
    (v.FilterState = yh),
    (v.FilterSystem = Bn),
    (v.Framebuffer = Zi),
    (v.FramebufferSystem = Fn),
    (v.GC_MODES = Ri),
    (v.GLFramebuffer = bh),
    (v.GLProgram = Dh),
    (v.GLTexture = rs),
    (v.GRAPHICS_CURVES = ag),
    (v.GenerateTextureSystem = Vn),
    (v.Geometry = me),
    (v.GeometrySystem = Un),
    (v.Graphics = va),
    (v.GraphicsData = ii),
    (v.GraphicsGeometry = gu),
    (v.IGLUniformData = Hf),
    (v.INSTALLED = ki),
    (v.INTERNAL_FORMATS = gt),
    (v.INTERNAL_FORMAT_TO_BYTES_PER_PIXEL = ti),
    (v.ImageBitmapResource = Ke),
    (v.ImageResource = Mn),
    (v.LINE_CAP = ve),
    (v.LINE_JOIN = Bt),
    (v.LineStyle = _s),
    (v.LoaderParserPriority = Ht),
    (v.MASK_TYPES = ut),
    (v.MIPMAP_MODES = Xt),
    (v.MSAA_QUALITY = ot),
    (v.MaskData = Ah),
    (v.MaskSystem = kn),
    (v.Matrix = et),
    (v.Mesh = fr),
    (v.MeshBatchUvs = _u),
    (v.MeshGeometry = ni),
    (v.MeshMaterial = pr),
    (v.MultisampleSystem = Zn),
    (v.NineSlicePlane = dg),
    (v.NoiseFilter = sl),
    (v.ObjectRenderer = $r),
    (v.ObjectRendererSystem = Jn),
    (v.ObservablePoint = ge),
    (v.PI_2 = Ur),
    (v.PRECISION = Pt),
    (v.ParticleContainer = mg),
    (v.ParticleRenderer = ya),
    (v.PlaneGeometry = yu),
    (v.PluginSystem = $n),
    (v.Point = tt),
    (v.Polygon = Ve),
    (v.Prepare = Aa),
    (v.Program = se),
    (v.ProjectionSystem = Hn),
    (v.Quad = xh),
    (v.QuadUv = Nn),
    (v.RAD_TO_DEG = ih),
    (v.RENDERER_TYPE = Hs),
    (v.Rectangle = Y),
    (v.RenderTexture = Me),
    (v.RenderTexturePool = Dn),
    (v.RenderTextureSystem = Xn),
    (v.Renderer = ns),
    (v.ResizePlugin = na),
    (v.Resource = ar),
    (v.RopeGeometry = bu),
    (v.RoundedRectangle = Xi),
    (v.Runner = Nt),
    (v.SAMPLER_TYPES = N),
    (v.SCALE_MODES = Qt),
    (v.SHAPES = mt),
    (v.SVGResource = as),
    (v.ScissorSystem = Ch),
    (v.Shader = Yt),
    (v.ShaderSystem = zn),
    (v.SimpleMesh = fg),
    (v.SimplePlane = Eu),
    (v.SimpleRope = pg),
    (v.Sprite = Ne),
    (v.SpriteMaskFilter = Th),
    (v.Spritesheet = Ra),
    (v.StartupSystem = jr),
    (v.State = ie),
    (v.StateSystem = kh),
    (v.StencilSystem = Gn),
    (v.SystemManager = Gh),
    (v.TARGETS = ke),
    (v.TEXT_GRADIENT = ai),
    (v.TYPES = H),
    (v.TYPES_TO_BYTES_PER_COMPONENT = ca),
    (v.TYPES_TO_BYTES_PER_PIXEL = Jl),
    (v.TemporaryDisplayObject = Zh),
    (v.Text = Ta),
    (v.TextFormat = li),
    (v.TextMetrics = xe),
    (v.TextStyle = Je),
    (v.Texture = O),
    (v.TextureGCSystem = Pe),
    (v.TextureMatrix = ts),
    (v.TextureSystem = jn),
    (v.TextureUvs = Pn),
    (v.Ticker = Tt),
    (v.TickerPlugin = qn),
    (v.TilingSprite = Sa),
    (v.TilingSpriteRenderer = wa),
    (v.TimeLimiter = Mg),
    (v.Transform = ji),
    (v.TransformFeedback = up),
    (v.TransformFeedbackSystem = Wn),
    (v.UPDATE_PRIORITY = De),
    (v.UniformGroup = Gt),
    (v.VERSION = cp),
    (v.VideoResource = ia),
    (v.ViewSystem = Yr),
    (v.ViewableBuffer = Ui),
    (v.WRAP_MODES = Jt),
    (v.WebWorkerAdapter = Dc),
    (v.XMLFormat = Ts),
    (v.XMLStringFormat = As),
    (v.autoDetectFormat = Nu),
    (v.autoDetectRenderer = zh),
    (v.autoDetectResource = yn),
    (v.cacheTextureArray = Fl),
    (v.checkDataUrl = Ze),
    (v.checkExtension = _e),
    (v.checkMaxIfStatementsInShader = Jo),
    (v.convertToList = $t),
    (v.copySearchParams = ls),
    (v.createStringVariations = ll),
    (v.createTexture = lr),
    (v.createUBOElements = Bh),
    (v.curves = Fe),
    (v.defaultFilterVertex = Kn),
    (v.defaultVertex = jh),
    (v.detectAvif = Ul),
    (v.detectCompressedTextures = Wl),
    (v.detectDefaults = $l),
    (v.detectMp4 = Vl),
    (v.detectOgv = Xl),
    (v.detectWebm = Hl),
    (v.detectWebp = kl),
    (v.extensions = U),
    (v.filters = sa),
    (v.generateProgram = Nh),
    (v.generateUniformBufferSync = Lh),
    (v.getFontFamilyName = gl),
    (v.getTestContext = lh),
    (v.getUBOData = Fh),
    (v.graphicsUtils = lg),
    (v.groupD8 = rt),
    (v.isMobile = Re),
    (v.isSingleItem = Zr),
    (v.loadBitmapFont = Hu),
    (v.loadDDS = iu),
    (v.loadImageBitmap = Al),
    (v.loadJson = dl),
    (v.loadKTX = au),
    (v.loadSVG = Rl),
    (v.loadTextures = Qr),
    (v.loadTxt = fl),
    (v.loadVideo = Pl),
    (v.loadWebFont = _l),
    (v.parseDDS = Kl),
    (v.parseKTX = tu),
    (v.resolveCompressedTextureUrl = ou),
    (v.resolveTextureUrl = zl),
    (v.settings = B),
    (v.spritesheetAsset = Du),
    (v.uniformParsers = Ye),
    (v.unsafeEvalSupported = mh),
    (v.utils = Qd),
    v
  );
})({});
//# sourceMappingURL=webworker.min.js.map
