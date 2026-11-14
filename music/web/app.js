/*
 * Dongge Music - UI + search layer.
 * Uses window.lx.request (native HTTP bridge) for searches and
 * window.__invoke (original plugin.js engine) for playback URLs.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var SRC_NAME = { tx: 'QQ音乐', wy: '网易云', kg: '酷狗', kw: '酷我', mg: '咪咕' };
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

  var state = {
    source: 'all', quality: '128k', view: 'search',
    results: [], fav: [], pending: {}, seq: 0,
    current: null, currentUrl: ''
  };
  var audio = $('audio');
  audio.volume = 0.8;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) {
    sec = Number(sec) || 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function status(msg) { $('status').textContent = msg; }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show';
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.className = 'toast'; }, 2400);
  }
  function log(msg) { if (window.DG) { try { DG.log(msg); } catch (e) {} } }

  /* ---------------- search providers ---------------- */

  function pickSinger(v) {
    if (Array.isArray(v)) return v.map(function (x) { return x && (x.name || x.singerName) || ''; }).filter(Boolean).join(' / ');
    return String(v || '');
  }

  function mgFindLists(o, out, depth) {
    if (!o || depth > 7) return;
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length && i < 60; i++) mgFindLists(o[i], out, depth + 1);
      return;
    }
    if (typeof o !== 'object') return;
    var arr = o.resultList || o.songList || o.songs || o.list;
    if (Array.isArray(arr) && arr.length && arr[0] &&
        (arr[0].copyrightId || arr[0].contentId || arr[0].songId || arr[0].songName || arr[0].name)) {
      out.push(arr);
      return;
    }
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) mgFindLists(o[k], out, depth + 1);
  }

  var SOURCES = {
    tx: {
      name: 'QQ音乐',
      url: function (q) {
        return 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=20&w=' + encodeURIComponent(q) + '&format=json';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.data && j.data.song && j.data.song.list) || (j.data && j.data.list) || [];
        return list.map(function (s) {
          var singer = pickSinger(s.singer);
          var name = s.songname || s.title || '';
          return {
            source: 'tx', songmid: String(s.songmid || s.songid || ''),
            name: name, singer: singer, album: s.albumname || '',
            duration: Number(s.interval || s.duration) || 0,
            extra: { mediaMid: s.media_mid || s.strMediaMid || '', title: name, name: name, singer: singer, artist: singer }
          };
        }).filter(function (x) { return x.songmid && x.name; });
      }
    },
    wy: {
      name: '网易云',
      url: function (q) {
        return 'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=1&offset=0&limit=20';
      },
      opts: {
        method: 'POST', timeout: 12000, body: '',
        headers: { 'Referer': 'https://music.163.com/', 'User-Agent': UA,
                   'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'appver=2.0.2' }
      },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.result && j.result.songs) || [];
        return list.map(function (s) {
          return {
            source: 'wy', songmid: String(s.id || ''),
            name: s.name || '', singer: pickSinger(s.artists || s.ar),
            album: (s.album && s.album.name) || '',
            duration: Math.round((Number(s.duration) || 0) / 1000),
            extra: {}
          };
        }).filter(function (x) { return x.songmid && x.name; });
      }
    },
    kg: {
      name: '酷狗',
      url: function (q) {
        return 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(q) +
               '&page=1&pagesize=20&platform=WebFilter';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'https://www.kugou.com/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = (j.data && (j.data.lists || j.data.list)) || [];
        return list.map(function (s) {
          var hash = s.FileHash || s.HQFileHash || s.SQFileHash || s.ResFileHash || '';
          var singer = String(s.SingerName || '').replace(/<[^>]*>/g, '');
          return {
            source: 'kg', songmid: String(hash || s.SongId || ''),
            name: String(s.SongName || s.FileName || '').replace(/<[^>]*>/g, ''),
            singer: singer, album: s.AlbumName || '',
            duration: Number(s.Duration) || 0,
            extra: { hash: hash, songmid: hash }
          };
        }).filter(function (x) { return x.songmid && x.name; });
      }
    },
    kw: {
      name: '酷我',
      url: function (q) {
        return 'https://search.kuwo.cn/r.s?all=' + encodeURIComponent(q) +
               '&ft=music&itemset=web_2013&client=kt&pn=0&rn=20&rformat=json&encoding=utf8';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'Referer': 'http://www.kuwo.cn/', 'User-Agent': UA } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var list = j.abslist || (j.data && j.data.abslist) || [];
        return list.map(function (s) {
          var raw = String(s.MUSICRID || s.musicrid || '');
          var rid = raw.replace(/^MUSIC_/i, '');
          if (!rid) rid = String(s.songid || s.MUSIC_ID || '');
          var name = String(s.SONGNAME || s.songname || '').replace(/&nbsp;/g, ' ');
          var singer = String(s.ARTIST || s.artist || '').replace(/&nbsp;/g, ' ');
          return {
            source: 'kw', songmid: rid, name: name, singer: singer,
            album: s.ALBUM || '', duration: Number(s.DURATION || s.duration) || 0,
            extra: { rid: rid, name: name, title: name, singer: singer, artist: singer }
          };
        }).filter(function (x) { return x.songmid && x.name; });
      }
    },
    mg: {
      name: '咪咕',
      url: function (q) {
        return 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.1&text=' +
               encodeURIComponent(q) + '&pageNo=1&pageSize=20';
      },
      opts: { method: 'GET', timeout: 12000, headers: { 'User-Agent': UA, 'Referer': 'https://music.migu.cn/' } },
      parse: function (txt) {
        var j = JSON.parse(txt);
        var lists = [];
        mgFindLists(j, lists, 0);
        var list = lists[0] || [];
        return list.map(function (s) {
          var cid = String(s.copyrightId || '');
          var cont = String(s.contentId || '');
          var sid = String(s.songId || s.id || '');
          var name = String(s.songName || s.name || s.title || '');
          var singer = String(s.singerName || s.singer || '');
          if (!singer && Array.isArray(s.singers)) singer = pickSinger(s.singers);
          var mid = cid || cont || sid;
          return {
            source: 'mg', songmid: mid, name: name, singer: singer,
            album: (s.albumName || (s.albums && s.albums[0] && s.albums[0].name)) || '',
            duration: Number(s.duration) || 0,
            extra: { contentId: cont, copyrightId: cid, songId: sid, songmid: mid }
          };
        }).filter(function (x) { return x.songmid && x.name; });
      }
    }
  };

  /* ---------------- musicInfo for plugin.js ---------------- */

  function buildInfo(it) {
    var q = state.quality;
    var base = {
      source: it.source,
      songmid: it.songmid, id: it.songmid, rid: it.songmid,
      hash: it.songmid, name: it.name, title: it.name,
      singer: it.singer, artist: it.singer,
      interval: it.duration || 0,
      contentId: it.songmid, copyrightId: it.songmid, songId: it.songmid,
      mediaMid: '', album: it.album || '', albumName: it.album || '',
      types: [{ type: q, size: '0' }, { type: '128k', size: '0' }, { type: '320k', size: '0' }, { type: 'flac', size: '0' }],
      _types: { '128k': { size: '0' }, '320k': { size: '0' }, flac: { size: '0' }, flac24bit: { size: '0' } }
    };
    if (it.extra) {
      for (var k in it.extra) {
        if (Object.prototype.hasOwnProperty.call(it.extra, k) &&
            it.extra[k] !== undefined && it.extra[k] !== null && it.extra[k] !== '') {
          base[k] = it.extra[k];
        }
      }
    }
    return base;
  }

  /* ---------------- search ---------------- */

  function search() {
    var q = $('q').value.trim();
    if (!q) { toast('请输入歌名或歌手'); return; }
    state.view = 'search';
    var keys = state.source === 'all' ? Object.keys(SOURCES) : [state.source];
    $('list').innerHTML = '<div class="empty">正在搜索「' + esc(q) + '」&hellip;</div>';
    status('搜索中…');

    var jobs = keys.map(function (k) {
      var d = SOURCES[k];
      var opts = {};
      for (var p in d.opts) if (Object.prototype.hasOwnProperty.call(d.opts, p)) opts[p] = d.opts[p];
      return lx.request(d.url(q), opts).then(function (r) {
        var arr = [];
        try { arr = d.parse(r.body); }
        catch (e) { log(k + ' parse error: ' + e.message + ' body=' + String(r.body).slice(0, 120)); }
        return { key: k, list: arr, err: null };
      }).catch(function (e) {
        return { key: k, list: [], err: (e && e.message) || 'error' };
      });
    });

    Promise.all(jobs).then(function (res) {
      var all = [], parts = [];
      res.forEach(function (x) {
        all = all.concat(x.list);
        parts.push(SOURCES[x.key].name + ' ' + x.list.length + (x.err ? '(失败)' : ''));
      });
      state.results = all;
      renderList();
      status('共 ' + all.length + ' 首 · ' + parts.join(' / '));
      if (!all.length) toast('没搜到结果，检查网络或换个关键词');
    });
  }

  /* ---------------- list / favourites ---------------- */

  function isFav(it) {
    return state.fav.some(function (f) { return f.source === it.source && f.songmid === it.songmid; });
  }
  function saveFav() {
    var json = JSON.stringify(state.fav);
    try { localStorage.setItem('dg_fav', json); } catch (e) {}
    if (window.DG) { try { DG.fav(json); } catch (e) {} }
  }
  function toggleFav(it) {
    var had = isFav(it);
    if (had) {
      state.fav = state.fav.filter(function (f) { return !(f.source === it.source && f.songmid === it.songmid); });
    } else {
      var copy = {};
      for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k)) copy[k] = it[k];
      state.fav.unshift(copy);
    }
    saveFav();
    $('favCount').textContent = state.fav.length;
    renderList();
    toast(had ? '已取消收藏' : '已收藏');
  }

  function renderList() {
    var el = $('list');
    var items = state.view === 'fav' ? state.fav : state.results;
    if (!items.length) {
      el.innerHTML = '<div class="empty">' + (state.view === 'fav' ? '还没有收藏歌曲' : '输入关键词开始搜索') + '</div>';
      return;
    }
    var html = '';
    items.forEach(function (it, i) {
      html += '<div class="row" data-i="' + i + '">' +
        '<div class="cell song"><b>' + esc(it.name) + '</b><small>' + esc(it.album || '') + '</small></div>' +
        '<div class="cell artist">' + esc(it.singer || '未知') + '</div>' +
        '<div class="cell dur">' + fmt(it.duration) + '</div>' +
        '<div class="cell src"><span class="badge b-' + esc(it.source) + '">' + esc(SRC_NAME[it.source] || it.source) + '</span></div>' +
        '<div class="cell ops">' +
          '<button data-act="play" title="播放">&#9654;</button>' +
          '<button data-act="fav" title="收藏">' + (isFav(it) ? '&#9829;' : '&#9825;') + '</button>' +
          '<button data-act="dl" title="下载">&#8595;</button>' +
        '</div></div>';
    });
    el.innerHTML = html;
  }

  /* ---------------- playback / url resolution ---------------- */

  function safeName(it) {
    return (it.name + ' - ' + (it.singer || '') + '.mp3').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  }

  function resolve(it, forDownload) {
    if (!window.__engineReady) { toast('音源引擎未就绪'); return; }
    if (typeof window.__invoke !== 'function') { toast('取链引擎不可用'); return; }
    var id = (forDownload ? 'd' : 'u') + (++state.seq);
    state.pending[id] = { item: it, download: !!forDownload };
    status((forDownload ? '取链用于下载：' : '正在取链：') + it.name + ' …');
    window.__invoke(id, it.source, state.quality, JSON.stringify(buildInfo(it)));
    setTimeout(function () {
      if (state.pending[id]) {
        delete state.pending[id];
        status('取链超时，试试换音质或换源');
        toast('取链失败');
      }
    }, 32000);
  }

  window.__onUrl = function (id, url) {
    var p = state.pending[id];
    if (!p) return;
    delete state.pending[id];
    if (!url || !/^https?:\/\//i.test(url)) {
      status('未取到播放链接，可切换音质后重试');
      toast('取链失败');
      return;
    }
    if (p.download) {
      if (window.DG) { DG.download(url, safeName(p.item)); toast('已开始下载'); status('下载中：' + p.item.name); }
      return;
    }
    var it = p.item;
    state.current = it;
    state.currentUrl = url;
    $('pTitle').textContent = it.name;
    $('pArtist').textContent = (it.singer || '未知') + ' · ' + (SRC_NAME[it.source] || it.source);
    audio.src = url;
    var pr = audio.play();
    if (pr && pr.then) {
      pr.then(function () {
        $('playBtn').innerHTML = '&#10074;&#10074;';
        status('正在播放：' + it.name);
      }).catch(function (e) {
        status('播放失败：' + ((e && e.message) || '链接可能已失效'));
        toast('播放失败');
      });
    }
  };

  window.__onDownload = function (name, ok) {
    status(ok ? '下载完成：' + name : '下载失败：' + name);
    toast(ok ? '已保存到 App 文档 / Downloads' : '下载失败');
  };

  window.__initFav = function (json) {
    try {
      var arr = JSON.parse(json);
      if (Array.isArray(arr)) state.fav = arr;
    } catch (e) {}
    $('favCount').textContent = state.fav.length;
    if (state.view === 'fav') renderList();
  };

  window.__onHostReady = function () {
    $('engineState').textContent = window.__engineReady ? '五源取链引擎已就绪' : '音源引擎未就绪';
    try {
      var local = localStorage.getItem('dg_fav');
      if (local && !state.fav.length) {
        var arr = JSON.parse(local);
        if (Array.isArray(arr)) { state.fav = arr; $('favCount').textContent = arr.length; }
      }
    } catch (e) {}
  };

  /* ---------------- events ---------------- */

  $('searchBtn').addEventListener('click', search);
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); this.blur(); search(); }
  });
  $('quality').addEventListener('change', function () {
    state.quality = this.value;
    toast('音质切换为 ' + this.value);
  });

  Array.prototype.forEach.call(document.querySelectorAll('.srctab[data-src]'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.srctab'), function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.source = btn.getAttribute('data-src');
      state.view = 'search';
      if ($('q').value.trim()) search(); else renderList();
    });
  });

  $('favTab').addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.srctab'), function (b) { b.classList.remove('active'); });
    this.classList.add('active');
    state.view = 'fav';
    renderList();
    status('收藏 ' + state.fav.length + ' 首');
  });

  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var row = btn.closest('.row');
    if (!row) return;
    var items = state.view === 'fav' ? state.fav : state.results;
    var it = items[Number(row.getAttribute('data-i'))];
    if (!it) return;
    var act = btn.getAttribute('data-act');
    if (act === 'play') resolve(it, false);
    else if (act === 'fav') toggleFav(it);
    else if (act === 'dl') resolve(it, true);
  });

  $('playBtn').addEventListener('click', function () {
    if (!audio.src) { toast('先选一首歌'); return; }
    if (audio.paused) {
      audio.play();
      this.innerHTML = '&#10074;&#10074;';
    } else {
      audio.pause();
      this.innerHTML = '&#9654;';
    }
  });
  $('seek').addEventListener('input', function () {
    if (audio.duration && isFinite(audio.duration)) audio.currentTime = audio.duration * (this.value / 1000);
  });
  $('vol').addEventListener('input', function () { audio.volume = this.value / 100; });

  audio.addEventListener('timeupdate', function () {
    $('curTime').textContent = fmt(audio.currentTime);
    $('totTime').textContent = fmt(audio.duration);
    if (audio.duration && isFinite(audio.duration)) $('seek').value = Math.round(audio.currentTime / audio.duration * 1000);
  });
  audio.addEventListener('pause', function () { $('playBtn').innerHTML = '&#9654;'; });
  audio.addEventListener('play', function () { $('playBtn').innerHTML = '&#10074;&#10074;'; });
  audio.addEventListener('ended', function () { $('playBtn').innerHTML = '&#9654;'; status('播放结束'); });
  audio.addEventListener('error', function () { status('音频加载失败，换音质或换源试试'); });

  renderList();
  setTimeout(function () {
    $('engineState').textContent = window.__engineReady ? '五源取链引擎已就绪' : '音源引擎未就绪';
  }, 600);
})();
