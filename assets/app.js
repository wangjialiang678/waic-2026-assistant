// WAIC 2026 参展指南 · 主页逻辑（大卡片、日程抽屉、彩蛋、URL 同步）

const DAY_LABELS = {
  '1': '7/17 周四',
  '2': '7/18 周五',
  '3': '7/19 周六',
  '4': '7/20 周日',
};

const FAVORITES_KEY = 'waic_favorites';

let ACTIVITIES = [];
let THEMES = { categories: [], honeycombs: [] };
let AI_NATIVE = { stats: [] };
let VERSION = '';

let STATE = {
  day: '1',
  category: '',
  hall: '',
  q: '',
};

let favoriteIds = new Set();

/* ============================================================
   Data loading
   ============================================================ */

async function loadData() {
  try {
    const [aRes, tRes, nRes, vRes] = await Promise.all([
      fetch('/data/activities.json'),
      fetch('/data/themes.json'),
      fetch('/data/ai-native.json'),
      fetch('/VERSION'),
    ]);

    const a = await aRes.json();
    THEMES = await tRes.json();
    AI_NATIVE = await nRes.json();
    VERSION = (await vRes.text()).trim();

    ACTIVITIES = (a.activities || []).map(prepareActivity);
    ACTIVITIES.sort(byStartTime);

    const versionEl = document.getElementById('data-version');
    if (versionEl) versionEl.textContent = VERSION;

    favoriteIds = new Set(getFavorites());
    ensureToolbarExtras();

    renderAINativeHero();
    renderDayNav();
    renderFilters();
    restoreStateFromURL();
    applyStateToUI();
    render();
    bindEvents();
    bindEasterEggs();
    updateNowIndicator();
    setInterval(updateNowIndicator, 60_000);
  } catch (e) {
    console.error(e);
    const listEl = document.getElementById('list-content');
    if (listEl) {
      listEl.innerHTML = `<p class="loading">加载失败：${escape(e.message)}</p>`;
    }
  }
}

function prepareActivity(a) {
  a._tokens = [
    ...new Set([
      ...tokenize(a.title),
      ...tokenize(a.title_en),
      ...tokenize(a.venue),
      ...tokenize(a.container?.name),
      ...tokenize(a.honeycomb?.name),
      ...tokenize(a.description),
      String(a.container?.name || '').toLowerCase(),
      String(a.honeycomb?.name || '').toLowerCase(),
      String(a.venue || '').toLowerCase(),
    ]),
  ].filter(Boolean);

  a._sortKey =
    String(a.day || 9).padStart(2, '0') + '_' +
    (a.start_time || '').slice(11, 16).replace(':', '');

  a._displayEn = cleanEnglishSubtitle(a.title_en, a.title);
  return a;
}

function cleanEnglishSubtitle(en, zh) {
  if (!en) return '';
  en = String(en).trim();
  if (en.length > 140) en = en.slice(0, 137) + '…';
  return en;
}

