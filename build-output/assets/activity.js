/* ==========================================================================
   WAIC 2026 参展助手 · 详情页（运行时按 id 从 activities.json 取数渲染）
   支持 official_program / exhibition_zone / side_event
   ========================================================================== */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nl2p(s) { return String(s || '').split(/\n+/).filter(x => x.trim()).map(x => `<p>${esc(x.trim())}</p>`).join(''); }
function shortHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return '来源'; } }
// 一键多端导航（按场馆名检索，无需经纬度）
function mapNavLinks(venue) {
  if (!venue) return '';
  const q = encodeURIComponent(venue + ' 上海');
  const links = [
    ['高德', 'https://uri.amap.com/search?keyword=' + q],
    ['百度', 'https://map.baidu.com/search/' + q],
    ['Apple', 'https://maps.apple.com/?q=' + q],
    ['Google', 'https://www.google.com/maps/search/?api=1&query=' + q],
  ];
  return `<div class="panel"><div class="panel-label">导航到 · ${esc(venue)}</div>
    <div class="mapnav">${links.map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener" data-ext="1">${esc(n)}地图 ↗</a>`).join('')}</div></div>`;
}
function channelLabel(ch) { return ({ 'waic-official-api': '官方来源', 'wechat': '微信公众号', 'web': '网络来源' })[ch] || '来源'; }
function relationLabel(r) { return ({ official: '官方', affiliated: '联名 / 合作', 'co-located': '同城同期' })[r] || ''; }
function kindClass(a) { return a.kind === 'side_event' || a.kind === 'community' ? 'k-side' : (a.kind === 'exhibition_zone' ? 'k-zone' : 'k-official'); }
function kindFlag(a) {
  if (a.kind === 'official_program') return a.venue_based ? '场馆活动' : '官方论坛';
  if (a.kind === 'exhibition_zone') return '官方展区';
  if (a.kind === 'side_event' || a.kind === 'community') return '边会 · 周边';
  return '活动';
}
function sourceUrl(a) {
  const s = a.source || {};
  if (a.source_type === 'official') return a.official_url || s.url || '';
  return s.url || s.sogou_url || '';
}

/* ---- 我的日程（localStorage，与首页共享同一 key） ---- */
const MYSCHED_KEY = 'waic2026.myschedule.v1';
function readMine() { try { return JSON.parse(localStorage.getItem(MYSCHED_KEY) || '[]').map(String); } catch (e) { return []; } }
function isMine(id) { return readMine().includes(String(id)); }
function toggleMine(id) { id = String(id); const s = readMine(); const i = s.indexOf(id); if (i >= 0) s.splice(i, 1); else s.push(id); localStorage.setItem(MYSCHED_KEY, JSON.stringify(s)); if (window.WAICSync) window.WAICSync.touch(); return i < 0; }
const ICON_EXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:14px;height:14px"><path d="M7 17 17 7M9 7h8v8"/></svg>';
const DAY_LABEL = { 1: '7/17 周五', 2: '7/18 周六', 3: '7/19 周日', 4: '7/20 周一' };
const ZONE_DESC = {
  '世博中心': '论坛策源 · 主题论坛与主论坛主场',
  '世博展览馆': '应用展览 · 核心展区 H1–H4',
  '徐汇西岸国际会展中心': '体验 · 西岸体验与互动展示',
  '西岸国际会展中心': '体验 · 西岸体验与互动展示',
  '张江科学会堂': '算力 · 张江算力与硬核科技',
};

async function loadActivity() {
  const root = document.getElementById('detail-root');
  const id = new URLSearchParams(location.search).get('id');
  if (!id) { root.innerHTML = shell('<p class="loading">缺少活动 ID。<a href="index.html">返回首页</a></p>'); return; }
  try {
    let a = null;
    // 详情走 API 取全量（议程/嘉宾等在服务端）；API 不可用则降级到静态索引层（部分信息）
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4500);
      const r = await fetch('/api/activity/' + encodeURIComponent(id), { signal: ctrl.signal });
      clearTimeout(to);
      if (r.ok) { const j = await r.json(); if (j && !j.error) a = j; }
    } catch (e) { /* API 不可用 → 降级 */ }
    if (!a) {
      const data = await (await fetch('data/activities.json')).json();
      a = (data.activities || []).find(x => String(x.id) === String(id));
      if (a) a._lite = true;   // 仅索引层：完整议程/嘉宾可能不全
    }
    if (!a) { root.innerHTML = shell(`<p class="loading">未找到活动 <code>${esc(id)}</code>。<a href="index.html">返回首页</a></p>`); return; }
    document.title = `${a.title} · WAIC 2026 参展助手`;
    root.innerHTML = renderDetail(a);
    // 浏览详情也算兴趣信号（轻权重 0.5，随同步上行）
    try {
      const pk = 'waic2026.profile.v1';
      const p = JSON.parse(localStorage.getItem(pk) || '{}');
      if (!p.inferred || typeof p.inferred !== 'object') p.inferred = {};
      const terms = [...new Set([...(a.tags || []).flatMap(t => String(t).split(',').map(s => s.trim())), a.track].filter(Boolean))];
      terms.forEach(t => { if (t && t.length <= 20) p.inferred[t] = Math.round(((p.inferred[t] || 0) + 0.5) * 1000) / 1000; });
      localStorage.setItem(pk, JSON.stringify(p));
      if (window.WAICSync) window.WAICSync.touch();
    } catch (e) { /* 忽略 */ }
    const mb = document.getElementById('detail-mine');
    if (mb) mb.addEventListener('click', () => {
      const on = toggleMine(mb.dataset.id);
      mb.textContent = on ? '✓ 已在我的日程' : '＋ 加入我的日程';
      mb.classList.toggle('primary', !on);
    });
  } catch (e) {
    root.innerHTML = shell(`<p class="loading">加载失败：${esc(e.message)}</p>`);
  }
}
function shell(inner) { return `<section class="detail-body"><div class="container"><a class="detail-back" href="index.html">← 返回首页</a>${inner}</div></section>`; }

function renderDetail(a) {
  const src = a.source || {};
  const url = sourceUrl(a);
  const kc = kindClass(a);
  const isSide = a.kind === 'side_event' || a.kind === 'community';
  const isZone = a.kind === 'exhibition_zone';

  const metaBits = [];
  if (a.day) metaBits.push(mkMeta('日期', `Day ${a.day} · ${a.date || ''} ${DAY_LABEL[a.day] || ''}`));
  else if (a.date) metaBits.push(mkMeta('日期', a.date));
  else if (src.published_date) metaBits.push(mkMeta('发布', src.published_date, true));
  if (a.start_time) metaBits.push(mkMeta('时间', `${a.start_time}${a.end_time ? ' – ' + a.end_time : ''}`));
  if (a.venue) metaBits.push(mkMeta('地点', `${a.venue}${a.room ? ' · ' + a.room : ''}`, true));
  if (a.district) metaBits.push(mkMeta('片区', a.district, true));
  if (a.track) metaBits.push(mkMeta('板块', a.track, true));

  const hero = `<section class="detail-hero"><div class="container">
    <a class="detail-back" href="index.html">← 返回首页</a>
    <div class="detail-eyebrow">
      <span class="k-flag ${kc}">${kindFlag(a)}</span>
      ${a.waic_relation && a.waic_relation !== 'official' ? `<span class="k-flag k-side" style="background:var(--side)">${relationLabel(a.waic_relation)}</span>` : ''}
      ${a.category ? `<span class="cat">${esc(a.category)}</span>` : ''}
    </div>
    <h1>${esc(a.title)}</h1>
    ${a.title_en ? `<div class="title-en">${esc(a.title_en)}</div>` : ''}
    ${metaBits.length ? `<div class="detail-meta">${metaBits.join('')}</div>` : ''}
    ${a.kind !== 'exhibition_zone' ? `<div class="detail-actions">
      <button class="mine-act${isMine(a.id) ? '' : ' primary'}" id="detail-mine" data-id="${esc(a.id)}" type="button">${isMine(a.id) ? '✓ 已在我的日程' : '＋ 加入我的日程'}</button>
      <a class="mine-act ghost" href="index.html">← 全部日程</a>
    </div>` : ''}
  </div></section>`;

  let body = '';
  if (a.cover_img) body += `<img class="cover" src="${esc(a.cover_img)}" alt="" loading="lazy" onerror="this.style.display='none'">`;

  if (isZone) {
    const halls = a.halls || [], hi = a.highlights || [], maps = a.map_images || [];
    body += `<div class="panel"><div class="panel-label">展区定位 · 官方介绍</div><div class="prose-block">${nl2p(a.description || (a.district + ' 展区'))}</div></div>`;
    if (a.address || a.transit || a.district) {
      body += `<div class="panel"><div class="panel-label">位置 · 交通</div><div class="zinfo">
        ${a.district ? `<div class="zinfo-row"><span class="zk">片区</span><span class="zv">${esc(a.district)}</span></div>` : ''}
        ${a.address ? `<div class="zinfo-row"><span class="zk">地址</span><span class="zv">${esc(a.address)} · <a class="zmap" href="https://uri.amap.com/search?keyword=${encodeURIComponent(a.venue || a.title)}" target="_blank" rel="noopener">高德地图 ↗</a></span></div>` : `<div class="zinfo-row"><span class="zk">地图</span><span class="zv"><a class="zmap" href="https://uri.amap.com/search?keyword=${encodeURIComponent(a.venue || a.title)}" target="_blank" rel="noopener">在高德地图查看「${esc(a.venue || a.title)}」↗</a></span></div>`}
        ${a.transit ? `<div class="zinfo-row"><span class="zk">交通</span><span class="zv">${esc(a.transit)}</span></div>` : ''}
      </div></div>`;
    }
    if (hi.length) {
      body += `<div class="panel"><div class="panel-label">展区亮点 · 看点</div><ul class="zhi">${hi.map(h => `<li>${esc(h)}</li>`).join('')}</ul>${(a.highlights_sources && a.highlights_sources.length) ? `<div class="zsrc">来源：${a.highlights_sources.map(s => `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(shortHost(s))}</a>`).join(' · ')}</div>` : ''}</div>`;
    }
    if (halls.length) {
      body += `<div class="panel"><div class="panel-label">分馆导览</div><div class="zhalls">${halls.map(h => `<div class="zhall"><span class="zhall-n">${esc(h.hall)}</span><span class="zhall-t">${esc(h.theme || '')}</span></div>`).join('')}</div></div>`;
    }
    if (maps.length) {
      body += `<div class="panel"><div class="panel-label">展区 / 导览图</div>${maps.map(m => `<img class="zmapimg" src="${esc(m)}" alt="展区导览图" loading="lazy" onerror="this.style.display='none'">`).join('')}</div>`;
    }
    body += `<div class="panel"><div class="panel-label">谁在这个展区</div><div class="prose-block">到首页「参展商」板块按展馆「<strong>${esc(a.venue)}</strong>」筛选，即可查看该场馆的参展企业。</div></div>`;
  }

  // registration panel (side events, prominent, near top)
  if (isSide && (a.registration_required !== null || a.price || a.registration_url)) {
    const cells = [];
    if (a.registration_required === true) cells.push(regCell('是否需注册', '需注册报名', true));
    else if (a.registration_required === false) cells.push(regCell('是否需注册', '无需注册'));
    if (a.price) cells.push(regCell('票价 / 门槛', a.price, /免费/.test(a.price)));
    if (a.venue) cells.push(regCell('地点', a.venue));
    body += `<div class="panel reg-panel"><div class="panel-label">报名信息 · Registration</div>
      <div class="reg-grid">${cells.join('')}</div>
      ${a.registration_url ? `<div class="reg-cta"><a href="${esc(a.registration_url)}" target="_blank" rel="noopener">前往报名 ${ICON_EXT}</a></div>` : ''}
    </div>`;
  }

  body += renderSourcePanel(a, src, url, kc);

  if ((a.additional_sources || []).length) {
    body += `<div class="panel"><div class="panel-label">相关报道 / 其他来源</div><ul class="addsrc">${a.additional_sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || shortHost(s.url))} ${ICON_EXT}</a></li>`).join('')}</ul></div>`;
  }

  if (a.venue && !isZone) body += mapNavLinks(a.venue);

  const descLabel = a.source_type === 'official' ? '简介' : '内容摘要';
  if (a.description && !isZone) body += `<div class="panel"><div class="panel-label">${descLabel}</div><div class="prose-block">${nl2p(a.description)}</div>${a.description_en ? `<div class="prose-block" style="margin-top:1rem;color:var(--ink-mute);font-size:0.9rem">${nl2p(a.description_en)}</div>` : ''}</div>`;
  else if (a.original_excerpt) body += `<div class="panel"><div class="panel-label">${descLabel}</div><div class="prose-block">${nl2p(a.original_excerpt)}</div></div>`;

  body += renderOrganizers(a.organizers);
  body += renderSchedule(a.schedule);
  body += renderGuests(a.guests);

  body += `<div class="ai-hint">用 AI 助手？装好 <a href="install.html">WAIC 日程 Skill</a> 后，可以直接问：「${esc((a.title || '').slice(0, 20))}… 是几点、在哪、${isSide ? '要不要报名、多少钱' : '有哪些嘉宾'}？」或「帮我把这场加进日历」。</div>`;

  return hero + `<section class="detail-body"><div class="container">${body}</div></section>`;
}

