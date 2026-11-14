/*
 * Injected at document start. Re-implements the Android WebView JavascriptInterface
 * ("AndroidBridge") on top of WKWebView message handlers, so the original
 * bridge.html + plugin.js from the APK can run unchanged.
 *
 *   b.http(id, url, optsJson)  -> native NSURLSession -> window.__resp(...)
 *   b.md5(s)                   -> synchronous, pure JS MD5
 *   b.onResult(callId, url)    -> native -> window.__onUrl(callId, url)
 *   b.onLoaded()               -> engine ready
 */
(function () {
  'use strict';

  /* ---------- compact, dependency-free MD5 ---------- */
  function md5(str) {
    var utf8 = unescape(encodeURIComponent(String(str)));
    var n = utf8.length, words = [], i;
    for (i = 0; i < n; i++) {
      words[i >> 2] = (words[i >> 2] || 0) | ((utf8.charCodeAt(i) & 0xff) << ((i % 4) * 8));
    }
    words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
    var totalWords = (((n + 8) >> 6) + 1) * 16;
    var bits = n * 8;
    words[totalWords - 2] = bits & 0xffffffff;
    words[totalWords - 1] = Math.floor(bits / 0x100000000);
    for (i = 0; i < totalWords; i++) if (words[i] === undefined) words[i] = 0;

    var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;

    for (var off = 0; off < totalWords; off += 16) {
      var A = a, B = b, C = c, D = d;
      for (i = 0; i < 64; i++) {
        var f, g;
        if (i < 16)      { f = (B & C) | (~B & D); g = i; }
        else if (i < 32) { f = (B & D) | (C & ~D); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = B ^ C ^ D;           g = (3 * i + 5) % 16; }
        else             { f = C ^ (B | ~D);        g = (7 * i) % 16; }
        var K = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
        var sum = (A + f + K + (words[off + g] | 0)) | 0;
        var rot = (sum << S[i]) | (sum >>> (32 - S[i]));
        var tmp = D; D = C; C = B;
        B = (B + rot) | 0;
        A = tmp;
      }
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    function hexLE(v) {
      var s = '';
      for (var k = 0; k < 4; k++) {
        var byte = (v >>> (k * 8)) & 0xff;
        s += (byte < 16 ? '0' : '') + byte.toString(16);
      }
      return s;
    }
    return hexLE(a) + hexLE(b) + hexLE(c) + hexLE(d);
  }

  function post(obj) {
    var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.iosBridge;
    if (h) { h.postMessage(obj); return; }
    /* desktop preview harness (never present inside the app bundle) */
    if (typeof window.__devBridge === 'function') { window.__devBridge(obj); return; }
    /* preview race: the harness attaches after the iframe boots */
    obj.__tries = (obj.__tries || 0) + 1;
    if (obj.__tries <= 25) {
      setTimeout(function () { post(obj); }, 100);
    }
  }

  window.AndroidBridge = {
    http: function (id, url, optsJson) {
      post({ op: 'http', id: id, url: String(url), opts: String(optsJson || '{}') });
    },
    md5: function (s) { return md5(s); },
    onInited: function (data) { post({ op: 'log', msg: 'engine: ' + String(data).slice(0, 400) }); },
    onAlert: function (data) { post({ op: 'log', msg: 'alert: ' + String(data).slice(0, 400) }); },
    onLoaded: function () { post({ op: 'loaded' }); },
    onResult: function (callId, url) {
      post({ op: 'result', id: String(callId), url: String(url == null ? '' : url) });
    }
  };

  /* Extra helpers used by the iOS UI layer. */
  window.DG = {
    /* Persist the whole app state (favourites / playlists / history / downloads). */
    store: function (json) { post({ op: 'store', json: String(json || '{}') }); },
    download: function (url, name, id) {
      post({ op: 'download', url: String(url), name: String(name), id: String(id || '') });
    },
    log: function (msg) { post({ op: 'log', msg: String(msg).slice(0, 400) }); }
  };
})();
