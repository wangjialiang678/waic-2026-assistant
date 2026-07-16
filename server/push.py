"""
push.py — 轮询式个性化推送编排（设计文档 docs/推送系统设计-20260716.md §五-§七）。

客户端（skill/网页）在会期每天 4 个窗口错峰轮询 GET /api/push；服务端按
「当前窗口 + 该 device 的画像 + push_config.json 编排」组装一条定制消息。

关键设计（v1.1 自审修订）：
- 错峰在客户端：装机时抽一次 0-20 分钟随机偏移并持久化；服务端窗口给宽松开放区间，
  区间内轮询都有效——不会因偏移错过整个窗口。
- 无状态去重：delivery_id = "MMDD-窗口名"，客户端记「已展示」，请求带 last=，
  服务端只做比对，不存投递记录。
- 定向内容零额外成本：直接从 intel（cimidata 每 2h 已灌真链文章）+ activities 按
  targeting.topics 过滤，不实时调外部 API。
- 画像优先级：服务端 user_state.interests+inferred（P4 上报）> 请求参数 interests。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import store_state

CST = timezone(timedelta(hours=8))
_CONFIG_PATH = Path(__file__).resolve().parent / "push_config.json"
_config_cache: Optional[dict] = None


def _config() -> dict:
    global _config_cache
    if _config_cache is None:
        try:
            _config_cache = json.loads(_CONFIG_PATH.read_text())
        except Exception:  # noqa: BLE001 - 配置损坏 → 推送静默关闭，不影响其他接口
            _config_cache = {"enabled": False}
    return _config_cache


def _split(s: str) -> list[str]:
    return [p.strip() for p in re.split(r"[／/、,，\|\s]+", s or "") if p.strip()]


def _real_link(url: str) -> bool:
    return bool(url) and url.startswith("http") and "weixin.sogou.com" not in url


def _date_in_span(span: str, date: str) -> bool:
    if not span or "~" not in span:
        return False
    lo, _, hi = span.partition("~")
    lo, hi = lo.strip(), hi.strip()
    if len(hi) < 10:
        hi = lo[:10 - len(hi)] + hi
    return bool(lo) and lo <= date <= hi


def _acts_on(store, date: str) -> list[dict]:
    out = []
    for a in store.activities:
        if a.get("kind") in ("exhibition_zone", "coverage"):
            continue
        d = a.get("date") or ""
        if d == date or _date_in_span(d, date):
            out.append(a)
    out.sort(key=lambda x: (-(x.get("weight") or 0), x.get("start_time") or "99:99"))
    return out


def _hit(text: str, tokens: list[str]) -> bool:
    return any(t and t in text for t in tokens)


def _device_interests(device: str, interests_param: str) -> list[str]:
    """画像：服务端存的显式兴趣 + 强推断（≥2 分），回退请求参数。"""
    toks: list[str] = []
    if device:
        st = store_state.get_state(device) or {}
        toks += [s for s in (st.get("interests") or []) if s]
        inferred = st.get("inferred") or {}
        toks += [k for k, v in inferred.items() if isinstance(v, (int, float)) and v >= 2]
    toks += _split(interests_param)
    seen, out = set(), []
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _fmt_article(a: dict) -> dict:
    return {"title": a.get("title", ""), "publisher": a.get("publisher", ""),
            "url": a.get("url", ""), "summary": (a.get("summary") or "")[:100]}


def _fmt_event(a: dict) -> dict:
    return {"id": a.get("id"), "title": a.get("title", ""),
            "time": a.get("start_time") or "全天", "venue": a.get("venue") or a.get("district", ""),
            "tags": (a.get("tags") or [])[:3], "weight": a.get("weight") or 0}


def _rank_by_interest(items: list[dict], blob_fn, tokens: list[str], cap: int) -> list[dict]:
    """兴趣命中的排前，其余按原序补足到 cap。"""
    hits = [x for x in items if _hit(blob_fn(x), tokens)] if tokens else []
    rest = [x for x in items if x not in hits]
    return (hits + rest)[:cap]


def build_push(store, device: str = "", interests: str = "", last: str = "",
               now: Optional[datetime] = None) -> dict:
    cfg = _config()
    if not cfg.get("enabled"):
        return {"ready": False, "window": "off"}
    now = now or datetime.now(CST)
    today, hm = now.strftime("%F"), now.strftime("%H:%M")
    period = cfg.get("period") or {}
    if not (period.get("start", "0000") <= today <= period.get("end", "9999")):
        return {"ready": False, "window": "none", "note": "会期外"}

    win = next((w for w in cfg.get("windows") or []
                if w.get("open_from", "") <= hm <= w.get("open_until", "")), None)
    if not win:
        return {"ready": False, "window": "none"}

    delivery_id = f"{today[5:7]}{today[8:10]}-{win['name']}"
    if last == delivery_id:
        return {"ready": False, "window": win["name"], "note": "本窗口已投递"}

    tokens = _device_interests(device, interests)
    arts_all = [a for a in (getattr(store, "intel", None) or [])
                if _real_link(a.get("url") or "")]
    yesterday = (now - timedelta(days=1)).strftime("%F")
    tomorrow = (now + timedelta(days=1)).strftime("%F")
    fresh = [a for a in arts_all if (a.get("date") or "")[:10] in (today, yesterday)]
    fresh.sort(key=lambda a: a.get("date") or "", reverse=True)
    art_blob = lambda a: (a.get("title", "") + " " + (a.get("summary") or ""))  # noqa: E731
    act_blob = lambda a: (a.get("title", "") + " " + " ".join(a.get("tags") or []))  # noqa: E731

    sections: list[dict] = []
    kind = win.get("kind", "速报")

    if win.get("audience") == "all":
        if win["name"] == "morning":
            arts = _rank_by_interest(fresh, art_blob, tokens, 6)
            evs = _rank_by_interest(_acts_on(store, today), act_blob, tokens, 8)
            if arts:
                sections.append({"h": "今日 WAIC 要闻", "type": "articles",
                                 "items": [_fmt_article(a) for a in arts]})
            if evs:
                sections.append({"h": "今日亮点·按你关注", "type": "events",
                                 "items": [_fmt_event(a) for a in evs]})
        else:  # evening 晚报
            arts = _rank_by_interest(fresh, art_blob, tokens, 5)
            evs = _rank_by_interest(_acts_on(store, tomorrow), act_blob, tokens, 8)
            if arts:
                sections.append({"h": "今日回顾", "type": "articles",
                                 "items": [_fmt_article(a) for a in arts]})
            if evs:
                sections.append({"h": "明日预告·按你关注", "type": "events",
                                 "items": [_fmt_event(a) for a in evs]})
    else:  # targeted：重大新闻全员，其余仅画像命中
        for b in cfg.get("breaking") or []:
            if b.get("date") == today and win["name"] in (b.get("windows") or []):
                sections.append({"h": "🔴 重要", "type": "articles",
                                 "items": [{"title": b.get("title", ""), "publisher": b.get("publisher", "官方"),
                                            "url": b.get("url", ""), "summary": b.get("summary", "")}]})
        topics: list[str] = []
        for rule in cfg.get("targeting") or []:
            if set(rule.get("interest_any") or []) & set(tokens):
                topics += rule.get("topics") or []
        if topics:
            arts = [a for a in fresh if _hit(art_blob(a), topics)][:5]
            evs = [a for a in _acts_on(store, today)
                   if _hit(act_blob(a), topics) and (a.get("start_time") or "24:00") >= hm][:5]
            if arts:
                sections.append({"h": "你关注方向的新动态", "type": "articles",
                                 "items": [_fmt_article(a) for a in arts]})
            if evs:
                sections.append({"h": "今天还来得及去", "type": "events",
                                 "items": [_fmt_event(a) for a in evs]})
        if not sections:
            return {"ready": False, "window": win["name"], "note": "无画像匹配内容"}

    if not sections:
        return {"ready": False, "window": win["name"], "note": "暂无新内容"}
    return {
        "ready": True, "window": win["name"], "kind": kind,
        "delivery_id": delivery_id,
        "title": f"WAIC {kind} · {today[5:7]}/{today[8:10]}",
        "personalized": bool(tokens),
        "sections": sections,
        "cta": ["帮我排今天行程", "看全部日程 waic.sg.superbrain-ai.com"],
    }
