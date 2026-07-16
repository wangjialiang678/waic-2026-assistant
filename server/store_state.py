"""
store_state.py — 用户状态的极简持久化（无登录，匿名同步码为键）。

设计要点：
  - 键=前端生成的匿名同步码(device)，非任何真实身份；值=该用户的 日程 + 兴趣 + 自动推断兴趣 + (可选)社交联系方式。
  - 存 SQLite 单文件（单 worker，够用）；写入用 last-write-wins（按客户端 updated_at 比较）。
  - 目的：① 让日程/兴趣在多端 + AI agent skill 间同步；② 为社交速配提供"兴趣可查"的服务端数据。
  - 隐私：默认只存匿名码 + 用户主动填的内容；contact 仅当用户自愿填写社交联系方式时才有。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time

_DB = os.environ.get("WAIC_STATE_DB") or os.path.join(os.path.dirname(__file__), "user_state.db")
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None

DEVICE_RE = re.compile(r"^[A-Za-z0-9-]{6,40}$")


def valid_device(d: str) -> bool:
    return bool(d and DEVICE_RE.match(d))


def _c() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_DB, check_same_thread=False)
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS user_state(
                 device     TEXT PRIMARY KEY,
                 schedule   TEXT,   -- JSON: 活动 id 数组
                 interests  TEXT,   -- JSON: 兴趣词数组（显式）
                 inferred   TEXT,   -- JSON: {tag: weight} 行为自动推断
                 contact    TEXT,   -- JSON: {type,value,optin} 或 null（社交，自愿）
                 updated_at TEXT,   -- 客户端时间戳（LWW 依据）
                 server_ts  TEXT    -- 服务端落库时间
               )"""
        )
        _conn.commit()
    return _conn


def get_state(device: str) -> dict | None:
    with _lock:
        cur = _c().execute(
            "SELECT schedule,interests,inferred,contact,updated_at FROM user_state WHERE device=?",
            (device,),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "device": device,
        "schedule": json.loads(row[0] or "[]"),
        "interests": json.loads(row[1] or "[]"),
        "inferred": json.loads(row[2] or "{}"),
        "contact": json.loads(row[3] or "null"),
        "updated_at": row[4] or "",
    }


def put_state(device: str, schedule, interests, inferred, contact, updated_at: str) -> dict:
    """LWW：仅当传入 updated_at 比库里更新时才覆盖；否则回传服务端已有版本。"""
    with _lock:
        c = _c()
        cur = c.execute("SELECT updated_at FROM user_state WHERE device=?", (device,))
        row = cur.fetchone()
        if row and row[0] and updated_at and row[0] > updated_at:
            # 服务端更新 → 不覆盖，回传服务端版本（客户端据此合并）
            return get_state(device) or {}
        server_ts = time.strftime("%Y-%m-%dT%H:%M:%S")
        c.execute(
            """INSERT INTO user_state(device,schedule,interests,inferred,contact,updated_at,server_ts)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(device) DO UPDATE SET
                 schedule=excluded.schedule, interests=excluded.interests,
                 inferred=excluded.inferred, contact=excluded.contact,
                 updated_at=excluded.updated_at, server_ts=excluded.server_ts""",
            (
                device,
                json.dumps(schedule, ensure_ascii=False),
                json.dumps(interests, ensure_ascii=False),
                json.dumps(inferred, ensure_ascii=False),
                json.dumps(contact, ensure_ascii=False),
                updated_at,
                server_ts,
            ),
        )
        c.commit()
    return get_state(device) or {}


def stats() -> dict:
    with _lock:
        cur = _c().execute("SELECT COUNT(*), SUM(CASE WHEN contact IS NOT NULL AND contact!='null' THEN 1 ELSE 0 END) FROM user_state")
        n, with_contact = cur.fetchone()
    return {"devices": n or 0, "with_contact": with_contact or 0}


# ---- 纠错入口：用户报错/纠正信息 ----
def add_report(device: str, kind: str, target_id: str, message: str) -> None:
    with _lock:
        c = _c()
        c.execute("CREATE TABLE IF NOT EXISTS reports(device TEXT, kind TEXT, target_id TEXT, message TEXT, ts TEXT)")
        c.execute("INSERT INTO reports(device,kind,target_id,message,ts) VALUES(?,?,?,?,?)",
                  (device[:40], (kind or "")[:20], (target_id or "")[:40], (message or "")[:400],
                   time.strftime("%Y-%m-%dT%H:%M:%S")))
        c.commit()


def list_reports(limit: int = 200) -> list:
    with _lock:
        c = _c()
        c.execute("CREATE TABLE IF NOT EXISTS reports(device TEXT, kind TEXT, target_id TEXT, message TEXT, ts TEXT)")
        rows = c.execute("SELECT kind,target_id,message,ts FROM reports ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [{"kind": r[0], "target_id": r[1], "message": r[2], "ts": r[3]} for r in rows]
