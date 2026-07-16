// WAIC 2026 参展指南 · 悬浮 AI 助手入口（前端 mock）
(function () {
  const fab = document.getElementById('ai-assistant-fab');
  const modal = document.getElementById('ai-assistant-modal');
  const closeBtn = document.getElementById('ai-assistant-close');
  const answerEl = document.getElementById('ai-assistant-answer');
  const input = document.getElementById('ai-assistant-input');
  const form = document.getElementById('ai-assistant-form');

  const PRESETS = {
    '如何分享长图？': '在我的日程、论坛详情页或项目墙点击生成分享长图即可下载 PNG；如果图片组件加载失败，会自动降级为复制链接。',
    '参展商在哪里？': '参展入口页面已经接入 WAIC 官方 exhibitors 数据源，目前展示官方展区与场馆入口，后续可继续接公司级参展商名录。',
    'AI 原住民项目墙有什么？': '项目墙收录 51 个 AI 原住民入选项目，支持按城市、机构、项目状态筛选，也可以打开 Demo、生成分享长图和现场留言。',
    'Michael 什么时候演讲？': 'Michael 将在 7 月 19 日的 WAIC AI 教育论坛演讲，主题为《在 AI 中，看见具体的人》。你可以在 AI 原住民计划页面查看详情。',
    'AI 原住民计划在哪？': 'AI 原住民计划位于上海西岸国际会展中心 4 楼，7.17-7.20 持续展出。',
    '如何查看我的日程？': '在论坛列表页点击「我的日程」按钮即可打开日程抽屉；你也可以点击任意论坛卡片的「加入我的日程」来添加活动。',
  };

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function openModal() {
    if (!modal) return;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    if (input) input.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    modal.style.display = 'none';
  }

  function showAnswer(text) {
    if (!answerEl) return;
    answerEl.innerHTML = '<p>' + esc(text) + '</p>';
  }

  function ask(question) {
    question = String(question || '').trim();
    if (!question) return;
    if (PRESETS[question]) {
      showAnswer(PRESETS[question]);
    } else {
      showAnswer('请通过接入 AI 助手获取更智能的问答。');
    }
  }

  if (fab) fab.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.querySelector('.ai-assistant-backdrop')?.addEventListener('click', closeModal);
  }

  document.querySelectorAll('.ai-assistant-question').forEach(btn => {
    btn.addEventListener('click', () => ask(btn.dataset.question));
  });

  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (input) {
        ask(input.value);
        input.value = '';
      }
    });
  }
})();
