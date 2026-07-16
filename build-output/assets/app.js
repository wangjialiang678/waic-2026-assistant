/* ==========================================================================
   WAIC 2026 参展助手 · 首页（四大板块 SPA，运行时 fetch JSON 渲染）
   官方日程 / 边会·周边 / 参展商 / 情报站
   ========================================================================== */

const DATA = { activities: [], themes: {}, intel: [], exhibitors: null };  // exhibitors lazy
let CURRENT_VIEW = 'official';
const EXH_PAGE = 60;

/* ---- 我的日程（localStorage，无登录） ---- */
const MYSCHED_KEY = 'waic2026.myschedule.v1';
const SITE_URL = 'waic.sg.superbrain-ai.com';
function readMine() { try { return JSON.parse(localStorage.getItem(MYSCHED_KEY) || '[]'); } catch (e) { return []; } }
let MINE = new Set(readMine().map(String));
function persistMine() { try { localStorage.setItem(MYSCHED_KEY, JSON.stringify([...MINE])); } catch (e) {} updateMineBadge(); if (window.WAICSync) window.WAICSync.touch(); }
function isMine(id) { return MINE.has(String(id)); }
function toggleMine(id) { id = String(id); if (MINE.has(id)) MINE.delete(id); else MINE.add(id); persistMine(); return MINE.has(id); }
function mineActivities() {
  return DATA.activities.filter(a => MINE.has(String(a.id)) && (a.kind === 'official_program' || a.kind === 'side_event' || a.kind === 'community'));
}

const DAY_META = {
  1: { date: '2026-07-17', label: '7/17 周五' },
  2: { date: '2026-07-18', label: '7/18 周六' },
  3: { date: '2026-07-19', label: '7/19 周日' },
  4: { date: '2026-07-20', label: '7/20 周一' },
};
const ZONE_DESC = {
  '世博中心': { role: '论坛策源', desc: '主题论坛与主论坛主场' },
  '世博展览馆': { role: '应用展览', desc: '核心展区 H1–H4，应用落地' },
  '徐汇西岸国际会展中心': { role: '体验', desc: '西岸体验与互动展示' },
  '西岸国际会展中心': { role: '体验', desc: '西岸体验与互动展示' },
  '张江科学会堂': { role: '算力', desc: '张江算力与硬核科技' },
};
const VIEW_COLOR = { official: 'var(--official)', side: 'var(--side)', exhibitors: 'var(--exh)', intel: 'var(--intel)', mine: 'var(--official)' };
const VIEW_TINT  = { official: 'var(--official-tint)', side: 'var(--side-tint)', exhibitors: 'var(--exh-tint)', intel: 'var(--intel-tint)', mine: 'var(--official-tint)' };

/* per-view filter state */
const F = {
  official: { day: '', district: '', venue: '', category: '', track: '', tag: '', q: '' },
  side:     { day: '', track: '', relation: '', q: '' },
  exhibitors: { hall: '', industry: '', role: '', q: '', page: 1 },
  intel:    { channel: '', q: '' },
  mine:     { day: '' },
};

