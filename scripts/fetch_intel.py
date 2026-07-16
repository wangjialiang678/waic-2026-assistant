#!/usr/bin/env python3
"""
fetch_intel.py — Tier 4 资讯采集（每 2h，由 refresh_and_deploy.sh 调用，06:00–24:00）。

公网搜索 WAIC 相关新闻/文章（重点覆盖官方公众号 mp.weixin.qq.com 与官网报道），
归一化后**追加**进 raw/web/articles.json（kind="coverage"）→ 下一步 build.py 自动并入
intel.json 情报库 → 前端「情报站」与每日 digest 可见。

- 搜索后端：Tavily（TAVILY_API_KEY，放 ~/waic-refresh/.env）。南京机已实测可达。
- 只追加不覆盖；按 URL + 归一化标题双重去重（对全部 raw 已知 URL）。
- 任何失败（无 key / 网络 / 限额）→ exit 0 降级跳过，绝不 block 数据管线。
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARTICLES = ROOT / "raw" / "web" / "articles.json"
KNOWN_SOURCES = [
    ROOT / "raw" / "web" / "articles.json",
    ROOT / "raw" / "extracted" / "web_coverage.json",
    ROOT / "raw" / "extracted" / "wechat_triage.json",
    ROOT / "build-output" / "data" / "intel.json",
]

QUERIES = [
    # (query, include_domains, days)
    ("WAIC 2026 世界人工智能大会 新闻 活动", None, 1),
    ("世界人工智能大会 WAIC", ["mp.weixin.qq.com"], 2),   # 公众号（含官方公众号）
    ("WAIC 2026 世界人工智能大会", ["worldaic.com.cn", "news.cn", "thepaper.cn", "sina.com.cn"], 1),
]
MUST_MATCH = re.compile(r"WAIC|世界人工智能大会|人工智能大会", re.I)
OWN_DOMAINS = ("superbrain-ai.com",)


def norm_title(t: str) -> str:
    return re.sub(r"[\s\W]+", "", (t or "").lower())[:60]


def collect_known():
    urls, titles = set(), set()
    for p in KNOWN_SOURCES:
        try:
            d = json.loads(p.read_text())
        except Exception:
            continue
        stack = [d]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                u = x.get("url") or (x.get("source") or {}).get("url") if isinstance(x.get("source"), dict) else x.get("url")
                if isinstance(u, str) and u.startswith("http"):
                    urls.add(u.split("#")[0])
                t = x.get("title") or x.get("article_title")
                if t:
                    titles.add(norm_title(t))
                stack.extend(x.values())
            elif isinstance(x, list):
                stack.extend(x)
    return urls, titles


def tavily(query, domains, days, key):
    body = {"api_key": key, "query": query, "topic": "news", "days": days,
            "max_results": 10, "search_depth": "basic"}
    if domains:
        body["include_domains"] = domains
    req = urllib.request.Request(
        "https://api.tavily.com/search",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read()).get("results", [])


# ---- cimidata（次幂）微信搜一搜：拿真 mp.weixin.qq.com 文章链，替代搜狗断链 ----
CIMI_HOST = "https://www.cimidata.com/"
CIMI_QUERIES = ["WAIC 2026 世界人工智能大会", "世界人工智能大会 上海", "WAIC 2026"]


def _cimi_env():
    aid = os.environ.get("CIMI_APP_ID", "")
    sec = os.environ.get("CIMI_APP_SECRET", "")
    if not (aid and sec):
        env = ROOT / ".env"
        if env.is_file():
            t = env.read_text()
            ma = re.search(r"^CIMI_APP_ID=(.+)$", t, re.M)
            ms = re.search(r"^CIMI_APP_SECRET=(.+)$", t, re.M)
            aid = aid or (ma.group(1).strip() if ma else "")
            sec = sec or (ms.group(1).strip() if ms else "")
    return aid, sec


def cimi_token(aid, sec):
    req = urllib.request.Request(
        CIMI_HOST + "api/token",
        data=json.dumps({"app_id": aid, "app_secret": sec}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["data"]["access_token"]


def cimi_search(keyword, token, page=1):
    req = urllib.request.Request(
        CIMI_HOST + "api/v3/articles/search?access_token=" + urllib.parse.quote(token),
        data=json.dumps({"keyword": keyword, "page": page}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read()).get("data") or {}
    return d.get("items") or []


def collect_cimi(known_urls, known_titles):
    """微信搜一搜 → 真链文章列表（跳过已知/搜狗/自家域）。失败降级返回 []。"""
    aid, sec = _cimi_env()
    if not (aid and sec):
        print("[fetch_intel] 无 CIMI 凭证，跳过微信搜一搜")
        return []
    try:
        token = cimi_token(aid, sec)
    except Exception as e:  # noqa: BLE001
        print(f"[fetch_intel] cimidata token 失败: {e}")
        return []
    out = []
    for kw in CIMI_QUERIES:
        try:
            items = cimi_search(kw, token)
        except Exception as e:  # noqa: BLE001
            print(f"[fetch_intel] cimi 搜索失败({kw}): {e}")
            continue
        for it in items:
            url = (it.get("content_url") or "").split("#")[0]
            title = re.sub(r"<[^>]+>", "", it.get("title") or "").strip()
            if not url or not title or "sogou.com" in url:
                continue
            if any(d in url for d in OWN_DOMAINS):
                continue
            if url in known_urls or norm_title(title) in known_titles:
                continue
            known_urls.add(url)
            known_titles.add(norm_title(title))
            out.append({
                "title": title,
                "kind": "coverage",
                "publisher": it.get("nickname") or "微信公众号",
                "date": (it.get("published_at") or "")[:10],
                "summary": "",
                "url": url,
                "auto_collected": True,
                "source_api": "cimidata",
                "collected_at": datetime.now().strftime("%F %T"),
            })
    return out


def main():
    key = os.environ.get("TAVILY_API_KEY", "")
    if not key:
        env = ROOT / ".env"
        if env.is_file():
            m = re.search(r"^TAVILY_API_KEY=(.+)$", env.read_text(), re.M)
            if m:
                key = m.group(1).strip()
    known_urls, known_titles = collect_known()
    try:
        data = json.loads(ARTICLES.read_text()) if ARTICLES.is_file() else []
    except Exception:
        print("[fetch_intel] articles.json 损坏，跳过（不冒险覆盖）")
        return 0
    if not isinstance(data, list):
        print("[fetch_intel] articles.json 非列表，跳过")
        return 0

    added = []
    # 源①：cimidata 微信搜一搜（真 mp.weixin 链）
    added.extend(collect_cimi(known_urls, known_titles))

    # 源②：Tavily（官网/主流媒体报道）；无 key 则只用 cimidata
    for q, domains, days in (QUERIES if key else []):
        try:
            results = tavily(q, domains, days, key)
        except Exception as e:  # noqa: BLE001
            print(f"[fetch_intel] 查询失败({q[:20]}…): {e}")
            continue
        for r in results:
            url = (r.get("url") or "").split("#")[0]
            title = (r.get("title") or "").strip()
            snippet = (r.get("content") or "")[:220]
            if not url or not title:
                continue
            if any(d in url for d in OWN_DOMAINS):
                continue
            if not MUST_MATCH.search(title + " " + snippet):
                continue
            if url in known_urls or norm_title(title) in known_titles:
                continue
            known_urls.add(url)
            known_titles.add(norm_title(title))
            pub = re.sub(r"^www\.", "", url.split("/")[2]) if "/" in url else ""
            added.append({
                "title": title,
                "kind": "coverage",                       # 非活动 → build 并入 intel
                "publisher": r.get("source") or pub,
                "date": (r.get("published_date") or "")[:10],
                "summary": snippet,
                "url": url,
                "auto_collected": True,
                "collected_at": datetime.now().strftime("%F %T"),
            })

    if added:
        data.extend(added)
        ARTICLES.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print(f"[fetch_intel] 新增 {len(added)} 篇（现共 {len(data)} 条 raw 文章）")
    for a in added[:10]:
        print(f"  + [{a['publisher']}] {a['title'][:44]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
