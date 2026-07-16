/* ==========================================================================
   WAIC 2026 参展助手 · 网站内 AI 助手（Phase 2/3 前端）
   - 右下角悬浮按钮 → 聊天面板（手机全屏 / 桌面浮层）
   - 聊天：fetch + ReadableStream 读 SSE，流式渲染文本 + 结果卡片
   - 结果卡复用站点卡片风格；活动卡带 [加入日程]/[详情]/[报名]
   - 个性化 profile（兴趣，存 localStorage waic2026.profile.v1）随请求带上
   - 静态兜底：config.json {mode} + /api/health 探活，任一不可用 → 优雅降级
     （Phase 1 浏览 / 我的日程等静态功能不受任何影响）
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------ 常量 / 状态 ------------------------------ */
  const CFG_URL        = 'config.json';
  const MYSCHED_KEY    = 'waic2026.myschedule.v1';   // 与 app.js 一致
  const PROFILE_KEY    = 'waic2026.profile.v1';
  const HEALTH_TIMEOUT = 3000;   // 探活超时 → 降级
  const CFG_TIMEOUT    = 2500;
  const MAX_TURNS      = 24;      // 送给后端的最近对话轮数上限

  let API_BASE  = '';       // '' = 同源 /api；config.json 可覆盖（本地联调后端用）
  let MODE      = 'api';    // 'api' | 'static'
  let AVAILABLE = false;    // 聊天是否可用（config + health 都过才 true）
  let sending   = false;
  const convo   = [];       // [{role,content}] 送后端的对话历史

  const INTEREST_OPTIONS = [
    // 产业方向
    '大模型', '智能体·Agent', '具身智能·机器人', 'AI芯片·算力', 'AI应用落地', '智能制造·工业',
    '智能驾驶·交通', 'AI+医疗健康', 'AI+金融', 'AI for Science', 'AIGC·文娱',
    'AGI·世界模型', '智能硬件·终端',
    // 视角与目的
    '投融资·找项目', '创业·出海找合作', '创作者·Builders', '开发者·开源', 'AI安全·治理', '边会·社交局', '青年·人才',
    // 超脑相关
    'AI教育', '青少年·带娃逛展', '一人公司·OPC',
  ];
  const EXAMPLES = [
    '帮我排满 7/18 关注具身智能的一天',
    '今晚有哪些要报名的 afterparty',
    '从世博中心到张江来得及吗',
    'H2 有哪些做机器人的展台',
  ];

  /* ------------------------------ 小工具 ------------------------------ */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function apiUrl(path) { return (API_BASE || '') + path; }
  function readMySchedule() { try { return JSON.parse(localStorage.getItem(MYSCHED_KEY) || '[]'); } catch (e) { return []; } }
  function readProfile() {
    try { const p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); return { interests: Array.isArray(p.interests) ? p.interests : [] }; }
    catch (e) { return { interests: [] }; }
  }
  function writeProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {} if (window.WAICSync) window.WAICSync.touch(); }
  // 自动选择：行为推断权重达阈值(≥2，如加入2场同标签活动)的方向，自动升为"已关注"，无需手动勾
  function promoteInferred() {
    let p; try { p = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch (e) { p = {}; }
    if (!Array.isArray(p.interests)) p.interests = [];
    const inf = (p.inferred && typeof p.inferred === 'object') ? p.inferred : {};
    let changed = false;
    Object.keys(inf).forEach(t => { if (inf[t] >= 2 && !p.interests.includes(t)) { p.interests.push(t); changed = true; } });
    if (changed) writeProfile(p);
    return p.interests;
  }
  function fetchTimeout(url, ms, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {})).finally(() => clearTimeout(t));
  }
  // 极简富文本：转义 + **加粗** + 换行；不引入任何依赖
  function fmt(text) {
    let h = esc(text);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  const ICON_SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>';
  const ICON_SEND  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const ICON_GEAR  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  /* ------------------------------ 构建 DOM ------------------------------ */
  let fab, root, panel, bodyEl, inputEl, sendBtn, headSub;

  function buildDOM() {
    fab = document.createElement('button');
    fab.id = 'waic-fab';
    fab.className = 'waic-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', '打开 AI 助手');
    fab.innerHTML = `<span class="wf-ic">${ICON_SPARK}</span><span class="wf-txt">AI 助手</span>`;
    fab.addEventListener('click', openPanel);

    root = document.createElement('div');
    root.id = 'waic-chat';
    root.className = 'waic-chat';
    root.hidden = true;
    root.innerHTML = `
      <div class="wc-backdrop"></div>
      <div class="wc-panel" role="dialog" aria-modal="true" aria-label="WAIC AI 助手">
        <header class="wc-head">
          <div class="wc-h-title"><span class="wc-h-ic">${ICON_SPARK}</span>
            <span>WAIC AI 助手<small id="wc-sub">超脑 · beta</small></span></div>
          <div class="wc-h-acts">
            <button class="wc-icon-btn" id="wc-settings" type="button" title="设置兴趣" aria-label="设置兴趣">${ICON_GEAR}</button>
            <button class="wc-icon-btn" id="wc-close" type="button" title="关闭" aria-label="关闭">${ICON_CLOSE}</button>
          </div>
        </header>
        <div class="wc-settings-drawer" id="wc-drawer" hidden></div>
        <div class="wc-body" id="wc-body"></div>
        <form class="wc-composer" id="wc-composer">
          <textarea id="wc-input" rows="1" placeholder="问点什么…例如：7/18 有哪些大模型论坛" autocomplete="off"></textarea>
          <button id="wc-send" class="wc-send" type="submit" aria-label="发送" disabled>${ICON_SEND}</button>
        </form>
        <div class="wc-foot">AI 生成，可能有误 · 以官方最终发布为准</div>
      </div>`;

    document.body.appendChild(fab);
    document.body.appendChild(root);

    panel   = root.querySelector('.wc-panel');
    bodyEl  = root.querySelector('#wc-body');
    inputEl = root.querySelector('#wc-input');
    sendBtn = root.querySelector('#wc-send');
    headSub = root.querySelector('#wc-sub');

    root.querySelector('.wc-backdrop').addEventListener('click', closePanel);
    root.querySelector('#wc-close').addEventListener('click', closePanel);
    root.querySelector('#wc-settings').addEventListener('click', toggleDrawer);
    root.querySelector('#wc-composer').addEventListener('submit', e => { e.preventDefault(); submitInput(); });

    // 输入框：自适应高度 + Enter 发送（Shift+Enter 换行）
    inputEl.addEventListener('input', () => { autoGrow(); updateSendState(); });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(); }
    });

    // 事件委托：卡片按钮 / 示例 chip / 兴趣 chip
    bodyEl.addEventListener('click', onBodyClick);
    root.querySelector('#wc-drawer').addEventListener('click', onDrawerClick);

    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !root.hidden) closePanel(); });
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }
  function updateSendState() {
    sendBtn.disabled = sending || !AVAILABLE || !inputEl.value.trim();
  }

  /* ------------------------------ 面板开合 ------------------------------ */
  function openPanel() {
    promoteInferred();   // 打开时把行为推断的方向自动升为已关注
    root.hidden = false;
    document.body.classList.add('wc-open-lock');
    requestAnimationFrame(() => root.classList.add('open'));
    if (AVAILABLE) setTimeout(() => inputEl && inputEl.focus(), 60);
  }
  function closePanel() {
    root.classList.remove('open');
    document.body.classList.remove('wc-open-lock');
    setTimeout(() => { root.hidden = true; }, 220);
  }

  /* ------------------------------ 兴趣设置抽屉 ------------------------------ */
  let drawerOpen = false;
  function toggleDrawer() {
    const d = root.querySelector('#wc-drawer');
    drawerOpen = !drawerOpen;
    if (drawerOpen) { d.hidden = false; renderDrawer(); requestAnimationFrame(() => d.classList.add('show')); }
    else { d.classList.remove('show'); setTimeout(() => { d.hidden = true; }, 200); }
  }
  function renderDrawer() {
    const chosen = new Set(promoteInferred());   // 先把行为推断的高权重方向自动升为已关注
    const chips = INTEREST_OPTIONS.map(t =>
      `<button class="wc-int-chip${chosen.has(t) ? ' on' : ''}" data-interest="${esc(t)}" type="button">${esc(t)}</button>`).join('');
    const custom = [...chosen].filter(t => !INTEREST_OPTIONS.includes(t));
    const customChips = custom.map(t =>
      `<button class="wc-int-chip on custom" data-interest="${esc(t)}" type="button">${esc(t)} <span class="x">✕</span></button>`).join('');
    // 猜你关注：从行为自动推断（profile.inferred）里挑还没选的高权重项
    let inferred = {};
    try { inferred = (JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}').inferred) || {}; } catch (e) {}
    const suggested = Object.keys(inferred)
      .filter(t => !chosen.has(t) && !INTEREST_OPTIONS.includes(t))
      .sort((a, b) => inferred[b] - inferred[a]).slice(0, 6);
    const suggestChips = suggested.map(t =>
      `<button class="wc-int-chip suggest" data-interest="${esc(t)}" type="button">+ ${esc(t)}</button>`).join('');
    root.querySelector('#wc-drawer').innerHTML = `
      <div class="wc-drawer-h">我关注的方向 <small>（可多选，帮助 AI 更懂你；仅存在你的浏览器）</small></div>
      <div class="wc-int-chips">${chips}</div>
      ${custom.length ? `<div class="wc-int-custom-list">${customChips}</div>` : ''}
      ${suggested.length ? `<div class="wc-int-suggest"><span class="wc-int-suggest-h">💡 猜你关注（据你加入的日程）</span><div class="wc-int-suggest-chips">${suggestChips}</div></div>` : ''}
      <div class="wc-int-add">
        <input type="text" id="wc-int-input" class="wc-int-input" placeholder="自定义方向，如 AI 教育、AI OPC…" maxlength="16" autocomplete="off">
        <button class="wc-int-addbtn" id="wc-int-add" type="button">添加</button>
      </div>`;
    const inp = root.querySelector('#wc-int-input');
    const add = () => {
      const v = (inp.value || '').trim();
      if (!v) return;
      const p = readProfile(); const set = new Set(p.interests); set.add(v); p.interests = [...set]; writeProfile(p);
      inp.value = ''; renderDrawer(); const ni = root.querySelector('#wc-int-input'); if (ni) ni.focus();
    };
    root.querySelector('#wc-int-add').addEventListener('click', add);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  }
  function onDrawerClick(e) {
    if (e.target.closest('#wc-int-add') || e.target.closest('#wc-int-input')) return;
    const chip = e.target.closest('[data-interest]');
    if (!chip) return;
    const t = chip.dataset.interest;
    const p = readProfile();
    const set = new Set(p.interests);
    if (set.has(t)) set.delete(t); else set.add(t);
    p.interests = [...set];
    writeProfile(p);
    renderDrawer();
  }

  /* ------------------------------ 空状态 / coming-soon ------------------------------ */
  function renderEmpty() {
    const interests = promoteInferred();
    const chips = EXAMPLES.map(q => `<button class="wc-ex" data-ask="${esc(q)}" type="button">${esc(q)}</button>`).join('');
    bodyEl.innerHTML = `
      <div class="wc-empty">
        <div class="wc-empty-ic">${ICON_SPARK}</div>
        <div class="wc-empty-h">问我 WAIC 的一切</div>
        <div class="wc-empty-p">官方论坛、边会周边、1020 家展商、动线路程——用大白话问就行。答案会带上可一键加入日程的卡片。</div>
        <div class="wc-ex-list">${chips}</div>
        <button class="wc-set-int" id="wc-set-int" type="button">${ICON_GEAR} ${interests.length ? '已设 ' + interests.length + ' 个兴趣，点此修改' : '设置我的兴趣（可选）'}</button>
      </div>`;
    bodyEl.querySelector('#wc-set-int').addEventListener('click', toggleDrawer);
  }
  function renderComingSoon() {
    bodyEl.innerHTML = `
      <div class="wc-empty wc-soon">
        <div class="wc-empty-ic">${ICON_SPARK}</div>
        <div class="wc-empty-h">AI 助手即将上线</div>
        <div class="wc-empty-p">网站内的 AI 对话马上就来。现在你已经可以<strong>浏览四大板块、筛选、加入「我的日程」、导出日历、生成分享长图</strong>——全部照常可用。<br>过一会儿再回来问我吧。</div>
        <button class="wc-ex" id="wc-goto-browse" type="button">先去浏览日程 →</button>
      </div>`;
    const b = bodyEl.querySelector('#wc-goto-browse');
    if (b) b.addEventListener('click', () => { closePanel(); const p = document.getElementById('panel'); if (p) p.scrollIntoView({ behavior: 'smooth' }); });
  }

  /* ------------------------------ 消息渲染 ------------------------------ */
  function scrollBottom() { bodyEl.scrollTop = bodyEl.scrollHeight; }
  function ensureMsgArea() {
    if (!bodyEl.querySelector('.wc-thread')) {
      bodyEl.innerHTML = '<div class="wc-thread"></div>';
    }
    return bodyEl.querySelector('.wc-thread');
  }
  function addUserMsg(text) {
    const t = ensureMsgArea();
    const el = document.createElement('div');
    el.className = 'wc-msg wc-user';
    el.innerHTML = `<div class="wc-bubble">${fmt(text)}</div>`;
    t.appendChild(el);
    scrollBottom();
  }
  function addAiMsg() {
    const t = ensureMsgArea();
    const el = document.createElement('div');
    el.className = 'wc-msg wc-ai';
    el.innerHTML = `<div class="wc-ai-ic">${ICON_SPARK}</div>
      <div class="wc-bubble"><div class="wc-text"></div><div class="wc-cards"></div>
        <div class="wc-typing"><span></span><span></span><span></span></div></div>`;
    t.appendChild(el);
    scrollBottom();
    return { el, text: el.querySelector('.wc-text'), cards: el.querySelector('.wc-cards'), typing: el.querySelector('.wc-typing') };
  }
  function setTyping(m, on) { if (m && m.typing) m.typing.style.display = on ? '' : 'none'; }

  function renderCards(m, evt) {
    const items = Array.isArray(evt.items) ? evt.items : [];
    if (!items.length) return;
    const kind = evt.kind === 'exhibitor' ? 'exhibitor' : 'activity';
    const wrap = document.createElement('div');
    wrap.className = 'wc-cards-block';
    wrap.innerHTML = items.map(it => kind === 'exhibitor' ? exhibitorCardHTML(it) : activityCardHTML(it)).join('');
    m.cards.appendChild(wrap);
    scrollBottom();
  }

  function metaBitsHTML(it) {
    const bits = [];
    const when = [it.date, it.start_time].filter(Boolean).join(' ');
    if (when) bits.push(`<span class="wc-c-time">${esc(when)}</span>`);
    if (it.venue) bits.push(`<span class="wc-c-venue">📍 ${esc(it.venue)}</span>`);
    if (it.category) bits.push(`<span class="wc-c-chip">${esc(it.category)}</span>`);
    if (it.track) bits.push(`<span class="wc-c-track">${esc(it.track)}</span>`);
    if (it.price) bits.push(`<span class="wc-c-price">${esc(String(it.price).slice(0, 24))}</span>`);
    return bits.join('');
  }
  function activityCardHTML(it) {
    const id = it.id;
    const detailUrl = 'activity.html?id=' + encodeURIComponent(id);
    const acts = [];
    if (window.WAICMine && id !== undefined && id !== null) acts.push(window.WAICMine.buttonHTML(id));
    acts.push(`<a class="wc-c-btn" href="${esc(detailUrl)}" target="_blank" rel="noopener">详情</a>`);
    if (it.registration_url) acts.push(`<a class="wc-c-btn reg" href="${esc(it.registration_url)}" target="_blank" rel="noopener">报名</a>`);
    else if (it.official_url) acts.push(`<a class="wc-c-btn" href="${esc(it.official_url)}" target="_blank" rel="noopener">官网</a>`);
    return `<div class="wc-card">
      <div class="wc-c-meta">${metaBitsHTML(it)}</div>
      <div class="wc-c-title">${esc(it.title)}</div>
      <div class="wc-c-actions">${acts.join('')}</div>
    </div>`;
  }
  function exhibitorCardHTML(it) {
    const bits = [];
    if (it.venue) bits.push(`<span class="wc-c-venue">📍 ${esc(it.venue)}</span>`);
    if (it.category) bits.push(`<span class="wc-c-chip">${esc(it.category)}</span>`);
    const acts = [];
    if (it.official_url) acts.push(`<a class="wc-c-btn" href="${esc(it.official_url)}" target="_blank" rel="noopener">官网</a>`);
    return `<div class="wc-card wc-card-exh">
      <div class="wc-c-meta">${bits.join('')}</div>
      <div class="wc-c-title">${esc(it.title)}</div>
      ${acts.length ? `<div class="wc-c-actions">${acts.join('')}</div>` : ''}
    </div>`;
  }

  function onBodyClick(e) {
    // 加入我的日程（复用 app.js 的全站同步逻辑）
    const mb = e.target.closest('[data-mine]');
    if (mb) {
      e.preventDefault(); e.stopPropagation();
      if (window.WAICMine) window.WAICMine.toggle(mb.dataset.mine);
      return;
    }
    // 示例问题：直接发
    const ex = e.target.closest('[data-ask]');
    if (ex) { sendMessage(ex.dataset.ask); return; }
  }

  /* ------------------------------ 发送 + SSE ------------------------------ */
  function submitInput() {
    const v = inputEl.value.trim();
    if (!v) return;
    inputEl.value = '';
    autoGrow();
    sendMessage(v);
  }

  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text || sending || !AVAILABLE) return;
    if (drawerOpen) toggleDrawer();
    sending = true;
    updateSendState();

    addUserMsg(text);
    convo.push({ role: 'user', content: text });
    const m = addAiMsg();
    setTyping(m, true);

    const payload = {
      messages: convo.slice(-MAX_TURNS),
      my_schedule: readMySchedule(),
      profile: readProfile(),
      device: (window.WAICSync ? window.WAICSync.code() : ''),   // 限流按同步码计，避免共享 WiFi(同 IP) 误伤
    };

    let acc = '';
    let gotAny = false;
    try {
      const res = await fetch(apiUrl('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evt = parseSSE(frame);
          if (!evt) continue;
          gotAny = handleEvent(m, evt, acc, v => { acc = v; }) || gotAny;
        }
      }
      // 收尾：处理无结尾空行的残帧
      const tail = parseSSE(buf);
      if (tail) handleEvent(m, tail, acc, v => { acc = v; });

      if (!gotAny && !acc) renderError(m, '没有收到回复，请再试一次。');
      if (acc) convo.push({ role: 'assistant', content: acc });
    } catch (err) {
      renderError(m, '连接 AI 失败，请稍后再试。你仍可正常浏览日程与「我的日程」。');
    } finally {
      setTyping(m, false);
      sending = false;
      updateSendState();
      scrollBottom();
    }
  }

  // 返回 true 表示这是一条“有内容”的事件（delta/cards）
  function handleEvent(m, evt, accSoFar, setAcc) {
    if (evt.type === 'delta') {
      const next = accSoFar + (evt.text || '');
      // 注意：accSoFar 是快照，用 setAcc 回写累计值到闭包
      setAcc(next);
      m.text.innerHTML = fmt(next);
      scrollBottom();
      return true;
    }
    if (evt.type === 'cards') { renderCards(m, evt); return true; }
    if (evt.type === 'error') { renderError(m, evt.message || 'AI 暂时出错了，请稍后再试。'); return false; }
    // 'done' 或未知类型：忽略
    return false;
  }
  function renderError(m, msg) {
    let e = m.el.querySelector('.wc-err');
    if (!e) { e = document.createElement('div'); e.className = 'wc-err'; m.el.querySelector('.wc-bubble').appendChild(e); }
    e.textContent = msg;
    scrollBottom();
  }

  // 解析单个 SSE 帧：收集 data: 行，拼接后 JSON.parse
  function parseSSE(frame) {
    if (!frame) return null;
    const lines = frame.split('\n');
    const data = [];
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line || line.startsWith(':')) continue;      // 空行 / 注释心跳
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return null;
    const payload = data.join('\n');
    if (payload === '[DONE]') return { type: 'done' };
    try { return JSON.parse(payload); } catch (e) { return null; }
  }

  /* ------------------------------ 探活 / 降级 ------------------------------ */
  function setFabState(state) {
    // state: 'ready' | 'soon'
    if (!fab) return;
    fab.classList.toggle('soon', state === 'soon');
    fab.querySelector('.wf-txt').textContent = state === 'soon' ? '即将上线' : 'AI 助手';
    fab.setAttribute('aria-label', state === 'soon' ? 'AI 助手即将上线' : '打开 AI 助手');
  }
  function paintBody() {
    if (AVAILABLE) renderEmpty(); else renderComingSoon();
    if (headSub) headSub.textContent = AVAILABLE ? '超脑 · beta' : '即将上线';
    updateSendState();
  }

  async function bootstrap() {
    // 1) 读 config.json（一键开关）
    try {
      const r = await fetchTimeout(CFG_URL, CFG_TIMEOUT, { cache: 'no-store' });
      if (r.ok) {
        const c = await r.json();
        if (c && c.mode) MODE = String(c.mode);
        if (c && c.api_base) API_BASE = String(c.api_base).replace(/\/+$/, '');
      }
    } catch (e) { /* config 读不到 → 保持默认 api，再靠 health 判定 */ }

    // 2) mode=static → 强制禁用聊天（一键关 AI）
    if (MODE === 'static') { AVAILABLE = false; setFabState('soon'); paintBody(); return; }

    // 3) 探活 /api/health（超时/失败 → 降级）
    try {
      const r = await fetchTimeout(apiUrl('/api/health'), HEALTH_TIMEOUT, { cache: 'no-store' });
      const j = await r.json();
      AVAILABLE = !!(r.ok && j && j.ok === true);
    } catch (e) { AVAILABLE = false; }

    setFabState(AVAILABLE ? 'ready' : 'soon');
    paintBody();
  }

  /* ------------------------------ 启动 ------------------------------ */
  function init() {
    buildDOM();
    renderComingSoon();      // 先给保守占位，探活后再切换
    setFabState('soon');
    bootstrap();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