/* ------------------------------ helpers ------------------------------ */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function channelLabel(ch) { return ({ 'waic-official-api': '官方', 'wechat': '公众号', 'web': '网络' })[ch] || '来源'; }
function channelClass(ch) { return ({ 'waic-official-api': 'ch-official', 'wechat': 'ch-wechat', 'web': 'ch-web' })[ch] || 'ch-web'; }
function relationLabel(r) { return ({ official: '官方', affiliated: '联名 / 合作', 'co-located': '同城同期' })[r] || ''; }
function sourceUrl(a) {
  const s = a.source || {};
  if (a.source_type === 'official') return a.official_url || s.url || '';
  return s.url || s.sogou_url || '';
}
function timeLabel(a) {
  if (a.start_time && a.end_time) return `${a.start_time} – ${a.end_time}`;
  if (a.start_time) return a.start_time;
  return '';
}
function flatTags(a) {
  const out = new Set();
  (a.tags || []).forEach(t => String(t).split(',').forEach(p => { p = p.trim(); if (p) out.add(p); }));
  return out;
}
const ICON_EXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 17 17 7M9 7h8v8"/></svg>';
const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function opt(value, label, selected) { return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`; }

function mineBtn(a) {
  const on = isMine(a.id);
  return `<button class="mine-btn${on ? ' on' : ''}" data-mine="${esc(a.id)}" aria-pressed="${on}" type="button">
    <span class="mb-ic">${on ? ICON_CHECK : ICON_PLUS}</span><span class="mb-label">${on ? '已加入我的日程' : '加入我的日程'}</span>
  </button>`;
}

/* ------------------------------ load ------------------------------ */
async function loadData() {
  try {
    const [aRes, tRes, iRes] = await Promise.all([
      fetch('data/activities.json'),
      fetch('data/themes.json'),
      fetch('data/intel.json'),
    ]);
    const a = await aRes.json();
    DATA.themes = await tRes.json();
    const intel = await iRes.json();
    DATA.activities = a.activities || [];
    DATA.intel = intel.articles || [];

    fillStats(a, intel);
    renderCountdown();
    renderTodayTop();
    bindTabs();
    updateMineBadge();
    setView('official');
    routeFromHash();
    window.addEventListener('hashchange', routeFromHash);
    // 服务端同步拉到新数据 → 刷新内存态 + 重渲染当前视图
    window.addEventListener('waic-sync', () => {
      MINE = new Set(readMine().map(String));
      updateMineBadge();
      if (CURRENT_VIEW) setView(CURRENT_VIEW);
    });
  } catch (e) {
    document.getElementById('view-content').innerHTML =
      `<p class="loading">加载失败：${esc(e.message)}<br>请确认在 build-output/ 目录下启动了本地服务。</p>`;
  }
}

function kindCount(k) { return DATA.activities.filter(x => x.kind === k).length; }

function fillStats(a, intel) {
  const forum = kindCount('official_program');
  const zone = kindCount('exhibition_zone');
  const side = DATA.activities.filter(x => x.kind === 'side_event' || x.kind === 'community').length;
  const exh = (DATA.themes.exhibitor_total) || 0;
  const intelN = (intel && intel.total) || DATA.intel.length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-forum', forum); set('stat-zone', zone); set('stat-side', side); set('stat-exh', exh); set('stat-intel', intelN);
  set('vt-n-official', forum + zone); set('vt-n-side', side); set('vt-n-exh', exh); set('vt-n-intel', intelN);
  set('foot-forum', forum); set('foot-zone', zone); set('foot-side', side); set('foot-exh', exh); set('foot-intel', intelN);
  set('data-version', a.version || '—');
}

function renderCountdown() {
  const start = new Date(2026, 6, 17), end = new Date(2026, 6, 20);
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const numEl = document.getElementById('cd-num'), unitEl = document.getElementById('cd-unit'), stEl = document.getElementById('cd-status');
  const dayMs = 86400000;
  if (today < start) { numEl.textContent = Math.round((start - today) / dayMs); unitEl.textContent = '天'; stEl.textContent = '距大会开幕'; }
  else if (today <= end) { numEl.textContent = 'Day ' + (Math.round((today - start) / dayMs) + 1); unitEl.textContent = '· 进行中'; stEl.textContent = '大会进行中'; numEl.style.fontSize = '2.2rem'; }
  else { numEl.textContent = '已闭幕'; unitEl.textContent = ''; stEl.textContent = '2026 WAIC'; numEl.style.fontSize = '2rem'; }
}

/* ------------------------------ view switching ------------------------------ */
function bindTabs() {
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
      document.getElementById('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
// 顶层导航 / 直达链接：#mine #official #side #exhibitors #intel
const HASH_VIEWS = { mine: 'mine', official: 'official', side: 'side', exhibitors: 'exhibitors', intel: 'intel' };
function routeFromHash() {
  const h = (location.hash || '').replace('#', '');
  if (!HASH_VIEWS[h]) return;
  setView(HASH_VIEWS[h]);
  const p = document.getElementById('panel');
  if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setView(v) {
  CURRENT_VIEW = v;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.nav-mine').forEach(b => b.classList.toggle('active', v === 'mine'));
  const controls = document.getElementById('controls');
  const content = document.getElementById('view-content');
  content.classList.toggle('grid', v === 'exhibitors');
  controls.style.setProperty('--vc', VIEW_COLOR[v]);
  controls.style.setProperty('--vtint', VIEW_TINT[v]);
  content.style.setProperty('--vc', VIEW_COLOR[v]);

  if (v === 'official') { renderOfficialControls(); renderOfficial(); }
  else if (v === 'side') { renderSideControls(); renderSide(); }
  else if (v === 'exhibitors') { ensureExhibitors().then(() => { renderExhControls(); renderExhibitors(); }); }
  else if (v === 'intel') { renderIntelControls(); renderIntel(); }
  else if (v === 'mine') { renderMineControls(); renderMine(); }
}

/* ============================ OFFICIAL ============================ */
function renderOfficialControls() {
  const f = F.official;
  const th = DATA.themes;
  const districts = (th.districts || []).filter(d => d.name);
  const venues = (th.venues || []).slice(0, 12);
  const cats = (th.categories || []).filter(c => ['分论坛', '主题论坛', '同期活动', '全体会议'].includes(c.name));
  const tracks = (th.tracks || []);
  // clean single tags
  const tagCounts = {};
  DATA.activities.filter(a => a.kind === 'official_program').forEach(a => flatTags(a).forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1));
  const tags = Object.entries(tagCounts).sort((x, y) => y[1] - x[1]).slice(0, 20);

  document.getElementById('controls').innerHTML = `
    <div class="controls-note" style="--vc:var(--official)">官方日程 = 大会官网发布的 <strong>174 场论坛</strong> + <strong>4 大展区</strong>。下方先看展区导览，再按天浏览论坛。</div>
    <div class="day-tabs" id="day-tabs">
      ${['', '1', '2', '3', '4'].map(d => `<button class="day-tab${f.day === d ? ' active' : ''}" data-day="${d}">${d === '' ? '全部' : 'Day ' + d + ' <span class="dw">' + (DAY_META[d].label) + '</span>'}</button>`).join('')}
    </div>
    <div class="filters">
      <div class="search-wrap">${SEARCH_ICON}<input type="search" id="q" placeholder="搜索论坛名、主办方、嘉宾、地点、关键词…" value="${esc(f.q)}"></div>
      <select id="f-district">${opt('', '全部片区', !f.district)}${districts.map(d => opt(d.name, `${d.name} (${d.count})`, f.district === d.name)).join('')}</select>
      <select id="f-venue">${opt('', '全部场馆', !f.venue)}${venues.map(v => opt(v.name, `${v.name} (${v.count})`, f.venue === v.name)).join('')}</select>
      <select id="f-category">${opt('', '全部类别', !f.category)}${cats.map(c => opt(c.name, `${c.name} (${c.count})`, f.category === c.name)).join('')}</select>
      <select id="f-track">${opt('', '全部板块', !f.track)}${tracks.map(t => opt(t.name, `${t.name} (${t.count})`, f.track === t.name)).join('')}</select>
      <select id="f-tag">${opt('', '全部标签', !f.tag)}${tags.map(([t, c]) => opt(t, `${t} (${c})`, f.tag === t)).join('')}</select>
      <span id="count"></span>
    </div>`;

  bindDayTabs('official');
  bindSearch('official');
  [['f-district', 'district'], ['f-venue', 'venue'], ['f-category', 'category'], ['f-track', 'track'], ['f-tag', 'tag']]
    .forEach(([id, key]) => document.getElementById(id).addEventListener('change', e => { F.official[key] = e.target.value; renderOfficial(); }));
}

function renderOfficial() {
  const f = F.official;
  // 搜索时全局搜（不分板块）：官方论坛 + 边会 / 社群 一起搜，按权重排序，超脑等高权重置顶；
  // 非搜索的浏览态：只显官方论坛（超脑由置顶卡代表），有筛选时并入超脑等官方合作活动。
  const searching = !!f.q;
  const filtering = !!(f.category || f.track || f.tag || f.venue || f.district);
  let progs = searching
    ? DATA.activities.filter(a => ['official_program', 'side_event', 'community'].includes(a.kind))
    : DATA.activities.filter(a => a.kind === 'official_program'
        || (filtering && a.kind === 'side_event' && a.waic_relation === 'official'));
  if (f.day) progs = progs.filter(a => String(a.day) === f.day);
  if (f.district) progs = progs.filter(a => a.district === f.district);
  if (f.venue) progs = progs.filter(a => a.venue === f.venue);
  if (f.category) progs = progs.filter(a => a.category === f.category);
  if (f.track) progs = progs.filter(a => a.track === f.track);
  if (f.tag) progs = progs.filter(a => flatTags(a).has(f.tag));
  if (f.q) progs = progs.filter(a => (a.search_text || '').includes(f.q));

  const cnt = document.getElementById('count');
  if (cnt) cnt.textContent = searching
    ? `搜索到 ${progs.length} 条 · 覆盖官方 + 边会 / 社群`
    : `显示 ${progs.length} / ${kindCount('official_program')} 场论坛`;

  // zones 导览带 + 超脑置顶：仅浏览态显示；搜索态隐藏以突出结果
  let html = '';
  const zones = searching ? [] : DATA.activities.filter(a => a.kind === 'exhibition_zone');
  if (zones.length) {
    html += `<div class="zones-block"><div class="zones-label">展区导览 · Exhibition Zones（${zones.length}）<span class="zones-sub">四大片区场馆 · 点开看官方定位 / 亮点 / 地图</span></div><div class="zones-grid">`;
    html += zones.map(z => {
      const d = ZONE_DESC[z.title] || ZONE_DESC[z.venue] || { role: '展区', desc: z.district || '' };
      const blurb = zoneBlurb(z) || d.desc;
      const cover = z.cover_img ? `<div class="z-cover" style="background-image:url('${esc(z.cover_img)}')"></div>` : '';
      return `<a class="zone-card${z.cover_img ? ' has-cover' : ''}" href="activity.html?id=${encodeURIComponent(z.id)}">
        ${cover}
        <div class="z-body">
          <span class="z-role">${esc(d.role)}${z.district ? ' · ' + esc(z.district) : ''}</span>
          <div class="z-name">${esc(z.title)}</div>
          <div class="z-desc">${esc(blurb)}</div>
          ${(z.halls && z.halls.length) ? `<div class="z-halls">${z.halls.slice(0,4).map(h => `<span>${esc(h.hall)}</span>`).join('')}</div>` : ''}
          <span class="z-more">看展区详情 →</span>
        </div>
      </a>`;
    }).join('');
    html += `</div></div>`;
  }

  // 超脑置顶：AI 原住民计划 = 与 WAIC 官方合作的青少年 AI 公益特别展，四天展台，方便直接加入日程
  const sb = DATA.activities.find(a => a.kind === 'side_event' && a.title.includes('超脑') && a.title.includes('参展'))
          || DATA.activities.find(a => a.kind === 'side_event' && a.title.includes('超脑'));
  if (sb && !f.q && !f.category && !f.track && !f.tag) {
    html += `<div class="pin-sb">
      <div class="pin-sb-flag">超脑 @ WAIC</div>
      <div class="pin-sb-main">
        <div class="pin-sb-title">AI 原住民计划 · 超脑展台（四天）</div>
        <div class="pin-sb-desc">世博展览馆 · 三大板块 · 六大主题展区 · 每日主题议程与青少年 AI 案例</div>
      </div>
      <div class="pin-sb-actions">
        <a class="pin-sb-btn" href="superbrain.html">查看展台议程 →</a>
        ${mineBtn(sb)}
      </div>
    </div>`;
  }

  const content = document.getElementById('view-content');
  if (!progs.length) { content.innerHTML = html + '<p class="list-note">没有匹配的论坛，试试放宽筛选或换个关键词。</p>'; return; }

  if (searching) {
    // 全局搜索结果：按权重降序（超脑=100 置顶），再按天 / 时间；超脑高亮
    const sorted = progs.slice().sort((x, y) =>
      (y.weight || 0) - (x.weight || 0)
      || (x.day || 99) - (y.day || 99)
      || (x.start_time || '99:99').localeCompare(y.start_time || '99:99'));
    html += `<div class="search-note">🔍 搜索覆盖官方论坛 + 边会 / 社群全部活动，按重要度排序</div>`;
    html += sorted.map(renderActivityCard).join('');
  } else {
    const sorted = sortOfficial(progs);
    if (!f.day) {
      const groups = {};
      sorted.forEach(a => { const d = a.day || 0; (groups[d] = groups[d] || []).push(a); });
      Object.keys(groups).sort((x, y) => (+x || 99) - (+y || 99)).forEach(d => {
        const meta = DAY_META[d];
        html += `<div class="day-group-head"><span class="dnum">${meta ? 'Day ' + d : '时间待定'}</span><span class="ddate mono">${meta ? meta.date + ' · ' + meta.label : ''}</span><span class="dcount">${groups[d].length} 场</span></div>`;
        html += groups[d].map(renderActivityCard).join('');
      });
    } else {
      html += sorted.map(renderActivityCard).join('');
    }
  }
  content.innerHTML = html;
}

/* ============================ SIDE (边会·周边) ============================ */
function renderSideControls() {
  const f = F.side;
  const tracks = (DATA.themes.tracks || []);
  document.getElementById('controls').innerHTML = `
    <div class="controls-note" style="--vc:var(--side)">边会·周边 = 民间发起、想去就报名的活动。每张卡直接看 <strong>时间 / 地点 / 是否需注册 / 票价 / 报名入口</strong>。非官方内容仅供参考。</div>
    <div class="day-tabs" id="day-tabs" style="--vc:var(--side)">
      ${['', '1', '2', '3', '4'].map(d => `<button class="day-tab${f.day === d ? ' active' : ''}" data-day="${d}">${d === '' ? '全部' : 'Day ' + d + ' <span class="dw">' + (DAY_META[d].label) + '</span>'}</button>`).join('')}
    </div>
    <div class="filters">
      <div class="search-wrap">${SEARCH_ICON}<input type="search" id="q" placeholder="搜索活动名、主办 / 社群、地点、关键词…" value="${esc(f.q)}"></div>
      <select id="f-relation">${opt('', '全部关联', !f.relation)}${opt('affiliated', '联名 / 合作', f.relation === 'affiliated')}${opt('co-located', '同城同期', f.relation === 'co-located')}</select>
      <select id="f-track">${opt('', '全部板块', !f.track)}${tracks.map(t => opt(t.name, `${t.name} (${t.count})`, f.track === t.name)).join('')}</select>
      <span id="count"></span>
    </div>`;
  bindDayTabs('side');
  bindSearch('side');
  document.getElementById('f-relation').addEventListener('change', e => { F.side.relation = e.target.value; renderSide(); });
  document.getElementById('f-track').addEventListener('change', e => { F.side.track = e.target.value; renderSide(); });
}

function renderSide() {
  const f = F.side;
  let list = DATA.activities.filter(a => a.kind === 'side_event' || a.kind === 'community');
  const total = list.length;
  if (f.day) list = list.filter(a => String(a.day) === f.day);
  if (f.relation) list = list.filter(a => a.waic_relation === f.relation);
  if (f.track) list = list.filter(a => a.track === f.track);
  if (f.q) list = list.filter(a => (a.search_text || '').includes(f.q));

  const cnt = document.getElementById('count');
  if (cnt) cnt.textContent = `显示 ${list.length} / ${total} 场`;

  list = sortSchedule(list);
  const content = document.getElementById('view-content');
  content.innerHTML = list.length ? list.map(renderSideCard).join('') : '<p class="list-note">没有匹配的边会，试试放宽筛选。</p>';
}

function renderSideCard(a) {
  const url = sourceUrl(a);
  const ch = (a.source || {}).channel;
  const pub = (a.source || {}).publisher || '';
  const t = timeLabel(a);
  const dayTag = a.day ? `Day ${a.day}` : (a.date || '');
  const venue = a.venue || '地点待公布';

  const metaBits = [];
  if (dayTag) metaBits.push(`<span class="time">${esc(dayTag)}</span>`);
  if (t) metaBits.push(`<span class="time">${esc(t)}</span>`);
  if (a.waic_relation && a.waic_relation !== 'official') metaBits.push(`<span class="rel-badge ${a.waic_relation}">${relationLabel(a.waic_relation)}</span>`);
  if (a.track) metaBits.push(`<span class="track-badge">${esc(a.track)}</span>`);

  // registration row
  const regBits = [];
  const reqd = a.registration_required;
  if (reqd === true) regBits.push('<span class="reg-tag need">需注册报名</span>');
  else if (reqd === false) regBits.push('<span class="reg-tag free">无需注册</span>');
  if (a.price) {
    const isFree = /免费/.test(a.price);
    regBits.push(`<span class="reg-tag ${isFree ? 'free' : 'price'}">${esc(a.price.length > 30 ? a.price.slice(0, 30) + '…' : a.price)}</span>`);
  }
  if ((a.additional_sources || []).length) regBits.push(`<span class="reg-tag multi">多来源 ·${a.additional_sources.length + 1}</span>`);
  const regBtn = a.registration_url ? `<a class="reg-btn" href="${esc(a.registration_url)}" target="_blank" rel="noopener" data-ext="1">报名 ${ICON_EXT}</a>` : '';

  const srcLink = url ? `<a class="src-link" href="${esc(url)}" target="_blank" rel="noopener" data-ext="1">来源 ${ICON_EXT}</a>` : '';

  return `<article class="card k-side" data-id="${esc(a.id)}" tabindex="0">
    <div class="card-meta">${metaBits.join('')}</div>
    <div class="card-title"><a href="activity.html?id=${encodeURIComponent(a.id)}">${esc(a.title)}</a></div>
    <div class="card-meta" style="margin-top:0.35rem;margin-bottom:0"><span class="venue">📍 ${esc(venue)}</span>${pub ? `<span>主办：${esc(pub)}</span>` : ''}</div>
    <div class="card-desc" style="margin-top:0.4rem">${esc(a.description || '')}</div>
    ${(regBits.length || regBtn) ? `<div class="reg-row">${regBits.join('')}${regBtn}</div>` : ''}
    <div class="card-src">
      <span class="src-badge ${channelClass(ch)}">${channelLabel(ch)}</span>
      <span class="src-pub">${esc(pub)}</span>
      ${srcLink}
    </div>
    <div class="card-actions">${mineBtn(a)}</div>
  </article>`;
}

/* ============================ EXHIBITORS ============================ */
async function ensureExhibitors() {
  if (DATA.exhibitors) return;
  document.getElementById('view-content').classList.remove('grid');
  document.getElementById('controls').innerHTML = '';
  document.getElementById('view-content').innerHTML = '<p class="loading">正在加载 1020 家参展商…</p>';
  const res = await fetch('data/exhibitors.json');
  const d = await res.json();
  DATA.exhibitors = d.exhibitors || [];
  DATA.exhFacets = d.facets || {};
}

function renderExhControls() {
  const f = F.exhibitors;
  const fc = DATA.exhFacets || {};
  const halls = (fc.halls || []);
  // flatten industries to clean singles
  const indCounts = {};
  (DATA.exhibitors || []).forEach(e => String(e.industry || '').split(',').forEach(p => { p = p.trim(); if (p) indCounts[p] = (indCounts[p] || 0) + 1; }));
  const industries = Object.entries(indCounts).sort((x, y) => y[1] - x[1]).slice(0, 25);
  const roles = [['展商', '展商'], ['论坛主办方', '论坛主办方']];

  document.getElementById('controls').innerHTML = `
    <div class="controls-note" style="--vc:var(--exh)">参展商目录 = WAIC 2026 官方 <strong>${(DATA.themes.exhibitor_total || DATA.exhibitors.length)}</strong> 家展商。按展馆 / 行业 / 角色筛选，点卡片展开完整介绍与全部展台。</div>
    <div class="filters">
      <div class="search-wrap">${SEARCH_ICON}<input type="search" id="q" placeholder="搜索企业名、行业、业务范围…" value="${esc(f.q)}"></div>
      <select id="f-hall">${opt('', '全部展馆', !f.hall)}${halls.map(h => opt(h.name, `${h.name} (${h.count})`, f.hall === h.name)).join('')}</select>
      <select id="f-industry">${opt('', '全部行业', !f.industry)}${industries.map(([n, c]) => opt(n, `${n} (${c})`, f.industry === n)).join('')}</select>
      <select id="f-role">${opt('', '全部角色', !f.role)}${roles.map(([v, l]) => opt(v, l, f.role === v)).join('')}</select>
      <span id="count"></span>
    </div>`;
  bindSearch('exhibitors', () => { F.exhibitors.page = 1; });
  document.getElementById('f-hall').addEventListener('change', e => { F.exhibitors.hall = e.target.value; F.exhibitors.page = 1; renderExhibitors(); });
  document.getElementById('f-industry').addEventListener('change', e => { F.exhibitors.industry = e.target.value; F.exhibitors.page = 1; renderExhibitors(); });
  document.getElementById('f-role').addEventListener('change', e => { F.exhibitors.role = e.target.value; F.exhibitors.page = 1; renderExhibitors(); });
}

function filteredExhibitors() {
  const f = F.exhibitors;
  let list = DATA.exhibitors || [];
  if (f.hall) list = list.filter(e => (e.halls || []).includes(f.hall));
  if (f.industry) list = list.filter(e => String(e.industry || '').split(',').map(s => s.trim()).includes(f.industry));
  if (f.role) list = list.filter(e => String(e.role || '').split(',').map(s => s.trim()).includes(f.role));
  if (f.q) list = list.filter(e => (e.search_text || '').includes(f.q));
  return list;
}

function renderExhibitors() {
  const f = F.exhibitors;
  const list = filteredExhibitors();
  const cnt = document.getElementById('count');
  if (cnt) cnt.textContent = `显示 ${Math.min(f.page * EXH_PAGE, list.length)} / ${list.length} 家`;

  const content = document.getElementById('view-content');
  content.classList.add('grid');
  if (!list.length) { content.classList.remove('grid'); content.innerHTML = '<p class="list-note">没有匹配的参展商，试试放宽筛选或换个关键词。</p>'; return; }

  const shown = list.slice(0, f.page * EXH_PAGE);
  content.innerHTML = shown.map(renderExhCard).join('');

  // load more (outside grid)
  let lm = document.getElementById('load-more-wrap');
  if (lm) lm.remove();
  if (list.length > shown.length) {
    lm = document.createElement('div');
    lm.id = 'load-more-wrap'; lm.className = 'load-more-wrap';
    lm.style.gridColumn = '1 / -1';
    lm.innerHTML = `<button class="load-more" id="load-more">加载更多（还有 ${list.length - shown.length} 家）</button>`;
    content.appendChild(lm);
    document.getElementById('load-more').addEventListener('click', () => { F.exhibitors.page++; renderExhibitors(); });
  }
}

function renderExhCard(e) {
  const initial = (e.name || '·').trim().charAt(0);
  const booths = e.booths || [];
  const firstBooth = booths[0];
  const industries = String(e.industry || '').split(',').map(s => s.trim()).filter(Boolean);
  const boothLines = booths.map(b => `<div class="booth-line"><span class="no">${esc(b.no)}</span> · ${esc(b.hall)}${b.district ? ' · ' + esc(b.district) : ''}</div>`).join('');
  return `<div class="exh-card" data-id="${esc(e.id)}">
    <div class="exh-head">
      <div class="exh-logo">${e.logo ? `<img src="${esc(e.logo)}" alt="" onerror="this.parentNode.textContent='${esc(initial)}'">` : esc(initial)}</div>
      <div class="exh-main">
        <div class="exh-name">${esc(e.name)}${e.name_en ? `<span class="en">${esc(e.name_en)}</span>` : ''}</div>
        <div class="exh-meta">
          ${firstBooth ? `<span class="exh-booth">${esc(firstBooth.no)}</span>` : ''}
          ${firstBooth ? `<span class="exh-hall">${esc(firstBooth.hall)}</span>` : ''}
          ${booths.length > 1 ? `<span class="exh-hall">+${booths.length - 1} 展台</span>` : ''}
          ${industries.slice(0, 2).map(i => `<span class="exh-industry">${esc(i)}</span>`).join('')}
          ${e.role && e.role !== '展商' ? `<span class="exh-role">${esc(e.role.replace('展商,', ''))}</span>` : ''}
        </div>
        ${e.intro ? `<div class="exh-intro">${esc(e.intro)}</div>` : ''}
      </div>
      <span class="exh-toggle">详情 ${ICON_CHEV}</span>
    </div>
    <div class="exh-detail">
      ${booths.length ? `<div class="row"><div class="k">展台（${booths.length}）</div><div class="booths">${boothLines}</div></div>` : ''}
      ${e.business_scope ? `<div class="row"><div class="k">业务范围</div>${esc(e.business_scope)}</div>` : ''}
      ${e.partner_level ? `<div class="row"><div class="k">合作级别</div>${esc(e.partner_level)}</div>` : ''}
      ${e.role ? `<div class="row"><div class="k">角色</div>${esc(e.role)}</div>` : ''}
    </div>
  </div>`;
}

/* ============================ INTEL ============================ */
function renderIntelControls() {
  const f = F.intel;
  const chCounts = { wechat: 0, web: 0 };
  DATA.intel.forEach(a => { if (chCounts[a.channel] !== undefined) chCounts[a.channel]++; });
  document.getElementById('controls').innerHTML = `
    <div class="controls-note" style="--vc:var(--intel)">情报站是 WAIC 相关的 <strong>资讯 / 攻略 / 报道素材</strong>（非活动本身）。其中的活动信息已抽取进前面三个板块，这里保留出处与原文，便于深读核对。</div>
    <div class="filters">
      <div class="search-wrap">${SEARCH_ICON}<input type="search" id="q" placeholder="搜索标题、媒体、摘要…" value="${esc(f.q)}"></div>
      <select id="f-channel">${opt('', '全部来源', !f.channel)}${opt('wechat', `公众号 (${chCounts.wechat})`, f.channel === 'wechat')}${opt('web', `网络 (${chCounts.web})`, f.channel === 'web')}</select>
      <span id="count"></span>
    </div>`;
  bindSearch('intel');
  document.getElementById('f-channel').addEventListener('change', e => { F.intel.channel = e.target.value; renderIntel(); });
}

function renderIntel() {
  const f = F.intel;
  let list = DATA.intel.slice();
  if (f.channel) list = list.filter(a => a.channel === f.channel);
  if (f.q) {
    const q = f.q;
    list = list.filter(a => ((a.title || '') + (a.summary || '') + (a.publisher || '')).toLowerCase().includes(q));
  }
  list.sort((x, y) => (y.date || '').localeCompare(x.date || ''));
  const cnt = document.getElementById('count');
  if (cnt) cnt.textContent = `显示 ${list.length} / ${DATA.intel.length} 篇`;
  const content = document.getElementById('view-content');
  content.classList.remove('grid');
  content.innerHTML = list.length ? list.map(renderIntelItem).join('') : '<p class="list-note">没有匹配的情报素材。</p>';
}

function renderIntelItem(a) {
  const url = a.url || a.sogou_url || '';
  return `<article class="intel-item">
    <div class="intel-meta">
      <span class="date">${esc(a.date || '')}</span>
      <span class="src-badge ${channelClass(a.channel)}">${channelLabel(a.channel)}</span>
      <span>${esc(a.publisher || '')}</span>
    </div>
    <div class="intel-title">${esc(a.title)}</div>
    ${a.summary ? `<div class="intel-summary">${esc(a.summary)}</div>` : ''}
    <div class="intel-foot">
      <span>来源：${esc(a.publisher || '未知')}</span>
      ${url ? `<a class="src-link" href="${esc(url)}" target="_blank" rel="noopener" style="margin-left:auto">看原文 ${ICON_EXT}</a>` : '<span style="margin-left:auto">（暂无链接）</span>'}
    </div>
  </article>`;
}

/* ============================ shared card + bindings ============================ */
function renderActivityCard(a) {
  const url = sourceUrl(a);
  const ch = (a.source || {}).channel;
  const pub = (a.source || {}).publisher || '';
  const isSb = (a.title || '').includes('超脑');   // 超脑活动：高亮置顶
  const t = timeLabel(a);
  const venueBits = [a.venue, a.room].filter(Boolean).join(' · ');
  const dayTag = a.day ? `Day ${a.day}` : '';

  const metaBits = [];
  if (dayTag) metaBits.push(`<span class="time">${dayTag}</span>`);
  if (t) metaBits.push(`<span class="time">${esc(t)}</span>`);
  if (venueBits) metaBits.push(`<span class="venue">${esc(venueBits)}</span>`);
  if (a.district) metaBits.push(`<span>${esc(a.district)}</span>`);
  if (a.category) metaBits.push(`<span class="kind-chip">${esc(a.category)}</span>`);
  if (a.track) metaBits.push(`<span class="track-badge">${esc(a.track)}</span>`);

  const tags = [...flatTags(a)].slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const srcLink = url ? `<a class="src-link" href="${esc(url)}" target="_blank" rel="noopener" data-ext="1">原文 ${ICON_EXT}</a>` : '';

  return `<article class="card k-official${isSb ? ' sb-hit' : ''}" data-id="${esc(a.id)}" tabindex="0">
    <div class="card-meta">${isSb ? '<span class="sb-chip">超脑</span>' : ''}${metaBits.join('')}</div>
    <div class="card-title"><a href="activity.html?id=${encodeURIComponent(a.id)}">${esc(a.title)}</a></div>
    <div class="card-desc">${esc(a.description || '')}</div>
    ${tags ? `<div class="card-tags">${tags}</div>` : ''}
    <div class="card-src"><span class="src-badge ${channelClass(ch)}">${channelLabel(ch)}</span><span class="src-pub">${esc(pub)}</span>${srcLink}</div>
    <div class="card-actions">${mineBtn(a)}</div>
  </article>`;
}

function sortSchedule(list) {
  return list.slice().sort((x, y) => {
    const dx = x.day || 99, dy = y.day || 99;
    if (dx !== dy) return dx - dy;
    return (x.start_time || '99:99').localeCompare(y.start_time || '99:99');
  });
}

// 官方论坛：先按天，再按重要度（全体会议/Keynote→主题论坛→分论坛→同期活动），同档按开始时间
const OFFICIAL_RANK = { '全体会议': 0, '主题论坛': 1, '分论坛': 2, '同期活动': 3 };
function sortOfficial(list) {
  return list.slice().sort((x, y) => {
    const dx = x.day || 99, dy = y.day || 99;
    if (dx !== dy) return dx - dy;
    const rx = OFFICIAL_RANK[x.category] ?? 5, ry = OFFICIAL_RANK[y.category] ?? 5;
    if (rx !== ry) return rx - ry;
    return (x.start_time || '99:99').localeCompare(y.start_time || '99:99');
  });
}

// 展区卡片一句话看点：优先亮点，否则取官方简介去掉标题段后的第一句
function zoneBlurb(z) {
  if (z.highlights && z.highlights.length) return z.highlights[0];
  let s = (z.description || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^｜|]{2,12}[｜|][^。]{2,24}[。\s]*/, '');
  const m = s.match(/^[^。]{6,70}。/);
  return m ? m[0] : s.slice(0, 60);
}

function bindDayTabs(view) {
  document.querySelectorAll('#day-tabs .day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#day-tabs .day-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      F[view].day = tab.dataset.day;
      ({ official: renderOfficial, side: renderSide, mine: renderMine })[view]();
    });
  });
}
function bindSearch(view, before) {
  const el = document.getElementById('q');
  if (!el) return;
  let deb;
  el.addEventListener('input', e => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      F[view].q = e.target.value.trim().toLowerCase();
      if (before) before();
      ({ official: renderOfficial, side: renderSide, exhibitors: renderExhibitors, intel: renderIntel })[view]();
    }, 140);
  });
}

/* delegated: card click → detail (ignore external links & exhibitor toggle) */
document.getElementById('view-content').addEventListener('click', e => {
  const mb = e.target.closest('[data-mine]');
  if (mb) { e.stopPropagation(); handleMineToggle(mb.dataset.mine); return; }
  const rm = e.target.closest('[data-remove-mine]');
  if (rm) { e.stopPropagation(); toggleMine(rm.dataset.removeMine); renderMine(); return; }
  if (e.target.closest('[data-ext]')) return;
  if (e.target.closest('.card-title a')) return;
  if (e.target.closest('#load-more')) return;
  const exh = e.target.closest('.exh-card');
  if (exh) { exh.classList.toggle('expanded'); return; }
  const card = e.target.closest('.card');
  if (card) location.href = 'activity.html?id=' + encodeURIComponent(card.dataset.id);
});
document.getElementById('view-content').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const card = e.target.closest('.card');
  if (card) location.href = 'activity.html?id=' + encodeURIComponent(card.dataset.id);
});

/* ============================ 我的日程 (My Schedule) ============================ */
// 自动兴趣：把行为信号（加入日程的活动 tags/track）累积到 profile.inferred（带权重），随同步上行
function bumpInferred(terms, w) {
  if (!terms || !terms.length) return;
  const pk = 'waic2026.profile.v1';
  let p; try { p = JSON.parse(localStorage.getItem(pk) || '{}'); } catch (e) { p = {}; }
  if (!p.inferred || typeof p.inferred !== 'object') p.inferred = {};
  terms.forEach(t => { t = String(t).trim(); if (t && t.length <= 20) p.inferred[t] = Math.round(((p.inferred[t] || 0) + w) * 1000) / 1000; });
  try { localStorage.setItem(pk, JSON.stringify(p)); } catch (e) {}
  if (window.WAICSync) window.WAICSync.touch();
}

function handleMineToggle(id) {
  const on = toggleMine(id);
  if (on) {
    const a = DATA.activities.find(x => String(x.id) === String(id));
    if (a) { const terms = [...flatTags(a)]; if (a.track) terms.push(a.track); bumpInferred(terms, 1); }
  }
  document.querySelectorAll('[data-mine]').forEach(b => {
    if (b.dataset.mine !== String(id)) return;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    const ic = b.querySelector('.mb-ic'); if (ic) ic.innerHTML = on ? ICON_CHECK : ICON_PLUS;
    const lb = b.querySelector('.mb-label'); if (lb) lb.textContent = on ? '已加入我的日程' : '加入我的日程';
  });
  if (CURRENT_VIEW === 'mine') renderMine();
}
function updateMineBadge() {
  const n = MINE.size;
  const el = document.getElementById('me-count'); if (el) el.textContent = n;
  const entry = document.getElementById('mine-entry'); if (entry) entry.classList.toggle('has', n > 0);
  document.querySelectorAll('.nav-mine-n').forEach(b => { b.textContent = n || ''; b.classList.toggle('has', n > 0); });
}

function renderMineControls() {
  const f = F.mine;
  const list = mineActivities();
  const dayCounts = {};
  list.forEach(a => { const d = a.day || 0; dayCounts[d] = (dayCounts[d] || 0) + 1; });
  const syncCode = window.WAICSync ? window.WAICSync.code() : '';
  document.getElementById('controls').innerHTML = `
    <div class="controls-note" style="--vc:var(--official)">我的日程存在<strong>你自己的浏览器</strong>里，无需登录。同一天时间重叠会 <strong style="color:var(--live)">红色高亮撞车</strong>。可一键导出到日历，或生成分享长图。</div>
    ${syncCode ? `<div class="sync-bar">
      <span class="sync-ic">🔗</span>
      <div class="sync-main"><span class="sync-txt">跨设备 / AI 助手 同步码</span><code class="sync-code" id="sync-code">${esc(syncCode)}</code><button class="sync-copy" id="sync-copy" type="button">复制</button></div>
      <span class="sync-hint">在你的另一台设备、或装了 WAIC skill 的 AI 助手里填入它，日程和兴趣就会自动同步（无需登录）。</span>
    </div>` : ''}
    ${list.length ? `<div class="mine-actions">
      <button class="mine-act primary" id="mine-share" type="button">📸 生成分享长图</button>
      <button class="mine-act" id="mine-ics" type="button">📅 导出到日历 (.ics)</button>
      <button class="mine-act ghost" id="mine-clear" type="button">清空</button>
    </div>
    <div class="day-tabs" id="day-tabs" style="--vc:var(--official)">
      ${['', '1', '2', '3', '4'].map(d => {
        const c = d === '' ? list.length : (dayCounts[d] || 0);
        return `<button class="day-tab${f.day === d ? ' active' : ''}" data-day="${d}">${d === '' ? '全部' : 'Day ' + d}<span class="dw">${d === '' ? '' : DAY_META[d].label}${c ? ' · ' + c : ''}</span></button>`;
      }).join('')}
    </div>` : ''}`;
  const copyBtn = document.getElementById('sync-copy');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const code = (document.getElementById('sync-code') || {}).textContent || '';
    const done = () => { copyBtn.textContent = '已复制 ✓'; setTimeout(() => { copyBtn.textContent = '复制'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(done);
    else done();
  });
  if (list.length) {
    bindDayTabs('mine');
    document.getElementById('mine-share').addEventListener('click', generateShareImage);
    document.getElementById('mine-ics').addEventListener('click', exportICS);
    document.getElementById('mine-clear').addEventListener('click', () => {
      if (!MINE.size) return;
      if (confirm('确定清空我的日程？此操作不可撤销。')) { MINE.clear(); persistMine(); renderMineControls(); renderMine(); }
    });
  }
}

function renderMine() {
  const f = F.mine;
  const all = mineActivities();
  const content = document.getElementById('view-content');
  content.classList.remove('grid');
  if (!all.length) {
    content.innerHTML = `<div class="mine-empty">
      <div class="me-ico">☆</div>
      <div class="me-h">还没有加入任何活动</div>
      <div class="me-p">在「官方日程」或「边会 · 周边」里，点每张卡片下方的 <b>加入我的日程</b>，就会出现在这里。<br>之后可一键导出到日历、生成分享长图。</div>
      <button class="mine-act primary" type="button" onclick="setView('official')">去挑选官方论坛 →</button>
    </div>`;
    return;
  }
  let show = all;
  if (f.day) show = all.filter(a => String(a.day || 0) === f.day);
  const groups = {};
  show.forEach(a => { const d = a.day || 0; (groups[d] = groups[d] || []).push(a); });
  let html = '';
  Object.keys(groups).sort((x, y) => (+x || 99) - (+y || 99)).forEach(d => {
    const meta = DAY_META[d];
    const items = sortSchedule(groups[d]);
    const clashes = findClashes(items);
    html += `<div class="day-group-head"><span class="dnum">${meta ? 'Day ' + d : '时间待定'}</span><span class="ddate mono">${meta ? meta.date + ' · ' + meta.label : '未标注日期'}</span><span class="dcount">${items.length} 场${clashes.size ? ` · <span style="color:var(--live)">${clashes.size} 场撞车</span>` : ''}</span></div>`;
    html += items.map(a => renderMineCard(a, clashes.has(String(a.id)))).join('');
  });
  content.innerHTML = html;
}

function renderMineCard(a, clash) {
  const t = timeLabel(a);
  const kind = (a.kind === 'side_event' || a.kind === 'community') ? 'k-side' : 'k-official';
  const venueBits = [a.venue, a.room].filter(Boolean).join(' · ') || '地点待公布';
  return `<article class="card mine-card ${kind}${clash ? ' clash' : ''}" data-id="${esc(a.id)}" tabindex="0">
    <div class="card-meta">
      ${clash ? '<span class="clash-badge">⚠ 时间撞车</span>' : ''}
      ${t ? `<span class="time">${esc(t)}</span>` : '<span class="time" style="color:var(--ink-mute)">时间待定</span>'}
      ${a.category ? `<span class="kind-chip">${esc(a.category)}</span>` : ''}
    </div>
    <div class="card-title"><a href="activity.html?id=${encodeURIComponent(a.id)}">${esc(a.title)}</a></div>
    <div class="card-meta" style="margin-top:0.35rem;margin-bottom:0"><span class="venue">📍 ${esc(venueBits)}</span></div>
    <button class="mine-remove" data-remove-mine="${esc(a.id)}" type="button">${ICON_X}<span>移除</span></button>
  </article>`;
}

/* ---- 撞车检测 ---- */
function toMin(t) { if (!t) return null; const m = /^(\d{1,2}):(\d{2})/.exec(String(t)); return m ? (+m[1] * 60 + +m[2]) : null; }
function addMinToTime(t, mins) { const v = toMin(t); if (v == null) return ''; const x = v + mins; return String(Math.floor(x / 60) % 24).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
function findClashes(items) {
  const clash = new Set();
  const iv = items.map(a => { const s = toMin(a.start_time); if (s == null) return null; let e = toMin(a.end_time); if (e == null || e <= s) e = s + 90; return { id: String(a.id), s, e }; });
  for (let i = 0; i < iv.length; i++) {
    for (let j = i + 1; j < iv.length; j++) {
      const A = iv[i], B = iv[j];
      if (!A || !B) continue;
      if (A.s < B.e && B.s < A.e) { clash.add(A.id); clash.add(B.id); }
    }
  }
  return clash;
}

/* ---- 导出 .ics ---- */
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  // RFC 5545 line folding: <=75 octets/line, continuation lines start with a single space (UTF-8 safe)
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 73) return line;
  let out = '', cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 72) { out += (out ? '\r\n ' : '') + cur; cur = ch; }
    else cur += ch;
  }
  out += (out ? '\r\n ' : '') + cur;
  return out;
}
function icsDateTime(date, time) { const [y, mo, d] = date.split('-'); const hm = time ? time.split(':') : ['00', '00']; return `${y}${mo}${d}T${String(hm[0]).padStart(2, '0')}${String(hm[1] || '00').padStart(2, '0')}00`; }
function buildICS(list) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SuperBrain//WAIC2026 参展助手//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:我的 WAIC 2026 日程', 'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Shanghai', 'BEGIN:STANDARD', 'DTSTART:19910101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:CST', 'END:STANDARD', 'END:VTIMEZONE'];
  list.forEach(a => {
    if (!a.date) return;
    L.push('BEGIN:VEVENT');
    L.push('UID:' + String(a.id) + '@' + SITE_URL);
    L.push('DTSTAMP:' + dtstamp);
    if (a.start_time) {
      L.push('DTSTART;TZID=Asia/Shanghai:' + icsDateTime(a.date, a.start_time));
      const end = a.end_time || addMinToTime(a.start_time, 90);
      L.push('DTEND;TZID=Asia/Shanghai:' + icsDateTime(a.date, end));
    } else {
      L.push('DTSTART;VALUE=DATE:' + a.date.replace(/-/g, ''));
    }
    L.push('SUMMARY:' + icsEsc(a.title));
    const loc = [a.venue, a.room, a.district].filter(Boolean).join(' ');
    if (loc) L.push('LOCATION:' + icsEsc(loc));
    const url = sourceUrl(a);
    const dp = [];
    if (a.description) dp.push(String(a.description).slice(0, 280));
    if (url) dp.push('来源：' + url);
    dp.push('via ' + SITE_URL + ' · 超脑 × 王佳梁 AI OPC 工作室');
    L.push('DESCRIPTION:' + icsEsc(dp.join('\n')));
    if (url) L.push('URL:' + url);
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n');
}
function exportICS() {
  const list = mineActivities().filter(a => a.date);
  if (!list.length) { alert('我的日程里还没有带日期、可导出的活动。'); return; }
  const blob = new Blob([buildICS(list)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '我的WAIC2026日程.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ---- 分享长图 (canvas 竖版海报) ---- */
const POSTER_SANS = '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
const POSTER_SERIF = '"Songti SC", "STSong", "Noto Serif SC", serif';
const POSTER_MONO = '"SF Mono", ui-monospace, Menlo, monospace';
function loadImg(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
function wrapText(ctx, text, maxW, maxLines) {
  const chars = [...String(text)]; const all = []; let cur = '';
  for (const ch of chars) {
    if (ctx.measureText(cur + ch).width > maxW && cur) { all.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) all.push(cur);
  if (!maxLines || all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (ctx.measureText(last + '…').width > maxW && last.length) last = last.slice(0, -1);
  out[maxLines - 1] = last + '…';
  return out;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
async function generateShareImage() {
  const all = mineActivities();
  if (!all.length) { alert('先加入一些活动到「我的日程」，再生成分享长图。'); return; }
  const btn = document.getElementById('mine-share');
  const btnTxt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
  try {
    let qr = null;
    try { qr = await loadImg('assets/superbrain-qr.png'); } catch (e) { qr = null; }

    const W = 560, PAD = 34, timeColW = 66, gap = 14;
    const rx = PAD + timeColW + gap, rw = W - PAD - rx;
    const stripes = ['#1d5178', '#9a6516', '#157567', '#8a3d63'];
    const HH = 152, FOOT = 196, bodyTop = HH + 22;

    const groups = {};
    all.forEach(a => { const d = a.day || 0; (groups[d] = groups[d] || []).push(a); });
    const dayKeys = Object.keys(groups).sort((x, y) => (+x || 99) - (+y || 99));

    const mc = document.createElement('canvas').getContext('2d');
    const plan = [];
    let y = bodyTop;
    dayKeys.forEach(d => {
      const meta = DAY_META[d];
      const items = sortSchedule(groups[d]);
      const clashes = findClashes(items);
      plan.push({ type: 'dayhead', y, d, meta, count: items.length });
      y += 46;
      items.forEach(a => {
        mc.font = '600 15.5px ' + POSTER_SANS;
        const titleLines = wrapText(mc, a.title, rw, 2);
        const venueBits = [a.venue, a.room].filter(Boolean).join(' · ') || '地点待公布';
        mc.font = '13px ' + POSTER_SANS;
        const venueLine = wrapText(mc, '📍 ' + venueBits, rw, 1)[0];
        const rowH = 14 + titleLines.length * 21 + 6 + 17 + 10;
        plan.push({ type: 'act', y, h: rowH, a, titleLines, venueLine, clash: clashes.has(String(a.id)) });
        y += rowH;
      });
      y += 10;
    });
    const totalH = Math.ceil(y + 8 + FOOT);

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale; canvas.height = totalH * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = '#eef0ec'; ctx.fillRect(0, 0, W, totalH);

    // header
    const hg = ctx.createLinearGradient(0, 0, W, HH);
    hg.addColorStop(0, '#1d5178'); hg.addColorStop(1, '#0d2c45');
    ctx.fillStyle = hg; ctx.fillRect(0, 0, W, HH);
    ctx.fillStyle = 'rgba(255,255,255,0.72)'; ctx.font = '600 12px ' + POSTER_SANS;
    ctx.fillText('WAIC · 2026 · 世界人工智能大会 · 上海', PAD, 42);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 32px ' + POSTER_SERIF;
    ctx.fillText('我的 WAIC 2026 日程', PAD, 88);
    ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.font = '14px ' + POSTER_SANS;
    ctx.fillText('7 月 17–20 日 · 上海 · 共 ' + all.length + ' 场已选', PAD, 120);
    const sw = W / 4;
    stripes.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * sw, HH - 5, sw, 5); });

    // body
    plan.forEach(p => {
      if (p.type === 'dayhead') {
        ctx.fillStyle = '#1d5178'; ctx.beginPath(); ctx.arc(PAD + 4, p.y + 13, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#12151b'; ctx.font = '700 18px ' + POSTER_SERIF;
        ctx.fillText(p.meta ? 'Day ' + p.d : '时间待定', PAD + 16, p.y + 20);
        ctx.fillStyle = '#757b85'; ctx.font = '12px ' + POSTER_SANS;
        ctx.fillText(p.meta ? p.meta.date + ' · ' + p.meta.label : '未标注日期', PAD + 92, p.y + 20);
        ctx.textAlign = 'right'; ctx.fillText(p.count + ' 场', W - PAD, p.y + 20); ctx.textAlign = 'left';
        ctx.strokeStyle = 'rgba(18,21,27,0.14)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD, p.y + 32); ctx.lineTo(W - PAD, p.y + 32); ctx.stroke();
      } else {
        const a = p.a, isSide = a.kind === 'side_event' || a.kind === 'community';
        const accent = p.clash ? '#bf3d2b' : (isSide ? '#9a6516' : '#1d5178');
        const cardX = PAD - 8, cardY = p.y, cardW = W - 2 * (PAD - 8), cardH = p.h - 8;
        roundRect(ctx, cardX, cardY, cardW, cardH, 9);
        ctx.fillStyle = p.clash ? '#fbecea' : '#ffffff'; ctx.fill();
        ctx.fillStyle = accent; ctx.fillRect(cardX, cardY + 8, 3, cardH - 16);
        // time
        ctx.fillStyle = accent; ctx.font = '600 14px ' + POSTER_SANS;
        if (a.start_time) {
          ctx.fillText(a.start_time, PAD + 6, cardY + 28);
          if (a.end_time) { ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.font = '11px ' + POSTER_SANS; ctx.fillText(a.end_time, PAD + 6, cardY + 44); }
        } else { ctx.fillStyle = '#9096a0'; ctx.font = '12px ' + POSTER_SANS; ctx.fillText('待定', PAD + 6, cardY + 28); }
        // title
        ctx.fillStyle = '#12151b'; ctx.font = '600 15.5px ' + POSTER_SANS;
        let ty = cardY + 26;
        p.titleLines.forEach(ln => { ctx.fillText(ln, rx, ty); ty += 21; });
        ctx.fillStyle = '#757b85'; ctx.font = '13px ' + POSTER_SANS;
        ctx.fillText(p.venueLine, rx, ty + 2);
        if (p.clash) {
          ctx.fillStyle = '#bf3d2b'; ctx.font = '600 11px ' + POSTER_SANS;
          ctx.textAlign = 'right'; ctx.fillText('⚠ 撞车', W - PAD - 2, cardY + 22); ctx.textAlign = 'left';
        }
      }
    });

    // footer
    const fy = totalH - FOOT;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, fy, W, FOOT);
    stripes.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * sw, fy, sw, 4); });
    const qrSize = 116, qrX = PAD, qrY = fy + (FOOT - qrSize) / 2 + 4;
    if (qr) {
      ctx.fillStyle = '#fff'; roundRect(ctx, qrX - 4, qrY - 4, qrSize + 8, qrSize + 8, 8); ctx.fill();
      ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);
    }
    const tx = qrX + qrSize + 24;
    ctx.fillStyle = '#12151b'; ctx.font = '700 17px ' + POSTER_SERIF;
    ctx.fillText('超脑 × 王佳梁 AI OPC 工作室', tx, fy + 56);
    ctx.fillStyle = '#3a3f48'; ctx.font = '13px ' + POSTER_SANS;
    ctx.fillText('扫码关注超脑，把日程装进你的 AI 助手', tx, fy + 84);
    ctx.fillStyle = '#123c5c'; ctx.font = '600 15px ' + POSTER_MONO;
    ctx.fillText(SITE_URL, tx, fy + 116);
    ctx.fillStyle = '#757b85'; ctx.font = '12px ' + POSTER_SANS;
    ctx.fillText('联名出品 · 一夜 AI native 建成', tx, fy + 142);

    showShareModal(canvas.toDataURL('image/png'));
  } catch (e) {
    alert('生成分享长图失败：' + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btnTxt; }
  }
}
function showShareModal(dataUrl) {
  let m = document.getElementById('share-modal');
  if (!m) { m = document.createElement('div'); m.id = 'share-modal'; document.body.appendChild(m); }
  m.className = 'share-modal open';
  m.innerHTML = `
    <div class="sm-backdrop"></div>
    <div class="sm-panel">
      <div class="sm-hint">长按图片保存到相册，或点下方按钮下载</div>
      <div class="sm-imgwrap"><img class="sm-img" src="${dataUrl}" alt="我的 WAIC 2026 日程"></div>
      <div class="sm-acts">
        <a class="mine-act primary" href="${dataUrl}" download="我的WAIC2026日程.png">下载长图</a>
        <button class="mine-act ghost" id="sm-close" type="button">关闭</button>
      </div>
    </div>`;
  const close = () => m.classList.remove('open');
  m.querySelector('.sm-backdrop').addEventListener('click', close);
  m.querySelector('#sm-close').addEventListener('click', close);
}

/* ============================ 今日看点 Top 10 ============================ */
function renderTodayTop() {
  const sec = document.getElementById('today-top');
  if (!sec) return;
  const start = new Date(2026, 6, 17), end = new Date(2026, 6, 20);
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let day, prefix;
  if (today < start) { day = 1; prefix = '开幕日 · Day 1'; }
  else if (today <= end) { day = Math.round((today - start) / 86400000) + 1; prefix = '今日 · Day ' + day; }
  else { sec.hidden = true; return; }
  let progs = DATA.activities.filter(a => a.kind === 'official_program' && String(a.day) === String(day));
  if (!progs.length) { sec.hidden = true; return; }
  const rank = c => ({ '全体会议': 0, '主题论坛': 1, '分论坛': 2, '同期活动': 3 }[c] ?? 4);
  progs = progs.slice().sort((x, y) => rank(x.category) - rank(y.category) || (x.start_time || '99:99').localeCompare(y.start_time || '99:99'));
  const top = progs.slice(0, 10);
  const meta = DAY_META[day];
  sec.hidden = false;
  sec.innerHTML = `
    <div class="container">
      <div class="section-head tt-head">
        <span class="eyebrow">今日看点 · Top 10</span>
        <h2>${prefix} <span class="tt-date mono">${meta.date} · ${meta.label}</span></h2>
        <p>按官方论坛的类别与开场时间挑选的当天重点场次。<a href="#panel" id="tt-all">看全部官方日程 →</a></p>
      </div>
      <div class="tt-scroll">${top.map((a, i) => ttCard(a, i + 1)).join('')}</div>
    </div>`;
  document.getElementById('tt-all').addEventListener('click', e => {
    e.preventDefault(); F.official.day = String(day); setView('official');
    document.getElementById('panel').scrollIntoView({ behavior: 'smooth' });
  });
  sec.querySelector('.tt-scroll').addEventListener('click', e => {
    const mb = e.target.closest('[data-mine]');
    if (mb) { e.preventDefault(); e.stopPropagation(); handleMineToggle(mb.dataset.mine); return; }
    if (e.target.closest('a')) return;
    const c = e.target.closest('.tt-card');
    if (c) location.href = 'activity.html?id=' + encodeURIComponent(c.dataset.id);
  });
}
function ttCard(a, rank) {
  const t = a.start_time ? (a.end_time ? a.start_time + '–' + a.end_time : a.start_time) : '时间待定';
  const venue = [a.venue, a.room].filter(Boolean).join(' · ') || '地点待公布';
  return `<article class="tt-card" data-id="${esc(a.id)}" tabindex="0">
    <div class="tt-top"><span class="tt-rank">${rank}</span><span class="tt-time mono">${esc(t)}</span>${a.category ? `<span class="tt-cat">${esc(a.category)}</span>` : ''}</div>
    <div class="tt-title">${esc(a.title)}</div>
    <div class="tt-venue">📍 ${esc(venue)}</div>
    <div class="tt-foot">${mineBtn(a)}</div>
  </article>`;
}

loadData();

/* ============================ 我的日程 · 对外桥接（供网站内 AI 助手 chat.js 复用） ============================
   显式、最小的集成契约：chat.js 只依赖 window.WAICMine，不直接触碰 Phase 1 内部实现。
   - buttonHTML(id)  生成与站内一致的「加入我的日程」按钮（含 .mb-ic/.mb-label，便于统一同步）
   - toggle(id)      切换并同步全站所有 [data-mine] 按钮（handleMineToggle 已 querySelectorAll 全文档）
   - has(id) / count() 读取状态
   - goto()          跳到「我的日程」视图 */
window.WAICMine = {
  buttonHTML: (id) => mineBtn({ id }),
  toggle: (id) => handleMineToggle(String(id)),
  has: (id) => isMine(id),
  count: () => MINE.size,
  goto: () => {
    setView('mine');
    const p = document.getElementById('panel');
    if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
};
