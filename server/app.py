"""
app.py — WAIC 日程助手 v2 后端（FastAPI + uvicorn, async, 适合 SSE）。

路由：
  GET  /api/health                       探活
  POST /api/chat            (SSE)         AI 对话（function-calling + 流式 + cards）
  GET  /api/activity/{id}                 活动完整详情
  GET  /api/exhibitors?hall=&industry=&q=&page=&size=
  GET  /api/route?from=&to=               两场馆转场时间
  GET  /api/digest?interests=a,b&day=1    个性化当日速报

安全/鲁棒：
  - CORS 仅放行正式站点（+ 本地开发）。
  - 限流：app 层每 IP 令牌桶（默认 20 chat/分钟）；
    注释：生产环境建议再在 nginx 用 `limit_req` 兜一层，app 层只是最后防线。
  - 模型出错 → 发 error 事件优雅降级，不 500 崩。
"""
from __future__ import annotations

import json
import logging
import time
from collections import defaultdict

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

import data
import store_state
import tools
from llm import run_chat

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("waic.app")

# ---- 事件日志（JSONL，滚动，封顶 ~500MB：50MB × 10 份）----
# 只记有用的：API 请求路径 / 聊天问题+命中卡数+耗时 / IP 哈希前缀（非明文，保隐私）/ 渠道来源。
# 用于：错误排查、用户使用路径分析、优化空间追踪。浏览(静态)由 nginx waic.access.log 记。
import os as _os
import hashlib as _hashlib
from logging.handlers import RotatingFileHandler as _RFH

_LOG_DIR = _os.environ.get("WAIC_LOG_DIR", "")
_evlog = logging.getLogger("waic.events")
_evlog.propagate = False
if _LOG_DIR:
    try:
        _os.makedirs(_LOG_DIR, exist_ok=True)
        _h = _RFH(_os.path.join(_LOG_DIR, "events.jsonl"),
                  maxBytes=50_000_000, backupCount=9, encoding="utf-8")
        _h.setFormatter(logging.Formatter("%(message)s"))
        _evlog.addHandler(_h)
        _evlog.setLevel(logging.INFO)
    except Exception:  # noqa: BLE001
        _LOG_DIR = ""


def _ip8(ip: str) -> str:
    return _hashlib.sha1((ip or "").encode()).hexdigest()[:8]


