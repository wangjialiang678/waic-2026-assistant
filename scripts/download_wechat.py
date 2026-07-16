#!/usr/bin/env python3
"""
公众号全文下载（补全阶段）—— 全程走 wechat-article-extractor skill，不用 Exa/Tavily。

⚠️ 何时能用：搜狗 /link 解析对 antispider 很敏感。若上一次搜索/解析刚触发 antispider，
   必须等 ≥30 分钟冷却再跑本脚本，否则一上来就被拦。

做什么：
  对一批 WAIC 相关查询词，用 skill 的「新会话搜索 + 同会话 --resolve」拿真实 mp.weixin URL
  （同会话 cookie 最稳），再用 wechat-article-to-markdown 逐篇下载到 build-output/公众号文章/。
  串行 + 间隔，撞 antispider/CAPTCHA 立即整轮停止。
  产物 raw/wechat/downloaded.json（title/account/date/real_url/md_path），
  之后跑 normalize_wechat.py + build.py 即把全文并入库、升级对应条目。

用法：
  python3 download_wechat.py                 # 用内置查询词
  python3 download_wechat.py --max 30        # 最多下 30 篇后停
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

PROJ = Path(__file__).resolve().parent.parent
OUT_DIR = PROJ / "build-output" / "公众号文章"
DL_JSON = PROJ / "raw" / "wechat" / "downloaded.json"
SOGOU = os.path.expanduser("~/.claude/skills/wechat-article-extractor/scripts/sogou_search.py")
PY = os.path.expanduser("~/.local/share/uv/tools/wechat-article-to-markdown/bin/python")
W2M = "wechat-article-to-markdown"

# 高优先查询：偏向"讲 WAIC 具体活动/日程/亮点"的近期文
QUERIES = [
    "WAIC2026 论坛 日程",
    "WAIC2026 逛会指南",
    "WAIC2026 边会 活动",
    "WAIC2026 亮点 前瞻",
    "世界人工智能大会 2026 展区",
    "WAIC2026 青少年 教育",
    "WAIC2026 大模型 发布",
    "世界人工智能大会 2026 嘉宾",
]


def resolve_query(query, max_resolve=8):
    """新会话搜索+解析，返回 [{title,account,date,real_url}...]（仅 mp.weixin 的）"""
    try:
        p = subprocess.run(
            [PY, SOGOU, query, "--pages", "1", "--resolve", "--max-resolve", str(max_resolve)],
            capture_output=True, text=True, timeout=240,
        )
    except subprocess.TimeoutExpired:
        print(f"  ⚠ 查询超时：{query}")
        return [], False
    antispider = "antispider" in (p.stderr or "")
    try:
        results = json.loads(p.stdout or "[]")
    except Exception:
        results = []
    good = [r for r in results if "mp.weixin.qq.com" in (r.get("real_url") or "")]
    return good, antispider


def download(url, title):
    try:
        p = subprocess.run([W2M, url, "--output-dir", str(OUT_DIR)],
                           capture_output=True, text=True, timeout=120)
        out = (p.stdout or "") + (p.stderr or "")
        if "未能提取到文章标题" in out or "验证" in out:
            return None, True   # CAPTCHA
        # 找生成的 md
        slug = re.sub(r"[^\w一-龥]", "", (title or ""))[:20]
        md = None
        for f in OUT_DIR.rglob("*.md"):
            if slug and slug[:8] in re.sub(r"[^\w一-龥]", "", f.stem):
                md = str(f.relative_to(PROJ / "build-output"))
                break
        return md, False
    except subprocess.TimeoutExpired:
        return None, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=40)
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    downloaded = json.loads(DL_JSON.read_text(encoding="utf-8")) if DL_JSON.exists() else []
    seen = {d.get("real_url") for d in downloaded}
    n = 0
    for q in QUERIES:
        if n >= args.max:
            break
        print(f"[query] {q}")
        good, antispider = resolve_query(q)
        if antispider:
            print("  ⛔ antispider — 整轮停止（等 ≥30 分钟再试）")
            break
        print(f"  解析到 {len(good)} 条真实链")
        for r in good:
            if n >= args.max:
                break
            url = r["real_url"]
            if url in seen:
                continue
            time.sleep(random.uniform(8, 15))
            print(f"  [dl] {r.get('title','')[:40]}")
            md, captcha = download(url, r.get("title"))
            if captcha:
                print("  ⛔ CAPTCHA — 整轮停止")
                DL_JSON.write_text(json.dumps(downloaded, ensure_ascii=False, indent=2), encoding="utf-8")
                return
            if md:
                downloaded.append({"title": r.get("title"), "account": r.get("account"),
                                   "date": r.get("date"), "real_url": url, "md_path": md})
                seen.add(url)
                n += 1
        time.sleep(random.uniform(6, 10))
    DL_JSON.write_text(json.dumps(downloaded, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ 本轮下载 {n} 篇 · 累计 {len(downloaded)} 篇 -> {DL_JSON}")
    print("下一步：python3 scripts/normalize_wechat.py && python3 scripts/build.py")


if __name__ == "__main__":
    main()
