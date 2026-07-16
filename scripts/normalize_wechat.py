#!/usr/bin/env python3
"""
把搜狗发现的公众号候选 raw/wechat/candidates.json 归一化成
build.py 消费的 raw/wechat/articles.json。

- 只保留 relevant==true
- 每条 kind="coverage"（媒体报道），全文下载后由下载阶段补 md_path/url 升级
- 保留 sogou_url 作为出处线索；真实 mp.weixin URL 待下载阶段解析回填
- 若 raw/wechat/downloaded.json 存在（下载阶段产物），据其 title 匹配补 md_path + real url
"""
import json
from pathlib import Path

PROJ = Path(__file__).resolve().parent.parent
src = PROJ / "raw" / "wechat" / "candidates.json"
dl = PROJ / "raw" / "wechat" / "downloaded.json"   # 下载阶段产物（可选）
dst = PROJ / "raw" / "wechat" / "articles.json"

cands = json.loads(src.read_text(encoding="utf-8"))

# 下载映射：title -> {md_path, real_url}
dlmap = {}
if dl.exists():
    for d in json.loads(dl.read_text(encoding="utf-8")):
        if d.get("title"):
            dlmap[d["title"].strip()] = d

out = []
for c in cands:
    if c.get("relevant") is not True:
        continue
    title = (c.get("title") or "").strip()
    d = dlmap.get(title)
    rec = {
        "title": title,
        "publisher": c.get("account") or "",
        "source_site": "mp.weixin.qq.com",
        "date": c.get("date") or "",
        "summary": c.get("snippet") or "",
        "kind": "coverage",
        "sogou_url": c.get("sogou_url") or "",
        "url": (d or {}).get("real_url") or c.get("real_url") or "",
    }
    if d and d.get("md_path"):
        rec["md_path"] = d["md_path"]
    out.append(rec)

dst.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
n_dl = sum(1 for r in out if r.get("md_path"))
print(f"wechat 归一化：{len(out)} 条相关（已下载全文 {n_dl}） -> {dst.name}")
