#!/usr/bin/env python3
"""
把其他渠道（Exa/Tavily）抓的候选 raw/web/other_candidates.json
归一化成 build.py 消费的 raw/web/articles.json。

映射：
  type "unofficial"(边会/周边) -> kind "side_event"，date 视为活动日期
  type "official"(官方相关报道) -> kind "coverage"，date 视为发布日期
只保留 relevant 为 true / maybe 的条目。
"""
import json
from pathlib import Path

PROJ = Path(__file__).resolve().parent.parent
src = PROJ / "raw" / "web" / "other_candidates.json"
dst = PROJ / "raw" / "web" / "articles.json"

items = json.loads(src.read_text(encoding="utf-8"))
CONF_DATES = {"2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"}

out = []
for it in items:
    rel = it.get("relevant")
    if rel is False or rel == "false":
        continue
    typ = (it.get("type") or "").lower()
    kind = "side_event" if typ == "unofficial" else "coverage"
    date = (it.get("date") or "").strip()
    rec = {
        "title": it.get("title") or "",
        "publisher": it.get("publisher") or "",
        "source_site": it.get("source_site") or "",
        "date": date,
        "url": it.get("url") or "",
        "summary": it.get("snippet") or "",
        "kind": kind,
    }
    # 边会：若 date 落在会期窗口，作为活动日期
    if kind == "side_event" and date in CONF_DATES:
        rec["event_date"] = date
    out.append(rec)

dst.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
n_side = sum(1 for r in out if r["kind"] == "side_event")
print(f"web 归一化：{len(out)} 条（边会 {n_side} / 报道 {len(out)-n_side}） -> {dst.name}")
