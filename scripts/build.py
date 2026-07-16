#!/usr/bin/env python3
"""
WAIC 2026 日程助手 · 数据构建脚本

把三个来源的原始数据合并成统一的数据库：
  官方   raw/official/forums_raw.json      —— WAIC 官网 API（174 场论坛/活动）
  公众号 raw/wechat/articles.json          —— 搜狗→wechat-article-extractor 下载（非官方）
  其他   raw/web/articles.json             —— Exa/Tavily 抓的非公众号渠道（非官方）

统一 schema 的每条记录都带 source_type（official/unofficial）+ source（channel/publisher/url），
官方与非官方一键可分。

输出 build-output/：
  VERSION
  data/activities.json    所有活动（官方+非官方，带来源）
  data/themes.json        类别/场馆/日期/标签 分面
  data/manifest.json      文件 sha256
  md/agenda/*.md          每场官方论坛一份详情（嘉宾+议程+主办）
  md/unofficial/*.md      每条非官方活动一份摘要（带来源出处）
  公众号文章/              下载的公众号原文 md + 图片（由下载阶段填充，这里只做索引）
  bundle.tar.gz           VERSION + data/ + md/ 全量压缩包

用法：
  python3 build.py [--proj <项目目录>] [--version YYYYMMDD-HHMM]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
from datetime import datetime
from pathlib import Path

# 大会日期 → day 序号
DAY_MAP = {"2026-07-17": 1, "2026-07-18": 2, "2026-07-19": 3, "2026-07-20": 4}
FRONT_FORUM_URL = "https://www.worldaic.com.cn/events/forum/{uuid}"


# ---------- 工具 ----------

def to_slug(name: str) -> str:
    """中英混合 → 简短 slug（保留中文）"""
    if not name:
        return "unknown"
    s = name.strip().replace(" ", "-").replace("/", "-").replace("\\", "-")
    s = re.sub(r"[^\w一-龥\-]", "", s)
    return s[:40] or "unknown"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def day_of(date_str: str):
    return DAY_MAP.get((date_str or "").strip())


def strip_html(html: str) -> str:
    if not html:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", html)
    s = re.sub(r"</p>", "\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
           .replace("&gt;", ">").replace("&quot;", '"').replace("&ldquo;", "“")
           .replace("&rdquo;", "”"))
    return re.sub(r"\n{3,}", "\n\n", s).strip()


# 场馆 → 片区（世博/张江/西岸三大片区）
VENUE_DISTRICT = {
    "世博中心": "世博片区", "世博展览馆": "世博片区", "世博滨江酒店": "世博片区",
    "上海世博桐森酒店": "世博片区",
    "张江科学会堂": "张江片区",
    "西岸国际会展中心": "西岸片区", "西岸穹顶艺术中心": "西岸片区",
    "徐汇西岸国际会展中心": "西岸片区", "徐汇会场": "西岸片区",
    "杨浦会场": "杨浦", "上海临港锦江国际酒店": "临港", "上海浦东嘉里酒店": "浦东",
}


def district_of(venue: str) -> str:
    return VENUE_DISTRICT.get((venue or "").strip(), "")


# track（板块）识别：从标题+英文名+主办+标签里认出 WAIC Young/Up/AI原住民/AI GRAVITY
def detect_track(text: str) -> str:
    raw = text or ""
    t = raw.lower().replace(" ", "").replace("!", "")
    if "waicyoung" in t:
        return "WAIC Young"
    if "waicup" in t:
        return "WAIC Up"
    if "原住民" in raw or "ainatives" in t:
        return "AI 原住民"
    if "aigravity" in t or "引力场" in raw:  # 引力场 = AI GRAVITY 计划中文名
        return "AI GRAVITY"
    return ""


# 活动权重：越高越靠前。超脑=我们自己的活动置顶；官方主场>主题>分论坛；官方合作边会>民间边会>资讯。
# 搜索/排序统一按 weight 降序 → 命中超脑时超脑排最前。
OFFICIAL_WEIGHT = {"全体会议": 92, "主题论坛": 75, "分论坛": 55, "同期活动": 45}


def compute_weight(kind: str, category: str, relation: str, is_superbrain: bool = False) -> int:
    if is_superbrain:
        return 100
    if kind == "exhibition_zone":
        return 82
    if kind == "official_program":
        return OFFICIAL_WEIGHT.get(category, 50)
    if kind == "side_event":
        return 60 if relation == "official" else 35
    if kind == "community":
        return 30
    if kind == "coverage":
        return 12
    return 20


# ---------- 官方来源 ----------

def build_guest_name_map(forums: list, global_guests: list) -> dict:
    """uuid → 展示名（name 优先，回退 leaderName）。用于议程 speechGuest 回填。"""
    m = {}
    def put(g):
        uid = g.get("uuid")
        nm = g.get("name") or g.get("leaderName") or ""
        if uid and nm:
            m[uid] = nm
    for f in forums:
        for g in (f.get("guestVisitList") or []):
            put(g)
    for g in (global_guests or []):
        put(g)
    return m


def norm_guest(g: dict) -> dict:
    return {
        "name": g.get("name") or g.get("leaderName") or "",
        "name_en": g.get("nameEn") or "",
        "company": g.get("company") or "",
        "position": g.get("position") or "",
        "bio": (g.get("introduce") or "").strip(),
    }


def norm_org(o: dict) -> dict:
    return {
        "name": o.get("name") or "",
        "name_en": o.get("nameEn") or "",
        # forumOrgStructureReqs.type: 1=主办/组委会, 2=承办
        "role": "主办" if o.get("type") == 1 else "承办",
    }


def norm_schedule(sl: list, guest_map: dict) -> list:
    out = []
    for s in (sl or []):
        speakers = []
        for uid in (s.get("speechGuest") or "").split(","):
            uid = uid.strip()
            if uid and uid in guest_map:
                speakers.append(guest_map[uid])
        out.append({
            "date": s.get("scheduleDate") or "",
            "start": s.get("startTime") or "",
            "end": s.get("endTime") or "",
            "session": s.get("sessionName") or "",
            "theme": (s.get("speechTheme") or "").strip(),
            "speakers": speakers,
        })
    # 按日期+起始时间排
    out.sort(key=lambda x: (x["date"], x["start"]))
    return out


def official_to_activity(f: dict, guest_map: dict) -> dict:
    uuid = f.get("uuid") or ""
    aid = "off-" + uuid[:10]
    date = f.get("forumDate") or ""
    guests = [norm_guest(g) for g in (f.get("guestVisitList") or [])]
    orgs = [norm_org(o) for o in (f.get("forumOrgStructureReqs") or [])]
    schedule = norm_schedule(f.get("scheduleList"), guest_map)
    tags = [t for t in (f.get("forumTagList") or []) if isinstance(t, str)]
    if f.get("forumTag") and f["forumTag"] not in tags:
        tags.append(f["forumTag"])
    official_url = FRONT_FORUM_URL.format(uuid=uuid)
    track = detect_track(" ".join(filter(None, [
        f.get("name"), f.get("nameEn"), " ".join(o["name"] for o in orgs), " ".join(tags)])))

    search_bits = [
        f.get("name"), f.get("nameEn"), f.get("desc"),
        f.get("forumAddr"), f.get("addr"), f.get("type"),
        " ".join(tags),
        " ".join(g["name"] for g in guests if g["name"]),
        " ".join(g["company"] for g in guests if g["company"]),
        " ".join(o["name"] for o in orgs if o["name"]),
        " ".join(s["theme"] for s in schedule if s["theme"]),
    ]
    return {
        "id": aid,
        "source_type": "official",
        "kind": "official_program",
        "source": {
            "channel": "waic-official-api",
            "publisher": "WAIC官方",
            "url": official_url,
            "retrieved_at": RETRIEVED_AT,
        },
        "waic_relation": "official",
        "title": f.get("name") or "",
        "title_en": f.get("nameEn") or "",
        "description": (f.get("desc") or "").strip(),
        "description_en": (f.get("descEn") or "").strip(),
        "date": date,
        "day": day_of(date),
        "start_time": f.get("startTime") or "",
        "end_time": f.get("endTime") or "",
        "venue": f.get("forumAddr") or "",
        "district": district_of(f.get("forumAddr")),
        "room": f.get("addr") or "",
        "category": f.get("type") or "",
        "track": track,
        "tags": tags,
        "registration_required": None,
        "registration_url": "",
        "price": "",
        "cover_img": f.get("coverImgUrl") or "",
        "organizers": orgs,
        "guests": guests,
        "participants": [],
        "schedule": schedule,
        "official_url": official_url,
        "article_md": "",
        "original_excerpt": "",
        "detail_md": f"md/agenda/{aid}-{to_slug(f.get('name'))}.md",
        "search_text": " ".join(filter(None, search_bits)).lower(),
        "weight": compute_weight("official_program", f.get("type") or "", "official"),
        "_sort_key": (day_of(date) or 99, f.get("startTime") or "99"),
    }


# ---------- 非官方来源（公众号 + 其他渠道）----------

def unofficial_to_activity(a: dict, channel: str, idx: int) -> dict:
    """
    a 来自 raw/wechat/articles.json 或 raw/web/articles.json，标准化字段：
      { title, publisher, date, url, summary, kind?,
        md_path?(公众号原文相对路径), source_site?, event_date?, event_venue? }
    kind: side_event（真实边会/周边活动）| coverage（关于 WAIC 的报道/资讯）
    """
    prefix = {"wechat": "wx", "web": "web", "extracted": "ext"}.get(channel, channel)
    aid = a.get("id") or f"{prefix}-{idx:03d}"
    date = a.get("event_date") or ""     # 从文中提取的活动日期
    md_path = a.get("md_path") or ""      # 公众号原文落地路径（相对 build-output）
    # kind: side_event 真实边会/周边活动 | coverage 报道资讯 | community 社群活动 | exhibition_zone 展区
    kind = a.get("kind") or ("side_event" if channel in ("web", "extracted") else "coverage")
    CAT = {"side_event": "边会·周边活动", "community": "社群联名活动",
           "exhibition_zone": "展区", "coverage": "媒体报道·资讯"}
    category = a.get("category") or CAT.get(kind, "边会·周边活动")
    waic_relation = a.get("waic_relation") or ("official" if kind == "exhibition_zone" else "affiliated")
    # 超脑 AI 原住民计划 = 与 WAIC 官方合作的青少年 AI 公益活动（非民间边会 / 非商业），标为官方；
    # 并补「超脑/教育/青少年/AI原住民」等关键词与标签，保证搜索能命中
    _t = a.get("title") or ""
    _is_superbrain = "超脑" in _t
    sb_keywords = ("超脑 超脑AI孵化器 SuperBrain AI教育 教育 教育科技 青少年 青少年AI 青少年人工智能 少儿 少儿编程 "
                   "亲子 亲子教育 家庭教育 家长 中小学 中学生 小学生 K12 10后 STEM 科创 创新素养 素养教育 "
                   "AI原住民 原住民计划"
                   if _is_superbrain else "")
    sb_tags = ["教育", "青少年", "AI 原住民"] if _is_superbrain else []
    if _is_superbrain and "原住民" in _t:
        waic_relation = "official"
    # organizers：既支持 [{name,role}] 也支持字符串 organizer
    orgs = a.get("organizers") or []
    if not orgs and a.get("organizer"):
        orgs = [{"name": a["organizer"], "name_en": "", "role": "主办"}]
    if a.get("co_brand"):
        orgs = orgs + [{"name": str(a["co_brand"]), "name_en": "", "role": "联名/合作"}]
    participants = a.get("participants") or []
    track = a.get("track") or detect_track((a.get("title") or "") + " " + (a.get("organizer") or ""))
    search_bits = [
        a.get("title"), a.get("summary") or a.get("description"), a.get("publisher"),
        a.get("source_site"), a.get("venue") or a.get("event_venue"), a.get("organizer"),
        a.get("target_audience"), track, sb_keywords,
        " ".join(p if isinstance(p, str) else p.get("name", "") for p in participants),
    ]
    source = {
        "channel": channel,               # wechat | web | extracted
        "publisher": a.get("publisher") or a.get("source_site") or "",
        "url": a.get("url") or a.get("source_url") or (a.get("source") or {}).get("url", ""),
        "published_date": a.get("date") or "",
        "retrieved_at": RETRIEVED_AT,
    }
    if isinstance(a.get("source"), dict):
        source["publisher"] = source["publisher"] or a["source"].get("publisher", "")
        source["article_title"] = a["source"].get("article_title", "")
    if a.get("sogou_url"):
        source["sogou_url"] = a["sogou_url"]
    download_status = "done" if md_path else ("pending" if channel == "wechat" and kind == "coverage" else "n/a")
    return {
        "id": aid,
        "source_type": "unofficial",
        "kind": kind,
        "waic_relation": waic_relation,
        "download_status": download_status,
        # 无任何来源链接（含搜狗）→ 无法核验，前端可标「待核实」并降低排序权重
        "unverified": not (source.get("url") or source.get("sogou_url")),
        "source": source,
        "title": a.get("title") or "",
        "title_en": "",
        "description": (a.get("description") or a.get("summary") or "").strip(),
        "description_en": "",
        "date": date,
        "day": day_of(date),
        "start_time": a.get("event_time") or a.get("start_time") or "",
        "end_time": a.get("end_time") or "",
        "venue": a.get("venue") or a.get("event_venue") or "",
        "district": district_of(a.get("venue") or a.get("event_venue") or ""),
        "room": a.get("room") or "",
        "category": category,
        "track": track,
        "tags": (a.get("tags") or []) + sb_tags,
        "registration_required": a.get("registration_required"),
        "registration_url": a.get("registration_url") or "",
        "price": a.get("price") or "",
        "cover_img": a.get("cover_img") or "",
        "organizers": orgs,
        "guests": [],
        "participants": participants,
        "schedule": [],
        "official_url": "",
        "article_md": md_path,            # 公众号原文（如已下载）
        "original_excerpt": a.get("original_excerpt") or "",
        "detail_md": f"md/unofficial/{aid}-{to_slug(a.get('title'))}.md",
        "search_text": " ".join(filter(None, [s for s in search_bits if isinstance(s, str)])).lower(),
        "weight": compute_weight(kind, category, waic_relation, _is_superbrain),
        "_sort_key": (day_of(date) or 99, a.get("event_time") or a.get("start_time") or "99"),
    }


def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"     ⚠ 读取 {path} 失败：{e}")
    return default


# ---------- 展区（4 片区场馆）----------

def exhibition_zone_to_activity(area: dict, enrich: dict | None = None) -> dict:
    detail = area.get("detail") or {}
    enrich = enrich or {}
    title = area.get("title") or detail.get("title") or ""
    uuid = area.get("uuid") or detail.get("uuid") or ""
    desc = strip_html(detail.get("introduction") or "")
    # 亮点/H1-H4/地图 由 enrich（研究员产出 raw/official/zones_enrich.json）补充
    highlights = enrich.get("highlights") or []
    halls = enrich.get("halls") or []
    hall_txt = " ".join(f"{h.get('hall','')} {h.get('theme','')}" for h in halls)
    return {
        "id": "zone-" + (uuid[:10] or to_slug(title)),
        "source_type": "official", "kind": "exhibition_zone", "waic_relation": "official",
        "source": {"channel": "waic-official-api", "publisher": "WAIC官方",
                   "url": "https://www.worldaic.com.cn/", "retrieved_at": RETRIEVED_AT},
        "title": title, "title_en": detail.get("titleEn") or area.get("titleEn") or "",
        "description": desc, "description_en": strip_html(detail.get("introductionEn") or ""),
        "date": "", "day": None, "start_time": "", "end_time": "",
        "venue": title, "district": district_of(title), "room": "",
        "category": "展区", "track": "", "tags": [],
        "registration_required": None, "registration_url": "", "price": "",
        "cover_img": detail.get("coverUrl") or "",
        # —— 展区增强字段 ——
        "address": enrich.get("address") or "",
        "transit": enrich.get("transit") or "",
        "highlights": highlights,
        "highlights_sources": enrich.get("sources") or [],
        "halls": halls,
        "map_images": enrich.get("map_images") or [],
        "organizers": [], "guests": [], "participants": [], "schedule": [],
        "official_url": "https://www.worldaic.com.cn/", "article_md": "", "original_excerpt": "",
        "detail_md": f"md/agenda/zone-{to_slug(title)}.md",
        "search_text": (title + " " + desc + " 展区 " + district_of(title) + " "
                        + " ".join(highlights) + " " + hall_txt).lower(),
        "weight": compute_weight("exhibition_zone", "展区", "official"),
        "_sort_key": (0, "00"),  # 展区排最前
    }


# ---------- 参展商（单独一份 data/exhibitors.json，不进 activities）----------

def _logo_url(logos):
    if isinstance(logos, list) and logos:
        x = logos[0]
        if isinstance(x, str):
            return x
        if isinstance(x, dict):
            for k in ("attachmentPath", "url", "logoUrl", "fileUrl", "imgUrl", "path", "temporaryUrl"):
                if x.get(k):
                    return x[k]
    return ""


def build_exhibitors(raw_exh: dict) -> dict:
    exs = raw_exh.get("exhibitors") or []
    out = []
    for e in exs:
        booths = []
        for b in (e.get("booths") or []):
            if isinstance(b, dict):
                booths.append({
                    "no": b.get("boothNumber") or "",
                    "hall": b.get("boothLocationName") or "",      # 如 世博展览馆H4
                    "venue": b.get("boothVenueName") or "",         # 如 世博展览馆
                    "district": district_of(b.get("boothVenueName") or ""),
                })
        out.append({
            "id": e.get("enterpriseCode") or to_slug(e.get("enterpriseName")),
            "name": e.get("enterpriseName") or "",
            "name_en": e.get("enterpriseNameEn") or "",
            "logo": _logo_url(e.get("enterpriseLogos")),
            "booths": booths,
            "halls": sorted({b["hall"] for b in booths if b["hall"]}),
            "industry": e.get("industryLevelOneName") or "",
            "business_scope": e.get("businessScope") or "",
            "partner_level": e.get("partnerLevelName") or "",
            "role": e.get("roleName") or "展商",
            "intro": (e.get("enterpriseIntroductionCn") or "").strip(),
            "search_text": " ".join(filter(None, [
                e.get("enterpriseName"), e.get("enterpriseNameEn"),
                e.get("industryLevelOneName"), e.get("businessScope"),
                e.get("enterpriseIntroductionCn"),
                " ".join(b["hall"] for b in booths),
            ])).lower(),
        })
    # 分面
    def facet(keyfn):
        c = {}
        for x in out:
            for k in keyfn(x):
                if k:
                    c[k] = c.get(k, 0) + 1
        return [{"name": k, "count": v} for k, v in sorted(c.items(), key=lambda i: -i[1])]
    return {
        "total": len(out),
        "facets": {
            "halls": facet(lambda x: x["halls"]),
            "industries": facet(lambda x: [x["industry"]]),
            "roles": facet(lambda x: [x["role"]]),
        },
        "exhibitors": out,
    }


# ---------- md 生成 ----------

def official_md(a: dict) -> str:
    L = [f"# {a['title']}"]
    if a.get("title_en"):
        L.append(f"*{a['title_en']}*")
    L.append("")
    L.append("> **来源**：WAIC 官方（世界人工智能大会官网） · `source_type: official`")
    L.append(f"> 官方详情页：<{a['official_url']}>")
    L.append("")
    L.append("## 基本信息")
    L.append("")
    if a.get("date"):
        L.append(f"- **时间**：Day {a.get('day','?')} · {a['date']} {a.get('start_time','')}–{a.get('end_time','')}")
    if a.get("venue"):
        loc = a["venue"] + (f" · {a['room']}" if a.get("room") else "")
        L.append(f"- **地点**：{loc}")
    if a.get("category"):
        L.append(f"- **类别**：{a['category']}")
    if a.get("tags"):
        L.append(f"- **主题标签**：{' / '.join(a['tags'])}")
    L.append(f"- **官方链接**：<{a['official_url']}>")
    L.append("")
    if a.get("description"):
        L.append("## 简介")
        L.append("")
        L.append(a["description"])
        L.append("")
    if a.get("organizers"):
        L.append("## 主办 / 承办")
        L.append("")
        for o in a["organizers"]:
            L.append(f"- **{o['role']}**：{o['name']}")
        L.append("")
    if a.get("schedule"):
        L.append("## 议程")
        L.append("")
        for s in a["schedule"]:
            t = f"{s['start']}–{s['end']}" if s.get("start") else ""
            head = f"- **{t}** {s.get('session','')}".rstrip()
            if s.get("theme"):
                head += f"：{s['theme']}"
            L.append(head)
            if s.get("speakers"):
                L.append(f"  - 演讲人：{' · '.join(s['speakers'])}")
        L.append("")
    if a.get("guests"):
        L.append(f"## 嘉宾（{len(a['guests'])} 位）")
        L.append("")
        for g in a["guests"]:
            line = f"- **{g['name']}**" if g["name"] else "- （待定）"
            meta = " · ".join(filter(None, [g.get("company"), g.get("position")]))
            if meta:
                line += f" — {meta}"
            L.append(line)
            if g.get("bio"):
                L.append(f"  - {g['bio'][:200]}")
        L.append("")
    L.append("---")
    L.append("")
    L.append("*数据来源：WAIC 官网 API · 本文件由 build.py 自动生成*")
    return "\n".join(L)


def unofficial_md(a: dict) -> str:
    src = a["source"]
    L = [f"# {a['title']}"]
    L.append("")
    L.append(f"> **来源**：{'微信公众号' if src['channel']=='wechat' else '网络渠道'} · `source_type: unofficial`")
    L.append(f"> 发布方：{src.get('publisher','')}" + (f" · {src.get('published_date','')}" if src.get('published_date') else ""))
    L.append(f"> 原文：<{src.get('url','')}>")
    L.append("")
    if a.get("date") or a.get("venue"):
        L.append("## 活动信息（从报道中提取，供参考）")
        L.append("")
        if a.get("date"):
            L.append(f"- **时间**：{a['date']} {a.get('start_time','')}")
        if a.get("venue"):
            L.append(f"- **地点**：{a['venue']}")
        L.append("")
    if a.get("description"):
        L.append("## 摘要")
        L.append("")
        L.append(a["description"])
        L.append("")
    if a.get("article_md"):
        L.append(f"> 📄 公众号原文全文已下载：`{a['article_md']}`")
        L.append("")
    L.append("---")
    L.append("")
    L.append("*非官方来源，信息以官方发布为准 · 本文件由 build.py 自动生成*")
    return "\n".join(L)


# ---------- themes.json ----------

def build_themes(activities: list) -> dict:
    def facet(key_fn):
        counts = {}
        for a in activities:
            for k in key_fn(a):
                if k:
                    counts[k] = counts.get(k, 0) + 1
        return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])]

    return {
        "source_types": [
            {"name": "official", "label": "官方日程",
             "count": sum(1 for a in activities if a["source_type"] == "official")},
            {"name": "unofficial", "label": "周边·民间活动",
             "count": sum(1 for a in activities if a["source_type"] == "unofficial")},
        ],
        "waic_relations": facet(lambda a: [a.get("waic_relation")]),
        "kinds": facet(lambda a: [a.get("kind")]),
        "categories": facet(lambda a: [a.get("category")]),
        "tracks": facet(lambda a: [a.get("track")]),
        "districts": facet(lambda a: [a.get("district")]),
        "venues": facet(lambda a: [a.get("venue")]),
        "days": facet(lambda a: [f"Day {a['day']} · {a.get('date')}" if a.get("day") else None]),
        "tags": facet(lambda a: a.get("tags") or []),
        "channels": facet(lambda a: [a["source"].get("channel")]),
    }


# ---------- 边会去重 + 情报库 ----------

def _sig(title: str) -> str:
    """标题归一化核心名，用于跨源去重。
    去 WAIC/年份 → 剥主办方前缀（“商汤科技·基座大模型…” → “基座大模型…”）
    → 去英文/数字（副标题、编号），保留括号内中文（区分“青春与锋芒/深耕与守望”等场次）。"""
    t = (title or "").strip()
    t = re.sub(r"(WAIC\s*2026|2026\s*WAIC|WAIC2026|2026WAIC|WAIC)", "", t, flags=re.I)
    for sep in ("·", "｜", "|"):
        if sep in t:
            cand = max(t.split(sep), key=len)          # 主办前缀通常较短，取最长段为核心名
            if len(re.sub(r"[^一-鿿]", "", cand)) >= 6:
                t = cand
            break
    t = re.sub(r"[A-Za-z0-9]+", "", t)
    t = re.sub(r"[\s\W_（）()「」·、,.:：|｜—\-《》【】“”\"'!！?？~～]+", "", t)
    return t.lower()


# 人工核对过的边会近似重复组：同组任一关键子串命中即视同一活动。
# （机械模糊匹配会把“XX之夜（同后缀）”这类系列误并，故长尾用白名单显式处理）
SIDE_DUP_GROUPS = [
    ["阿里云主题论坛"],
    ["智启具身论坛"],
    ["清华科创夜", "清华朋友圈"],
    ["文客松"],
    ["穿越者之夜"],
    ["思想者论坛"],          # 3 条系列概览重复（6 个具名专场已并入官方）
    ["100 AI Founders"],    # 3 条同一场 Private Dinner 的不同措辞
]

# 人工核对：标题差异过大、机械去重抓不到，但确为官方论坛重复描述的边会。
# （边会标题需全部包含左侧关键词）→ 归入右侧官方论坛（核心名匹配）。
CURATED_SIDE_TO_OFFICIAL = [
    (("Datawhale", "线下论坛"), "心智与智能青年生态论坛"),  # 三条“具体名称未披露”占位，实为该官方论坛
    (("全球治理高级别会议",), "2026世界人工智能大会暨人工智能全球治理高级别会议主论坛"),  # 主论坛重复
    (("主论坛", "下午场"), "2026世界人工智能大会暨人工智能全球治理高级别会议主论坛"),
]


def _dedup_key(title: str) -> str:
    """边会内去重键：先查人工白名单组，否则回退归一化核心名。"""
    t = title or ""
    for i, grp in enumerate(SIDE_DUP_GROUPS):
        if any(kw in t for kw in grp):
            return f"__sidegrp{i}"
    return _sig(title)


def dedup_side_events(acts: list) -> list:
    """按标题签名去重，重复项把来源合并进 additional_sources、并补空字段。"""
    kept, index = [], {}
    for a in acts:
        k = _dedup_key(a.get("title"))
        if k and k in index:
            base = index[k]
            u = (a.get("source") or {}).get("url")
            if u and u != (base.get("source") or {}).get("url"):
                base.setdefault("additional_sources", []).append(
                    {"publisher": a["source"].get("publisher"), "url": u})
            for fld in ("date", "day", "venue", "start_time", "registration_url",
                        "price", "description", "cover_img", "track"):
                if not base.get(fld) and a.get(fld):
                    base[fld] = a[fld]
            if base.get("registration_required") is None and a.get("registration_required") is not None:
                base["registration_required"] = a["registration_required"]
            for p in (a.get("participants") or []):
                if p not in base.get("participants", []):
                    base.setdefault("participants", []).append(p)
        else:
            if k:
                index[k] = a
            kept.append(a)
    return kept


def to_intel_record(a: dict, channel: str) -> dict:
    """资讯素材记录（不是活动）：保留出处 + 原文链接。"""
    return {
        "title": a.get("title") or "",
        "channel": channel,                        # wechat | web
        "publisher": a.get("account") or a.get("publisher") or a.get("source_site") or "",
        "date": a.get("date") or "",
        "summary": a.get("snippet") or a.get("summary") or "",
        "url": a.get("url") or "",
        "sogou_url": a.get("sogou_url") or "",
        "article_md": a.get("md_path") or "",      # 已下载全文（少数）
    }


# ---------- 主流程 ----------

def build_manifest(out_dir: Path, version: str) -> dict:
    files = {}
    v = out_dir / "VERSION"
    if v.is_file():
        files["VERSION"] = {"sha256": sha256_of_file(v), "size": v.stat().st_size}
    for subdir in ["data", "md"]:
        sub = out_dir / subdir
        if not sub.exists():
            continue
        for root, _, filenames in os.walk(sub):
            for fn in filenames:
                if fn == "manifest.json":
                    continue
                full = Path(root) / fn
                rel = full.relative_to(out_dir).as_posix()
                files[rel] = {"sha256": sha256_of_file(full), "size": full.stat().st_size}
    return {
        "version": version,
        "last_updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "files": files,
    }


def main():
    global RETRIEVED_AT
    parser = argparse.ArgumentParser()
    default_proj = Path(__file__).resolve().parent.parent
    parser.add_argument("--proj", default=str(default_proj))
    parser.add_argument("--version", default=None)
    args = parser.parse_args()

    proj = Path(args.proj)
    raw = proj / "raw"
    out = proj / "build-output"
    version = args.version or datetime.now().strftime("%Y%m%d-%H%M")
    RETRIEVED_AT = datetime.now().strftime("%Y-%m-%d")

    print("====== WAIC 2026 日程助手 · 数据构建 ======")
    print(f"  proj:    {proj}")
    print(f"  version: {version}\n")

    out_data = out / "data"
    out_agenda = out / "md" / "agenda"
    out_unoff = out / "md" / "unofficial"
    for d in (out_data, out_agenda, out_unoff):
        d.mkdir(parents=True, exist_ok=True)

    activities = []

    def pick_channel(a):
        url = (a.get("url") or a.get("source_url") or
               (a.get("source") or {}).get("url", "") or "")
        return "wechat" if "mp.weixin.qq.com" in url else "web"

    # 1. 官方论坛/活动
    print("[1] 官方论坛/活动...")
    forums = load_json(raw / "official" / "forums_raw.json", [])
    global_guests = load_json(raw / "official" / "guests_global.json", [])
    if isinstance(global_guests, dict):
        global_guests = global_guests.get("list") or global_guests.get("data") or []
    guest_map = build_guest_name_map(forums, global_guests)
    for f in forums:
        activities.append(official_to_activity(f, guest_map))
    print(f"     {len(forums)} 场官方 · 嘉宾名映射 {len(guest_map)} 人")

    # 1b. 展区（4 片区场馆）—— 官方介绍/大图在 areaDetails；地址/交通/亮点/H1-H4 由 zones_enrich.json 补充
    exh_raw = load_json(raw / "official" / "exhibitions.json", {})
    areas = exh_raw.get("areas") or {}
    area_items = list(areas.values()) if isinstance(areas, dict) else areas
    area_details = exh_raw.get("areaDetails") or {}
    zones_enrich = load_json(raw / "official" / "zones_enrich.json", {})  # {venue: {address,transit,highlights,halls,map_images,sources}}
    for area in area_items:
        uuid = area.get("uuid") or ""
        det = (area_details.get(uuid) or {}).get("detail") or {}
        merged = {**area, "detail": det}
        activities.append(exhibition_zone_to_activity(merged, zones_enrich.get(area.get("title", ""))))
    print(f"     {len(area_items)} 个展区（介绍 {sum(1 for a in area_items if (area_details.get(a.get('uuid','')) or {}).get('detail'))} 带官方简介，{len(zones_enrich)} 带增强）")

    # 2. 边会/周边/社群/上海同期 + 从资讯抽取的活动 → 汇总后去重
    print("[2] 边会/周边/社群/抽取活动...")
    def as_list(x):
        if isinstance(x, list):
            return x
        if isinstance(x, dict):
            return x.get("activities") or x.get("events") or x.get("list") or []
        return []
    web_all = as_list(load_json(raw / "web" / "articles.json", []))
    web_side = [a for a in web_all if a.get("kind") == "side_event"]
    web_cov = [a for a in web_all if a.get("kind") != "side_event"]   # coverage → intel
    community = as_list(load_json(raw / "web" / "community_events.json", []))
    shanghai = as_list(load_json(raw / "web" / "shanghai_events.json", []))
    ext_web = load_json(raw / "extracted" / "web_coverage.json", {})
    ext_wx = load_json(raw / "extracted" / "wechat_triage.json", {})
    ext_cimi = load_json(raw / "extracted" / "cimidata_activities.json", {})
    ext_web_acts = (ext_web.get("activities") if isinstance(ext_web, dict) else ext_web) or []
    ext_wx_acts = (ext_wx.get("activities") if isinstance(ext_wx, dict) else ext_wx) or []
    ext_cimi_acts = (ext_cimi.get("activities") if isinstance(ext_cimi, dict) else ext_cimi) or []

    side_raw = web_side + community + shanghai + ext_web_acts + ext_wx_acts + ext_cimi_acts
    side_acts = []
    for i, a in enumerate(side_raw, 1):
        side_acts.append(unofficial_to_activity(a, pick_channel(a), i))
    before = len(side_acts)
    side_acts = dedup_side_events(side_acts)
    # 跨官方去重：与官方论坛同名/同实的抽取活动，并入官方 additional_sources，不重复列进边会。
    # 匹配三档：① 归一化核心名相等 ② 官方核心名(≥8)作为子串出现在边会核心名里 ③ 人工核对映射。
    off_index = {}
    for a in activities:
        if a["source_type"] == "official" and a.get("kind") == "official_program":
            k = _sig(a["title"])
            if len(k) >= 6:
                off_index.setdefault(k, a)

    def match_official(side_title):
        k = _sig(side_title)
        if len(k) >= 6 and k in off_index:
            return off_index[k]
        if len(k) >= 8:
            for ok, oa in off_index.items():
                if len(ok) >= 8 and ok in k:      # 官方规范名完整出现在边会标题核心里
                    return oa
        for kws, off_core in CURATED_SIDE_TO_OFFICIAL:
            if all(kw in (side_title or "") for kw in kws):
                oa = off_index.get(_sig(off_core))
                if oa:
                    return oa
        return None

    final_side, merged_off = [], 0
    for s in side_acts:
        off = match_official(s.get("title"))
        if off:
            u = (s.get("source") or {}).get("url")
            if u and u != off.get("official_url"):
                off.setdefault("additional_sources", []).append(
                    {"publisher": s["source"].get("publisher"), "url": u})
            merged_off += 1
        else:
            final_side.append(s)
    activities.extend(final_side)
    print(f"     边会/社群/上海/抽取 {before} → 边会内去重 {len(side_acts)} → 去官方重 {merged_off} → 最终 {len(final_side)} 条")

    # 3. 资讯（公众号 + web 报道）→ 情报库 intel.json（素材，不算活动）
    wx_articles = load_json(raw / "wechat" / "articles.json", [])
    promoted = {_sig(a.get("title")) for a in (ext_web_acts + ext_wx_acts + ext_cimi_acts)}
    intel = []
    for a in wx_articles:
        if _sig(a.get("title")) not in promoted:
            intel.append(to_intel_record(a, "wechat"))
    for a in web_cov:
        if _sig(a.get("title")) not in promoted:
            intel.append(to_intel_record(a, "web"))
    (out_data / "intel.json").write_text(json.dumps({
        "version": version, "total": len(intel),
        "_note": "WAIC 相关资讯/报道/攻略素材（非活动）。活动已从中抽取进 activities.json；此处保留出处与原文链接。",
        "articles": intel,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[3] 情报库 intel.json：{len(intel)} 篇资讯素材")

    # 排序 + 落 activities.json
    activities.sort(key=lambda a: a["_sort_key"])
    for a in activities:
        a.pop("_sort_key", None)
    n_off = sum(1 for a in activities if a["source_type"] == "official")
    n_un = len(activities) - n_off
    (out_data / "activities.json").write_text(json.dumps({
        "version": version,
        "total": len(activities),
        "official_count": n_off,
        "unofficial_count": n_un,
        "activities": activities,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[4/5] activities.json：{len(activities)} 条（官方 {n_off} / 非官方 {n_un}）")

    # 4b. 参展商（单独文件）
    exhibitors = build_exhibitors(exh_raw if isinstance(exh_raw, dict) and exh_raw.get("exhibitors")
                                  else load_json(raw / "official" / "exhibitors.json", {}))
    (out_data / "exhibitors.json").write_text(
        json.dumps(exhibitors, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"     参展商 {exhibitors['total']} 家 → data/exhibitors.json")

    # themes.json
    themes = build_themes(activities)
    themes["exhibitor_total"] = exhibitors["total"]
    themes["exhibitor_facets"] = exhibitors["facets"]
    (out_data / "themes.json").write_text(
        json.dumps(themes, ensure_ascii=False, indent=2), encoding="utf-8")

    # md
    for a in activities:
        if a["source_type"] == "official":
            fname = out / a["detail_md"]
            fname.write_text(official_md(a), encoding="utf-8")
        else:
            fname = out / a["detail_md"]
            fname.write_text(unofficial_md(a), encoding="utf-8")

    # 公众号文章库索引（从 intel 里的 wechat 资讯生成）
    wx_arts = [a for a in intel if a.get("channel") == "wechat"]
    if wx_arts:
        art_dir = out / "公众号文章"
        art_dir.mkdir(parents=True, exist_ok=True)
        idx = ["# 公众号文章库索引", "",
               f"WAIC 2026 相关公众号文章 {len(wx_arts)} 篇（搜狗微信搜索发现，作为资讯素材）。",
               "全文下载受搜狗 antispider 限流；`✅` 表示已下载全文，`⏳` 表示仅有标题/摘要/出处。", "",
               "| # | 状态 | 标题 | 公众号 | 日期 |", "|---|---|---|---|---|"]
        for i, a in enumerate(sorted(wx_arts, key=lambda x: x.get("date") or "", reverse=True), 1):
            st = "✅" if a.get("article_md") else "⏳"
            idx.append(f"| {i} | {st} | {a['title']} | {a.get('publisher','')} | {a.get('date','')} |")
        (art_dir / "INDEX.md").write_text("\n".join(idx), encoding="utf-8")
        print(f"     公众号文章库索引：{len(wx_arts)} 篇 → 公众号文章/INDEX.md")

    # VERSION + manifest + bundle
    print("[5/5] VERSION + manifest + bundle.tar.gz...")
    (out / "VERSION").write_text(version + "\n", encoding="utf-8")
    manifest = build_manifest(out, version)
    (out_data / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    bundle = out / "bundle.tar.gz"
    with tarfile.open(bundle, "w:gz") as tar:
        tar.add(out / "VERSION", arcname="VERSION")
        tar.add(out_data, arcname="data")
        tar.add(out / "md", arcname="md")
    print(f"     bundle.tar.gz {bundle.stat().st_size // 1024} KB\n")
    print("====== ✓ 构建完成 ======")
    print(f"  官方 {n_off} · 非官方 {n_un} · 合计 {len(activities)}")


if __name__ == "__main__":
    RETRIEVED_AT = datetime.now().strftime("%Y-%m-%d")
    main()
