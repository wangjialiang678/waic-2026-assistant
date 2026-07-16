/* ============================================================
   cms.js — 展商自助 CMS（M11）前端：认领 → 审核 → 通过后受限编辑。
   官方数据只读；这里只提交/编辑「编辑层」，通过审核后前端合并展示并标「商家提供」。
   ============================================================ */
(function () {
  'use strict';
  function device() { return window.WAICSync ? window.WAICSync.code() : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function api(p, opt) { return fetch(p, opt).then(r => r.json().then(j => ({ ok: r.ok, j }))); }

  let root = null, ex = null, st = null;

  function ensure() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'cms-root'; root.hidden = true;
    root.innerHTML = `<div class="cms-mask"></div><div class="cms-panel" role="dialog" aria-modal="true">
      <header class="cms-head"><span class="cms-title">认领 / 编辑展台</span><button class="cms-x" aria-label="关闭">✕</button></header>
      <div class="cms-body" id="cms-body"></div></div>`;
    document.body.appendChild(root);
    root.querySelector('.cms-x').addEventListener('click', close);
    root.querySelector('.cms-mask').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) close(); });
  }
  function close() { root.hidden = true; document.body.classList.remove('soc-lock'); }

  async function open(exhibitor) {
    ensure(); ex = exhibitor;
    root.hidden = false; document.body.classList.add('soc-lock');
    root.querySelector('#cms-body').innerHTML = '<div class="cms-loading">加载中…</div>';
    try { const r = await api('/api/cms/status?device=' + encodeURIComponent(device()) + '&exhibitor_id=' + encodeURIComponent(ex.id)); st = r.ok ? r.j : { status: 'none' }; }
    catch (e) { st = { status: 'none' }; }
    render();
  }

  function render() {
    const body = root.querySelector('#cms-body');
    const head = `<div class="cms-ex">${esc(ex.name)}${ex.brand ? '（' + esc(ex.brand) + '）' : ''}</div>`;
    if (st.status === 'pending') {
      body.innerHTML = head + `<div class="cms-msg">✅ 认领已提交，正在人工审核（我们会通过你留的联系方式核实营业执照）。审核通过后回到这里即可编辑展台简介。</div>`;
      return;
    }
    if (st.status === 'approved') {
      body.innerHTML = head + `<div class="cms-msg ok">✅ 已通过认领，可编辑下方内容（保存后公开展示并标「商家提供」；官方字段如时间/展台以官方为准）。</div>
        <div class="cms-form">
          <div class="cms-field"><span class="cms-k">展台简介</span><textarea id="cms-intro" rows="4" maxlength="400">${esc(st.intro || '')}</textarea></div>
          <div class="cms-field"><span class="cms-k">官网链接（http/https）</span><input id="cms-website" maxlength="200" value="${esc(st.website || '')}" placeholder="https://…"></div>
          <div class="cms-field"><span class="cms-k">补充（如展台号/亮点，一句话）</span><input id="cms-extra" maxlength="200" value="${esc(st.extra || '')}"></div>
          <button class="cms-btn primary" id="cms-save">保存并公开</button>
        </div>`;
      body.querySelector('#cms-save').addEventListener('click', saveEdit);
      return;
    }
    // none / rejected → 认领表单
    const rej = st.status === 'rejected' ? `<div class="cms-msg warn">上次认领未通过${st.reviewed_note ? '：' + esc(st.reviewed_note) : ''}。可重新提交。</div>` : '';
    body.innerHTML = head + rej + `
      <div class="cms-form">
        <div class="cms-msg">认领后经人工核验营业执照即可自助编辑本展台的对外简介与官网。</div>
        <div class="cms-field"><span class="cms-k">公司全称（与营业执照一致）</span><input id="cms-company" maxlength="60" value="${esc(ex.name || '')}"></div>
        <div class="cms-field"><span class="cms-k">联系方式（用于核验，如微信/手机）</span><input id="cms-contact" maxlength="80" placeholder="我们会通过它联系你核验"></div>
        <button class="cms-btn primary" id="cms-claim">提交认领</button>
      </div>`;
    body.querySelector('#cms-claim').addEventListener('click', doClaim);
  }

  async function doClaim() {
    const g = id => (root.querySelector(id) || {}).value || '';
    const company = g('#cms-company').trim(), contact = g('#cms-contact').trim();
    if (!company || !contact) { alert('请填写公司全称和联系方式。'); return; }
    const btn = root.querySelector('#cms-claim'); btn.textContent = '提交中…'; btn.disabled = true;
    try {
      const r = await api('/api/cms/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: device(), exhibitor_id: ex.id, company, contact }) });
      st = r.j; render();
    } catch (e) { btn.textContent = '提交失败，重试'; btn.disabled = false; }
  }

  async function saveEdit() {
    const g = id => (root.querySelector(id) || {}).value || '';
    const btn = root.querySelector('#cms-save'); btn.textContent = '保存中…'; btn.disabled = true;
    try {
      const r = await api('/api/cms/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: device(), exhibitor_id: ex.id, intro: g('#cms-intro'), website: g('#cms-website'), extra: g('#cms-extra') }) });
      if (r.ok) { st = r.j; btn.textContent = '已保存并公开 ✓'; setTimeout(() => { btn.textContent = '保存并公开'; btn.disabled = false; }, 1200); }
      else { btn.textContent = '保存失败'; btn.disabled = false; }
    } catch (e) { btn.textContent = '保存失败'; btn.disabled = false; }
  }

  window.WAICCms = { open };
})();