/* ============================================================
   Utilities
   ============================================================ */

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[·,.\/\\\-–—:;!?()""''\[\]]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function byStartTime(a, b) {
  const da = String(a.day || 9).padStart(2, '0') + (a.start_time || 'Z');
  const db = String(b.day || 9).padStart(2, '0') + (b.start_time || 'Z');
  return da.localeCompare(db);
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function highlightTerms(text, terms) {
  if (!terms || !terms.length) return text;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const re = new RegExp('(' + sorted.map(escapeRegExp).join('|') + ')', 'gi');
  return text.replace(re, m => `<mark>${m}</mark>`);
}

function ensureToolbarExtras() {
  const toolbar = document.querySelector('.list-toolbar');
  if (!toolbar) return;

  if (!document.getElementById('count')) {
    const count = document.createElement('span');
    count.id = 'count';
    count.className = 'count-label';
    toolbar.appendChild(count);
  }

  if (!document.getElementById('clear-filters')) {
    const btn = document.createElement('button');
    btn.id = 'clear-filters';
    btn.type = 'button';
    btn.className = 'btn';
    btn.style.display = 'none';
    btn.textContent = '清除筛选';
    btn.addEventListener('click', clearAllFilters);
    toolbar.appendChild(btn);
  }
}

/* ============================================================
   Rendering: hero, nav, filters
   ============================================================ */

function renderAINativeHero() {
  const stats = Array.isArray(AI_NATIVE.stats) ? AI_NATIVE.stats : [];
  const el = document.querySelector('.sb-hero-stats');
  if (!el) return;

  el.innerHTML = stats
    .slice(0, 6)
    .map(s => `
      <div class="stat">
        <div class="n">${escape(s.value)}</div>
        <div class="l">${escape(s.label)}</div>
      </div>
    `)
    .join('');
}

function renderDayNav() {
  const mobile = document.querySelector('.day-tabs-mobile');
  const desktop = document.querySelector('.day-nav');

  const buttons = Object.entries(DAY_LABELS)
    .map(([day, label]) => `
      <button type="button" class="day-tab ${STATE.day === day ? 'active' : ''}" data-day="${escape(day)}">
        Day ${day} · ${escape(label.split(' ')[0])}
      </button>
    `)
    .join('');

  const items = Object.entries(DAY_LABELS)
    .map(([day, label]) => `
      <button type="button" class="day-nav-item ${STATE.day === day ? 'active' : ''}" data-day="${escape(day)}">
        Day ${day} · ${escape(label)}
      </button>
    `)
    .join('');

  if (mobile) mobile.innerHTML = buttons;
  if (desktop) desktop.innerHTML = items;
}

function renderFilters() {
  const containerSel = document.getElementById('filter-container');
  if (containerSel) {
    containerSel.innerHTML = '<option value="">全部分类</option>';
    (THEMES.categories || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} (${c.activity_count})`;
      containerSel.appendChild(o);
    });
  }

  const hallSel = document.getElementById('filter-hall');
  if (hallSel) {
    hallSel.innerHTML = '<option value="">全部场馆</option>';
    (THEMES.honeycombs || []).forEach(h => {
      const o = document.createElement('option');
      o.value = h.id;
      o.textContent = `${h.name} (${h.activity_count})`;
      hallSel.appendChild(o);
    });
  }
}

function applyStateToUI() {
  const qEl = document.getElementById('q');
  if (qEl) qEl.value = STATE.q;

  const catEl = document.getElementById('filter-container');
  if (catEl) catEl.value = STATE.category;

  const hallEl = document.getElementById('filter-hall');
  if (hallEl) hallEl.value = STATE.hall;

  document.querySelectorAll('.day-tab, .day-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.day === STATE.day);
  });
}

/* ============================================================
   Search
   ============================================================ */

function parseQuery(q) {
  if (!q) return [];
  return String(q)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchScore(a, terms) {
  if (!terms.length) return 1;

  const title = String(a.title || '').toLowerCase();
  const en = String(a.title_en || '').toLowerCase();
  const cat = String(a.container?.name || '').toLowerCase();
  const hall = String(a.honeycomb?.name || '').toLowerCase();
  const venue = String(a.venue || '').toLowerCase();
  const anywhere = String(a.search_text || `${title} ${en} ${cat} ${hall} ${venue}`).toLowerCase();

  let score = 0;
  let allMatch = true;

  for (const t of terms) {
    const inTitle = title.includes(t);
    const inEn = en.includes(t);
    const inCat = cat.includes(t);
    const inHall = hall.includes(t);
    const inVenue = venue.includes(t);
    const inAnywhere = anywhere.includes(t);

    if (!inAnywhere) {
      allMatch = false;
      break;
    }

    if (inTitle) score += 100;
    else if (inEn) score += 70;
    else if (inCat) score += 40;
    else if (inHall) score += 35;
    else if (inVenue) score += 30;
    else score += 10;
  }

  return allMatch ? score : 0;
}

/* ============================================================
   Main render
   ============================================================ */

function render() {
  const terms = parseQuery(STATE.q);

  let filtered = ACTIVITIES;

  if (STATE.day) {
    filtered = filtered.filter(a => String(a.day) === STATE.day);
  }
  if (STATE.category) {
    filtered = filtered.filter(a => String(a.container?.id) === STATE.category);
  }
  if (STATE.hall) {
    filtered = filtered.filter(a => String(a.honeycomb?.id) === STATE.hall);
  }

  if (terms.length) {
    filtered = filtered
      .map(a => ({ a, score: matchScore(a, terms) }))
      .filter(x => x.score > 0)
      .sort((x, y) => y.score - x.score || byStartTime(x.a, y.a))
      .map(x => x.a);
  } else {
    filtered = [...filtered].sort(byStartTime);
  }

  const hasFilters = STATE.q || STATE.day || STATE.category || STATE.hall;
  const countEl = document.getElementById('count');
  if (countEl) countEl.textContent = `显示 ${filtered.length} / ${ACTIVITIES.length} 场`;

  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) clearBtn.style.display = hasFilters ? 'inline-flex' : 'none';

  const listEl = document.getElementById('list-content');
  if (!listEl) return;

  let html = '';

  if (hasEasterSearchTrigger(STATE.q)) {
    html += renderSearchRecommendation(terms);
  }

  if (filtered.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-title">没有匹配的论坛</div>
        <p>试试减少关键词，或清除筛选条件。</p>
        <button type="button" class="btn btn-primary" id="empty-clear">清除筛选</button>
      </div>`;
    listEl.innerHTML = html;
    document.getElementById('empty-clear')?.addEventListener('click', clearAllFilters);
    updateFavoriteButtons();
    return;
  }

  html += filtered.map(a => renderBigCard(a, terms)).join('');
  listEl.innerHTML = html;

  updateNowIndicator();
  updateFavoriteButtons();
}

/* ============================================================
   Big card
   ============================================================ */

function renderBigCard(a, terms) {
  const start = a.start_time ? a.start_time.slice(11, 16) : '?';
  const end = a.end_time ? a.end_time.slice(11, 16) : '?';
  const isFav = favoriteIds.has(String(a.id));
  const sb = a.superbrain || {};
  const summary = truncate(a.description, 60);

  const titleHtml = highlightTerms(escape(a.title), terms);
  const summaryHtml = summary ? highlightTerms(escape(summary), terms) : '';

  const categoryBadge = a.container
    ? `<span class="badge badge-category">${highlightTerms(escape(a.container.name), terms)}</span>`
    : '';
  const hallBadge = a.honeycomb
    ? `<span class="badge badge-hall">${highlightTerms(escape(a.honeycomb.name), terms)}</span>`
    : '';
  const sbBadge = sb.badge_label
    ? `<span class="badge badge-super">${escape(sb.badge_label)}</span>`
    : '';

  const heart = isFav
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

  const happening = isHappeningNow(a) ? 'now-happening' : '';

  return `
    <article class="big-card ${sb.recommended ? 'rich' : ''} ${happening}"
             data-id="${escape(a.id)}"
             data-start="${escape(a.start_time)}"
             data-end="${escape(a.end_time)}">
      <button type="button" class="fav-btn ${isFav ? 'active' : ''}"
              data-id="${escape(a.id)}"
              data-action="favorite"
              aria-label="${isFav ? '取消收藏' : '收藏'}"
              title="${isFav ? '取消收藏' : '收藏'}">
        ${heart}
      </button>
      <div class="card-time">
        <div class="clock">${start}</div>
        <div class="day-label">${escape(a.date_label || `Day ${a.day || '?'}`)}</div>
      </div>
      <div class="card-body">
        <div class="badges">${categoryBadge}${hallBadge}${sbBadge}</div>
        <h3 class="card-title" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${titleHtml}</h3>
        ${summaryHtml ? `<p class="card-summary">${summaryHtml}</p>` : ''}
        <div class="card-meta">
          <span class="meta-venue">${escape(a.venue || '场地待定')}</span>
          <span class="meta-time">${start} - ${end}</span>
        </div>
        <button type="button" class="schedule-btn ${isFav ? 'active' : ''}"
                data-id="${escape(a.id)}"
                data-action="favorite">
          ${isFav ? '已加入' : '加入我的日程'}
        </button>
      </div>
    </article>
  `;
}

/* ============================================================
   Easter egg: search recommendation
   ============================================================ */

function hasEasterSearchTrigger(q) {
  if (!q) return false;
  const s = String(q).toLowerCase();
  return ['michael', '超脑', 'ai 原住民', 'ai原住民'].some(t => s.includes(t));
}

function renderSearchRecommendation(terms) {
  const michaelTalk = AI_NATIVE.michael_talk || {};
  const recommended = ACTIVITIES.filter(a => a.superbrain?.recommended || a.superbrain?.michael_speaking).slice(0, 3);

  const chips = recommended
    .map(a => `
      <a class="rec-chip" href="./activity.html?id=${encodeURIComponent(a.id)}">
        ${highlightTerms(escape(truncate(a.title, 28)), terms)}
      </a>
    `)
    .join('');

  return `
    <div class="big-card rich search-recommendation">
      <div class="card-body">
        <div class="badges"><span class="badge badge-super">超脑推荐</span></div>
        <h3 class="card-title">你似乎对 Michael 和「AI 原住民计划」感兴趣 🧠</h3>
        <p class="card-summary">
          超脑 AI 孵化器把 AI 放回真实世界的问题现场。
          ${michaelTalk.title ? `Michael 将在「${escape(michaelTalk.title)}」分享：` : ''}
          “让热爱，在真实世界创造未来。”
        </p>
        <div class="card-actions">
          <a href="/ai-native.html" class="btn btn-primary">了解 AI 原住民计划</a>
          ${chips ? `<div class="rec-chips">${chips}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

/* ============================================================
   Favorites / My Schedule
   ============================================================ */

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteIds]));
  } catch (e) {
    console.warn('无法保存收藏', e);
  }
}

