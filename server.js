const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
loadDotEnv(path.join(ROOT, '.env'));

const DEFAULT_PORT = path.basename(ROOT).includes('official') ? 8212 : 8211;
const PORT = Number(process.env.PORT || DEFAULT_PORT);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.gz': 'application/gzip',
};

const DATA = {
  activities: readJson('data/activities.json').activities || [],
  projects: readJson('data/project-wall.json').projects || [],
  exhibitors: readJson('data/exhibitors.json').exhibitors || [],
  sideEvents: readJson('data/side-events.json').items || [],
  aiNative: readJson('data/ai-native.json'),
  themes: readJson('data/themes.json'),
};

const PRESETS = {
  '如何分享长图？': '在我的日程、论坛详情页或项目墙点击生成分享长图即可下载 PNG；如果图片组件加载失败，会自动降级为复制链接。',
  '参展商在哪里？': '参展入口页面已经接入 WAIC 官方 exhibitors 数据源，目前展示官方展区与场馆入口，后续可继续接公司级参展商名录。',
  'AI 原住民项目墙有什么？': '项目墙收录 51 个 AI 原住民入选项目，支持按城市、机构、项目状态筛选，也可以打开 Demo、生成分享长图和现场留言。',
  'Michael 什么时候演讲？': 'Michael 将在 7 月 19 日的 WAIC AI 教育论坛演讲，主题为《在 AI 中，看见具体的人》。你可以在 AI 原住民计划页面查看详情。',
  'AI 原住民计划在哪？': 'AI 原住民计划位于上海西岸国际会展中心 4 楼，7.17-7.20 持续展出。',
  '如何查看我的日程？': '在论坛列表页点击「我的日程」按钮即可打开日程抽屉；你也可以点击任意论坛卡片的「加入我的日程」来添加活动。',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      sendJson(res, 204, {});
      return;
    }

    if (url.pathname === '/api/assistant/health') {
      sendJson(res, 200, {
        ok: true,
        configured: isAssistantConfigured(),
        model: getModelName(),
      });
      return;
    }

    if (url.pathname === '/api/assistant') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      await handleAssistant(req, res);
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error.message);
    sendJson(res, 500, { error: 'server_error' });
  }
});

server.listen(PORT, () => {
  console.log(`WAIC guide server running at http://127.0.0.1:${PORT}/`);
  console.log(`AI assistant configured: ${isAssistantConfigured() ? 'yes' : 'no'}`);
});

async function handleAssistant(req, res) {
  const body = await readBody(req);
  const question = String(body.question || '').trim().slice(0, 1000);

  if (!question) {
    sendJson(res, 400, { error: 'missing_question' });
    return;
  }

  if (!isAssistantConfigured()) {
    sendJson(res, 503, {
      error: 'assistant_not_configured',
      answer: PRESETS[question] || 'AI 助手后端还没有配置模型密钥。',
    });
    return;
  }

  const context = buildContext(question, {
    page: body.page,
    title: body.title,
  });

  try {
    const answer = await callModel(question, context);
    sendJson(res, 200, {
      answer,
      model: getModelName(),
      sources: context.sources,
    });
  } catch (error) {
    console.error(`assistant error: ${error.message}`);
    sendJson(res, 502, {
      error: 'assistant_model_error',
      answer: PRESETS[question] || 'AI 助手暂时没有返回结果，请稍后再试。',
    });
  }
}

