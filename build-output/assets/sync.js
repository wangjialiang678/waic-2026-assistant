/* ============================================================
   sync.js — 无登录跨端同步（匿名同步码 + 服务端 /api/state）
   ------------------------------------------------------------
   高频状态（日程/兴趣）本地 localStorage 即时读写、离线可用；
   低频地把本地状态同步到服务端（键=匿名同步码 device），
   实现「多设备 + AI agent skill」间同步，并为社交速配提供服务端兴趣数据。
   合并策略：整体 last-write-wins（按客户端 updated_at）。后端也做 LWW。
   ============================================================ */
(function () {
  'use strict';
  var DEVICE_KEY = 'waic2026.device.v1';
  var META_KEY = 'waic2026.syncmeta.v1';      // { updated_at }
  var MYSCHED_KEY = 'waic2026.myschedule.v1';  // 与 app.js/activity.js 一致
  var PROFILE_KEY = 'waic2026.profile.v1';     // { interests, inferred?, contact? }
  var API_BASE = '';                            // 同源 /api
  var PUSH_DELAY = 1200;

  var pushTimer = null;
  var syncing = false;

  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }

  // 友好同步码：8 位无歧义字符 + 中间连字符，如 K7M2-9QXP（满足后端 ^[A-Za-z0-9-]{6,40}$）
  function genCode() {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混 0/O/1/I
    var out = '';
    try {
      var a = new Uint8Array(8); crypto.getRandomValues(a);
      for (var i = 0; i < 8; i++) out += abc[a[i] % abc.length];
    } catch (e) {
      for (var j = 0; j < 8; j++) out += abc[Math.floor(Math.random() * abc.length)];
    }
    return out.slice(0, 4) + '-' + out.slice(4);
  }
  function device() {
    var d = null;
    try { d = localStorage.getItem(DEVICE_KEY); } catch (e) {}
    if (!d) { d = genCode(); try { localStorage.setItem(DEVICE_KEY, d); } catch (e) {} }
    return d;
  }

  function readJSON(k, def) { try { return JSON.parse(localStorage.getItem(k) || def); } catch (e) { try { return JSON.parse(def); } catch (e2) { return null; } } }
  function meta() { return readJSON(META_KEY, '{}') || {}; }
  function setMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }
  function localSchedule() { return readJSON(MYSCHED_KEY, '[]') || []; }
  function localProfile() { var p = readJSON(PROFILE_KEY, '{}') || {}; if (!Array.isArray(p.interests)) p.interests = []; return p; }

  function hasLocalData() {
    var p = localProfile();
    return localSchedule().length > 0 || (p.interests && p.interests.length > 0) || !!meta().updated_at;
  }

  // 触发：本地状态变了 → 记新时间戳 + 稍后推送（防抖）
  function touch() {
    var m = meta(); m.updated_at = nowIso(); setMeta(m);
    pushSoon();
  }
  function pushSoon() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(); }, PUSH_DELAY);
  }

  function apiUrl(p) { return (API_BASE || '') + p; }

  function push() {
    var dev = device();
    var p = localProfile();
    var body = {
      device: dev,
      schedule: localSchedule(),
      interests: p.interests || [],
      inferred: p.inferred || {},
      contact: p.contact || null,
      updated_at: meta().updated_at || nowIso()
    };
    try {
      fetch(apiUrl('/api/state'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), keepalive: true
      }).then(function (r) {
        if (r && r.ok) { var m = meta(); m.last_push = nowIso(); setMeta(m); }
      }).catch(function () {});
    } catch (e) {}
  }

  // 拉取：服务端更新则采用（整体 LWW）；否则把本地推上去
  function pull() {
    if (syncing) return Promise.resolve();
    // 全新访客（无任何本地数据）不打服务端，减少无谓请求
    if (!hasLocalData()) return Promise.resolve();
    syncing = true;
    var dev = device();
    return fetch(apiUrl('/api/state?device=' + encodeURIComponent(dev)))
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (srv) {
        if (!srv) return;
        var localTs = meta().updated_at || '';
        var srvTs = srv.updated_at || '';
        if (srvTs && srvTs > localTs) {
          // 服务端较新 → 采用服务端整体状态
          try { localStorage.setItem(MYSCHED_KEY, JSON.stringify(srv.schedule || [])); } catch (e) {}
          var p = localProfile();
          p.interests = srv.interests || [];
          if (srv.inferred) p.inferred = srv.inferred;
          if (srv.contact) p.contact = srv.contact;
          try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
          var m = meta(); m.updated_at = srvTs; setMeta(m);
          try { window.dispatchEvent(new CustomEvent('waic-sync', { detail: { from: 'server' } })); } catch (e) {}
        } else if (localTs && (!srvTs || localTs > srvTs)) {
          push();  // 本地较新 → 推上去
        }
      })
      .catch(function () {})
      .then(function () { syncing = false; });
  }

  // 社交/联系方式：写入 profile.contact 并同步
  function setContact(contact) {
    var p = localProfile(); p.contact = contact; try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {}
    touch();
  }
  function getContact() { return localProfile().contact || null; }

  window.WAICSync = {
    device: device,
    code: device,            // 展示用（已含连字符）
    pull: pull,
    push: push,
    touch: touch,
    setContact: setContact,
    getContact: getContact
  };

  // 载入即尝试拉取（有本地数据才打服务端）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { pull(); });
  } else { pull(); }

  // 离开页面时保底推一次
  window.addEventListener('pagehide', function () { if (pushTimer) { clearTimeout(pushTimer); push(); } });
})();
