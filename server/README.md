# WAIC 日程助手 v2 · 后端服务（Phase 2）

FastAPI + uvicorn（async, 适合 SSE）。启动时把 `../build-output/data/*.json`
（activities / exhibitors / intel / venues）读进内存并建索引，**不用数据库**，内存查询即可。
AI 对话走腾讯云 TokenHub 的 `qwen3.5-flash`（OpenAI 兼容 + function-calling + 流式）。

## 文件

| 文件 | 作用 |
|---|---|
| `app.py` | FastAPI 应用 + 6 个路由 + CORS + 限流 |
| `llm.py` | Qwen 客户端：tool-loop + 流式 + `enable_thinking:false` |
| `tools.py` | 8 个 function-calling 工具实现 + card 构建 + tools schema |
| `data.py` | 启动载入 JSON + 索引 + 场馆动线（route）计算 |
| `requirements.txt` | 依赖 |
| `run.sh` | 本地/服务器启动脚本（uvicorn） |
| `waic-api.service` | systemd 模板（key 用 EnvironmentFile 注入） |

## 模型

- base_url `https://tokenhub.tencentmaas.com/v1`，model `qwen3.5-flash`
- key 从**环境变量 `TOKENHUB_API_KEY`** 读，**绝不硬编码、绝不进 git**
- 调用固定传 `enable_thinking:false`（否则默认思考慢到 ~14s）
- 可用 `TOKENHUB_MODEL` / `TOKENHUB_BASE_URL` 环境变量覆盖（切 hy3 / DashScope 热备）

## 本地启动 + 自测

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 注入 key（本地测试）
set -a; source <(grep TENCENT_TOKENHUB_API_KEY ~/.claude/api-vault.env); set +a
export TOKENHUB_API_KEY=$TENCENT_TOKENHUB_API_KEY

# 起服务（默认 127.0.0.1:8790）
./run.sh
# 或： PORT=8790 .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8790
```

自测（另开一个终端）：

```bash
B=http://127.0.0.1:8790
curl -s $B/api/health                                   # {"ok":true,"mode":"api"}
# 注意：中文参数需 URL 编码，用 curl -G --data-urlencode
curl -s -G $B/api/route --data-urlencode from=世博中心 --data-urlencode to=张江科学会堂
curl -s -G $B/api/exhibitors --data-urlencode hall=H2 --data-urlencode q=机器人
curl -s -G $B/api/digest --data-urlencode interests=具身智能 --data-urlencode day=2
curl -sN -X POST $B/api/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"7月18日世博中心有哪些大模型论坛？"}]}'
```

## API 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{"ok":true,"mode":"api"}`，供前端探活 |
| POST | `/api/chat` | SSE (`text/event-stream`)，见下 |
| GET | `/api/activity/{id}` | 完整活动 JSON（含 `detail_md_content`） |
| GET | `/api/exhibitors?hall=&industry=&q=&page=&size=` | `{total,page,size,items}` |
| GET | `/api/route?from=&to=` | `{same_district,minutes,note}` |
| GET | `/api/digest?interests=a,b&day=1` | `{day,date,summary,items}` |

### POST /api/chat

请求体：
```json
{"messages":[{"role":"user","content":".."}],
 "my_schedule":["off-.."],
 "profile":{"interests":[".."]}}
```

SSE 每条 `data: {json}\n\n`，事件类型：
- `{"type":"delta","text":".."}` — 流式文本
- `{"type":"cards","kind":"activity"|"exhibitor","items":[..]}` — 工具命中的结果卡
- `{"type":"done"}` — 结束
- `{"type":"error","message":".."}` — 出错降级（不 500）

卡片字段：`id,title,date,start_time,venue,category,track,registration_url,price,official_url`
（另附 `end_time,district,room,day,source_type`；展商卡另附 `hall,booth,industry,logo,partner_level,walk_minutes`）。

## AI 工具（function-calling）

模型只能靠这 8 个工具查库，不许用自带知识（模型不知 WAIC 真实日期）：

`search_activities(day?,district?,category?,track?,keyword?,need_registration?)` ·
`get_activity_detail(id)` · `search_exhibitors(hall?,industry?,keyword?)` ·
`plan_day(interests[],day,constraints?)` · `route_between(from,to)` ·
`whats_on_now(now,near?)` · `nearest_next(current_hall,keyword?)` · `search_intel(keyword)`

工具返回活动/展台时，同时向前端发 `cards` 事件。

## 鲁棒 / 安全

- **限流**：app 层每 IP 令牌桶（20 chat/分钟，超限发 error 事件不断流）。
  生产环境建议 nginx 再加 `limit_req` 兜一层（app 层是最后防线）。
- **CORS**：仅放行 `https://waic.sg.superbrain-ai.com`（+ 本地开发端口）。
- **降级**：模型/key 不可用 → 发 `error` 事件优雅降级，不 500 崩；
  只读端点（route/exhibitors/digest/activity）**不依赖模型**，模型挂了照常可用。
- **数据层量小全内存**：363 活动 / 1020 展商 / 208 情报，无 dump 端点，`/api/exhibitors` 分页上限 100。

## 部署（服务器侧）

1. rsync `server/` + `build-output/data/` + `build-output/md/` 到服务器（如 `/opt/waic/日程助手/`）。
2. 建 venv 装依赖：`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`。
3. key 注入：写 `/etc/waic/api.env`（`chmod 600`）：`TOKENHUB_API_KEY=...`；`waic-api.service` 已用 `EnvironmentFile` 引用。
4. 装服务：`cp waic-api.service /etc/systemd/system/` → 改 `WorkingDirectory`/`ExecStart` 路径 → `systemctl daemon-reload && systemctl enable --now waic-api`。
5. nginx 反代 `/api/` → `127.0.0.1:8790`，并加 `limit_req` 限流；SSE 记得 `proxy_buffering off;`。
6. 端口默认 `8790`（可用 `PORT` 环境变量改）。
