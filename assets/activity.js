// WAIC 2026 参展指南 · 论坛详情页（summary-first 版）

const FAVORITES_KEY = 'waic_favorites';

let currentActivity = null;
let favoriteIds = new Set();
let currentTranscript = null;
let currentTranscriptEntries = [];

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

function highlightTerms(text, terms) {
  if (!terms || !terms.length || !text) return text;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const re = new RegExp('(' + sorted.map(escapeRegExp).join('|') + ')', 'gi');
  return String(text).replace(re, m => `<mark>${escape(m)}</mark>`);
}

function truncate(text, maxLength) {
  if (!text) return '';
  let t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= maxLength) return t;
  return t.slice(0, maxLength - 1) + '…';
}

function firstSentence(text, maxLength = 80) {
  if (!text) return '暂无简介';
  const t = String(text).replace(/\s+/g, ' ').trim();
  const m = t.match(/^.+?[。！？.!?](?=\s|$)/);
  const sentence = m ? m[0] : t;
  return truncate(sentence, maxLength);
}

function formatTimeRange(start_time, end_time, day, date_label) {
  const start = start_time ? start_time.slice(11, 16) : '?';
  const end = end_time ? end_time.slice(11, 16) : '?';

  let date = date_label;
  if (!date && start_time) {
    const m = start_time.match(/2026-(\d{2})-(\d{2})/);
    if (m) date = `7月${parseInt(m[2], 10)}日`;
  }

  const dayPart = day ? `Day ${day} · ` : '';
  return `${dayPart}${date || '待定'} ${start} – ${end}`;
}

function setSectionContent(id, html) {
  const details = document.getElementById(id);
  if (!details) return;
  const content = details.querySelector('.detail-section-content');
  if (content) content.innerHTML = html;
}

/* ============================================================
   Favorites
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

function updateFavoriteButton() {
  const btn = document.getElementById('btn-favorite');
  if (!btn || !currentActivity) return;
  const id = String(currentActivity.id);
  const active = favoriteIds.has(id);
  btn.classList.toggle('active', active);
  btn.textContent = active ? '已收藏' : '收藏';
  btn.setAttribute('aria-label', active ? '取消收藏' : '收藏');
}

function toggleFavorite() {
  if (!currentActivity) return;
  const id = String(currentActivity.id);
  if (favoriteIds.has(id)) {
    favoriteIds.delete(id);
  } else {
    favoriteIds.add(id);
  }
  saveFavorites();
  updateFavoriteButton();
}

/* ============================================================
   Share
   ============================================================ */

