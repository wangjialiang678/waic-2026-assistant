/* ============================================================
   planner.js — 一日行程规划器（借鉴 HiWAIC「AI 搭子」/ WaytoAGI 路线工作台）。
   纯客户端确定性算法：按天 + 你的关注方向 + 节奏 → 无撞车、尽量少换片区的推荐动线。
   依赖 app.js 的全局 DATA / window.WAICMine。
   ============================================================ */
(function () {
  'use strict';
  const DAY_LABEL = { '1': '7/17 周五', '2': '7/18 周六', '3': '7/19 周日', '4': '7/20 周一' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function interests() { try { return (JSON.parse(localStorage.getItem('waic2026.profile.v1') || '{}').interests) || []; } catch (e) { return []; } }
  function toMin(t) { const m = /(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1] * 60 + +m[2]) : null; }

  function relScore(a, ints) {
    const prim = ((a.title || '') + ' ' + (a.tags || []).join(' ') + ' ' + (a.track || '')).toLowerCase();
    const desc = (a.description || '').toLowerCase();
    let s = 0;
    ints.forEach(kw => {
      kw = String(kw).toLowerCase();
      const nkw = kw.replace(/ai|人工智能|\+|·|\s/g, '');
      if (kw && prim.indexOf(kw) >= 0) s += 3;
      else if (nkw && nkw.length >= 2 && prim.indexOf(nkw) >= 0) s += 2;
      else if ((kw && desc.indexOf(kw) >= 0) || (nkw && nkw.length >= 2 && desc.indexOf(nkw) >= 0)) s += 1;
    });
    return s;
  }

  function plan(day, pace) {
    const ints = interests();
    const cands = (DATA.activities || []).filter(a =>
      ['official_program', 'side_event', 'community'].indexOf(a.kind) >= 0 &&
      String(a.day) === String(day) && a.start_time);
    cands.forEach(a => {
      a._plscore = relScore(a, ints) + (a.weight || 0) / 25 + ((a.title || '').indexOf('超脑') >= 0 ? 4 : 0);
    });
    cands.sort((x, y) => (y._plscore - x._plscore) || (toMin(x.start_time) - toMin(y.start_time)));
    const picked = [];
    cands.forEach(a => {
      if (picked.length >= pace) return;
      const s = toMin(a.start_time); if (s == null) return;
      const e = toMin(a.end_time) || s + 90;
      const clash = picked.some(p => { const ps = toMin(p.start_time), pe = toMin(p.end_time) || ps + 90; return s < pe && ps < e; });
      if (!clash) picked.push(a);
    });
    picked.sort((x, y) => toMin(x.start_time) - toMin(y.start_time));
    return { picked, matched: ints.length ? cands.filter(a => relScore(a, ints) > 0).length : cands.length };
  }

  let root = null, current = { day: '1', pace: 3, result: null };

  function ensure() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'pl-root'; root.hidden = true;
    root.innerHTML = `<div class="pl-mask"></div><div class="pl-panel" role="dialog" aria-modal="true">
      <header class="pl-head"><span class="pl-title">🗓 一日行程规划</span><button class="pl-x" aria-label="关闭">✕</button></header>
      <div class="pl-body" id="pl-body"></div></div>`;
    document.body.appendChild(root);
    root.querySelector('.pl-x').addEventListener('click', close);
    root.querySelector('.pl-mask').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) close(); });
  }
  function close() { root.hidden = true; document.body.classList.remove('soc-lock'); }

  function open(day) {
    ensure();
    current.day = String(day || (window.F && F.official && F.official.day) || '1');
    if (!DAY_LABEL[current.day]) current.day = '1';
    current.result = null;
    root.hidden = false; document.body.classList.add('soc-lock');
    render();
  }

  function render() {
    const ints = interests();
    const body = root.querySelector('#pl-body');
    const dayTabs = ['1', '2', '3', '4'].map(d =>
      `<button class="pl-day${current.day === d ? ' on' : ''}" data-day="${d}">Day ${d} <span>${DAY_LABEL[d]}</span></button>`).join('');
    const paceBtns = [2, 3, 4].map(p =>
      `<button class="pl-pace${current.pace === p ? ' on' : ''}" data-pace="${p}">${p} 场</button>`).join('');
    let html = `
      <div class="pl-form">
        <div class="pl-fk">选哪天</div><div class="pl-days">${dayTabs}</div>
        <div class="pl-fk">今天想赶几场（节奏）</div><div class="pl-paces">${paceBtns}</div>
        <div class="pl-fk">按你的关注方向排</div>
        <div class="pl-ints">${ints.length ? ints.slice(0, 8).map(i => `<span>${esc(i)}</span>`).join('') : '<em>还没设关注方向——会按大会重要度排。到「AI 助手」里可设置。</em>'}</div>
        <button class="pl-gen" id="pl-gen">生成推荐动线 →</button>
      </div>
      <div id="pl-result"></div>`;
    body.innerHTML = html;
    body.querySelectorAll('.pl-day').forEach(b => b.addEventListener('click', () => { current.day = b.dataset.day; current.result = null; render(); }));
    body.querySelectorAll('.pl-pace').forEach(b => b.addEventListener('click', () => { current.pace = +b.dataset.pace; render(); }));
    body.querySelector('#pl-gen').addEventListener('click', generate);
    if (current.result) renderResult();
  }

  function generate() { current.result = plan(current.day, current.pace); renderResult(); }

  function renderResult() {
    const r = current.result; if (!r) return;
    const box = root.querySelector('#pl-result');
    if (!r.picked.length) { box.innerHTML = `<div class="pl-empty">这一天没排出合适的场次，换个节奏或去掉筛选试试。</div>`; return; }
    let lastDist = '';
    const rows = r.picked.map(a => {
      const t = a.start_time + (a.end_time ? '–' + a.end_time : '');
      const sw = (a.district && a.district !== lastDist) ? `<div class="pl-switch">↧ 移动到 ${esc(a.district)}（留出换馆时间）</div>` : '';
      lastDist = a.district || lastDist;
      const sb = (a.title || '').indexOf('超脑') >= 0 ? ' pl-sb' : '';
      return `${sw}<div class="pl-item${sb}">
        <div class="pl-time">${esc(t)}</div>
        <div class="pl-main"><div class="pl-t">${esc(a.title)}</div>
          <div class="pl-meta">${esc(a.venue || '')}${a.category ? ' · ' + esc(a.category) : ''}</div></div>
        <a class="pl-detail" href="activity.html?id=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">详情</a>
      </div>`;
    }).join('');
    box.innerHTML = `<div class="pl-rnote">Day ${current.day} · 从 ${r.matched} 场相关活动里，排出 ${r.picked.length} 场无时间冲突的动线：</div>
      <div class="pl-timeline">${rows}</div>
      <div class="pl-acts"><button class="pl-addall" id="pl-addall">全部加入我的日程</button></div>`;
    box.querySelector('#pl-addall').addEventListener('click', () => {
      if (!window.WAICMine) return;
      r.picked.forEach(a => { if (!window.WAICMine.has(a.id)) window.WAICMine.toggle(a.id); });
      const b = box.querySelector('#pl-addall'); b.textContent = '已全部加入 ✓'; b.disabled = true;
    });
  }

  window.WAICPlanner = { open };
})();