async function callModel(question, context) {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const endpoint = buildMessagesEndpoint(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const controller = new AbortController();
  const timeoutMs = Number(process.env.API_TIMEOUT_MS || 45000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const system = [
    '你是 WAIC 2026 参展指南的现场 AI 助手。',
    '只能根据提供的资料回答；资料没有覆盖时要明确说“当前资料暂未收录”。',
    '优先给出具体日期、时间、地点、页面入口和可执行建议。',
    '回答使用简洁中文，最多 6 条，不要编造嘉宾、展商或活动。',
  ].join('\n');

  const user = [
    `用户问题：${question}`,
    `当前页面：${context.page || '未知'} ${context.title || ''}`,
    '可用资料：',
    JSON.stringify(context.data, null, 2),
  ].join('\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': token,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: getModelName(),
        max_tokens: 900,
        temperature: 0.2,
        system,
        messages: [
          {
            role: 'user',
            content: user,
          },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`model status ${response.status}: ${text.slice(0, 240)}`);
    }

    const payload = JSON.parse(text);
    return extractAssistantText(payload);
  } finally {
    clearTimeout(timer);
  }
}

function buildContext(question, meta) {
  const activities = pickMatches(DATA.activities, question, compactActivity, 8);
  const projects = pickMatches(DATA.projects, question, compactProject, 8);
  const exhibitors = pickMatches(DATA.exhibitors, question, compactExhibitor, 6);
  const sideEvents = pickMatches(DATA.sideEvents, question, compactSideEvent, 4);

  return {
    page: meta.page,
    title: meta.title,
    sources: ['activities.json', 'project-wall.json', 'exhibitors.json', 'side-events.json', 'ai-native.json'],
    data: {
      overview: {
        activities_total: DATA.activities.length,
        projects_total: DATA.projects.length,
        exhibitors_total: DATA.exhibitors.length,
        ai_native_title: DATA.aiNative.title,
        ai_native_tagline: DATA.aiNative.tagline,
        ai_native_question: DATA.aiNative.question,
        ai_native_location: '上海西岸国际会展中心 4 楼，7.17-7.20 持续展出',
      },
      matched_activities: activities,
      matched_projects: projects,
      matched_exhibitors: exhibitors,
      matched_side_events: sideEvents,
      fixed_facts: {
        michael_talk: 'Michael 将在 2026-07-19 的 WAIC AI 教育论坛演讲，主题为《在 AI 中，看见具体的人》。',
        project_wall: 'AI 原住民项目墙收录 51 个入选项目，支持搜索、筛选、Demo 入口、分享长图与留言。',
        schedule: '用户可在论坛列表页打开“我的日程”，也可从论坛卡片加入日程，并导出 .ics 或生成分享图。',
      },
    },
  };
}

function pickMatches(records, question, compact, limit) {
  const terms = getTerms(question);
  return records
    .map(item => ({ item, score: scoreRecord(item, terms) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(row => compact(row.item));
}

function getTerms(question) {
  const q = normalize(question);
  const splitTerms = q
    .split(/[\s,，。！？?、；;:：()（）《》"'“”【】\[\]/\\|-]+/)
    .filter(term => term.length >= 2);
  const knownTerms = [
    'michael',
    '王佳梁',
    'ai 原住民',
    'ai原住民',
    '项目墙',
    '项目',
    '日程',
    '论坛',
    '演讲',
    '参展',
    '展商',
    '展区',
    '长图',
    '分享',
    '世博中心',
    '世博展览馆',
    '西岸',
    '张江',
    '大模型',
    '算力',
    'agent',
  ].filter(term => q.includes(normalize(term)));

  return [...new Set([...splitTerms, ...knownTerms])];
}

function scoreRecord(record, terms) {
  const haystack = normalize(JSON.stringify(record));
  return terms.reduce((score, term) => {
    if (!term) return score;
    const normalizedTerm = normalize(term);
    if (!normalizedTerm) return score;
    return score + (haystack.includes(normalizedTerm) ? Math.min(normalizedTerm.length, 12) : 0);
  }, 0);
}

function compactActivity(activity) {
  return {
    id: activity.id,
    title: activity.title,
    title_en: activity.title_en,
    time: [activity.start_time, activity.end_time].filter(Boolean).join(' - '),
    day: activity.day,
    venue: activity.venue,
    category: activity.container && activity.container.name,
    hall: activity.honeycomb && activity.honeycomb.name,
    summary: truncate(activity.description || activity.search_text, 240),
  };
}

function compactProject(project) {
  return {
    name: project['项目名称'],
    student: project['学生姓名'],
    grade: project['年级'],
    city: project['城市'],
    institution: project['推荐机构'],
    summary: project['一句话介绍'],
    user_status: project['真实用户状态'],
    demo: project['Demo 可访问链接'],
  };
}

function compactExhibitor(exhibitor) {
  return {
    name: exhibitor.name,
    booth: exhibitor.booth,
    hall: exhibitor.hall,
    industry: exhibitor.industry,
    profile: truncate(exhibitor.profile, 220),
    url: exhibitor.url,
  };
}

function compactSideEvent(item) {
  return {
    title: item.title,
    source: item.source,
    url: item.url,
    summary: truncate(item.summary, 220),
  };
}

function extractAssistantText(payload) {
  if (typeof payload.completion === 'string') return payload.completion.trim();
  if (typeof payload.content === 'string') return payload.content.trim();
  if (Array.isArray(payload.content)) {
    return payload.content
      .map(part => {
        if (typeof part === 'string') return part;
        return part.text || '';
      })
      .join('\n')
      .trim();
  }
  return 'AI 助手没有返回可读文本。';
}

function buildMessagesEndpoint(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function getModelName() {
  return process.env.ANTHROPIC_MODEL ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
    'kimi-for-coding';
}

function isAssistantConfigured() {
  return Boolean((process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) && process.env.ANTHROPIC_BASE_URL);
}

function serveStatic(requestPath, res) {
  const pathname = decodeURIComponent(requestPath.split('?')[0]);
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(ROOT, `.${normalized}`);

  if (!filePath.toLowerCase().startsWith(ROOT.toLowerCase())) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
  } catch (error) {
    console.warn(`Could not read ${relativePath}: ${error.message}`);
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  if (status === 204) {
    res.end();
  } else {
    res.end(JSON.stringify(payload));
  }
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}
