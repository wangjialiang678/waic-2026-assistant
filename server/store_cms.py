"""
store_cms.py — 展商自助 CMS（M11）后端存储。

分层原则（关键）：
  - 官方采集层（exhibitors.json，build.py 生成）**只读、每日覆盖**，本模块绝不改它。
  - 合作方编辑层（本表）**独立存储**，读时前端合并、并标注「商家提供」，每日刷新不冲掉商家编辑。
流程：认领(留公司名+联系方式，人工线下核验营业执照) → 审核 → 通过后可编辑自家简介/官网/补充。
安全：不存证件文件（PII 最小化，线下核验）；编辑内容剥 HTML 防 XSS；官网只收 http(s)；admin 用 token。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time

_DB = os.environ.get("WAIC_CMS_DB") or os.path.join(os.path.dirname(__file__), "user_state.db")
ADMIN_TOKEN = os.environ.get("WAIC_CMS_TOKEN", "")   # 空则 admin 接口一律拒绝
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
_TAG = re.compile(r"<[^>]+>")


def _clean(s: str, n: int) -> str:
    return _TAG.sub("", str(s or "")).strip()[:n]


def _clean_url(u: str) -> str:
    u = str(u or "").strip()[:200]
    return u if u.startswith("http://") or u.startswith("https://") else ""


def _c() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_DB, check_same_thread=False)
        _conn.execute(
            """CREATE TABLE IF NOT EXISTS cms(
                 exhibitor_id TEXT, device TEXT,
                 company TEXT, contact TEXT,        -- 认领信息（线下核验用）
                 status TEXT DEFAULT 'pending',     -- pending / approved / rejected
                 intro TEXT, website TEXT, extra TEXT,   -- 编辑层内容（通过后可填）
                 reviewed_note TEXT, created_at TEXT, updated_at TEXT,
                 PRIMARY KEY(exhibitor_id, device) )"""
        )
        _conn.commit()
    return _conn


def claim(exhibitor_id, device, company, contact) -> dict:
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    with _lock:
        c = _c()
        c.execute(
            """INSERT INTO cms(exhibitor_id,device,company,contact,status,created_at,updated_at)
               VALUES(?,?,?,?, 'pending', ?, ?)
               ON CONFLICT(exhibitor_id,device) DO UPDATE SET company=excluded.company,
                 contact=excluded.contact, updated_at=excluded.updated_at""",
            (exhibitor_id, device, _clean(company, 60), _clean(contact, 80), now, now))
        c.commit()
    return my_status(exhibitor_id, device)


def my_status(exhibitor_id, device) -> dict:
    with _lock:
        r = _c().execute(
            "SELECT status,intro,website,extra,reviewed_note FROM cms WHERE exhibitor_id=? AND device=?",
            (exhibitor_id, device)).fetchone()
    if not r:
        return {"status": "none"}
    return {"status": r[0], "intro": r[1] or "", "website": r[2] or "",
            "extra": r[3] or "", "reviewed_note": r[4] or ""}


def save_edit(exhibitor_id, device, intro, website, extra) -> dict:
    """仅当该 (exhibitor,device) 认领已 approved 才允许写编辑层。"""
    with _lock:
        c = _c()
        r = c.execute("SELECT status FROM cms WHERE exhibitor_id=? AND device=?",
                      (exhibitor_id, device)).fetchone()
        if not r or r[0] != "approved":
            return {"error": "not_approved"}
        c.execute(
            "UPDATE cms SET intro=?, website=?, extra=?, updated_at=? WHERE exhibitor_id=? AND device=?",
            (_clean(intro, 400), _clean_url(website), _clean(extra, 200),
             time.strftime("%Y-%m-%dT%H:%M:%S"), exhibitor_id, device))
        c.commit()
    return my_status(exhibitor_id, device)


def overrides() -> dict:
    """公开：所有已通过的编辑层内容（供前端合并，标『商家提供』）。"""
    with _lock:
        rows = _c().execute(
            "SELECT exhibitor_id,intro,website,extra FROM cms WHERE status='approved'").fetchall()
    out = {}
    for eid, intro, website, extra in rows:
        if intro or website or extra:
            out[eid] = {"intro": intro or "", "website": website or "", "extra": extra or "", "by": "商家提供"}
    return out


# ---- admin（token 保护）----
def admin_ok(token: str) -> bool:
    return bool(ADMIN_TOKEN) and token == ADMIN_TOKEN


def pending() -> list:
    with _lock:
        rows = _c().execute(
            "SELECT exhibitor_id,device,company,contact,status,created_at FROM cms WHERE status='pending' ORDER BY created_at").fetchall()
    return [{"exhibitor_id": r[0], "device": r[1], "company": r[2], "contact": r[3],
             "status": r[4], "created_at": r[5]} for r in rows]


def review(exhibitor_id, device, action, note) -> dict:
    status = "approved" if action == "approve" else "rejected"
    with _lock:
        c = _c()
        c.execute("UPDATE cms SET status=?, reviewed_note=?, updated_at=? WHERE exhibitor_id=? AND device=?",
                  (status, _clean(note, 120), time.strftime("%Y-%m-%dT%H:%M:%S"), exhibitor_id, device))
        c.commit()
    return {"ok": True, "status": status}
