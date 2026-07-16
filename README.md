# WAIC 2026 参展助手

超脑为 **WAIC 世界人工智能大会 2026**（上海 · 2026-07-17 ~ 20）做的**日程聚合数据库 + AI 助手 skill + 网站**。仿照 [2050 大会聚合](../../2050大会/) 的模式：把散落在官网、公众号、各网络渠道的 WAIC 活动扒下来、去重、结构化，配一份给 AI 读的 SKILL.md 和一个查询网站。

## 线上

**https://waic.sg.superbrain-ai.com**（新加坡服务器 + certbot SSL；DNS 走 `*.sg` 泛解析）
四板块：官方日程 / 边会·周边 / 参展商 / 情报站。skill 接入见 `/install.html`。

## 数据构成（活动中心；每条都带来源 `source` + `source_type` + `waic_relation`）

产物分三类文件：

| 文件 | 内容 | 量 |
|---|---|---|
| `data/activities.json` | **活动**：官方论坛174 + 展区4 + 边会/社群/上海周边（去重后） | ~326（官方178/非官方148） |
| `data/exhibitors.json` | **参展商/展台**：展台号、展馆(H1-H4/西岸/张江)、25 行业、简介、logo | 1020（904有logo） |
| `data/intel.json` | **情报库**：公众号+web 资讯素材（活动已从中抽取，保留出处/原文链） | ~208 |

来源渠道：`waic-official-api`（官网）/ `wechat`（公众号，搜狗发现）/ `web`（Exa/Tavily/社群聚合页）。
`waic_relation`：`official` / `affiliated`（联名合作边会）/ `co-located`（同城同期无直接关联）。
`kind`：`official_program` / `exhibition_zone` / `side_event` / `community`。
`track`：WAIC Up / WAIC Young / AI 原住民 / AI GRAVITY。
边会字段面向"想去的人"：`registration_required` / `registration_url` / `price` / `participants`。

### 关于公众号全文下载（重要）
搜狗 `/link` 跳转链解析被**持续性 antispider 封锁**（跨 IP、含服务器侧），拿不到真实 mp.weixin URL。
**正解**：从非搜狗渠道（社群聚合页/媒体转载/报名页）拿到真实 `mp.weixin.qq.com/s/...` 链接，
再用 `wechat-article-to-markdown "<real_url>" -o <dir>` 下载（下载器与搜狗独立风控，可正常下）。
已用此法下载 3 篇；其余 200+ 篇因近期文章未被搜索引擎收录、拿不到真实链，暂以资讯素材（intel）保留出处。
`wechat-article-extractor` skill 的 `--resolve/--download` 已停用（见该 skill SKILL.md）。

## 目录

```
参展助手/
├── raw/                     # 各来源原始数据
│   ├── official/            # 官网 API 抓取（forums_raw.json 174条 + 嘉宾/展区/端点文档）
│   ├── wechat/              # 搜狗候选 candidates.json(322) + 归一化 articles.json(214)
│   └── web/                 # 其他渠道 other_candidates.json + 归一化 articles.json
├── scripts/
│   ├── build.py             # ⭐ 合并三源 → build-output（activities.json/themes/md/bundle）
│   ├── normalize_web.py     # web 候选 → raw/web/articles.json
│   ├── normalize_wechat.py  # 公众号候选 → raw/wechat/articles.json（并入下载全文）
│   ├── download_wechat.py   # 公众号全文补下载（走 wechat-extractor skill，需 antispider 冷却）
│   ├── package-skill.sh     # 打包 agent-skill → build-output/skill
│   └── deploy.sh            # 构建 + 打包 + rsync 上传
├── agent-skill/             # 给 AI 的 SKILL.md + config/endpoints.json
├── build-output/            # 构建产物（数据 + 网站 + skill + bundle.tar.gz）
└── docs/
```

## 构建 / 更新

```bash
python3 scripts/normalize_web.py       # 其他渠道入库
python3 scripts/normalize_wechat.py    # 公众号入库（若已下载全文自动并入）
python3 scripts/build.py               # 合并生成 build-output/
```

## 公众号全文下载（补全阶段）

搜狗 `/link` 解析对 antispider 敏感，一次只能下有限篇、撞限流即停。等冷却（≥30 分钟）后：

```bash
python3 scripts/download_wechat.py --max 30   # 串行下载，产物 raw/wechat/downloaded.json
python3 scripts/normalize_wechat.py && python3 scripts/build.py   # 并入库
```

## 部署

```bash
SERVER=user@host REMOTE_PATH=/var/www/waic/ bash scripts/deploy.sh
```
目标域名（计划）：https://waic.sg.superbrain-ai.com

## 数据源接口备忘

见 `raw/official/endpoints.md`（官网 98 个 API 端点，论坛列表 `POST queryOfficialFrontForumList` 空 body 返回全部 174 条）。