async function shareActivity() {
  if (!currentActivity) return;

  const modal = document.getElementById('share-modal');
  const preview = document.getElementById('share-preview');
  const target = document.getElementById('share-render-target');
  if (!modal || !preview || !target) {
    // fallback to native share
    fallbackNativeShare();
    return;
  }

  const start = currentActivity.start_time ? currentActivity.start_time.slice(11, 16) : '?';
  const end = currentActivity.end_time ? currentActivity.end_time.slice(11, 16) : '?';
  const date = currentActivity.date_label || `Day ${currentActivity.day || '?'}`;
  const venue = [currentActivity.honeycomb?.name, currentActivity.venue].filter(Boolean).join(' · ');
  const badge = currentActivity.superbrain?.badge_label ? `<div class="share-activity-badge">${escape(currentActivity.superbrain.badge_label)}</div>` : '';
  const desc = (currentActivity.description || '').slice(0, 120) + ((currentActivity.description || '').length > 120 ? '…' : '');

  target.innerHTML = `
    <div class="share-activity-card">
      ${badge}
      <div class="share-activity-title">${escape(currentActivity.title || '')}</div>
      <div class="share-activity-meta">
        <div>${escape(date)} · ${escape(start)} - ${escape(end)}</div>
        <div>${escape(venue || '场地待定')}</div>
      </div>
      <div class="share-activity-desc">${escape(desc)}</div>
      <div class="share-card-footer">
        <span class="share-card-brand">WAIC 2026 参展指南 · 超脑 AI 孵化器</span>
        <span>waic.sg.superbrain-ai.com</span>
      </div>
    </div>
  `;

  if (typeof html2canvas !== 'function') {
    target.style.visibility = 'hidden';
    fallbackNativeShare();
    return;
  }

  target.style.visibility = 'visible';
  html2canvas(target.firstElementChild, { scale: 2, backgroundColor: '#ffffff' }).then(canvas => {
    target.style.visibility = 'hidden';
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.alt = currentActivity.title || '分享图';
    preview.innerHTML = '';
    preview.appendChild(img);

    const downloadBtn = document.getElementById('share-download');
    if (downloadBtn) {
      downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `waic2026-${String(currentActivity.id).slice(0, 8)}.png`;
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
    fallbackNativeShare();
  });
}

function fallbackNativeShare() {
  const url = window.location.href;
  const title = currentActivity ? currentActivity.title : document.title;
  const text = currentActivity
    ? `推荐看看 WAIC 2026 论坛：${currentActivity.title}`
    : 'WAIC 2026 参展指南';

  if (navigator.share) {
    navigator.share({ title, text, url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => showToast('链接已复制')).catch(() => showToast('复制失败'));
  }
}

function closeShareModal() {
  const modal = document.getElementById('share-modal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
}

function showToast(message) {
  let toast = document.getElementById('share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'share-toast';
    toast.className = 'share-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

/* ============================================================
   Data loading
   ============================================================ */

async function loadActivity() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const container = document.querySelector('.detail-hero .container');

  if (!id) {
    if (container) {
      container.innerHTML = '<p class="loading">缺少论坛 ID，<a href="./">返回论坛列表</a></p>';
    }
    return;
  }

  try {
    const [aRes, tRes] = await Promise.all([
      fetch('/data/activities.json'),
      fetch('/data/transcripts.json'),
    ]);
    if (!aRes.ok) throw new Error(`HTTP ${aRes.status}`);
    const data = await aRes.json();
    const activities = data.activities || [];
    const act = activities.find(a => String(a.id) === id);

    if (!act) {
      if (container) {
        container.innerHTML = `<p class="loading">未找到论坛 ${escape(id)}，<a href="./">返回论坛列表</a></p>`;
      }
      return;
    }

    let transcripts = { transcripts: {} };
    if (tRes.ok) {
      transcripts = await tRes.json();
    }

    favoriteIds = new Set(getFavorites().map(String));
    renderDetail(act, transcripts.transcripts || {});
  } catch (e) {
    console.error(e);
    if (container) {
      container.innerHTML = `<p class="loading">加载失败：${escape(e.message)}，<a href="./">返回论坛列表</a></p>`;
    }
  }
}

/* ============================================================
   Rendering
   ============================================================ */

function renderDetail(act, transcriptsMap = {}) {
  currentActivity = act;
  currentTranscript = transcriptsMap[String(act.id)] || { entries: [] };
  currentTranscriptEntries = currentTranscript.entries || [];

  document.title = `${act.title} · WAIC 2026 参展指南`;

  const container = document.querySelector('.detail-hero .container');
  if (container) {
    const loading = container.querySelector('.loading');
    if (loading) loading.style.display = 'none';
  }

  const categoryEl = document.getElementById('detail-category');
  if (categoryEl) categoryEl.textContent = act.container?.name || '论坛';

  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = act.title;

  const enEl = document.getElementById('detail-en');
  if (enEl) enEl.textContent = act.title_en || '';

  const summaryEl = document.getElementById('detail-summary');
  if (summaryEl) summaryEl.textContent = firstSentence(act.description, 80);

  const timeEl = document.getElementById('detail-time');
  if (timeEl) {
    timeEl.textContent = formatTimeRange(act.start_time, act.end_time, act.day, act.date_label);
  }

  const locationEl = document.getElementById('detail-location');
  if (locationEl) locationEl.textContent = act.venue || '待定';

  const hallEl = document.getElementById('detail-hall');
  if (hallEl) hallEl.textContent = act.honeycomb?.name || '待定';

  const officialEl = document.getElementById('detail-official');
  if (officialEl) {
    if (act.official_url) {
      officialEl.href = act.official_url;
      officialEl.style.display = 'inline-flex';
    } else {
      officialEl.style.display = 'none';
    }
  }

  updateFavoriteButton();

  renderDescription(act);
  renderAgenda(act);
  renderGuests(act);
  renderMap(act);
  renderTranscript();
  renderSuperbrain(act);

  document.getElementById('btn-favorite')?.addEventListener('click', toggleFavorite);
  document.getElementById('btn-share')?.addEventListener('click', shareActivity);
  document.getElementById('share-modal-close')?.addEventListener('click', closeShareModal);
  document.getElementById('share-modal-backdrop')?.addEventListener('click', closeShareModal);
  document.getElementById('share-copy-link')?.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => showToast('链接已复制')).catch(() => showToast('复制失败'));
  });
  document.getElementById('transcript-search')?.addEventListener('input', onTranscriptSearch);
}

function renderDescription(act) {
  const desc = act.description || act.description_en || '';
  if (!desc) {
    setSectionContent('detail-description', '<p>暂无论坛简介。</p>');
    return;
  }
  let html = '';
  if (act.description) {
    html += `<p>${escape(act.description).replace(/\n/g, '<br>')}</p>`;
  }
  if (act.description_en) {
    html += `<p class="description-en">${escape(act.description_en).replace(/\n/g, '<br>')}</p>`;
  }
  setSectionContent('detail-description', html);
}

function renderAgenda(act) {
  const periods = act.periods || act.agenda;
  if (!Array.isArray(periods) || periods.length === 0) {
    setSectionContent('detail-agenda', '<p>暂无详细议程</p>');
    return;
  }

  const items = periods.map(p => {
    const start = p.start ? p.start.slice(11, 16) : '?';
    const end = p.end ? p.end.slice(11, 16) : '?';
    const title = p.title ? `<span class="agenda-title">${escape(p.title)}</span>` : '';
    return `<li><time>${start} – ${end}</time>${title}</li>`;
  }).join('');

  setSectionContent('detail-agenda', `<ul class="agenda-timeline">${items}</ul>`);
}

function renderGuests(act) {
  const conveners = act.conveners;
  if (!Array.isArray(conveners) || conveners.length === 0) {
    setSectionContent('detail-guests', '<p>暂无嘉宾信息</p>');
    return;
  }

  const cards = conveners.map(c => {
    const name = typeof c === 'string' ? c : (c.name || '嘉宾');
    const title = typeof c === 'object' && c ? (c.title || '') : '';
    return `
      <div class="guest-card">
        <div class="guest-avatar" aria-hidden="true"></div>
        <div class="guest-info">
          <div class="guest-name">${escape(name)}</div>
          ${title ? `<div class="guest-title">${escape(title)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  setSectionContent('detail-guests', `<div class="guest-list">${cards}</div>`);
}

function renderMap(act) {
  const venue = act.venue || '待定';
  const hall = act.honeycomb?.name || '';
  const html = `
    <div class="map-info">
      <div class="map-row"><strong>场馆：</strong>${escape(hall || '待定')}</div>
      <div class="map-row"><strong>地点：</strong>${escape(venue)}</div>
      <p class="map-note">现场请参照 WAIC 官方指引</p>
    </div>
    <div class="map-placeholder">
      <img src="https://placehold.co/600x300?text=Map" alt="场地位置示意图">
    </div>
  `;
  setSectionContent('detail-map', html);
}

function renderTranscript() {
  const metaEl = document.getElementById('transcript-meta');
  const listEl = document.getElementById('transcript-list');
  const countEl = document.getElementById('transcript-count');
  const contribEl = document.getElementById('transcript-contribute');
  const contribLink = document.getElementById('transcript-contribute-link');

  const entries = currentTranscriptEntries;

  if (metaEl) {
    const updated = currentTranscript.updated_at;
    const source = currentTranscript.source;
    const contributors = (currentTranscript.contributors || []).join('、');
    let metaHtml = '';
    if (updated) metaHtml += `<span>更新于 ${escape(updated)}</span>`;
    if (source) metaHtml += `<span>来源：${escape(source)}</span>`;
    if (contributors) metaHtml += `<span>贡献者：${escape(contributors)}</span>`;
    metaEl.innerHTML = metaHtml || '<span>暂无转录元数据</span>';
  }

  if (!entries.length) {
    if (listEl) listEl.innerHTML = '';
    if (countEl) countEl.textContent = '';
    if (contribEl) contribEl.style.display = 'block';
    if (contribLink && currentActivity) {
      const subject = encodeURIComponent(`提交 WAIC 2026 论坛转录：${currentActivity.title}`);
      const body = encodeURIComponent(`论坛 ID：${currentActivity.id}\n论坛标题：${currentActivity.title}\n\n请在此粘贴转录内容、笔记或录音链接：`);
      contribLink.href = `mailto:hi@superbrain-ai.com?subject=${subject}&body=${body}`;
    }
    return;
  }

  if (contribEl) contribEl.style.display = 'none';
  renderTranscriptEntries(entries, '');
  if (countEl) countEl.textContent = `共 ${entries.length} 条`;
}

function renderTranscriptEntries(entries, query) {
  const listEl = document.getElementById('transcript-list');
  const countEl = document.getElementById('transcript-count');
  if (!listEl) return;

  const terms = query.trim().split(/\s+/).filter(t => t.length >= 1);
  const filtered = terms.length
    ? entries.filter(e => terms.some(t => (e.text || '').toLowerCase().includes(t.toLowerCase()) || (e.speaker || '').toLowerCase().includes(t.toLowerCase())))
    : entries;

  if (countEl) countEl.textContent = `共 ${filtered.length} 条${terms.length ? ' / 匹配 ' + terms.map(t => `「${t}」`).join(' ') : ''}`;

  if (!filtered.length) {
    listEl.innerHTML = '<p class="transcript-empty">没有匹配的转录内容。</p>';
    return;
  }

  const html = filtered.map(e => {
    const time = escape(e.time || '');
    const speaker = escape(e.speaker || '');
    const text = highlightTerms(e.text || '', terms);
    return `
      <div class="transcript-entry">
        <div class="transcript-entry-header">
          <time>${time || ''}</time>
          <span class="transcript-speaker">${speaker || '嘉宾'}</span>
        </div>
        <p class="transcript-text">${text}</p>
      </div>
    `;
  }).join('');
  listEl.innerHTML = html;
}

function onTranscriptSearch(e) {
  const query = e.target.value || '';
  renderTranscriptEntries(currentTranscriptEntries, query);
}

function renderSuperbrain(act) {
  const card = document.getElementById('superbrain-card');
  if (!card) return;
  const sb = act.superbrain || {};

  if (!sb.recommended && !sb.michael_speaking && !sb.ai_native_related) {
    card.style.display = 'none';
    return;
  }

  const reasons = [];
  if (sb.michael_speaking) reasons.push('Michael 主讲');
  if (sb.ai_native_related) reasons.push('AI 原住民计划相关');
  if (sb.recommended && reasons.length === 0) reasons.push('超脑推荐');

  card.innerHTML = `
    <div class="superbrain-card-title">${escape(sb.badge_label || '超脑推荐')}</div>
    <p>根据你的兴趣和已收藏论坛，这场活动可能与你的日程高度相关。</p>
    ${reasons.length ? `<p class="superbrain-reasons">${escape(reasons.join(' · '))}</p>` : ''}
  `;
  card.style.display = 'block';
}

/* ============================================================
   Boot
   ============================================================ */


/* ============================================================
   Comments (localStorage demo)
   ============================================================ */

function getCommentsKey() {
  return 'waic_comments_' + (currentActivity ? currentActivity.id : 'global');
}

function getComments() {
  try {
    const raw = localStorage.getItem(getCommentsKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveComments(comments) {
  try {
    localStorage.setItem(getCommentsKey(), JSON.stringify(comments));
  } catch (e) {
    console.warn('无法保存评论', e);
  }
}

function renderComments() {
  const listEl = document.getElementById('comment-list');
  if (!listEl) return;
  const comments = getComments();
  if (comments.length === 0) {
    listEl.innerHTML = '<div class="comment-empty">还没有评论，来说两句吧。</div>';
    return;
  }
  listEl.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-header">
        <span class="comment-author">${escape(c.name || '匿名')}</span>
        <span class="comment-time">${escape(c.time || '')}</span>
      </div>
      <div class="comment-body">${escape(c.text || '')}</div>
    </div>
  `).join('');
}

function submitComment() {
  const nameEl = document.getElementById('comment-name');
  const textEl = document.getElementById('comment-text');
  if (!nameEl || !textEl) return;
  const name = nameEl.value.trim();
  const text = textEl.value.trim();
  if (!text) {
    alert('请输入评论内容');
    return;
  }
  const comments = getComments();
  comments.unshift({
    name: name || '匿名',
    text,
    time: new Date().toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  });
  saveComments(comments);
  textEl.value = '';
  renderComments();
}

function bindComments() {
  const submitBtn = document.getElementById('comment-submit');
  if (submitBtn) submitBtn.addEventListener('click', submitComment);
  renderComments();
}


bindComments();

loadActivity();
