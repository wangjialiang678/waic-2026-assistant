#!/usr/bin/env python3
"""
make_digest.py — Tier 5 每日日报生成（由 refresh_and_deploy.sh 每 2h 调用，随发布走）。

产出 build-output/digest-latest.json（轻量、可公开），内容：
  - yesterday_articles：昨天/今晨的 WAIC 资讯集锦（来自 intel.json，含标题/出处/链接/摘要）
  - today_events：今天的活动推荐池（含跨天活动；带 weight/tags，个性化过滤由客户端/skill 按
    用户兴趣标签本地完成——服务端不碰用户数据）
发布：refresh_and_deploy.sh 把它 cp 进 webroot 并推 SG（/digest-latest.json）。
skill 端：每天首次使用时 GET /digest-latest.json，按本地 interests 过滤后呈现（SKILL.md v2.2.0）。

会期之外（<7/15 或 >7/21）today_events 取距今最近的会期日，避免空日报。
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "build-output" / "data"
OUT = ROOT / "build-output" / "digest-latest.json"
CST = timezone(timedelta(hours=8))
DAY1, DAY4 = "2026-07-17", "2026-07-20"


def date_in_span(span: str, date: str) -> bool:
    if not span or "~" not in span:
        return False
    lo, _, hi = span.partition("~")
    lo, hi = lo.strip(), hi.strip()
    if len(hi) < 10:
        hi = lo[:10 - len(hi)] + hi
    return bool(lo) and lo <= date <= hi


def main():
    now = datetime.now(CST)
    today = now.strftime("%F")
    yesterday = (now - timedelta(days=1)).strftime("%F")
    # 会期外取最近会期日，保证日报有活动可推
    target = min(max(today, DAY1), DAY4)

    acts = json.loads((DATA / "activities.json").read_text())
    acts = acts if isinstance(acts, list) else acts.get("activities") or acts.get("items") or []
    intel = json.loads((DATA / "intel.json").read_text())
    arts = intel.get("articles") or []

    y_arts = [a for a in arts if (a.get("date") or "")[:10] in (yesterday, today)]
    y_arts.sort(key=lambda a: a.get("date") or "", reverse=True)
    yesterday_articles = [{
        "title": a.get("title", ""), "publisher": a.get("publisher", ""),
        "date": a.get("date", ""), "url": a.get("url") or a.get("sogou_url") or "",
        "summary": (a.get("summary") or "")[:140],
    } for a in y_arts[:20]]

    todays = []
    for a in acts:
        if a.get("kind") == "exhibition_zone":
            continue
        d = a.get("date") or ""
        if d == target or date_in_span(d, target):
            todays.append({
                "id": a.get("id"), "title": a.get("title", ""),
                "start_time": a.get("start_time", ""), "end_time": a.get("end_time", ""),
                "venue": a.get("venue", ""), "district": a.get("district", ""),
                "category": a.get("category", ""), "track": a.get("track", ""),
                "tags": a.get("tags") or [], "weight": a.get("weight") or 0,
                "waic_relation": a.get("waic_relation", ""),
                "source_type": a.get("source_type", ""),
            })
    todays.sort(key=lambda x: (-(x["weight"] or 0), x["start_time"] or "99:99"))

    OUT.write_text(json.dumps({
        "kind": "waic-daily-digest", "v": 1,
        "generated_at": now.strftime("%F %T"),
        "date": today, "event_date": target, "yesterday": yesterday,
        "yesterday_articles": yesterday_articles,
        "today_events": todays[:80],
        "counts": {"articles": len(yesterday_articles), "events": len(todays)},
        "note": "today_events 已按重要度排序；个性化请按用户 interests 在客户端过滤",
    }, ensure_ascii=False, indent=1))
    print(f"[digest] {today}: 昨日文章 {len(yesterday_articles)} 篇 · 今日({target})活动 {len(todays)} 场")
    return 0


if __name__ == "__main__":
    sys.exit(main())