function mkMeta(k, v, plain) { return `<span class="m"><span class="k">${esc(k)}</span><span class="v${plain ? ' plain' : ''}">${esc(v)}</span></span>`; }
function regCell(k, v, hl) { return `<div class="reg-cell"><div class="k">${esc(k)}</div><div class="v${hl ? ' hl' : ''}">${esc(v)}</div></div>`; }

function renderSourcePanel(a, src, url, kc) {
  const add = a.additional_sources || [];
  return `<div class="panel source-panel ${kc}">
    <div class="panel-label">来源 · Source</div>
    <div class="src-row">
      <div>
        <div class="src-pub">${esc(src.publisher || '未知来源')}</div>
        <div class="src-meta">${channelLabel(src.channel)}${src.article_title ? ' · ' + esc(src.article_title) : ''}${src.retrieved_at ? ' · 采集于 ' + esc(src.retrieved_at) : ''}</div>
      </div>
      ${url ? `<a class="src-link" href="${esc(url)}" target="_blank" rel="noopener">查看原文 ${ICON_EXT}</a>` : '<span class="src-meta">（暂无可跳转链接）</span>'}
    </div>
    ${add.length ? `<div class="add-src"><div class="k">其它来源（${add.length}）</div>${add.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.url)} ↗</a>`).join('')}</div>` : ''}
  </div>`;
}

function renderOrganizers(orgs) {
  if (!orgs || !orgs.length) return '';
  const byRole = {};
  orgs.forEach(o => { const r = o.role || '主办'; (byRole[r] = byRole[r] || []).push(o); });
  const order = ['主办', '承办'];
  const roles = order.filter(r => byRole[r]).concat(Object.keys(byRole).filter(r => !order.includes(r)));
  const groups = roles.map(r => `<div class="org-group"><div class="role">${esc(r)}方</div><div class="org-list">${byRole[r].map(o => `<span class="org-item">${esc(o.name)}${o.name_en ? `<span class="en">${esc(o.name_en)}</span>` : ''}</span>`).join('')}</div></div>`).join('');
  return `<div class="panel"><div class="panel-label">主办 · 承办</div>${groups}</div>`;
}

function renderSchedule(sched) {
  if (!sched || !sched.length) return '';
  const rows = sched.map(s => {
    const t = s.start ? `${esc(s.start)}${s.end ? '–' + esc(s.end) : ''}` : '';
    const speakers = (s.speakers || []).filter(Boolean);
    return `<div class="sched-row"><div class="sched-time">${t}</div><div class="sched-body">
      ${s.session && s.session !== '其他' ? `<span class="sess">${esc(s.session)}</span><br>` : ''}
      <span class="theme">${esc(s.theme || s.session || '—')}</span>
      ${speakers.length ? `<div class="speakers"><span class="sp-label">演讲人：</span>${speakers.map(esc).join('、')}</div>` : ''}
    </div></div>`;
  }).join('');
  return `<div class="panel"><div class="panel-label">议程 · Agenda</div><div class="sched">${rows}</div></div>`;
}

function renderGuests(guests) {
  if (!guests || !guests.length) return '';
  const cards = guests.filter(g => g.name).map(g => {
    const role = [g.company, g.position].filter(Boolean).join(' · ');
    return `<div class="guest"><div class="g-name">${esc(g.name)}${g.name_en ? `<span class="en">${esc(g.name_en)}</span>` : ''}</div>${role ? `<div class="g-role">${esc(role)}</div>` : ''}${g.bio ? `<div class="g-bio">${esc(g.bio)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="panel"><div class="panel-label">嘉宾 · Guests <span style="font-weight:400;color:var(--ink-mute);letter-spacing:0">（${guests.length} 位）</span></div><div class="guest-grid">${cards}</div></div>`;
}

loadActivity();