function toggleFavorite(id) {
  id = String(id);
  if (favoriteIds.has(id)) {
    favoriteIds.delete(id);
  } else {
    favoriteIds.add(id);
  }
  saveFavorites();
  updateFavoriteButtons();
  renderScheduleDrawer();
}

function updateFavoriteButtons() {
  document.querySelectorAll('.fav-btn[data-id]').forEach(btn => {
    const id = String(btn.dataset.id);
    const active = favoriteIds.has(id);
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-label', active ? '取消收藏' : '收藏');
    btn.title = active ? '取消收藏' : '收藏';
    btn.innerHTML = active
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  });

  document.querySelectorAll('.schedule-btn[data-id]').forEach(btn => {
    const id = String(btn.dataset.id);
    const active = favoriteIds.has(id);
    btn.classList.toggle('active', active);
    btn.textContent = active ? '已加入' : '加入我的日程';
  });
}

function openScheduleDrawer() {
  const drawer = document.getElementById('schedule-drawer');
  if (!drawer) return;
  renderScheduleDrawer();
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  drawer.style.display = 'block';
}

function closeScheduleDrawer() {
  const drawer = document.getElementById('schedule-drawer');
  if (!drawer) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.style.display = 'none';
}

function renderScheduleDrawer() {
  const listEl = document.getElementById('schedule-list');
  if (!listEl) return;

  if (favoriteIds.size === 0) {
    listEl.innerHTML = `
      <div class="schedule-empty">
        <p>还没有加入任何活动。</p>
        <p>在论坛列表里点「加入我的日程」，即可生成个人行程、导出日历或分享长图。</p>
        <a href="#list" class="btn btn-primary schedule-empty-cta">去挑选论坛 →</a>
      </div>
    `;
    const cta = listEl.querySelector('.schedule-empty-cta');
    if (cta) cta.addEventListener('click', closeScheduleDrawer);
    return;
  }

  const favs = ACTIVITIES
    .filter(a => favoriteIds.has(String(a.id)))
    .sort(byStartTime);

  const conflicts = detectConflicts(favs);

  listEl.innerHTML = favs
    .map(a => {
      const start = a.start_time ? a.start_time.slice(11, 16) : '?';
      const end = a.end_time ? a.end_time.slice(11, 16) : '?';
      const conflict = conflicts.has(String(a.id));
      return `
        <div class="schedule-item ${conflict ? 'conflict' : ''}" data-id="${escape(a.id)}">
          <div class="schedule-time ${conflict ? 'conflict-time' : ''}">${escape(a.date_label || `Day ${a.day || '?'}`)} ${start} - ${end}</div>
          <a class="schedule-title" href="./activity.html?id=${encodeURIComponent(a.id)}">${escape(a.title)}</a>
          <div class="schedule-venue">${escape(a.venue || '场地待定')} · ${escape(a.honeycomb?.name || '')}</div>
          ${conflict ? '<div class="conflict-warning">⚠️ 时间冲突</div>' : ''}
          <button type="button" class="btn btn-small schedule-remove" data-id="${escape(a.id)}">移除</button>
        </div>
      `;
    })
    .join('');
}

