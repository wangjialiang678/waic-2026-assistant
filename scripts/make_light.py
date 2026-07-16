#!/usr/bin/env python3
"""
make_light.py — 数据分层保护：把全量 data/ 后处理成"索引层"data-lite/（公开）。

分工：不改 build.py、不改 data/*.json（那是数据侧的）。本脚本只读全量 → 产出精简公开版。
  - 全量 build-output/data/        → 部署到服务器私有目录 /opt/waic-api/data（仅 /api/* 和 AI 聊天可取）
  - 精简 build-output/data-lite/   → 部署到公开 /var/www/waic/data（客户端浏览/搜索够用）

剥离的"护城河"结构化字段（点详情走 /api/activity/{id} 取全量）：
  活动：schedule(议程/演讲人)、guests(嘉宾简介)、description_en、original_excerpt、
        article_md、additional_sources；description 截断为摘要。search_text 保留（搜索不退化）。
  展商：intro/business/简介 截断；search_text 保留。
目的：结构化的、辛苦聚合的干净数据不再裸奔；提高复制成本，不追求绝对。
"""
import json
import os
import shutil
import sys

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PROJ, "build-output", "data")
LITE = os.path.join(PROJ, "build-output", "data-lite")

# 活动：剥离的重字段（详情走 API）
ACT_STRIP = ["schedule", "guests", "description_en", "original_excerpt", "article_md", "additional_sources"]
DESC_MAX = 140          # 卡片摘要够用
EXH_INTRO_MAX = 60      # 展商列表摘要够用


def light_activity(a: dict) -> dict:
    o = {k: v for k, v in a.items() if k not in ACT_STRIP}
    d = o.get("description") or ""
    if len(d) > DESC_MAX:
        o["description"] = d[:DESC_MAX] + "…"
    o["has_detail"] = True   # 提示客户端：完整详情走 /api/activity/{id}
    # organizers 只留 name/role（去掉 name_en 等），已很轻，保留
    return o


def light_exhibitor(x: dict) -> dict:
    o = dict(x)
    for k in ("intro", "introduction", "business", "desc", "description", "profile"):
        v = o.get(k)
        if isinstance(v, str) and len(v) > EXH_INTRO_MAX:
            o[k] = v[:EXH_INTRO_MAX] + "…"
    o["has_detail"] = True
    return o


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def dump(name, obj):
    with open(os.path.join(LITE, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    if not os.path.isdir(DATA):
        print(f"缺全量数据目录 {DATA}", file=sys.stderr); sys.exit(1)
    os.makedirs(LITE, exist_ok=True)

    # activities → 精简
    acts = load("activities.json")
    arr = acts["activities"] if isinstance(acts, dict) else acts
    light = [light_activity(a) for a in arr]
    out = dict(acts); out["activities"] = light if isinstance(acts, dict) else None
    dump("activities.json", out if isinstance(acts, dict) else light)

    # exhibitors → 精简（简介截断）
    if os.path.exists(os.path.join(DATA, "exhibitors.json")):
        exh = load("exhibitors.json")
        earr = exh["exhibitors"] if isinstance(exh, dict) else exh
        elight = [light_exhibitor(x) for x in earr]
        eout = dict(exh); eout["exhibitors"] = elight if isinstance(exh, dict) else None
        dump("exhibitors.json", eout if isinstance(exh, dict) else elight)

    # themes / intel / manifest / VERSION → 原样复制（themes 是分面已很轻；intel 是资讯链接）
    for name in ("themes.json", "intel.json", "manifest.json"):
        src = os.path.join(DATA, name)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(LITE, name))

    # 体检
    sched_leak = sum(1 for a in light if a.get("schedule") or a.get("guests"))
    print(f"[make_light] 活动 {len(light)} 条 → data-lite/activities.json")
    print(f"  剥离校验：仍含 schedule/guests 的 = {sched_leak}（应为 0）")
    sizes = {}
    for name in ("activities.json", "exhibitors.json"):
        fu = os.path.join(DATA, name); fl = os.path.join(LITE, name)
        if os.path.exists(fu) and os.path.exists(fl):
            sizes[name] = (os.path.getsize(fu), os.path.getsize(fl))
    for name, (u, l) in sizes.items():
        print(f"  {name}: 全量 {u//1024}KB → 精简 {l//1024}KB（省 {100*(u-l)//u}%）")


if __name__ == "__main__":
    main()
