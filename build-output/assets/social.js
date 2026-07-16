/* ============================================================
   social.js — 人脉对接（社交速配 M9）。无登录，匿名同步码为身份。
   隐私：显式同意才开启；联系方式只在双向匹配后露出；一键删除全部社交数据。
   后端不可用 / WAIC_SOCIAL=off → 入口自动隐藏。
   ============================================================ */
(function () {
  'use strict';
  function device() { return window.WAICSync ? window.WAICSync.code() : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function api(p, opt) { return fetch(p, opt).then(r => r.ok ? r.json() : Promise.reject(r.status)); }
  function readInterests() { try { return (JSON.parse(localStorage.getItem('waic2026.profile.v1') || '{}').interests) || []; } catch (e) { return []; } }

  let root = null, TAB = 'me', profile = null, cands = [], myMatches = [];

  async function init() {
    let cfg;
    try { cfg = await api('/api/social/config'); } catch (e) { return; }   // 后端没有/关了 → 不注入
    if (!cfg || !cfg.enabled) return;
    injectEntry();
    injectModal();
  }

  function injectEntry() {
    document.querySelectorAll('.nav-links').forEach(nav => {
      if (nav.querySelector('.nav-social')) return;
      const a = document.createElement('a');
      a.href = 'javascript:void 0'; a.className = 'nav-social'; a.textContent = '人脉对接';
      a.addEventListener('click', open);
      const cta = nav.querySelector('.nav-cta');
      nav.insertBefore(a, cta || null);
    });
  }

  function injectModal() {
    root = document.createElement('div');
    root.className = 'soc-root'; root.hidden = true;
    root.innerHTML = `<div class="soc-mask"></div><div class="soc-panel" role="dialog" aria-modal="true">
      <header class="soc-head"><span class="soc-title">人脉对接 · 找同频的人</span><button class="soc-x" aria-label="关闭">✕</button></header>
      <div class="soc-tabs">
        <button class="soc-tab" data-tab="me">我的名片</button>
        <button class="soc-tab" data-tab="discover">发现</button>
        <button class="soc-tab" data-tab="matches">我的匹配</button>
      </div>
      <div class="soc-body" id="soc-body"></div>
      <div class="soc-note">匿名，无需登录。<strong>联系方式只在双方互相「感兴趣」后才互相看到</strong>；随时可一键删除全部对接资料。</div>
    </div>`;
    document.body.appendChild(root);
    root.querySelector('.soc-x').addEventListener('click', close);
    root.querySelector('.soc-mask').addEventListener('click', close);
    root.querySelectorAll('.soc-tab').forEach(t => t.addEventListener('click', () => { TAB = t.dataset.tab; render(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) close(); });
  }

  async function open() {
    root.hidden = false; document.body.classList.add('soc-lock');
    try { profile = await api('/api/social/profile?device=' + encodeURIComponent(device())); } catch (e) { profile = null; }
    TAB = (profile && profile.enabled) ? 'discover' : 'me';
    render();
  }
  function close() { root.hidden = true; document.body.classList.remove('soc-lock'); }

  function render() {
    root.querySelectorAll('.soc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === TAB));
    const body = root.querySelector('#soc-body');
    if (TAB === 'me') return renderMe(body);
    if (TAB === 'discover') return renderDiscover(body);
    if (TAB === 'matches') return renderMatches(body);
  }

  function renderMe(body) {
    const p = profile || {};
    const c = p.contact || {};
    const tags = (p.tags && p.tags.length) ? p.tags : readInterests().slice(0, 6);
    body.innerHTML = `
      <div class="soc-form">
        <label class="soc-consent"><input type="checkbox" id="soc-enabled" ${p.enabled ? 'checked' : ''}> 我同意加入人脉对接，并按下方设置向他人展示（不含联系方式）</label>
        <div class="soc-field"><span class="soc-k">一句话介绍你自己</span><input id="soc-intro" maxlength="40" value="${esc(p.intro || '')}" placeholder="如：做青少年 AI 教育的创业者"></div>
        <div class="soc-field"><span class="soc-k">我能提供</span><input id="soc-offer" maxlength="60" value="${esc(p.offer || '')}" placeholder="如：AI 课程资源 / 渠道 / 技术"></div>
        <div class="soc-field"><span class="soc-k">我在找</span><input id="soc-seeking" maxlength="60" value="${esc(p.seeking || '')}" placeholder="如：投资人 / 合作方 / 同行"></div>
        <div class="soc-field"><span class="soc-k">方向标签（逗号分隔，默认取你的关注方向）</span><input id="soc-tags" maxlength="120" value="${esc(tags.join(', '))}" placeholder="AI教育, 投融资"></div>
        <div class="soc-contact">
          <span class="soc-k">联系方式（自愿 · 仅双向匹配后展示给对方）</span>
          <div class="soc-contact-row">
            <select id="soc-ctype">
              ${['微信', '手机号', '小红书', '其它'].map(t => `<option ${c.type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <input id="soc-cvalue" maxlength="60" value="${esc(c.value || '')}" placeholder="留空则暂不填">
          </div>
        </div>
        <div class="soc-actions">
          <button class="soc-btn primary" id="soc-save">保存</button>
          <button class="soc-btn ghost" id="soc-delete">删除我的对接资料</button>
        </div>
      </div>`;
    body.querySelector('#soc-save').addEventListener('click', saveProfile);
    body.querySelector('#soc-delete').addEventListener('click', deleteProfile);
  }

  async function saveProfile() {
    const g = id => (root.querySelector(id) || {}).value || '';
    const enabled = root.querySelector('#soc-enabled').checked;
    const cval = g('#soc-cvalue').trim();
    const payload = {
      device: device(), enabled,
      intro: g('#soc-intro').trim(), offer: g('#soc-offer').trim(), seeking: g('#soc-seeking').trim(),
      tags: g('#soc-tags').split(/[,，]/).map(s => s.trim()).filter(Boolean),
      contact: cval ? { type: g('#soc-ctype'), value: cval } : null,
    };
    const btn = root.querySelector('#soc-save'); btn.textContent = '保存中…'; btn.disabled = true;
    try {
      profile = await api('/api/social/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      btn.textContent = '已保存 ✓'; setTimeout(() => { TAB = enabled ? 'discover' : 'me'; render(); }, 700);
    } catch (e) { btn.textContent = '保存失败，重试'; btn.disabled = false; }
  }

  async function deleteProfile() {
    if (!confirm('确定删除你的全部对接资料（名片、感兴趣、匹配）？此操作不可撤销。')) return;
    try { await api('/api/social/optout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: device() }) }); } catch (e) {}
    profile = null; TAB = 'me'; render();
  }

  async function renderDiscover(body) {
    if (!profile || !profile.enabled) { body.innerHTML = `<div class="soc-empty">先在「我的名片」里开启人脉对接，才能发现同频的人。</div>`; return; }
    body.innerHTML = `<div class="soc-empty">加载中…</div>`;
    try { const r = await api('/api/social/candidates?device=' + encodeURIComponent(device())); cands = r.items || []; } catch (e) { cands = []; }
    if (!cands.length) { body.innerHTML = `<div class="soc-empty">暂时没有更多同频的人。稍后再来看看——会期里加入的人会越来越多。</div>`; return; }
    body.innerHTML = cands.map(candCard).join('');
    body.querySelectorAll('[data-like]').forEach(b => b.addEventListener('click', () => doLike(b.dataset.like)));
    body.querySelectorAll('[data-skip]').forEach(b => b.addEventListener('click', () => { b.closest('.soc-card').remove(); }));
  }

  function candCard(c) {
    const tags = (c.tags || []).slice(0, 5).map(t => `<span class="soc-tag">${esc(t)}</span>`).join('');
    return `<div class="soc-card">
      <div class="soc-c-intro">${esc(c.intro || '（未填介绍）')}</div>
      ${c.offer ? `<div class="soc-c-line"><b>能提供</b> ${esc(c.offer)}</div>` : ''}
      ${c.seeking ? `<div class="soc-c-line"><b>在找</b> ${esc(c.seeking)}</div>` : ''}
      ${tags ? `<div class="soc-c-tags">${tags}</div>` : ''}
      <div class="soc-c-acts"><button class="soc-btn ghost" data-skip="${esc(c.device)}">跳过</button><button class="soc-btn primary" data-like="${esc(c.device)}">感兴趣</button></div>
    </div>`;
  }

  async function doLike(target) {
    let res;
    try { res = await api('/api/social/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: device(), target }) }); } catch (e) { return; }
    const card = root.querySelector('.soc-card [data-like="' + (window.CSS && CSS.escape ? CSS.escape(target) : target) + '"]');
    if (card) card.closest('.soc-card').remove();
    if (res && res.matched) {
      const t = res.target || {};
      alert('🎉 互相感兴趣！你们匹配上了。\n对方：' + (t.intro || '') + '\n联系方式：' + ((t.contact && (t.contact.type + ' ' + t.contact.value)) || '（对方未留）') + '\n（也可在「我的匹配」里查看）');
    }
  }

  async function renderMatches(body) {
    body.innerHTML = `<div class="soc-empty">加载中…</div>`;
    try { const r = await api('/api/social/matches?device=' + encodeURIComponent(device())); myMatches = r.items || []; } catch (e) { myMatches = []; }
    if (!myMatches.length) { body.innerHTML = `<div class="soc-empty">还没有匹配。去「发现」里，对感兴趣的人点「感兴趣」，双方都点了就会匹配、互看联系方式。</div>`; return; }
    body.innerHTML = myMatches.map(m => {
      const ct = m.contact ? (m.contact.type + ' · ' + m.contact.value) : '（对方未留联系方式）';
      const tags = (m.tags || []).slice(0, 5).map(t => `<span class="soc-tag">${esc(t)}</span>`).join('');
      return `<div class="soc-card matched">
        <div class="soc-c-intro">${esc(m.intro || '')}</div>
        ${m.offer ? `<div class="soc-c-line"><b>能提供</b> ${esc(m.offer)}</div>` : ''}
        ${m.seeking ? `<div class="soc-c-line"><b>在找</b> ${esc(m.seeking)}</div>` : ''}
        ${tags ? `<div class="soc-c-tags">${tags}</div>` : ''}
        <div class="soc-c-contact">🔓 联系方式：<strong>${esc(ct)}</strong></div>
      </div>`;
    }).join('');
  }

  window.WAICSocial = { open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