function detectConflicts(list) {
  const conflicts = new Set();
  const sorted = [...list].sort(byStartTime);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aStart = new Date(a.start_time).getTime();
    const aEnd = new Date(a.end_time).getTime();
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (String(a.day) !== String(b.day)) continue;
      const bStart = new Date(b.start_time).getTime();
      const bEnd = new Date(b.end_time).getTime();
      if (aStart < bEnd && bStart < aEnd) {
        conflicts.add(String(a.id));
        conflicts.add(String(b.id));
      }
    }
  }
  return conflicts;
}

function formatICSDate(iso) {
  if (!iso) return '20260717T000000';
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function escapeICS(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function exportScheduleICS() {
  const favs = ACTIVITIES
    .filter(a => favoriteIds.has(String(a.id)))
    .sort(byStartTime);
  if (favs.length === 0) {
    alert('日程为空，请先加入活动。');
    return;
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WAIC 2026//超脑 AI 孵化器//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  favs.forEach(a => {
    const uid = `waic2026-${String(a.id).replace(/[^a-zA-Z0-9-]/g, '')}@superbrain-ai.com`;
    const dtstart = formatICSDate(a.start_time);
    const dtend = formatICSDate(a.end_time);
    const summary = escapeICS(a.title || 'WAIC 2026 论坛');
    const location = escapeICS([a.honeycomb?.name, a.venue].filter(Boolean).join(' · '));
    const description = escapeICS(a.description || '');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`DTEND:${dtend}`);
    lines.push(`SUMMARY:${summary}`);
    lines.push(`LOCATION:${location}`);
    lines.push(`DESCRIPTION:${description}`);
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'waic2026-my-schedule.ics';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clearSchedule() {
  if (favoriteIds.size === 0) return;
  if (!confirm('确定要清空我的日程吗？')) return;
  favoriteIds.clear();
  saveFavorites();
  updateFavoriteButtons();
  renderScheduleDrawer();
}

function openSharePanel() {
  const favs = ACTIVITIES
    .filter(a => favoriteIds.has(String(a.id)))
    .sort(byStartTime);
  if (favs.length === 0) {
    alert('日程为空，请先加入活动。');
    return;
  }

  const target = document.getElementById('share-render-target');
  const preview = document.getElementById('share-preview');
  const modal = document.getElementById('share-modal');
  if (!target || !preview || !modal) return;

  const itemsHtml = favs.map(a => {
    const start = a.start_time ? a.start_time.slice(11, 16) : '?';
    const end = a.end_time ? a.end_time.slice(11, 16) : '?';
    return `
      <div class="share-card-item">
        <div class="share-card-time">
          <div class="day">${escape(a.date_label || `Day ${a.day || '?'}`)}</div>
          <div>${escape(start)} - ${escape(end)}</div>
        </div>
        <div class="share-card-body">
          <div class="share-card-title">${escape(a.title || '')}</div>
          <div class="share-card-venue">${escape(a.venue || '场地待定')} · ${escape(a.honeycomb?.name || '')}</div>
        </div>
      </div>
    `;
  }).join('');

  target.innerHTML = `
    <div class="share-card">
      <div class="share-card-header">
        <h2>我的 WAIC 2026 日程</h2>
        <p>7.17 - 7.20 · 上海 · 共 ${favs.length} 场活动</p>
      </div>
      ${itemsHtml}
      <div class="share-card-footer">
        <span class="share-card-brand">WAIC 2026 参展指南 · 超脑 AI 孵化器</span>
        <span>waic.sg.superbrain-ai.com</span>
      </div>
    </div>
  `;

  if (typeof html2canvas !== 'function') {
    target.style.visibility = 'hidden';
    if (navigator.clipboard) {
      navigator.clipboard.writeText(location.href).catch(() => {});
    }
    alert('分享图组件暂不可用，已为你保留当前页面链接。');
    return;
  }

  target.style.visibility = 'visible';
  html2canvas(target.firstElementChild, { scale: 2, backgroundColor: null }).then(canvas => {
    target.style.visibility = 'hidden';
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.alt = '我的 WAIC 2026 日程';
    preview.innerHTML = '';
    preview.appendChild(img);

    const downloadBtn = document.getElementById('share-download');
    if (downloadBtn) {
      downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = 'waic2026-my-schedule.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }

    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }).catch(err => {
    target.style.visibility = 'hidden';
    console.error('html2canvas failed', err);
    alert('生成图片失败，请重试。');
  });
}

function closeShareModal() {
  const modal = document.getElementById('share-modal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

/* ============================================================
   Now happening
   ============================================================ */

function isHappeningNow(a) {
  if (!a.start_time || !a.end_time) return false;
  const now = Date.now();
  const start = new Date(a.start_time).getTime();
  const end = new Date(a.end_time).getTime();
  return now >= start && now < end;
}

function updateNowIndicator() {
  document.querySelectorAll('.big-card[data-id]').forEach(el => {
    const id = el.dataset.id;
    const a = ACTIVITIES.find(x => String(x.id) === String(id));
    if (a) el.classList.toggle('now-happening', isHappeningNow(a));
  });
}

/* ============================================================
   URL sync
   ============================================================ */

function syncURL() {
  const params = new URLSearchParams();
  if (STATE.day && STATE.day !== '1') params.set('day', STATE.day);
  if (STATE.category) params.set('category', STATE.category);
  if (STATE.hall) params.set('hall', STATE.hall);
  if (STATE.q) params.set('q', STATE.q);
  const qs = params.toString();
  const hash = qs ? `#${qs}` : '';
  history.replaceState(null, '', `${location.pathname}${hash}`);
}

function restoreStateFromURL() {
  const hash = location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);

  STATE = {
    day: params.get('day') || '1',
    category: params.get('category') || '',
    hall: params.get('hall') || '',
    q: params.get('q') || '',
  };
}

function clearAllFilters() {
  STATE = { day: '1', category: '', hall: '', q: '' };
  applyStateToUI();
  render();
  syncURL();
}

/* ============================================================
   Events
   ============================================================ */

function bindEvents() {
  const qEl = document.getElementById('q');
  if (qEl) {
    let debounce;
    qEl.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        STATE.q = qEl.value.trim();
        render();
        syncURL();
      }, 300);
    });
  }

  const catEl = document.getElementById('filter-container');
  if (catEl) {
    catEl.addEventListener('change', () => {
      STATE.category = catEl.value;
      render();
      syncURL();
    });
  }

  const hallEl = document.getElementById('filter-hall');
  if (hallEl) {
    hallEl.addEventListener('change', () => {
      STATE.hall = hallEl.value;
      render();
      syncURL();
    });
  }

  document.body.addEventListener('click', e => {
    const dayBtn = e.target.closest('.day-tab, .day-nav-item');
    if (dayBtn && dayBtn.dataset.day) {
      STATE.day = dayBtn.dataset.day;
      applyStateToUI();
      render();
      syncURL();
      return;
    }

    const favBtn = e.target.closest('[data-action="favorite"]');
    if (favBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.id);
      return;
    }

    const card = e.target.closest('.big-card[data-id]');
    if (card && !e.target.closest('.fav-btn')) {
      const id = card.dataset.id;
      if (id) location.href = `./activity.html?id=${encodeURIComponent(id)}`;
      return;
    }

    const removeBtn = e.target.closest('.schedule-remove');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(removeBtn.dataset.id);
      return;
    }
  });

  const scheduleBtn = document.getElementById('btn-my-schedule');
  if (scheduleBtn) scheduleBtn.addEventListener('click', openScheduleDrawer);

  const closeBtn = document.getElementById('schedule-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeScheduleDrawer);

  document.getElementById('schedule-export-ics')?.addEventListener('click', exportScheduleICS);
  document.getElementById('schedule-share')?.addEventListener('click', openSharePanel);
  document.getElementById('schedule-clear')?.addEventListener('click', clearSchedule);

  
  document.getElementById('share-modal-close')?.addEventListener('click', closeShareModal);
  document.getElementById('share-modal-backdrop')?.addEventListener('click', closeShareModal);
  document.getElementById('share-copy-link')?.addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => alert('链接已复制')).catch(() => alert('复制失败'));
  });

  window.addEventListener('popstate', () => {
    restoreStateFromURL();
    applyStateToUI();
    render();
  });
}

/* ============================================================
   Easter eggs
   ============================================================ */

function bindEasterEggs() {
  const logo = document.querySelector('.nav-brand');
  if (!logo) return;

  let clicks = 0;
  let resetTimer;

  logo.addEventListener('click', e => {
    clicks += 1;
    clearTimeout(resetTimer);
    if (clicks >= 5) {
      e.preventDefault();
      clicks = 0;
      openEasterEgg();
      return;
    }
    resetTimer = setTimeout(() => { clicks = 0; }, 2000);
  });

  const closeBtn = document.getElementById('easter-egg-close');
  const modal = document.getElementById('easter-egg');

  if (closeBtn) closeBtn.addEventListener('click', closeEasterEgg);
  if (modal) {
    modal.querySelector('.easter-egg-backdrop')?.addEventListener('click', closeEasterEgg);
  }
}

function openEasterEgg() {
  const modal = document.getElementById('easter-egg');
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  modal.style.display = 'flex';
}

function closeEasterEgg() {
  const modal = document.getElementById('easter-egg');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  modal.style.display = 'none';
}

/* ============================================================
   Boot
   ============================================================ */

loadData();
