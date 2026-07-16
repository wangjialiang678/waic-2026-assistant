"""
tools.py — 8 个 function-calling 工具的实现 + 给前端发的 card 构建 + 给模型的 tools schema。

约定：每个工具函数签名 `fn(store, **args) -> ToolResult`
ToolResult = {"model": <给模型回填的精简 JSON>, "cards": <发前端的 cards 事件或 None>}

模型只看到 model 部分（精简、去掉 search_text 等大字段以省 token）；
前端收到 cards 事件（含更多展示字段）。
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

log = logging.getLogger("waic.tools")


# ============ card 构建（发给前端） ============
def activity_card(a: dict) -> dict:
    src = a.get("source") or {}
    return {
        "id": a.get("id"),
        "title": a.get("title", ""),
        "date": a.get("date", ""),
        "start_time": a.get("start_time", ""),
        "venue": a.get("venue", "") or a.get("district", ""),
        "category": a.get("category", ""),
        "track": a.get("track", ""),
        "registration_url": a.get("registration_url", ""),
        "price": a.get("price", ""),
        "official_url": a.get("official_url", "") or src.get("url", ""),
        # 额外展示字段（前端可选用）
        "end_time": a.get("end_time", ""),
        "district": a.get("district", ""),
        "room": a.get("room", ""),
        "day": a.get("day"),
        "source_type": a.get("source_type", ""),
    }


def exhibitor_card(x: dict, walk_minutes: Optional[int] = None) -> dict:
    booths = x.get("booths") or []
    booth = booths[0] if booths else {}
    card = {
        "id": x.get("id"),
        "title": x.get("name", ""),
        "date": "",
        "start_time": "",
        "venue": booth.get("hall") or booth.get("venue", ""),
        "category": x.get("industry", ""),
        "track": "",
        "registration_url": "",
        "price": "",
        "official_url": "",
        # 额外字段
        "hall": booth.get("hall", ""),
        "booth": booth.get("no", ""),
        "industry": x.get("industry", ""),
        "logo": x.get("logo", ""),
        "partner_level": x.get("partner_level", ""),
        "district": booth.get("district", ""),
    }
    if walk_minutes is not None:
        card["walk_minutes"] = walk_minutes
    return card


# ============ 模型看到的精简结构 ============
def _act_brief(a: dict) -> dict:
    return {
        "id": a.get("id"),
        "title": a.get("title", ""),
        "date": a.get("date", ""),
        "day": a.get("day"),
        "start_time": a.get("start_time", ""),
        "end_time": a.get("end_time", ""),
        "venue": a.get("venue", ""),
        "room": a.get("room", ""),
        "district": a.get("district", ""),
        "category": a.get("category", ""),
        "track": a.get("track", ""),
        "registration_required": a.get("registration_required"),
        "registration_url": a.get("registration_url", ""),
        "price": a.get("price", ""),
        "source_type": a.get("source_type", ""),  # official / unofficial → 让模型标来源
        "tags": a.get("tags", []),
    }


def _exh_brief(x: dict) -> dict:
    booths = x.get("booths") or []
    return {
        "id": x.get("id"),
        "name": x.get("name", ""),
        "industry": x.get("industry", ""),
        "partner_level": x.get("partner_level", ""),
        "halls": x.get("halls", []),
        "booths": [{"no": b.get("no", ""), "hall": b.get("hall", "")} for b in booths],
        "intro": (x.get("intro", "") or "")[:160],
    }


# ============ 检索辅助 ============
def _kw_hit(text: str, keyword: str) -> bool:
    if not keyword:
        return True
    return keyword.lower() in (text or "").lower()


def _act_search_blob(a: dict) -> str:
    if a.get("search_text"):
        return a["search_text"]
    parts = [a.get("title", ""), a.get("description", ""), a.get("venue", ""),
             a.get("category", ""), a.get("track", ""), " ".join(a.get("tags", []))]
    return " ".join(parts)


def _needs_registration(a: dict) -> bool:
    return bool(a.get("registration_required")) or bool(a.get("registration_url"))


def _time_key(a: dict) -> str:
    return a.get("start_time") or "99:99"


# ============ 工具实现 ============
def search_activities(store, day=None, district=None, category=None, track=None,
                      keyword=None, need_registration=None, limit=20) -> dict:
    date = store.date_for_day(day) if day is not None else None
    out = []
    for a in store.activities:
        if a.get("kind") == "exhibition_zone":
            continue
        if day is not None and a.get("day") != day and a.get("date") != date:
            continue
        if district and district not in (a.get("district") or ""):
            continue
        if category and category not in (a.get("category") or ""):
            continue
        if track and track not in (a.get("track") or ""):
            continue
        if need_registration is not None:
            if _needs_registration(a) != bool(need_registration):
                continue
        if keyword and not _kw_hit(_act_search_blob(a), keyword):
            continue
        out.append(a)

    out.sort(key=lambda a: (a.get("date") or "9999", _time_key(a)))
    total = len(out)
    picked = out[:limit]
    return {
        "model": {"total": total, "returned": len(picked),
                  "items": [_act_brief(a) for a in picked]},
        "cards": {"kind": "activity", "items": [activity_card(a) for a in picked]},
    }


def get_activity_detail(store, id=None) -> dict:
    a = store.act_by_id.get(id)
    if not a:
        return {"model": {"error": f"未找到活动 id={id}"}, "cards": None}
    detail = dict(a)
    detail.pop("search_text", None)
    md = store.detail_md(a)
    if md:
        detail["detail_md_content"] = md[:4000]
    return {"model": detail, "cards": {"kind": "activity", "items": [activity_card(a)]}}


def search_exhibitors(store, hall=None, industry=None, keyword=None, limit=20) -> dict:
    out = []
    for x in store.exhibitors:
        halls = x.get("halls", []) or [b.get("hall", "") for b in x.get("booths", [])]
        if hall and not any(hall in (h or "") for h in halls):
            continue
        if industry and industry not in (x.get("industry") or ""):
            continue
        if keyword and not _kw_hit(x.get("search_text", "") or x.get("name", ""), keyword):
            continue
        out.append(x)
    total = len(out)
    picked = out[:limit]
    return {
        "model": {"total": total, "returned": len(picked),
                  "items": [_exh_brief(x) for x in picked]},
        "cards": {"kind": "exhibitor", "items": [exhibitor_card(x) for x in picked]},
    }


def plan_day(store, interests=None, day=None, constraints=None) -> dict:
    interests = interests or []
    date = store.date_for_day(day) if day is not None else None
    # 候选：该天、有开始时间的活动
    cands = []
    for a in store.activities:
        if a.get("kind") == "exhibition_zone":
            continue
        if day is not None and a.get("day") != day and a.get("date") != date:
            continue
        if not a.get("start_time"):
            continue
        blob = _act_search_blob(a)
        score = sum(1 for kw in interests if _kw_hit(blob, kw)) if interests else 0
        if interests and score == 0:
            continue
        cands.append((score, a))

    # 按开始时间排序，贪心去重叠（时间不重叠），同片区聚拢作为次要偏好
    cands.sort(key=lambda t: (_time_key(t[1]), -t[0]))
    plan: list[dict] = []
    last_end = ""
    last_district = None
    for _score, a in cands:
        st = a.get("start_time") or ""
        et = a.get("end_time") or st
        if last_end and st < last_end:
            continue  # 与已选时间重叠，跳过
        # 同片区优先：若与上一个不同片区且已有安排，仍接受（提示转场），这里只做聚拢排序不硬排除
        plan.append(a)
        last_end = et or st
        last_district = a.get("district")
    # 计算相邻转场提示
    legs = []
    for i in range(len(plan) - 1):
        r = store.route(plan[i].get("venue", ""), plan[i + 1].get("venue", ""))
        legs.append({
            "from": plan[i].get("venue", ""), "to": plan[i + 1].get("venue", ""),
            "minutes": r.get("minutes"), "same_district": r.get("same_district"),
        })
    model = {
        "day": day, "date": date, "interests": interests,
        "constraints": constraints or "",
        "count": len(plan),
        "items": [_act_brief(a) for a in plan],
        "transfers": legs,
    }
    return {"model": model, "cards": {"kind": "activity", "items": [activity_card(a) for a in plan]}}


def route_between(store, **kw) -> dict:
    frm = kw.get("from") or kw.get("from_") or kw.get("origin") or ""
    to = kw.get("to") or kw.get("destination") or ""
    r = store.route(frm, to)
    return {"model": {"from": frm, "to": to, **r}, "cards": None}


def _parse_now(now: str, store) -> tuple[Optional[str], Optional[str]]:
    """把 now 解析成 (date, 'HH:MM')。支持 ISO / 'YYYY-MM-DD HH:MM' / 'HH:MM'。"""
    if not now:
        return None, None
    s = now.strip().replace("T", " ")
    date = None
    m = re.search(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        date = m.group(1)
    tm = re.search(r"(\d{1,2}):(\d{2})", s)
    hm = f"{int(tm.group(1)):02d}:{tm.group(2)}" if tm else None
    if date is None:
        # 只给了时间：默认会期第 1 天
        date = store.day_to_date.get(1)
    return date, hm


def _add_minutes(hm: str, mins: int) -> str:
    h, m = map(int, hm.split(":"))
    total = h * 60 + m + mins
    total = max(0, min(total, 23 * 60 + 59))
    return f"{total // 60:02d}:{total % 60:02d}"


def whats_on_now(store, now=None, near=None, window_min=90) -> dict:
    date, hm = _parse_now(now or "", store)
    if not hm:
        return {"model": {"error": "now 需包含时间，如 '2026-07-18 10:30'"}, "cards": None}
    horizon = _add_minutes(hm, window_min)
    ongoing, upcoming = [], []
    for a in store.activities:
        if a.get("date") != date:
            continue
        if near and near not in (a.get("district") or ""):
            continue
        st, et = a.get("start_time") or "", a.get("end_time") or ""
        if not st:
            continue
        if st <= hm and (not et or hm <= et):
            ongoing.append(a)
        elif hm < st <= horizon:
            upcoming.append(a)
    ongoing.sort(key=_time_key)
    upcoming.sort(key=_time_key)
    picked = (ongoing + upcoming)[:20]
    model = {
        "now": f"{date} {hm}", "near": near or "",
        "ongoing": [_act_brief(a) for a in ongoing[:12]],
        "upcoming": [_act_brief(a) for a in upcoming[:12]],
    }
    return {"model": model, "cards": {"kind": "activity", "items": [activity_card(a) for a in picked]}}


def nearest_next(store, current_hall=None, keyword=None, limit=8) -> dict:
    if not current_hall:
        return {"model": {"error": "需要 current_hall，如 '世博展览馆H2'"}, "cards": None}
    scored = []
    for x in store.exhibitors:
        if keyword and not _kw_hit(x.get("search_text", "") or x.get("name", ""), keyword):
            continue
        halls = x.get("halls", []) or [b.get("hall", "") for b in x.get("booths", [])]
        if not halls:
            continue
        best = min((store.hall_distance_minutes(current_hall, h) for h in halls), default=999)
        if best >= 999:
            continue
        scored.append((best, x))
    scored.sort(key=lambda t: t[0])
    picked = scored[:limit]
    model = {
        "current_hall": current_hall, "keyword": keyword or "",
        "items": [{**_exh_brief(x), "walk_minutes": mins} for mins, x in picked],
    }
    cards = {"kind": "exhibitor",
             "items": [exhibitor_card(x, walk_minutes=mins) for mins, x in picked]}
    return {"model": model, "cards": cards}


def search_intel(store, keyword=None, limit=10) -> dict:
    out = []
    for it in store.intel:
        blob = " ".join([it.get("title", ""), it.get("summary", ""), it.get("publisher", "")])
        if keyword and not _kw_hit(blob, keyword):
            continue
        out.append(it)
    picked = out[:limit]
    model = {
        "total": len(out),
        "items": [{
            "title": it.get("title", ""),
            "publisher": it.get("publisher", ""),
            "channel": it.get("channel", ""),
            "date": it.get("date", ""),
            "summary": (it.get("summary", "") or "")[:200],
            "url": it.get("url") or it.get("sogou_url", ""),
        } for it in picked],
    }
    return {"model": model, "cards": None}


# ============ 注册表：名字 -> 实现 ============
TOOL_IMPL: dict[str, Callable[..., dict]] = {
    "search_activities": search_activities,
    "get_activity_detail": get_activity_detail,
    "search_exhibitors": search_exhibitors,
    "plan_day": plan_day,
    "route_between": route_between,
    "whats_on_now": whats_on_now,
    "nearest_next": nearest_next,
    "search_intel": search_intel,
}


def run_tool(store, name: str, args: dict) -> dict:
    fn = TOOL_IMPL.get(name)
    if not fn:
        return {"model": {"error": f"未知工具 {name}"}, "cards": None}
    try:
        return fn(store, **(args or {}))
    except TypeError as e:
        log.warning("tool %s bad args %s: %s", name, args, e)
        # 过滤掉不认识的参数再试一次
        import inspect
        allowed = set(inspect.signature(fn).parameters) - {"store"}
        clean = {k: v for k, v in (args or {}).items() if k in allowed}
        try:
            return fn(store, **clean)
        except Exception as e2:  # noqa: BLE001
            log.exception("tool %s failed: %s", name, e2)
            return {"model": {"error": f"工具 {name} 执行失败"}, "cards": None}
    except Exception as e:  # noqa: BLE001
        log.exception("tool %s failed: %s", name, e)
        return {"model": {"error": f"工具 {name} 执行失败"}, "cards": None}


# ============ 给模型的 tools schema（OpenAI function-calling 格式）============
def tool_schemas() -> list[dict]:
    def f(name, desc, props, required=None):
        return {"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required or []},
        }}

    return [
        f("search_activities",
          "按条件检索 WAIC 活动/论坛/边会。所有日程事实必须调此工具查库，不要凭模型知识回答。",
          {
              "day": {"type": "integer", "description": "会期第几天：1=7/17,2=7/18,3=7/19,4=7/20"},
              "district": {"type": "string", "description": "片区：世博片区/张江片区/西岸片区"},
              "category": {"type": "string", "description": "类别：主题论坛/分论坛/边会·周边活动/全体会议/同期活动"},
              "track": {"type": "string", "description": "分轨：WAIC Young/WAIC Up/AI GRAVITY/AI 原住民"},
              "keyword": {"type": "string", "description": "主题关键词，如 大模型/具身智能/机器人/Agent"},
              "need_registration": {"type": "boolean", "description": "是否只看需要报名的活动"},
          }),
        f("get_activity_detail",
          "按活动 id 取完整详情（简介/议程/嘉宾/报名/来源）。",
          {"id": {"type": "string"}}, ["id"]),
        f("search_exhibitors",
          "检索参展商/展台。可按展馆、行业、关键词过滤。",
          {
              "hall": {"type": "string", "description": "展馆，如 世博展览馆H2/世博展览馆H4/西岸国际会展中心"},
              "industry": {"type": "string", "description": "行业，如 具身智能/核心技术/智慧医疗"},
              "keyword": {"type": "string", "description": "公司名或业务关键词，如 机器人/芯片"},
          }),
        f("plan_day",
          "为某一天按兴趣排一天日程：筛选匹配活动、去时间重叠、给出转场提示。",
          {
              "interests": {"type": "array", "items": {"type": "string"},
                            "description": "兴趣关键词列表，如 ['具身智能','机器人']"},
              "day": {"type": "integer", "description": "会期第几天 1-4"},
              "constraints": {"type": "string", "description": "额外约束，如 只看下午/只在世博片区"},
          }, ["interests", "day"]),
        f("route_between",
          "估算两个场馆/展馆之间的步行或转场时间。",
          {"from": {"type": "string"}, "to": {"type": "string"}}, ["from", "to"]),
        f("whats_on_now",
          "按当前时间筛出正在进行 / 即将开始的活动。",
          {
              "now": {"type": "string", "description": "当前时间，如 '2026-07-18 10:30'"},
              "near": {"type": "string", "description": "限定片区（可选）"},
          }, ["now"]),
        f("nearest_next",
          "在世博展览馆内（H1-H4 邻接）从当前展馆找最近的匹配展台。",
          {
              "current_hall": {"type": "string", "description": "当前所在展馆，如 世博展览馆H2"},
              "keyword": {"type": "string", "description": "想找的展台关键词，如 机器人/大模型"},
          }, ["current_hall"]),
        f("search_intel",
          "检索 WAIC 相关资讯/报道/攻略（非活动）。用于'关于X的报道/新闻'类问题。",
          {"keyword": {"type": "string"}}, ["keyword"]),
    ]
