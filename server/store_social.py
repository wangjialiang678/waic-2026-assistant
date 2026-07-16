"""
store_social.py — 社交速配（M9）后端存储。无登录，匿名同步码为键。

隐私护栏（硬要求）：
  - 独立模块、独立表；可用 WAIC_SOCIAL=off 一键全关。
  - 联系方式（contact）**只在双向 like（互相感兴趣）后**才露给对方；未匹配绝不外泄。
  - 进社交需显式 enable（前端单独同意）；一键 optout 删除全部社交数据。
  - 候选卡片只含公开信息（一句话/我能提供/我在找/标签），**不含 contact**。
  - 匹配池/候选/like 都限流（app 层），防批量抓。
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

_DB = os.environ.get("WAIC_SOCIAL_DB") or os.path.join(os.path.dirname(__file__), "user_state.db")
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

ENABLED = (os.environ.get("WAIC_SOCIAL", "on").lower() != "off")   # kill-switch


def _c() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_DB, check_same_thread=False)
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS social_profile(
                 device TEXT PRIMARY KEY,
                 enabled INTEGER DEFAULT 0,
                 intro TEXT, offer TEXT, seeking TEXT,
                 tags TEXT,           -- JSON 数组（兴趣/领域）
                 contact TEXT,        -- JSON {type,value}，只在双向匹配后露出
                 role TEXT,
                 updated_at TEXT )"""
        )
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS social_like(
                 liker TEXT, target TEXT, ts TEXT,
                 PRIMARY KEY(liker, target) )"""
        )
        _conn.commit()
    return _conn


def _pub_card(row) -> dict:
    """候选/公开卡：不含 contact。"""
    return {
        "device": row[0], "intro": row[2] or "", "offer": row[3] or "",
        "seeking": row[4] or "", "tags": json.loads(row[5] or "[]"), "role": row[7] or "",
    }


def get_profile(device: str) -> dict | None:
    with _lock:
        cur = _c().execute(
            "SELECT device,enabled,intro,offer,seeking,tags,contact,role FROM social_profile WHERE device=?",
            (device,))
        r = cur.fetchone()
    if not r:
        return None
    return {
        "device": r[0], "enabled": bool(r[1]), "intro": r[2] or "", "offer": r[3] or "",
        "seeking": r[4] or "", "tags": json.loads(r[5] or "[]"),
        "contact": json.loads(r[6] or "null"), "role": r[7] or "",
    }


def save_profile(device, enabled, intro, offer, seeking, tags, contact, role) -> dict:
    with _lock:
        c = _c()
        c.execute(
            """INSERT INTO social_profile(device,enabled,intro,offer,seeking,tags,contact,role,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(device) DO UPDATE SET enabled=excluded.enabled,intro=excluded.intro,
                 offer=excluded.offer,seeking=excluded.seeking,tags=excluded.tags,
                 contact=excluded.contact,role=excluded.role,updated_at=excluded.updated_at""",
            (device, 1 if enabled else 0, intro[:80], offer[:120], seeking[:120],
             json.dumps(tags[:12], ensure_ascii=False),
             json.dumps(contact, ensure_ascii=False) if contact else None,
             (role or "")[:16], time.strftime("%Y-%m-%dT%H:%M:%S")))
        c.commit()
    return get_profile(device) or {}


def optout(device: str) -> None:
    """一键删除全部社交数据。"""
    with _lock:
        c = _c()
        c.execute("DELETE FROM social_profile WHERE device=?", (device,))
        c.execute("DELETE FROM social_like WHERE liker=? OR target=?", (device, device))
        c.commit()


def _overlap(a: list, b: set) -> int:
    return len(set(a) & b)


def candidates(device: str, limit: int = 20) -> list:
    """按兴趣/标签重合度排序的候选（不含 contact，排除自己 + 已 like 的）。"""
    me = get_profile(device)
    my_tags = set(me.get("tags", [])) if me else set()
    with _lock:
        liked = {r[0] for r in _c().execute("SELECT target FROM social_like WHERE liker=?", (device,))}
        rows = _c().execute(
            "SELECT device,enabled,intro,offer,seeking,tags,contact,role FROM social_profile WHERE enabled=1 AND device!=?",
            (device,)).fetchall()
    out = []
    for r in rows:
        if r[0] in liked:
            continue
        card = _pub_card(r)
        card["_score"] = _overlap(card["tags"], my_tags)
        out.append(card)
    out.sort(key=lambda c: -c["_score"])
    for c in out:
        c.pop("_score", None)
    return out[:limit]


def like(device: str, target: str) -> dict:
    """记录 like；若对方也 like 过我 → 双向匹配，露出双方 contact。"""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
    with _lock:
        c = _c()
        c.execute("INSERT OR IGNORE INTO social_like(liker,target,ts) VALUES(?,?,?)", (device, target, ts))
        back = c.execute("SELECT 1 FROM social_like WHERE liker=? AND target=?", (target, device)).fetchone()
        c.commit()
    if not back:
        return {"matched": False}
    tp = get_profile(target)
    return {"matched": True, "target": _safe_match(tp)}


def _safe_match(p: dict | None) -> dict:
    if not p:
        return {}
    return {"device": p["device"], "intro": p["intro"], "offer": p["offer"],
            "seeking": p["seeking"], "tags": p["tags"], "role": p["role"],
            "contact": p.get("contact")}   # 匹配后才带 contact


def matches(device: str) -> list:
    """双向匹配列表（带对方 contact）。"""
    with _lock:
        mine = {r[0] for r in _c().execute("SELECT target FROM social_like WHERE liker=?", (device,))}
        theirs = {r[0] for r in _c().execute("SELECT liker FROM social_like WHERE target=?", (device,))}
    mutual = mine & theirs
    return [_safe_match(get_profile(t)) for t in mutual if get_profile(t)]


def stats() -> dict:
    with _lock:
        n = _c().execute("SELECT COUNT(*) FROM social_profile WHERE enabled=1").fetchone()[0]
        likes = _c().execute("SELECT COUNT(*) FROM social_like").fetchone()[0]
    return {"enabled_profiles": n, "likes": likes}
