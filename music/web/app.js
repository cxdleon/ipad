/*
 * 东哥音乐网 - iPadOS 13 client
 *
 * Data flow:
 *   search / chart  ->  window.lx.request  ->  NSURLSession (native, no CORS)
 *   play URL        ->  window.__invoke     ->  original plugin.js engine
 *   persistence     ->  window.DG.store     ->  Documents/appstate.json
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) {
    sec = Number(sec) || 0;
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
  function status(msg) { $('engineState').textContent = msg; }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.className = 'toast'; }, 2200);
  }
  function log(m) { try { if (window.DG) DG.log(m); } catch (e) {} }

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

  var SRC_NAME = { tx: 'QQ音乐', wy: '网易云', kg: '酷狗', kw: '酷我', mg: '咪咕' };
  var HOT_WORDS = ['周杰伦', '孤勇者', '晴天', '起风了', '海底', '陈奕迅', '夜的钢琴曲', '告白气球'];
  var CHARTS = [
    { id: 3778678, name: '热歌榜', tag: '热门' },
    { id: 3779629, name: '新歌榜', tag: '每日更新' },
    { id: 19723756, name: '飙升榜', tag: '实时' },
    { id: 2884035, name: '原创榜', tag: '原创' }
  ];
  var CURATED = [
    { name: '华语热歌', q: '华语 热门', color: 'linear-gradient(135deg,#ff6b6b,#c92a2a)' },
    { name: '粤语经典', q: '粤语 经典', color: 'linear-gradient(135deg,#4dd0c1,#2a7f9e)' },
    { name: '轻音乐', q: '轻音乐 纯音乐', color: 'linear-gradient(135deg,#7c9cff,#3b5bdb)' },
    { name: '摇滚现场', q: '摇滚 乐队', color: 'linear-gradient(135deg,#ffa94d,#d9480f)' },
    { name: '民谣时光', q: '民谣', color: 'linear-gradient(135deg,#b197fc,#6741d9)' },
    { name: '电子节奏', q: '电子 舞曲', color: 'linear-gradient(135deg,#63e6be,#0ca678)' }
  ];

  var S = {
    tab: 'home', source: 'all', quality: '128k', mode: 'list',
    query: '', results: [], resultLabel: '',
    history: [], fav: [], playlists: [], recent: [], downloads: [],
    queue: [], qi: -1, current: null, playing: false,
    charts: {}, chartLoaded: false,
    newSongs: [], plView: null,
    health: {}, pending: {}, seq: 0,
    timerUntil: 0, timerEndOfTrack: false
  };
  var audio = $('audio');
  audio.volume = 0.85;

  /* ================= diagnostics ================= */
  var DIAG = [];
  window.__dgLog = function (kind, msg) {
    var d = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    DIAG.push({
      t: p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()),
      k: String(kind || 'log'),
      m: String(msg == null ? '' : msg).slice(0, 300)
    });
    if (DIAG.length > 220) DIAG.shift();
    if (S.tab === 'mine') renderDiag();
  };

  function renderDiag() {
    var el = $('diagList');
    if (!el) return;
    if (!DIAG.length) { el.innerHTML = '<div class="empty">暂无诊断记录</div>'; return; }
    el.innerHTML = DIAG.slice().reverse().map(function (x) {
      return '<div class="diag-row"><span class="diag-t">' + esc(x.t) + '</span>' +
             '<span class="diag-k">' + esc(x.k) + '</span>' +
             '<span class="diag-m">' + esc(x.m) + '</span></div>';
    }).join('');
  }

  /* Retry playback after the next user gesture: WKWebView can reject a play()
     that happens long after the tap that triggered it. */
  var pendingPlayUrl = '';
  function retryOnGesture() {
    if (NAT && NAT.on) { pendingPlayUrl = ''; return; }
    if (!pendingPlayUrl) return;
    var u = pendingPlayUrl;
    pendingPlayUrl = '';
    audio.src = u;
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () {});
    if (window.__dgLog) window.__dgLog('audio', 'gesture retry');
  }
  document.addEventListener('touchend', retryOnGesture, true);
  document.addEventListener('click', retryOnGesture, true);

  /* ================= playback transport =================
     Inside the app the URL is handed to a native AVPlayer. WKWebView's <audio>
     on a file:// page mis-reports duration for these CDN streams and fires
     `ended` a few seconds in — indistinguishable from a 10-second preview.
     In a plain browser (preview harness) there is no native handler, so the
     <audio> element stays in charge. */
  var NAT = { on: false, t: 0, dur: 0, buf: 0, ready: false };
  var shortTried = {};   /* one cross-source retry per song on a truncated clip */

  function nativeTransport() {
    return !!(window.DG && typeof window.DG.play === 'function' &&
              window.webkit && window.webkit.messageHandlers &&
              window.webkit.messageHandlers.iosBridge);
  }

  function mediaDur() {
    return NAT.on ? NAT.dur : (isFinite(audio.duration) ? audio.duration : 0);
  }

  function paintProgress() {
    var t = NAT.on ? NAT.t : (audio.currentTime || 0);
    var d = mediaDur();
    $('curTime').textContent = fmt(t);
    $('totTime').textContent = fmt(d || (S.current ? S.current.dur : 0));
    if (d > 0 && isFinite(d)) $('seek').value = Math.round(t / d * 1000);
    paintLyric(false);
  }

  function seekTo(t) {
    if (NAT.on) { NAT.t = t; window.DG.seek(t); paintProgress(); return; }
    try { audio.currentTime = t; } catch (e) {}
  }

  function startPlayback(url, s) {
    NAT.t = 0; NAT.dur = 0; NAT.buf = 0; NAT.ready = false;
    loadLyrics(s);
    if (nativeTransport()) {
      NAT.on = true;
      /* Release the media element so it cannot race the native player for the
         same URL (and cannot fire a stale `error` into the UI). */
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
      status('正在缓冲：' + s.name);
      window.DG.play(url);
      window.__dgLog('audio', 'native play ' + String(url).slice(0, 70));
      return;
    }
    NAT.on = false;
    audio.src = url;
    var pr = audio.play();
    if (pr && pr.then) {
      pr.then(function () {
        S.playing = true;
        updateMini(); updateFull();
        status('正在播放：' + s.name);
        window.__dgLog('audio', 'playing ' + s.name);
        addRecent(s);
      }).catch(function (e) {
        var msg = (e && (e.name + ': ' + e.message)) || 'unknown';
        window.__dgLog('audio', 'play() rejected ' + msg);
        pendingPlayUrl = url;
        status('播放失败：' + ((e && e.message) || '链接可能已失效'));
        toast('点一下屏幕继续播放');
      });
    }
  }

  /* Native player -> UI */
  window.__player = function (ev) {
    if (!ev) return;
    var k = ev.ev;

    /* The native NSTimer fires even when WKWebView's JS was frozen (locked
       screen / background). Handle these before the NAT.on guard so a torn
       down transport can never swallow a sleep-timer event. */
    if (k === 'timerfired') {
      window.__dgLog('timer', 'native fired');
      finishTimer('定时播放结束');
      return;
    }
    if (k === 'endstop') {
      window.__dgLog('timer', 'native end-of-track stop');
      S.timerEndOfTrack = false;
      saveState();
      S.playing = false;
      renderTimer(); updateMini(); updateFull();
      status('本曲已结束，定时停止');
      toast('本曲已结束，定时停止');
      return;
    }
    if (!NAT.on) return;

    if (k === 'time') {
      NAT.t = ev.t || 0;
      if (ev.dur > 0) NAT.dur = ev.dur;
      NAT.buf = ev.buf || 0;
      /* st: 0 unknown, 1 readyToPlay, 2 failed (AVPlayerItemStatus) */
      if (ev.st === 1 && !NAT.ready) {
        NAT.ready = true;
        window.__dgLog('audio', 'ready dur=' + NAT.dur.toFixed(1) + 's buf=' + NAT.buf.toFixed(1) + 's');
      }
      if (ev.err) {
        window.__dgLog('audio', 'item failed code=' + ev.code + ' ' + ev.err);
        status('播放失败：' + ev.err);
      }
      paintProgress();
      return;
    }
    if (k === 'loadstart') {
      window.__dgLog('audio', 'loadstart referer=' + (ev.referer || '-'));
      return;
    }
    if (k === 'playing') {
      S.playing = true; updateMini(); updateFull();
      status('正在播放：' + (S.current ? S.current.name : ''));
      if (S.current) addRecent(S.current);
      return;
    }
    if (k === 'paused') {
      S.playing = false; updateMini(); updateFull();
      return;
    }
    if (k === 'stalled') {
      window.__dgLog('audio', 'stalled at ' + NAT.t.toFixed(1) + 's buf=' + NAT.buf.toFixed(1) + 's');
      status('缓冲中…');
      return;
    }
    if (k === 'ended') {
      try {
        window.__dgLog('audio', 'ended at ' + NAT.t.toFixed(1) + 's dur=' + NAT.dur.toFixed(1) + 's');
        var cur = S.current;
        var expect = (cur && cur.dur) ? cur.dur : 0;
        /* Only a genuinely tiny clip (<30s) counts as a preview. The old
           "dur < expect*0.7" ratio mis-fired whenever the metadata duration
           was in the wrong unit, which swallowed the next-track transition
           on perfectly good songs. The native AVPlayer reports real durations
           now, so this is only a last-resort guard. */
        if (expect > 60 && NAT.dur > 0 && NAT.dur < 30 && NAT.dur < expect * 0.5) {
          window.__dgLog('audio', 'SHORT stream ' + NAT.dur.toFixed(0) + 's vs expected ' + expect.toFixed(0) + 's');
          var sk = cur ? songKey(cur) : 'x';
          if (!shortTried[sk]) {
            shortTried[sk] = 1;
            autoFallback(cur, 'short');
            /* If cross-source lookup finds nothing, still advance the list. */
            setTimeout(function () {
              if (S.current === cur && !S.playing) {
                window.__dgLog('audio', 'fallback gave up, advancing');
                next(true);
              }
            }, 4500);
          } else next(true);
          return;
        }
        if (timerBlocksNext()) return;
        if (S.mode === 'single') { seekTo(0); window.DG.resume(); return; }
        window.__dgLog('audio', 'advance mode=' + S.mode + ' qi=' + S.qi + '/' + S.queue.length);
        next(true);
      } catch (e) {
        window.__dgLog('audio', 'ended handler error ' + ((e && e.message) || e));
        try { next(true); } catch (e2) {}
      }
      return;
    }
    if (k === 'error') {
      window.__dgLog('audio', 'native error code=' + (ev.code || '?') + ' ' + (ev.msg || ''));
      status('无法播放该链接');
      toast('该链接无法播放');
    }
  };

  /* ================= transport helpers ================= */

  function pausePlayback() {
    if (NAT.on) { try { window.DG.pause(); } catch (e) {} }
    else { try { audio.pause(); } catch (e) {} }
    S.playing = false;
    updateMini(); updateFull();
  }

  /* ================= sleep timer ================= */

  function timerLeft() {
    if (!S.timerUntil) return 0;
    return Math.max(0, Math.round((S.timerUntil - Date.now()) / 1000));
  }

  function timerLabel() {
    if (S.timerEndOfTrack) return '本曲结束后停';
    var left = timerLeft();
    if (!left) return '定时关闭';
    var m = Math.floor(left / 60), s = left % 60;
    return '定时 ' + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function renderTimer() {
    var b = $('btnTimer');
    if (b) {
      b.textContent = timerLabel();
      b.className = (S.timerUntil || S.timerEndOfTrack) ? 'pill on' : 'pill';
    }
    var st = $('timerState');
    if (st) st.textContent = (S.timerUntil || S.timerEndOfTrack) ? timerLabel() : '未开启';
  }

  /* Arm the native NSTimer too. JS setInterval alone is not enough: iOS 13
     freezes WKWebView timers while the screen is locked or the app is in the
     background, which is exactly when a sleep timer matters. */
  function armNativeTimer() {
    try {
      if (window.DG && typeof window.DG.setTimer === 'function') {
        window.DG.setTimer(S.timerUntil || 0, !!S.timerEndOfTrack);
      }
    } catch (e) { window.__dgLog('timer', 'arm failed ' + ((e && e.message) || e)); }
  }

  function setTimer(min) {
    if (min === -1) {
      S.timerUntil = 0; S.timerEndOfTrack = false;
      toast('定时已关闭');
    } else if (min === -2) {
      S.timerUntil = 0; S.timerEndOfTrack = true;
      toast('播完当前这首后停止');
    } else if (min > 0) {
      S.timerUntil = Date.now() + min * 60000;
      S.timerEndOfTrack = false;
      toast(min + ' 分钟后停止播放');
    }
    timerFiring = 0;
    saveState();
    renderTimer();
    armNativeTimer();
    var sh = $('timerSheet');
    if (sh) sh.classList.remove('open');
    window.__dgLog('timer', 'set ' + min + ' -> ' + timerLabel() +
      ' until=' + (S.timerUntil || 0) + ' endstop=' + S.timerEndOfTrack);
  }

  /* Idempotent: both the JS loop and the native timerfired event may call it. */
  var timerFiring = 0;
  function finishTimer(reason) {
    var now = Date.now();
    if (now - timerFiring < 1500) return;
    timerFiring = now;
    S.timerUntil = 0;
    S.timerEndOfTrack = false;
    saveState();
    pausePlayback();
    armNativeTimer();
    renderTimer();
    status(reason + '，已停止播放');
    toast(reason);
    window.__dgLog('timer', 'fired, playback stopped');
  }

  function startTimerLoop() {
    setInterval(function () {
      if (!S.timerUntil) return;
      if (Date.now() >= S.timerUntil) { finishTimer('定时播放结束'); return; }
      renderTimer();
    }, 1000);
  }

  /* Browser-preview fallback only. Inside the app the native layer consumes
     the end-of-track stop and sends `endstop` instead of `ended`. */
  function timerBlocksNext() {
    if (!S.timerEndOfTrack) return false;
    S.timerEndOfTrack = false;
    saveState();
    pausePlayback();
    armNativeTimer();
    renderTimer();
    toast('本曲已结束，定时停止');
    window.__dgLog('timer', 'end-of-track stop (js)');
    return true;
  }

  /* ================= play order ================= */

  var MODE_TEXT = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };

  function setMode(m) {
    window.__dgLog('order', 'setMode ' + m + ' (was ' + S.mode + ')');
    if (!MODE_TEXT[m] || S.mode === m) { renderOrderSeg(); return; }
    S.mode = m;
    var sel = $('setMode');
    if (sel) sel.value = m;
    saveState();
    renderOrderSeg();
    updateFull();
    toast(MODE_TEXT[m]);
    window.__dgLog('order', 'mode now ' + S.mode);
  }

  function renderOrderSeg() {
    var seg = $('orderSeg');
    if (!seg) return;
    var kids = seg.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = (kids[i].getAttribute('data-mode') === S.mode) ? 'on' : '';
    }
  }

  /* ================= lyrics ================= */

  var LYR = { key: '', lines: [], idx: -1 };

  function lyricKey(s) { return s ? (s.source + '|' + s.mid + '|' + s.name) : ''; }

  function lyricPlaceholder(text) {
    var inner = $('lyricInner');
    if (inner) inner.innerHTML = '<div class="lyric-empty">' + esc(text) + '</div>';
  }

  function parseLrc(text) {
    var out = [];
    if (!text) return out;
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    var raw = String(text).split(/\r?\n/);
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i].trim();
      if (!line) continue;
      var times = [], m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        var sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        var frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
        times.push(sec + frac);
      }
      var body = line.replace(re, '').trim();
      if (!times.length || !body) continue;
      for (var k = 0; k < times.length; k++) out.push({ t: times[k], s: body });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function fetchLyricText(id) {
    var url = 'https://music.163.com/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&kv=-1&tv=-1';
    return window.lx.request(url, {
      method: 'GET', timeout: 9000,
      headers: { 'Referer': 'https://music.163.com/', 'Cookie': 'appver=2.0.2', 'User-Agent': UA }
    }).then(function (r) {
      var j = JSON.parse(r.body || '{}');
      var t = (j.lrc && j.lrc.lyric) || '';
      if (!t || t.indexOf('暂无歌词') >= 0) {
        return (j.tlyric && j.tlyric.lyric) || '';
      }
      return t;
    });
  }

  /* Lyrics always come from NetEase (it has the widest LRC coverage). A track
     playing from another source is matched by title + artist first. */
  function loadLyrics(s) {
    if (!s) {
      LYR.key = ''; LYR.lines = []; LYR.idx = -1;
      lyricPlaceholder('暂无歌词');
      return;
    }
    var key = lyricKey(s);
    if (LYR.key === key && LYR.lines.length) { paintLyric(true); return; }
    LYR.key = key; LYR.lines = []; LYR.idx = -1;
    lyricPlaceholder('歌词加载中…');
    var mine = key;

    var p;
    if (s.source === 'wy' && s.mid) {
      p = fetchLyricText(s.mid);
    } else {
      p = fetchSource('wy', (s.name + ' ' + (s.singer || '')).trim()).then(function (res) {
        var hit = null;
        (res.list || []).slice(0, 8).forEach(function (c) {
          if (!hit && c && c.mid && nameMatch(c.name, s.name)) hit = c;
        });
        return hit ? fetchLyricText(hit.mid) : '';
      });
    }

    p.then(function (text) {
      if (LYR.key !== mine) return;
      var lines = parseLrc(text);
      if (!lines.length) {
        window.__dgLog('lyric', 'empty for ' + s.name);
        lyricPlaceholder('暂无歌词');
        return;
      }
      LYR.lines = lines; LYR.idx = -1;
      var inner = $('lyricInner');
      if (inner) {
        var h = '';
        for (var i = 0; i < lines.length; i++) {
          h += '<div class="lyric-line" data-i="' + i + '">' + esc(lines[i].s) + '</div>';
        }
        inner.innerHTML = h;
      }
      window.__dgLog('lyric', 'loaded ' + lines.length + ' lines for ' + s.name);
      paintLyric(true);
    }).catch(function (e) {
      if (LYR.key !== mine) return;
      window.__dgLog('lyric', 'failed ' + ((e && e.message) || ''));
      lyricPlaceholder('歌词加载失败');
    });
  }

  function paintLyric(force) {
    if (!LYR.lines.length) return;
    var t = NAT.on ? NAT.t : (audio.currentTime || 0);
    var idx = -1;
    for (var i = 0; i < LYR.lines.length; i++) {
      if (LYR.lines[i].t <= t + 0.12) idx = i; else break;
    }
    if (idx < 0) idx = 0;   /* before the first timestamp: highlight line 1 */
    if (idx === LYR.idx && !force) return;
    LYR.idx = idx;
    var inner = $('lyricInner');
    if (!inner) return;
    var kids = inner.children;
    for (var k = 0; k < kids.length; k++) {
      kids[k].className = (k === idx) ? 'lyric-line on' : 'lyric-line';
    }
    var wrap = $('lyricWrap');
    if (wrap && idx >= 0 && kids[idx]) {
      var top = kids[idx].offsetTop - wrap.clientHeight / 2 + kids[idx].offsetHeight / 2;
      wrap.scrollTop = top > 0 ? top : 0;
    }
  }

  /* ================= persistence ================= */

  function saveState() {
    var blob = {
      fav: S.fav, playlists: S.playlists, history: S.history,
      recent: S.recent, downloads: S.downloads, quality: S.quality, mode: S.mode,
      timerUntil: S.timerUntil, timerEndOfTrack: S.timerEndOfTrack
    };
    var json = JSON.stringify(blob);
    try { localStorage.setItem('dg_state', json); } catch (e) {}
    try { if (window.DG) DG.store(json); } catch (e) {}
  }
  window.__initStore = function (json) {
    try {
      var o = JSON.parse(json || '{}');
      if (Array.isArray(o.fav)) S.fav = o.fav;
      if (Array.isArray(o.playlists)) S.playlists = o.playlists;
      if (Array.isArray(o.history)) S.history = o.history;
      if (Array.isArray(o.recent)) S.recent = o.recent;
      if (Array.isArray(o.downloads)) S.downloads = o.downloads;
      if (o.quality) { S.quality = o.quality; $('setQuality').value = o.quality; }
      if (o.mode) { S.mode = o.mode; $('setMode').value = o.mode; }
      if (typeof o.timerUntil === 'number') S.timerUntil = o.timerUntil;
      if (o.timerEndOfTrack) S.timerEndOfTrack = true;
    } catch (e) { log('initStore: ' + e.message); }
    /* The native NSTimer does not survive an app restart; re-arm from persisted
       state. An already-expired deadline stops playback immediately. */
    armNativeTimer();
    renderAll();
  };
  function loadLocalFallback() {
    try {
      var raw = localStorage.getItem('dg_state');
      if (raw) window.__initStore(raw);
    } catch (e) {}
  }

  /* ================= helpers ================= */

  function lenientParse(txt) {
    try { return JSON.parse(txt); } catch (e) {}
    try { return Function('return (' + txt + ')')(); } catch (e) {}
    return null;
  }
  function pickSinger(v) {
    if (Array.isArray(v)) {
      return v.map(function (x) { return x && (x.name || x.singerName) || ''; }).filter(Boolean).join(' / ');
    }
    return clean(v);
  }
  function sameSong(a, b) {
    return a && b && a.source === b.source && String(a.mid) === String(b.mid);
  }
  function isFav(s) { return S.fav.some(function (f) { return sameSong(f, s); }); }
  function songKey(s) { return s.source + ':' + s.mid; }

  /* Loose title comparison used by the cross-source fallback: strip bracketed
     suffixes such as "(Live)" / "（R&B版）" and punctuation before comparing. */
  function normName(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
      .replace(/[\s\-_·・.,，。!！?？'"“”‘’/]/g, '');
  }
  function nameMatch(a, b) {
    var x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (Math.min(x.length, y.length) < 2) return false;
    return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }

  /* ================= sources ================= */

  function mgSwitch() {
    return encodeURIComponent(JSON.stringify({
      song: 1, album: 0, singer: 0, tagSong: 0, mvSong: 0, bestShow: 1, songlist: 0
    }));
  }

  var SOURCES = {
    tx: {
      name: 'QQ音乐',
      url: function (q) {
        return 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1' +
               '&remoteplace=txt.yqq.song&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0' +
               '&p=1&n=30&w=' + encodeURIComponent(q) +
               '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8' +
               '&notice=0&platform=yqq.json&needNewCode=0';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.data && j.data.song && j.data.song.list) || [];
        return list.map(function (s) {
          var singer = pickSinger(s.singer);
          var name = clean(s.songname || s.title);
          return {
            source: 'tx', mid: String(s.songmid || s.songid || ''),
            name: name, singer: singer, album: clean(s.albumname),
            dur: Number(s.interval) || 0,
            extra: { mediaMid: s.media_mid || s.strMediaMid || '', title: name, name: name, singer: singer, artist: singer }
          };
        }).filter(function (x) { return x.mid && x.name; });
      }
    },
    wy: {
      name: '网易云',
      url: function (q) {
        return 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) +
               '&type=1&offset=0&limit=30';
      },
      opts: {
        method: 'GET', timeout: 12000,
        headers: { 'Referer': 'https://music.163.com/', 'User-Agent': UA, 'Cookie': 'appver=2.0.2' }
      },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.result && j.result.songs) || [];
        return list.map(function (s) {
          return {
            source: 'wy', mid: String(s.id || ''),
            name: clean(s.name), singer: pickSinger(s.artists || s.ar),
            album: clean((s.album && s.album.name) || (s.al && s.al.name)),
            dur: Math.round((Number(s.duration) || Number(s.dt) || 0) / 1000),
            extra: {}
          };
        }).filter(function (x) { return x.mid && x.name; });
      }
    },
    kg: {
      name: '酷狗',
      url: function (q) {
        return 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(q) +
               '&page=1&pagesize=30&platform=WebFilter';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'https://www.kugou.com/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.data && (j.data.lists || j.data.list)) || [];
        return list.map(function (s) {
          var hash = s.FileHash || s.HQFileHash || s.SQFileHash || s.ResFileHash || '';
          return {
            source: 'kg', mid: String(hash || s.SongID || s.ID || ''),
            name: clean(s.SongName || s.FileName), singer: clean(s.SingerName),
            album: clean(s.AlbumName), dur: Number(s.Duration) || 0,
            extra: { hash: hash, songmid: hash }
          };
        }).filter(function (x) { return x.mid && x.name; });
      }
    },
    kw: {
      name: '酷我',
      url: function (q) {
        return 'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(q) +
               '&ft=music&itemset=web_2013&client=kt&pn=0&rn=30&rformat=json&encoding=utf8';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'http://www.kuwo.cn/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = lenientParse(txt);
        var list = (j && (j.abslist || (j.data && j.data.abslist))) || [];
        return list.map(function (s) {
          var raw = String(s.MUSICRID || s.musicrid || '');
          var rid = raw.replace(/^MUSIC_/i, '') || String(s.DC_TARGETID || s.MUSIC_ID || '');
          var name = clean(s.SONGNAME || s.songname || s.NAME);
          var singer = clean(s.ARTIST || s.artist);
          return {
            source: 'kw', mid: rid, name: name, singer: singer,
            album: clean(s.ALBUM), dur: Number(s.DURATION) || 0,
            extra: { rid: rid, name: name, title: name, singer: singer, artist: singer }
          };
        }).filter(function (x) { return x.mid && x.name; });
      }
    },
    mg: {
      name: '咪咕',
      url: function (q) {
        return 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do' +
               '?ua=Android_migu&version=5.1&text=' + encodeURIComponent(q) +
               '&pageNo=1&pageSize=30&searchSwitch=' + mgSwitch();
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'https://music.migu.cn/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.songResultData && (j.songResultData.result || j.songResultData.resultList)) || [];
        return list.map(function (s) {
          var cid = String(s.copyrightId || '');
          var cont = String(s.contentId || '');
          var sid = String(s.songId || s.id || '');
          var mid = cid || cont || sid;
          return {
            source: 'mg', mid: mid,
            name: clean(s.name || s.songName), singer: pickSinger(s.singers) || clean(s.singerName),
            album: clean((s.albums && s.albums[0] && s.albums[0].name) || s.albumName),
            dur: 0,
            extra: { contentId: cont, copyrightId: cid, songId: sid, songmid: mid }
          };
        }).filter(function (x) { return x.mid && x.name; });
      }
    }
  };

  function buildInfo(s) {
    var q = S.quality;
    var base = {
      source: s.source,
      songmid: s.mid, id: s.mid, rid: s.mid, hash: s.mid,
      name: s.name, title: s.name,
      singer: s.singer, artist: s.singer,
      interval: s.dur || 0,
      contentId: s.mid, copyrightId: s.mid, songId: s.mid,
      mediaMid: '', album: s.album || '', albumName: s.album || '',
      types: [{ type: q, size: '0' }, { type: '128k', size: '0' }, { type: '320k', size: '0' }, { type: 'flac', size: '0' }],
      _types: { '128k': { size: '0' }, '320k': { size: '0' }, flac: { size: '0' }, flac24bit: { size: '0' } }
    };
    if (s.extra) {
      for (var k in s.extra) {
        if (Object.prototype.hasOwnProperty.call(s.extra, k) &&
            s.extra[k] !== undefined && s.extra[k] !== null && s.extra[k] !== '') {
          base[k] = s.extra[k];
        }
      }
    }
    return base;
  }

  /* ================= search ================= */

  function fetchSource(key, q) {
    var d = SOURCES[key];
    if (!d) return Promise.resolve({ key: key, list: [], err: 'unknown' });
    var o = {};
    for (var p in d.opts) if (Object.prototype.hasOwnProperty.call(d.opts, p)) o[p] = d.opts[p];
    return lx.request(d.url(q), o).then(function (r) {
      var arr = [];
      try { arr = d.parse(r.body); }
      catch (e) { log(key + ' parse: ' + e.message); }
      S.health[key] = arr.length ? 'ok' : 'empty';
      return { key: key, list: arr, err: null };
    }).catch(function (e) {
      S.health[key] = 'fail';
      return { key: key, list: [], err: (e && e.message) || 'error' };
    });
  }

  function search(q, opts) {
    opts = opts || {};
    q = (q || '').trim();
    if (!q) { toast('先输入歌名或歌手'); return; }
    S.query = q;
    S.tab = 'search';
    switchTab('search', true);
    $('q').value = q;
    pushHistory(q);

    var keys = opts.source ? [opts.source] : (S.source === 'all' ? Object.keys(SOURCES) : [S.source]);
    S.resultLabel = opts.label || '';
    $('resultTitle').textContent = opts.label || ('“' + q + '” 的搜索结果');
    $('resultHint').textContent = '搜索中…';
    $('searchResults').innerHTML = '<div class="empty">加载中…</div>';
    status('五源聚合搜索中…');

    var jobs = keys.map(function (k) { return fetchSource(k, q); });

    Promise.all(jobs).then(function (res) {
      var all = [], parts = [];
      res.forEach(function (x) {
        all = all.concat(x.list);
        parts.push(SRC_NAME[x.key] + ' ' + x.list.length + (x.err ? '(失败)' : ''));
      });
      S.results = all;
      $('resultHint').textContent = '共 ' + all.length + ' 首';
      renderSearchResults();
      status('共 ' + all.length + ' 首 · ' + parts.join(' / '));
      if (!all.length) toast('没搜到结果，换个关键词或切换音源试试');
    });
  }

  function pushHistory(q) {
    S.history = S.history.filter(function (x) { return x !== q; });
    S.history.unshift(q);
    if (S.history.length > 20) S.history.length = 20;
    saveState();
    renderHistory();
  }

  /* ================= charts ================= */

  function loadCharts(force) {
    if (S.chartLoaded && !force) return Promise.resolve();
    $('chartGrid').innerHTML = '<div class="empty">加载中…</div>';
    var jobs = CHARTS.map(function (c) {
      return lx.request('https://music.163.com/api/playlist/detail?id=' + c.id, {
        method: 'GET', timeout: 15000,
        headers: { 'Referer': 'https://music.163.com/', 'User-Agent': UA }
      }).then(function (r) {
        var j = JSON.parse(r.body);
        var tracks = (j.result && j.result.tracks) || [];
        return { chart: c, tracks: tracks.slice(0, 30).map(function (t) {
          return {
            source: 'wy', mid: String(t.id || ''),
            name: clean(t.name), singer: pickSinger(t.artists || t.ar),
            album: clean((t.album && t.album.name) || (t.al && t.al.name)),
            dur: Math.round((Number(t.duration) || Number(t.dt) || 0) / 1000),
            extra: {}
          };
        }).filter(function (x) { return x.mid && x.name; }) };
      }).catch(function (e) {
        return { chart: c, tracks: [], err: e.message };
      });
    });
    return Promise.all(jobs).then(function (res) {
      S.charts = {};
      var okCount = 0;
      res.forEach(function (x) {
        S.charts[x.chart.id] = x.tracks;
        if (x.tracks.length) okCount++;
      });
      S.chartLoaded = okCount > 0;
      S.newSongs = (S.charts[3779629] || []).slice(0, 12);
      renderCharts();
      renderNewSongs();
      $('chartHint').textContent = okCount + ' 个官方榜';
      if (!okCount) $('chartGrid').innerHTML = '<div class="empty">榜单加载失败<small>回首页点刷新重试</small></div>';
    });
  }

  /* ================= player ================= */

  function setQueue(list, startIndex, label) {
    S.queue = list.slice();
    playAt(startIndex || 0);
  }

  function playAt(i) {
    if (!S.queue.length) return;
    if (i < 0) i = S.queue.length - 1;
    if (i >= S.queue.length) i = 0;
    S.qi = i;
    playSong(S.queue[i]);
  }

  function playSong(s) {
    if (!window.__engineReady) {
      window.__dgLog('play', 'engine NOT ready');
      toast('取链引擎初始化失败'); return;
    }
    S.current = s;
    updateMini();
    updateFull();
    var id = 'u' + (++S.seq);
    S.pending[id] = { song: s, download: false };
    status('正在解析：' + s.name + ' …');
    window.__dgLog('play', s.source + ' | ' + s.name + ' | q=' + S.quality + ' | id=' + id);
    if ($('full').classList.contains('open')) lyricPlaceholder('正在解析…');
    window.__invoke(id, s.source, S.quality, JSON.stringify(buildInfo(s)));
    setTimeout(function () {
      if (S.pending[id]) {
        var pend = S.pending[id];
        delete S.pending[id];
        window.__dgLog('play', 'TIMEOUT ' + id);
        status('暂未取到可用链接');
        if (pend && !pend.download) autoFallback(pend.song, 'timeout');
        else toast('暂未取到可用链接，换个音质或音源试试');
      }
    }, 15000);
  }

  /* Cross-source fallback: a track can be unresolvable on one platform
     (VIP-only, removed, or the plugin's relay hosts are down). Look the same
     title up on the other sources and play that version instead. */
  var fbTried = {};
  var fbDepth = 0;

  function autoFallback(s, reason) {
    if (!s) return;
    var nk = normName(s.name) + '|' + normName(s.singer);
    if (fbDepth >= 2 || fbTried[nk]) {
      window.__dgLog('fallback', 'give up depth=' + fbDepth + ' ' + nk);
      status('这首歌所有音源都取不到');
      toast('该歌曲无可用资源，换一首试试');
      return;
    }
    fbTried[nk] = 1;
    var others = Object.keys(SOURCES).filter(function (k) { return k !== s.source && k !== 'tx'; });
    status('换源中：' + (SRC_NAME[s.source] || s.source) + ' 无资源，正在找其他源…');
    window.__dgLog('fallback', (SRC_NAME[s.source] || s.source) + ' 无资源(' + (reason || '') + ') -> ' + others.join(','));

    var q = (s.name + ' ' + (s.singer || '')).trim();
    Promise.all(others.map(function (k) { return fetchSource(k, q); })).then(function (res) {
      var best = null;
      res.forEach(function (x) {
        if (best) return;
        x.list.slice(0, 10).forEach(function (c) {
          if (!best && c && c.mid && nameMatch(c.name, s.name)) best = c;
        });
      });
      if (!best) {
        window.__dgLog('fallback', 'no match: ' + q);
        status('其他音源也没有这首歌');
        toast('该歌曲无可用资源，换一首试试');
        return;
      }
      window.__dgLog('fallback', 'switch -> ' + best.source + ' | ' + best.name + ' | ' + best.mid);
      toast('已切到' + (SRC_NAME[best.source] || best.source) + '播放');
      fbDepth++;
      playSong(best);
    }).catch(function (e) {
      window.__dgLog('fallback', 'search failed ' + ((e && e.message) || ''));
      status('换源失败');
    });
  }

  window.__onUrl = function (id, url) {
    var p = S.pending[id];
    if (!p) { window.__dgLog('result', id + ' no-pending ' + (url ? 'url' : 'empty')); return; }
    delete S.pending[id];
    window.__dgLog('result', id + ' ' + (url ? String(url).slice(0, 110) : 'EMPTY'));
    url = String(url == null ? '' : url).trim();
    if (url.indexOf('//') === 0) url = 'https:' + url;
    if (!url || !/^(https?|blob|data):/i.test(url)) {
      status('暂未取到可用链接');
      if (p.download) { toast('该音源取不到这首歌'); return; }
      autoFallback(p.song, 'empty');
      return;
    }
    if (p.download) { startDownload(p.song, url); return; }
    fbDepth = 0;
    var s = p.song;
    S.current = s;
    startPlayback(url, s);
    updateMini(); updateFull();
  };

  function addRecent(s) {
    S.recent = S.recent.filter(function (x) { return !sameSong(x, s); });
    var copy = JSON.parse(JSON.stringify(s));
    copy.playedAt = Date.now();
    copy.count = 1;
    S.recent.unshift(copy);
    if (S.recent.length > 60) S.recent.length = 60;
    saveState();
  }

  function next(auto) {
    if (!S.queue.length) return;
    if (S.mode === 'shuffle') {
      var n = Math.floor(Math.random() * S.queue.length);
      if (S.queue.length > 1 && n === S.qi) n = (n + 1) % S.queue.length;
      playAt(n);
      return;
    }
    if (S.mode === 'single' && auto) { playAt(S.qi); return; }
    playAt(S.qi + 1);
  }
  function prev() {
    if (!S.queue.length) return;
    if ((NAT.on ? NAT.t : audio.currentTime) > 3) { seekTo(0); return; }
    playAt(S.qi - 1);
  }

  /* ================= downloads ================= */

  function startDownload(s, url) {
    var name = (s.name + ' - ' + (s.singer || '') + '.mp3').replace(/[\\/:*?"<>|]/g, '_').slice(0, 110);
    var dl = {
      id: 'd' + Date.now(), key: songKey(s), name: name, song: JSON.parse(JSON.stringify(s)),
      status: 'downloading', pct: 0
    };
    S.downloads = S.downloads.filter(function (x) { return x.key !== dl.key; });
    S.downloads.unshift(dl);
    saveState();
    renderDownloads();
    if (window.DG) DG.download(url, name, dl.id);
    toast('开始下载');
  }

  window.__onProgress = function (id, pct) {
    var d = S.downloads.filter(function (x) { return x.id === id; })[0];
    if (!d) return;
    d.pct = Math.max(0, Math.min(100, Math.round(pct)));
    renderDownloads();
  };
  window.__onDownload = function (id, ok, name) {
    var d = S.downloads.filter(function (x) { return x.id === id; })[0];
    if (d) {
      d.status = ok ? 'done' : 'fail';
      d.pct = ok ? 100 : d.pct;
      d.name = name || d.name;
    }
    saveState();
    renderDownloads();
    toast(ok ? '已下载到 App 文档' : '下载失败');
  };

  /* ================= views ================= */

  var TITLES = { home: '推荐', search: '搜索', fav: '收藏', playlist: '歌单', mine: '我的' };

  function switchTab(tab, keepScroll) {
    S.tab = tab;
    $('abTitle').textContent = TITLES[tab] || '推荐';
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.remove('active');
    });
    var el = $('view-' + tab);
    if (el) el.classList.add('active');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    if (!keepScroll) $('views').scrollTop = 0;
    if (tab === 'home' && !S.chartLoaded) loadCharts(false);
    if (tab === 'fav') renderFav();
    if (tab === 'playlist') renderPlaylists();
    if (tab === 'mine') { renderMine(); renderDiag(); }
    if (tab === 'search') { renderHistory(); renderSearchResults(); }
  }

  function renderAll() {
    renderHot();
    renderCurated();
    renderHistory();
    renderSearchResults();
    renderFav();
    renderPlaylists();
    renderMine();
    renderQueue();
    updateMini();
    updateFull();
    $('favCount').textContent = S.fav.length;
    $('setQuality').value = S.quality;
    $('setMode').value = S.mode;
  }

  function renderHot() {
    $('hotWords').innerHTML = HOT_WORDS.map(function (w) {
      return '<button class="chip" data-hot="' + esc(w) + '">' + esc(w) + '</button>';
    }).join('');
  }

  function renderCurated() {
    $('curatedGrid').innerHTML = CURATED.map(function (c, i) {
      return '<div class="pl-card" data-cur="' + i + '">' +
        '<div class="pl-cover" style="background:' + c.color + '">&#9834;</div>' +
        '<div class="pl-name">' + esc(c.name) + '</div></div>';
    }).join('');
  }

  function renderCharts() {
    $('chartGrid').innerHTML = CHARTS.map(function (c) {
      var list = S.charts[c.id] || [];
      var lines = list.slice(0, 3).map(function (s, i) {
        return '<div class="cc-line"><b>' + (i + 1) + '.</b> ' + esc(s.name) + ' &middot; ' + esc(s.singer) + '</div>';
      }).join('');
      if (!lines) lines = '<div class="cc-line">暂无数据</div>';
      return '<div class="chart-card" data-chart="' + c.id + '">' +
        '<div class="cc-head"><span class="cc-name">' + esc(c.name) + '</span>' +
        '<span class="cc-upd">' + esc(c.tag) + '</span></div>' + lines +
        '<div class="cc-line" style="margin-top:6px;color:#5f6d84">点击查看完整榜单</div></div>';
    }).join('');
  }

  function renderNewSongs() {
    if (!S.newSongs.length) {
      $('newSongs').innerHTML = '<div class="empty">新歌暂时加载不到<small>点右上角刷新试试</small></div>';
      return;
    }
    $('newSongs').innerHTML = S.newSongs.map(function (s, i) {
      return rowHTML(s, i, 'new');
    }).join('');
  }

  function rowHTML(s, i, ctx) {
    var faved = isFav(s);
    return '<div class="song-row" data-ctx="' + ctx + '" data-i="' + i + '">' +
      '<div class="idx">' + (i + 1) + '</div>' +
      '<div class="s-main"><span class="s-name">' + esc(s.name) + '</span>' +
      '<span class="s-sub"><span class="badge b-' + s.source + '">' + esc(SRC_NAME[s.source] || s.source) + '</span>' +
      esc(s.album || '') + '</span></div>' +
      '<div class="s-artist">' + esc(s.singer || '未知歌手') + '</div>' +
      '<div class="s-dur">' + fmt(s.dur) + '</div>' +
      '<div class="s-ops">' +
        '<button data-act="play" title="播放">&#9654;</button>' +
        '<button data-act="fav" class="' + (faved ? 'faved' : '') + '" title="收藏">' + (faved ? '&#9829;' : '&#9825;') + '</button>' +
        '<button data-act="more" title="更多">&#8943;</button>' +
      '</div></div>';
  }

  function ctxList(ctx) {
    if (ctx === 'new') return S.newSongs;
    if (ctx === 'search') return S.results;
    if (ctx === 'fav') return S.fav;
    if (ctx === 'pl') return currentPlSongs();
    if (ctx === 'recent') return S.recent;
    if (ctx === 'dl') return S.downloads.map(function (d) { return d.song; });
    if (ctx === 'queue') return S.queue;
    if (ctx === 'chart') return S.charts[S.curChart] || [];
    return [];
  }

  function renderSearchResults() {
    var el = $('searchResults');
    if (!S.results.length) {
      el.innerHTML = '<div class="empty">先输入歌名或歌手<small>五源聚合 · 同时检索</small></div>';
      return;
    }
    el.innerHTML = S.results.map(function (s, i) { return rowHTML(s, i, 'search'); }).join('');
  }

  function renderHistory() {
    var block = $('searchHistoryBlock');
    if (!S.history.length) { block.classList.add('hidden'); return; }
    block.classList.remove('hidden');
    $('historyChips').innerHTML = S.history.map(function (w) {
      return '<button class="chip" data-hot="' + esc(w) + '">' + esc(w) + '</button>';
    }).join('');
  }

  function renderFav() {
    $('favCount').textContent = S.fav.length;
    var el = $('favList');
    if (!S.fav.length) {
      el.innerHTML = '<div class="empty">还没有收藏<small>播放页点 &#9825; 收藏喜欢的歌</small></div>';
      return;
    }
    el.innerHTML = S.fav.map(function (s, i) { return rowHTML(s, i, 'fav'); }).join('');
  }

  function currentPlSongs() {
    var pl = S.playlists.filter(function (p) { return p.id === S.plView; })[0];
    return pl ? pl.songs : [];
  }

  function renderPlaylists() {
    if (S.plView) {
      $('plIndex').classList.add('hidden');
      $('plDetail').classList.remove('hidden');
      var pl = S.playlists.filter(function (p) { return p.id === S.plView; })[0];
      if (!pl) { S.plView = null; renderPlaylists(); return; }
      $('plName').textContent = pl.name;
      $('plMeta').textContent = pl.songs.length + ' 首';
      $('plSongs').innerHTML = pl.songs.length
        ? pl.songs.map(function (s, i) { return rowHTML(s, i, 'pl'); }).join('')
        : '<div class="empty">这个歌单暂时没有可播放的歌曲<small>在歌曲「更多」里加入歌单</small></div>';
      return;
    }
    $('plIndex').classList.remove('hidden');
    $('plDetail').classList.add('hidden');
    $('playlistList').innerHTML = S.playlists.length
      ? S.playlists.map(function (p) {
          return '<div class="pl-row" data-pl="' + p.id + '">' +
            '<div class="pr-icon">&#9776;</div>' +
            '<div class="pr-text"><strong>' + esc(p.name) + '</strong>' +
            '<small>' + p.songs.length + ' 首</small></div>' +
            '<div class="pr-icon" style="background:none;color:#5f6d84">&#8250;</div></div>';
        }).join('')
      : '<div class="empty">还没有歌单<small>点「新建歌单」创建一个</small></div>';
  }

  function renderMine() {
    var rl = $('recentList');
    rl.innerHTML = S.recent.length
      ? S.recent.slice(0, 20).map(function (s, i) { return rowHTML(s, i, 'recent'); }).join('')
      : '<div class="empty">还没有播放记录<small>去听点什么吧</small></div>';

    renderDownloads();

    var parts = [];
    Object.keys(SRC_NAME).forEach(function (k) {
      var st = S.health[k];
      if (st) parts.push(SRC_NAME[k] + (st === 'ok' ? ' ✓' : st === 'empty' ? ' 空' : ' ✗'));
    });
    $('srcHealth').textContent = parts.length ? parts.join(' · ') : '搜索一次后显示';
  }

  function renderDownloads() {
    var el = $('downloadList');
    if (!S.downloads.length) {
      el.innerHTML = '<div class="empty">还没有下载<small>歌曲「更多」里选择下载</small></div>';
      $('dlHint').textContent = '本地记录';
      return;
    }
    var done = S.downloads.filter(function (d) { return d.status === 'done'; }).length;
    $('dlHint').textContent = done + ' 首已下载';
    el.innerHTML = S.downloads.map(function (d, i) {
      var sub = d.status === 'downloading' ? ('下载中 ' + d.pct + '%')
              : d.status === 'done' ? '已下载到 App 文档'
              : '下载失败';
      return '<div class="song-row" data-ctx="dl" data-i="' + i + '">' +
        '<div class="idx">' + (i + 1) + '</div>' +
        '<div class="s-main"><span class="s-name">' + esc(d.song.name) + '</span>' +
        '<span class="s-sub">' + esc(d.song.singer || '') + ' · ' + sub + '</span></div>' +
        '<div class="s-artist"></div><div class="s-dur"></div>' +
        '<div class="s-ops">' +
          (d.status === 'done' ? '<button data-act="play">&#9654;</button>' : '') +
          '<button data-act="more">&#8943;</button>' +
        '</div></div>';
    }).join('');
  }

  function renderQueue() {
    $('queueCount').textContent = S.queue.length + ' 首';
    $('queueList').innerHTML = S.queue.length
      ? S.queue.map(function (s, i) {
          var on = S.current && sameSong(s, S.current);
          return '<div class="song-row" data-ctx="queue" data-i="' + i + '">' +
            '<div class="idx">' + (on ? '&#9835;' : (i + 1)) + '</div>' +
            '<div class="s-main"><span class="s-name" style="' + (on ? 'color:#6de3cd' : '') + '">' + esc(s.name) + '</span>' +
            '<span class="s-sub">' + esc(s.singer || '') + '</span></div>' +
            '<div class="s-artist"></div><div class="s-dur"></div>' +
            '<div class="s-ops"><button data-act="play">&#9654;</button></div></div>';
        }).join('')
      : '<div class="empty">播放列表是空的</div>';
  }

  function updateMini() {
    var s = S.current;
    if (!s) { $('mini').classList.add('hidden'); return; }
    $('mini').classList.remove('hidden');
    $('miniTitle').textContent = s.name;
    $('miniArtist').textContent = (s.singer || '未知') + ' · ' + (SRC_NAME[s.source] || s.source);
    $('miniPlay').innerHTML = S.playing ? '&#10074;&#10074;' : '&#9654;';
  }

  function updateFull() {
    var s = S.current;
    $('fullTitle').textContent = s ? s.name : '未播放';
    $('fullArtist').textContent = s ? (s.singer || '未知歌手') : '—';
    $('fullSource').textContent = s ? ('音源 ' + (SRC_NAME[s.source] || s.source)) : '音源 —';
    $('btnQuality').textContent = '音质 ' + S.quality;
    $('btnPlay').innerHTML = S.playing ? '&#10074;&#10074;' : '&#9654;';
    $('btnFavCur').innerHTML = s && isFav(s) ? '&#9829;' : '&#9825;';
    $('btnFavCur').style.color = s && isFav(s) ? '#ff7b8a' : '';
    $('fullCover').classList.toggle('spin', !!S.playing);
    if (!mediaDur()) {
      $('totTime').textContent = s ? fmt(s.dur) : '0:00';
    }
    renderOrderSeg();
    renderTimer();
  }

  /* ================= actions ================= */

  function toggleFav(s) {
    var had = isFav(s);
    if (had) {
      S.fav = S.fav.filter(function (f) { return !sameSong(f, s); });
    } else {
      S.fav.unshift(JSON.parse(JSON.stringify(s)));
    }
    saveState();
    renderFav();
    renderSearchResults();
    renderNewSongs();
    renderPlaylists();
    updateFull();
    toast(had ? '已取消收藏' : '已收藏');
  }

  function addToPlaylist(s) {
    if (!S.playlists.length) {
      askText('新建歌单', '未命名歌单', function (name) {
        if (!name) return;
        var pl = { id: 'p' + Date.now(), name: name, songs: [] };
        S.playlists.push(pl);
        pl.songs.push(JSON.parse(JSON.stringify(s)));
        saveState(); renderPlaylists(); toast('已加入歌单');
      });
      return;
    }
    var opts = S.playlists.map(function (p) { return { label: p.name, fn: function () {
      if (p.songs.some(function (x) { return sameSong(x, s); })) { toast('歌单里已有这首'); return; }
      p.songs.push(JSON.parse(JSON.stringify(s)));
      saveState(); renderPlaylists(); toast('已加入歌单');
    } }; });
    opts.push({ label: '＋ 新建歌单', fn: function () { addToPlaylistNew(s); } });
    showSheet('加入歌单', opts);
  }
  function addToPlaylistNew(s) {
    askText('新建歌单', '未命名歌单', function (name) {
      if (!name) return;
      var pl = { id: 'p' + Date.now(), name: name, songs: [JSON.parse(JSON.stringify(s))] };
      S.playlists.push(pl);
      saveState(); renderPlaylists(); toast('已加入歌单');
    });
  }

  function downloadSong(s) {
    var id = 'dl' + (++S.seq);
    S.pending[id] = { song: s, download: true };
    status('正在解析下载链接：' + s.name + ' …');
    toast('正在解析下载链接');
    window.__invoke(id, s.source, S.quality, JSON.stringify(buildInfo(s)));
  }

  /* ================= modals ================= */

  function ensureModal() {
    var m = $('dgModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'dgModal';
    m.className = 'sheet';
    m.innerHTML = '<div class="sheet-panel" style="max-height:70%">' +
      '<div class="sheet-head"><strong id="dgModalTitle"></strong>' +
      '<span></span><button class="linkbtn" id="dgModalClose">收起</button></div>' +
      '<div id="dgModalBody" style="padding:10px 18px calc(14px + env(safe-area-inset-bottom));overflow-y:auto"></div>' +
      '</div>';
    document.body.appendChild(m);
    $('dgModalClose').addEventListener('click', function () { m.classList.remove('open'); });
    m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('open'); });
    return m;
  }

  function showSheet(title, items) {
    var m = ensureModal();
    $('dgModalTitle').textContent = title;
    var body = $('dgModalBody');
    body.innerHTML = '';
    items.forEach(function (it) {
      var b = document.createElement('button');
      b.className = 'setting-row';
      b.style.width = '100%';
      b.style.textAlign = 'left';
      b.innerHTML = '<span>' + esc(it.label) + '</span>';
      b.addEventListener('click', function () { m.classList.remove('open'); it.fn(); });
      body.appendChild(b);
    });
    m.classList.add('open');
  }

  function askText(title, def, cb) {
    var m = ensureModal();
    $('dgModalTitle').textContent = title;
    var body = $('dgModalBody');
    body.innerHTML = '<input id="dgAskInput" style="width:100%;padding:11px 14px;border-radius:10px;' +
      'border:1px solid #2a3448;background:#0f1420;color:#e9eef7;outline:none;margin-bottom:14px">' +
      '<div style="display:flex;gap:10px;justify-content:flex-end">' +
      '<button class="linkbtn" id="dgAskCancel">取消</button>' +
      '<button class="primary" id="dgAskOk" style="padding:9px 22px;border-radius:9px">确定</button></div>';
    var input = $('dgAskInput');
    input.value = def || '';
    m.classList.add('open');
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 120);
    $('dgAskCancel').addEventListener('click', function () { m.classList.remove('open'); });
    $('dgAskOk').addEventListener('click', function () {
      var v = input.value.trim();
      m.classList.remove('open');
      cb(v);
    });
  }

  /* ================= events ================= */

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  $('btnRefresh').addEventListener('click', function () {
    if (S.tab === 'home') {
      S.chartLoaded = false;
      loadCharts(true);
      toast('刷新中…');
    } else if (S.tab === 'search' && S.query) {
      search(S.query);
    } else {
      renderAll();
      toast('已刷新');
    }
  });

  $('hotWords').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-hot]');
    if (b) search(b.getAttribute('data-hot'));
  });
  $('historyChips').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-hot]');
    if (b) search(b.getAttribute('data-hot'));
  });
  $('btnClearHistory').addEventListener('click', function () {
    S.history = []; saveState(); renderHistory(); toast('已清空');
  });

  $('curatedGrid').addEventListener('click', function (e) {
    var c = e.target.closest('[data-cur]');
    if (!c) return;
    var item = CURATED[Number(c.getAttribute('data-cur'))];
    if (item) search(item.q, { label: '歌单 · ' + item.name });
  });

  $('chartGrid').addEventListener('click', function (e) {
    var c = e.target.closest('[data-chart]');
    if (!c) return;
    var id = Number(c.getAttribute('data-chart'));
    var chart = CHARTS.filter(function (x) { return x.id === id; })[0];
    var list = S.charts[id] || [];
    if (!list.length) { toast('榜单加载失败，回首页点刷新重试'); return; }
    S.curChart = id;
    S.results = list;
    S.resultLabel = chart.name;
    $('resultTitle').textContent = chart.name;
    $('resultHint').textContent = '共 ' + list.length + ' 首';
    S.tab = 'search';
    switchTab('search', true);
    renderSearchResults();
  });

  $('btnSearch').addEventListener('click', function () { search($('q').value); });
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); this.blur(); search(this.value); }
  });

  $('srcBar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-src]');
    if (!b) return;
    S.source = b.getAttribute('data-src');
    renderSrcBar();
    if (S.query) search(S.query);
  });
  function renderSrcBar() {
    var all = [{ k: 'all', n: '全部' }].concat(Object.keys(SRC_NAME).map(function (k) {
      return { k: k, n: SRC_NAME[k] };
    }));
    $('srcBar').innerHTML = all.map(function (x) {
      return '<button class="chip' + (S.source === x.k ? ' on' : '') + '" data-src="' + x.k + '">' + x.n + '</button>';
    }).join('');
  }

  $('searchResults').addEventListener('click', onSongClick);
  $('newSongs').addEventListener('click', onSongClick);
  $('favList').addEventListener('click', onSongClick);
  $('plSongs').addEventListener('click', onSongClick);
  $('recentList').addEventListener('click', onSongClick);
  $('downloadList').addEventListener('click', onSongClick);
  $('queueList').addEventListener('click', onSongClick);

  function onSongClick(e) {
    var btn = e.target.closest('button[data-act]');
    var row = e.target.closest('.song-row');
    if (!row) return;
    var list = ctxList(row.getAttribute('data-ctx'));
    var s = list[Number(row.getAttribute('data-i'))];
    if (!s) return;
    if (!btn) { playOne(list, Number(row.getAttribute('data-i'))); return; }
    var act = btn.getAttribute('data-act');
    if (act === 'play') playOne(list, Number(row.getAttribute('data-i')));
    else if (act === 'fav') toggleFav(s);
    else if (act === 'more') showSongActions(s);
  }

  function playOne(list, i) {
    S.queue = list.slice();
    S.qi = i;
    fbDepth = 0;
    fbTried = {};
    playSong(S.queue[i]);
  }

  function showSongActions(s) {
    showSheet(s.name, [
      { label: '▶ 立即播放', fn: function () { playOne([s], 0); } },
      { label: '♫ 加入播放列表', fn: function () {
          S.queue.push(JSON.parse(JSON.stringify(s))); renderQueue(); toast('已加入播放列表');
      } },
      { label: (isFav(s) ? '♥ 取消收藏' : '♡ 收藏'), fn: function () { toggleFav(s); } },
      { label: '＋ 加入歌单', fn: function () { addToPlaylist(s); } },
      { label: '↓ 下载', fn: function () { downloadSong(s); } }
    ]);
  }

  $('btnPlayAllFav').addEventListener('click', function () {
    if (!S.fav.length) { toast('还没有收藏'); return; }
    setQueue(S.fav, 0);
    toast('播放全部收藏');
  });
  $('btnClearFav').addEventListener('click', function () {
    if (!S.fav.length) return;
    showSheet('清空收藏？', [
      { label: '确认清空 ' + S.fav.length + ' 首', fn: function () {
          S.fav = []; saveState(); renderFav(); toast('已清空');
      } }
    ]);
  });

  $('btnNewPlaylist').addEventListener('click', function () {
    askText('新建歌单', '未命名歌单', function (name) {
      if (!name) return;
      S.playlists.push({ id: 'p' + Date.now(), name: name, songs: [] });
      saveState(); renderPlaylists(); toast('已创建');
    });
  });
  $('playlistList').addEventListener('click', function (e) {
    var r = e.target.closest('[data-pl]');
    if (!r) return;
    S.plView = r.getAttribute('data-pl');
    renderPlaylists();
  });
  $('btnPlBack').addEventListener('click', function () { S.plView = null; renderPlaylists(); });
  $('btnPlayAllPl').addEventListener('click', function () {
    var songs = currentPlSongs();
    if (!songs.length) { toast('这个歌单暂时没有可播放的歌曲'); return; }
    setQueue(songs, 0);
  });
  $('btnDelPl').addEventListener('click', function () {
    var pl = S.playlists.filter(function (p) { return p.id === S.plView; })[0];
    if (!pl) return;
    showSheet('删除歌单「' + pl.name + '」？', [
      { label: '确认删除', fn: function () {
          S.playlists = S.playlists.filter(function (p) { return p.id !== pl.id; });
          S.plView = null; saveState(); renderPlaylists(); toast('已删除');
      } }
    ]);
  });

  $('btnClearRecent').addEventListener('click', function () {
    S.recent = []; saveState(); renderMine(); toast('已清空');
  });

  $('btnClearDiag').addEventListener('click', function () {
    DIAG.length = 0; renderDiag(); toast('诊断已清空');
  });

  $('btnCopyDiag').addEventListener('click', function () {
    var txt = DIAG.map(function (x) { return x.t + ' [' + x.k + '] ' + x.m; }).join('\n');
    if (!txt) { toast('暂无诊断记录'); return; }
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var done = false;
    try { done = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    toast(done ? '诊断已复制' : '复制失败，请截图');
  });

  $('setQuality').addEventListener('change', function () {
    S.quality = this.value; saveState(); updateFull(); toast('默认音质 ' + this.value);
  });
  $('setMode').addEventListener('change', function () {
    S.mode = this.value; saveState(); renderOrderSeg(); updateFull();
    toast(this.options[this.selectedIndex].text);
  });

  /* mini / full player. The tappable region is a real <button>: iOS only
     reliably synthesises `click` for interactive elements, so a plain div
     could swallow the tap. Transport buttons are excluded explicitly. */
  function openFull() {
    var f = $('full');
    if (!f) { window.__dgLog('ui', 'openFull: #full missing'); return; }
    /* 兜底：iOS 13 WebKit 不认 CSS 的 inset 简写，若样式表里那条被丢弃，
       #full 就会变成「无偏移 + 收缩宽度」，打开后停在文档流末尾（屏幕外），
       表现就是「点了没反应」。这里用内联样式再钉一次铺满视口。 */
    var st = f.style;
    st.position = 'fixed';
    st.top = '0'; st.right = '0'; st.bottom = '0'; st.left = '0';
    st.width = '100%'; st.height = '100%';
    f.classList.add('open');

    var vis = '';
    try { vis = window.getComputedStyle(f).visibility; } catch (e) {}
    window.__dgLog('ui', 'openFull open=' + f.classList.contains('open') + ' vis=' + vis);

    /* 过渡跑完再量一次真实几何，判断「打开了但不在视口内」这类问题 */
    setTimeout(function () {
      var r = null, vw = 0, vh = 0;
      try { r = f.getBoundingClientRect(); vw = window.innerWidth; vh = window.innerHeight; } catch (e) {}
      if (!r) { window.__dgLog('ui', 'openFull rect=?'); return; }
      var onScreen = (r.top < vh - 40) && (r.top > -40) && r.width > 40;
      window.__dgLog('ui', 'openFull rect=' + Math.round(r.left) + ',' + Math.round(r.top) +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
        ' vp=' + vw + 'x' + vh + ' onScreen=' + onScreen);
    }, 360);

    updateFull();
    loadLyrics(S.current);
    paintLyric(true);
  }

  /* 底栏 → 播放页：双通道绑定。
     ① 直接绑真按钮 #miniOpen（iOS 对 <button> 的 click 合成最可靠）；
     ② 再在 #mini 上兜一层冒泡，覆盖右侧 14px 内边距等按钮外的空白区。
     按钮那一路 stopPropagation，不会重复触发。 */
  $('mini').addEventListener('click', function (e) {
    if (e.target.closest('.mini-btn') || e.target.closest('.mini-open')) return;
    window.__dgLog('ui', 'mini tap (container)');
    if (!S.current) { toast('先选一首歌'); return; }
    openFull();
  });

  (function () {
    var mo = $('miniOpen');
    if (!mo) { window.__dgLog('ui', 'miniOpen 未找到'); return; }
    mo.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      window.__dgLog('ui', 'mini tap (button)');
      if (!S.current) { toast('先选一首歌'); return; }
      openFull();
    });
  })();

  $('btnCloseFull').addEventListener('click', function () { $('full').classList.remove('open'); });
  $('miniPlay').addEventListener('click', togglePlay);
  $('btnPlay').addEventListener('click', togglePlay);
  $('miniNext').addEventListener('click', function () { next(false); });
  $('btnNext').addEventListener('click', function () { next(false); });
  $('btnPrev').addEventListener('click', prev);

  function togglePlay() {
    if (!S.current) { toast('先选一首歌'); return; }
    if (NAT.on) {
      if (S.playing) { window.DG.pause(); S.playing = false; }
      else { window.DG.resume(); S.playing = true; }
      updateMini(); updateFull();
      return;
    }
    if (!audio.src) { toast('先选一首歌'); return; }
    if (audio.paused) audio.play(); else audio.pause();
  }

  /* iOS 13 WebKit does not always synthesise `click` for taps inside a
     transformed / fixed full-screen layer. Handle touchend as well, with a
     short de-dupe window so the trailing synthetic click cannot double-fire. */
  function bindTap(el, fn) {
    if (!el) return;
    var lastTouch = 0;
    el.addEventListener('touchend', function (e) {
      lastTouch = Date.now();
      try { fn(e); } catch (err) { window.__dgLog('ui', 'tap err ' + ((err && err.message) || err)); }
    }, false);
    el.addEventListener('click', function (e) {
      if (Date.now() - lastTouch < 700) return;
      try { fn(e); } catch (err) { window.__dgLog('ui', 'tap err ' + ((err && err.message) || err)); }
    }, false);
  }

  /* play order */
  bindTap($('orderSeg'), function (e) {
    var t = e.target;
    var b = t && t.closest ? t.closest('button[data-mode]') : null;
    if (!b) return;
    window.__dgLog('ui', 'order tap ' + b.getAttribute('data-mode'));
    setMode(b.getAttribute('data-mode'));
  });

  /* sleep timer */
  bindTap($('btnTimer'), function () {
    window.__dgLog('ui', 'timer tap open sheet');
    renderTimer();
    $('timerSheet').classList.add('open');
  });
  bindTap($('btnCloseTimer'), function () { $('timerSheet').classList.remove('open'); });
  bindTap($('timerSheet'), function (e) {
    var t = e.target;
    if (t === $('timerSheet')) { $('timerSheet').classList.remove('open'); return; }
    var b = t && t.closest ? t.closest('.timer-opt') : null;
    if (!b) return;
    window.__dgLog('ui', 'timer tap option ' + b.getAttribute('data-min'));
    setTimer(Number(b.getAttribute('data-min')));
  });

  $('btnFavCur').addEventListener('click', function () {
    if (S.current) toggleFav(S.current);
  });
  $('btnQuality').addEventListener('click', function () {
    var order = ['128k', '320k', 'flac', 'flac24bit'];
    S.quality = order[(order.indexOf(S.quality) + 1) % order.length];
    $('setQuality').value = S.quality;
    saveState(); updateFull();
    toast('音质 ' + S.quality);
  });
  $('btnQueue').addEventListener('click', function () {
    renderQueue();
    $('sheet').classList.add('open');
  });
  $('btnCloseSheet').addEventListener('click', function () { $('sheet').classList.remove('open'); });
  $('sheet').addEventListener('click', function (e) {
    if (e.target === $('sheet')) $('sheet').classList.remove('open');
  });

  $('seek').addEventListener('input', function () {
    var d = mediaDur();
    if (d > 0 && isFinite(d)) seekTo(d * (this.value / 1000));
  });

  audio.addEventListener('timeupdate', function () {
    if (NAT.on) return;
    paintProgress();
  });
  audio.addEventListener('play', function () {
    if (NAT.on) return;
    S.playing = true; updateMini(); updateFull();
  });
  audio.addEventListener('pause', function () {
    if (NAT.on) return;
    S.playing = false; updateMini(); updateFull();
  });
  audio.addEventListener('ended', function () {
    if (NAT.on) return;
    if (timerBlocksNext()) return;
    if (S.mode === 'single') { audio.currentTime = 0; audio.play(); return; }
    next(true);
  });
  audio.addEventListener('error', function () {
    if (NAT.on) return;
    var e = audio.error;
    window.__dgLog('audio', 'error code=' + (e ? e.code : '?') + ' msg=' + (e && e.message ? e.message : '-') +
                          ' net=' + audio.networkState + ' src=' + String(audio.src || '').slice(0, 80));
    status('无法播放该链接');
  });

  /* ================= boot ================= */

  window.__onHostReady = function () {
    status(window.__engineReady ? '五源引擎已就绪' : '取链引擎初始化失败');
    $('srcHealth').textContent = '搜索一次后显示';
    window.__dgLog('boot', 'hostReady engine=' + !!window.__engineReady);
  };

  window.__dgLog('boot', 'engine=' + !!window.__engineReady +
                         ' handlerAtLoad=' + (window.__engineHandlerAtLoad || '?') +
                         ' handlerNow=' + (window.__engineHandlerType ? window.__engineHandlerType() : '?'));
  if (window.__dgEarly && window.__dgEarly.length) {
    window.__dgEarly.forEach(function (m) { window.__dgLog('jserr', m); });
    window.__dgEarly.length = 0;
  }

  renderSrcBar();
  renderOrderSeg();
  renderTimer();
  startTimerLoop();
  switchTab('home');
  renderAll();
  loadLocalFallback();
  setTimeout(function () {
    status(window.__engineReady ? '五源引擎已就绪' : '取链引擎启动中…');
  }, 500);
})();