def _log_event(kind: str, **fields):
    if not _LOG_DIR:
        return
    rec = {"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind}
    rec.update({k: v for k, v in fields.items() if v not in (None, "")})
    try:
        _evlog.info(json.dumps(rec, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        pass

app = FastAPI(title="WAIC 日程助手 API", version="2.0")

# ---- CORS：仅放行正式站点 + 本地开发 ----
ALLOWED_ORIGINS = [
    "https://waic.sg.superbrain-ai.com",
    "http://127.0.0.1:8790",
    "http://localhost:8790",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ---- 访问日志中间件：记录每个 /api 调用（路径/IP哈希/渠道/状态/耗时）----
@app.middleware("http")
async def _access_log(request: Request, call_next):
    t0 = time.monotonic()
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/health",):
        _log_event("req", path=path,
                   ip8=_ip8(_client_ip(request)),
                   frm=request.query_params.get("from", ""),
                   status=resp.status_code,
                   ms=int((time.monotonic() - t0) * 1000))
    return resp


# ================= 限流：每 IP 令牌桶 =================
# 生产建议：nginx 再加 `limit_req zone=chat burst=... nodelay;` 兜一层，
# 本 app 层令牌桶是应用内的最后防线，防烧钱/防刷。
class TokenBucket:
    def __init__(self, capacity: int, refill_per_sec: float):
        self.capacity = capacity
        self.refill = refill_per_sec
        self.state: dict[str, tuple[float, float]] = {}  # ip -> (tokens, last_ts)

    def allow(self, ip: str) -> bool:
        now = time.monotonic()
        tokens, last = self.state.get(ip, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.refill)
        if tokens < 1.0:
            self.state[ip] = (tokens, now)
            return False
        self.state[ip] = (tokens - 1.0, now)
        return True


# 限流按"同步码(设备)"计，避免大会现场共享 WiFi(同一 NAT 公网 IP) 误伤正常用户；
# 另加一个宽松的 per-IP 上限只兜底真正的滥用（一个 IP 刷大量设备码）。
CHAT_LIMITER = TokenBucket(capacity=40, refill_per_sec=40 / 60.0)       # 每设备 40 chat/分钟（个人够用）
CHAT_IP_LIMITER = TokenBucket(capacity=300, refill_per_sec=300 / 60.0)  # 每 IP 300/分钟 兜底（会场 NAT 也够）
STATE_LIMITER = TokenBucket(capacity=180, refill_per_sec=180 / 60.0)    # 状态同步很轻，每设备 180/分钟


def _client_ip(request: Request) -> str:
    # 反代后取 X-Forwarded-For 第一个；否则用直连 IP
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ================= 启动：载入数据 =================
@app.on_event("startup")
def _startup():
    data.init_store()
    log.info("startup complete")


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ================= 路由 =================
@app.get("/api/health")
def health():
    return {"ok": True, "mode": "api"}


@app.post("/api/chat")
async def chat(request: Request):
    ip = _client_ip(request)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    user_messages = body.get("messages") or []
    my_schedule = body.get("my_schedule") or []
    profile = body.get("profile") or {}
    _dev = (body.get("device") or "").strip()
    rl_key = _dev if store_state.valid_device(_dev) else ip   # 限流键：优先同步码，回退 IP

    q = ""
    for m in reversed(user_messages):
        if isinstance(m, dict) and m.get("role") == "user":
            q = (m.get("content") or "")[:120]
            break
    frm = request.query_params.get("from", "")

    async def gen():
        t0 = time.monotonic()
        n_cards = 0
        status = "ok"
        # 限流：超限 → 发 error 事件（保持 SSE 契约，不 429 直断）
        if not CHAT_LIMITER.allow(rl_key) or not CHAT_IP_LIMITER.allow(ip):
            _log_event("chat", ip8=_ip8(ip), q=q, frm=frm, status="ratelimited")
            yield _sse({"type": "error", "message": "请求过于频繁，请稍后再试。"})
            yield _sse({"type": "done"})
            return
        if not user_messages:
            yield _sse({"type": "error", "message": "缺少 messages。"})
            yield _sse({"type": "done"})
            return
        try:
            async for ev in run_chat(user_messages, my_schedule, profile):
                if isinstance(ev, dict) and ev.get("type") == "cards":
                    n_cards += len(ev.get("items") or [])
                yield _sse(ev)
        except Exception as e:  # noqa: BLE001 - 兜底，绝不 500
            status = "error"
            log.exception("chat stream error: %s", e)
            yield _sse({"type": "error", "message": "服务暂时不可用，请稍后再试。"})
            yield _sse({"type": "done"})
        finally:
            _log_event("chat", ip8=_ip8(ip), q=q, frm=frm,
                       cards=n_cards, ms=int((time.monotonic() - t0) * 1000),
                       status=status)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/activity/{activity_id}")
def activity_detail(activity_id: str):
    store = data.get_store()
    a = store.act_by_id.get(activity_id)
    if not a:
        return JSONResponse({"error": "not_found", "id": activity_id}, status_code=404)
    out = dict(a)
    out.pop("search_text", None)
    md = store.detail_md(a)
    if md:
        out["detail_md_content"] = md
    return out


@app.get("/api/exhibitors")
def exhibitors(
    hall: str = Query("", description="展馆过滤，如 世博展览馆H2"),
    industry: str = Query("", description="行业过滤"),
    q: str = Query("", description="关键词（公司名/业务）"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    store = data.get_store()
    out = []
    for x in store.exhibitors:
        halls = x.get("halls", []) or [b.get("hall", "") for b in x.get("booths", [])]
        if hall and not any(hall in (h or "") for h in halls):
            continue
        if industry and industry not in (x.get("industry") or ""):
            continue
        if q and not tools._kw_hit(x.get("search_text", "") or x.get("name", ""), q):
            continue
        out.append(x)
    total = len(out)
    start = (page - 1) * size
    items = [tools.exhibitor_card(x) for x in out[start:start + size]]
    return {"total": total, "page": page, "size": size, "items": items}


# route: from 是 Python 关键字，用底层 query_params 手动取，避开命名冲突
@app.get("/api/route")
def route_impl(request: Request):
    qp = request.query_params
    frm = qp.get("from", "")
    to = qp.get("to", "")
    store = data.get_store()
    r = store.route(frm, to)
    return {"from": frm, "to": to, **r}


@app.get("/api/digest")
def digest(
    interests: str = Query("", description="逗号分隔的兴趣关键词"),
    day: int = Query(1, ge=1, le=4),
):
    store = data.get_store()
    interest_list = [s.strip() for s in interests.split(",") if s.strip()]
    date = store.date_for_day(day)

    # 当天有时间的活动
    cands = [a for a in store.activities
             if (a.get("day") == day or a.get("date") == date)
             and a.get("kind") != "exhibition_zone" and a.get("start_time")]

    def score(a):
        blob = tools._act_search_blob(a)
        s = sum(1 for kw in interest_list if tools._kw_hit(blob, kw)) if interest_list else 0
        # 官方 + 主题论坛/全体会议 略微加权，作为"看点"
        if a.get("source_type") == "official":
            s += 0.3
        if a.get("category") in ("全体会议", "主题论坛"):
            s += 0.2
        return s

    matched = [a for a in cands if (not interest_list or score(a) >= 1)]
    ranked = sorted(matched or cands, key=lambda a: (-score(a), tools._time_key(a)))
    top = ranked[:12]

    items = [{
        "id": a.get("id"),
        "title": a.get("title", ""),
        "start_time": a.get("start_time", ""),
        "end_time": a.get("end_time", ""),
        "venue": a.get("venue", ""),
        "district": a.get("district", ""),
        "category": a.get("category", ""),
        "source_type": a.get("source_type", ""),
    } for a in top]

    if interest_list:
        summary = (f"7/{date[-2:] if date else ''} 第{day}天，围绕你关注的「{'、'.join(interest_list)}」"
                   f"共有 {len(matched)} 场相关活动，精选 {len(top)} 场看点如下。"
                   f"非官方信息以官方为准。")
    else:
        summary = (f"7/{date[-2:] if date else ''} 第{day}天，共 {len(cands)} 场有明确时间的活动，"
                   f"精选 {len(top)} 场看点。设置兴趣后可获得更精准的每日速报。")

    return {"day": day, "date": date, "interests": interest_list,
            "summary": summary, "items": items}


# ================= 用户状态同步（无登录，匿名同步码为键） =================
# GET  /api/state?device=<code>   拉取该同步码下的 日程/兴趣/推断兴趣/联系方式
# POST /api/state                 保存（LWW）；body: {device,schedule,interests,inferred,contact,updated_at}
# 用途：多端 + AI agent skill 间同步日程/兴趣；并为社交速配提供服务端兴趣数据。

_EMPTY_STATE = {"schedule": [], "interests": [], "inferred": {}, "contact": None, "updated_at": ""}


@app.get("/api/state")
def state_get(device: str = Query("", description="匿名同步码")):
    if not store_state.valid_device(device):
        return JSONResponse({"error": "bad_device"}, status_code=400)
    st = store_state.get_state(device)
    return st or {"device": device, **_EMPTY_STATE}


@app.post("/api/state")
async def state_put(request: Request):
    ip = _client_ip(request)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    device = (body.get("device") or "").strip()
    if not store_state.valid_device(device):
        return JSONResponse({"error": "bad_device"}, status_code=400)
    if not STATE_LIMITER.allow(device):   # 按同步码限流，避免共享 IP 误伤
        return JSONResponse({"error": "rate_limited"}, status_code=429)

    # 尺寸/类型收敛，防滥用
    schedule = [str(x)[:64] for x in (body.get("schedule") or []) if x][:500]
    interests = [str(x)[:32] for x in (body.get("interests") or []) if x][:60]
    inferred_in = body.get("inferred") or {}
    inferred = {}
    if isinstance(inferred_in, dict):
        for k, v in list(inferred_in.items())[:120]:
            try:
                inferred[str(k)[:32]] = round(float(v), 3)
            except (TypeError, ValueError):
                continue
    contact = body.get("contact")
    if isinstance(contact, dict):
        contact = {
            "type": str(contact.get("type", ""))[:16],
            "value": str(contact.get("value", ""))[:80],
            "optin": bool(contact.get("optin")),
        }
    else:
        contact = None
    updated_at = str(body.get("updated_at") or "")[:32]

    st = store_state.put_state(device, schedule, interests, inferred, contact, updated_at)
    _log_event("state", ip8=_ip8(ip), dev=device[:6], n_sch=len(schedule), n_int=len(interests))
    return st
