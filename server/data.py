"""
data.py — 启动时把 build-output/data/*.json 读进内存并建简单索引。
数据量小（363 活动 / 1020 展商 / 208 情报），全内存查询即可，不用数据库。

对外暴露一个单例 STORE（DataStore 实例），tools.py / app.py 直接 import 使用。
入口/加载/异常都打日志，便于排查。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

log = logging.getLogger("waic.data")

# server/ 的上一级是「日程助手」，数据默认在 ../build-output/data/。
# 服务器部署时用环境变量 WAIC_DATA_DIR 覆盖，指向 nginx 已服务的数据目录
# （如 /var/www/waic/data），避免复制、永远与线上一致。
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)
DATA_DIR = os.environ.get("WAIC_DATA_DIR") or os.path.join(_PROJECT_ROOT, "build-output", "data")
_BUILD_ROOT = os.path.dirname(DATA_DIR)

# WAIC 2026 会期：day1..day4 → 日期。既从数据推断，也内置兜底。
_DAY_DATE_FALLBACK = {
    1: "2026-07-17",
    2: "2026-07-18",
    3: "2026-07-19",
    4: "2026-07-20",
}


def _load_json(name: str) -> Any:
    path = os.path.join(DATA_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    log.info("loaded %s", path)
    return data


class DataStore:
    """内存数据仓库 + 索引。"""

    def __init__(self) -> None:
        # 原始 payload
        act_payload = _load_json("activities.json")
        exh_payload = _load_json("exhibitors.json")
        intel_payload = _load_json("intel.json")
        self.venues: dict = _load_json("venues.json")

        self.activities: list[dict] = act_payload.get("activities", [])
        self.exhibitors: list[dict] = exh_payload.get("exhibitors", [])
        self.intel: list[dict] = intel_payload.get("articles", [])
        self.exhibitor_facets: dict = exh_payload.get("facets", {})

        # ---- 索引 ----
        self.act_by_id: dict[str, dict] = {a["id"]: a for a in self.activities if a.get("id")}
        self.exh_by_id: dict[str, dict] = {x["id"]: x for x in self.exhibitors if x.get("id")}

        # day <-> date 映射（优先用数据里出现的真实映射）
        self.day_to_date: dict[int, str] = dict(_DAY_DATE_FALLBACK)
        self.date_to_day: dict[str, int] = {}
        for a in self.activities:
            d, day = a.get("date"), a.get("day")
            if d and isinstance(day, int):
                self.day_to_date[day] = d
                self.date_to_day[d] = day
        for day, d in self.day_to_date.items():
            self.date_to_day.setdefault(d, day)

        # 场馆图相关快捷字段
        self.districts: dict = self.venues.get("districts", {})
        self.hall_adjacency: dict = self.venues.get("hall_adjacency", {})
        self.cross_district: dict = self.venues.get("cross_district_minutes", {})
        self.same_district_minutes: int = self.venues.get("same_district_minutes", 12)
        self.same_hall_minutes: int = self.venues.get("same_hall_minutes", 3)
        self.adjacent_hall_minutes: int = self.venues.get("adjacent_hall_minutes", 6)

        log.info(
            "DataStore ready: %d activities, %d exhibitors, %d intel; days=%s",
            len(self.activities), len(self.exhibitors), len(self.intel),
            sorted(self.day_to_date.items()),
        )

    # ---------- 通用工具 ----------
    def date_for_day(self, day: Optional[int]) -> Optional[str]:
        if day is None:
            return None
        return self.day_to_date.get(int(day))

    def detail_md(self, activity: dict) -> str:
        """读取活动详情 markdown（若存在）。"""
        rel = activity.get("detail_md")
        if not rel:
            return ""
        path = os.path.join(_BUILD_ROOT, rel)
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:  # noqa: BLE001 - 详情缺失不致命
            return ""

    # ---------- 场馆 / 片区解析 ----------
    def resolve_venue(self, name: str) -> Optional[dict]:
        """把一个场馆/展馆字符串解析为 {district, venue, hall}。识别不了返回 None。"""
        if not name:
            return None
        v = name.strip()

        # 1) 命中世博展览馆内的分区（hall_adjacency 的 key，如 "世博展览馆H2"）
        for hk in self.hall_adjacency:
            if hk == v or hk in v or v in hk:
                return {"district": "世博片区", "venue": "世博展览馆", "hall": hk}

        # 2) 按 districts 里的成员场馆做包含匹配
        for dname, dinfo in self.districts.items():
            for mv in dinfo.get("venues", []):
                if mv and (mv in v or v in mv):
                    hall = self._extract_expo_hall(v)
                    return {"district": dname, "venue": mv, "hall": hall}

        # 3) 关键词兜底
        if "世博展览馆" in v:
            return {"district": "世博片区", "venue": "世博展览馆", "hall": self._extract_expo_hall(v)}
        if "世博" in v:
            return {"district": "世博片区", "venue": "世博中心", "hall": None}
        if "张江" in v:
            return {"district": "张江片区", "venue": "张江科学会堂", "hall": None}
        if "西岸" in v or "徐汇" in v:
            return {"district": "西岸片区", "venue": "西岸国际会展中心", "hall": None}
        return None

    def _extract_expo_hall(self, v: str) -> Optional[str]:
        """从字符串里抽出世博展览馆的 hall key（H1-H4 / 中厅）。"""
        for hk in self.hall_adjacency:
            if hk in v:
                return hk
        for tag in ("H1", "H2", "H3", "H4"):
            if tag in v:
                return f"世博展览馆{tag}"
        if "中厅" in v and "世博展览馆" in v:
            return "世博展览馆中厅"
        return None

    def route(self, frm: str, to: str) -> dict:
        """估算两个场馆间步行/转场时间。
        规则：同展馆3min / 邻馆6min / 同片区12min / 跨片区查 cross_district_minutes。"""
        ra, rb = self.resolve_venue(frm), self.resolve_venue(to)
        if not ra or not rb:
            return {
                "same_district": None,
                "minutes": None,
                "note": f"无法识别场馆（from={frm!r}, to={to!r}），请以官方指引为准。",
            }
        da, db = ra["district"], rb["district"]

        # 跨片区
        if da != db:
            m = self._cross_minutes(da, db)
            return {
                "same_district": False,
                "minutes": m,
                "note": f"跨片区：{da} → {db}，约 {m} 分钟，建议预留转场缓冲。",
            }

        # 同片区：先看世博展览馆内的 hall 关系
        ha, hb = ra["hall"], rb["hall"]
        if ha and hb:
            if ha == hb:
                return {"same_district": True, "minutes": self.same_hall_minutes,
                        "note": f"同一展馆分区（{ha}），步行约 {self.same_hall_minutes} 分钟。"}
            if hb in self.hall_adjacency.get(ha, []):
                return {"same_district": True, "minutes": self.adjacent_hall_minutes,
                        "note": f"相邻展馆分区（{ha}↔{hb}），步行约 {self.adjacent_hall_minutes} 分钟。"}
            # 同馆但非相邻分区（如 H1↔H4）
            est = self.adjacent_hall_minutes + 2
            return {"same_district": True, "minutes": est,
                    "note": f"同一展馆不同分区（{ha}↔{hb}），步行约 {est} 分钟。"}

        # 同片区、同一场馆建筑
        if ra["venue"] == rb["venue"]:
            return {"same_district": True, "minutes": self.same_hall_minutes,
                    "note": f"同一场馆（{ra['venue']}），步行约 {self.same_hall_minutes} 分钟。"}

        # 同片区、不同场馆
        return {"same_district": True, "minutes": self.same_district_minutes,
                "note": f"同片区不同场馆（{ra['venue']} → {rb['venue']}），约 {self.same_district_minutes} 分钟。"}

    def _cross_minutes(self, da: str, db: str) -> int:
        for key in (f"{da}|{db}", f"{db}|{da}"):
            if key in self.cross_district:
                return self.cross_district[key]
        return 30  # 兜底粗估

    # ---------- hall 邻接距离（供 nearest_next 排序）----------
    def hall_distance_minutes(self, current_hall: str, target_hall: str) -> int:
        """current_hall 到 target_hall 的估算步行分钟（越小越近），无法比较返回较大值。"""
        rc = self.resolve_venue(current_hall)
        rt = self.resolve_venue(target_hall)
        if not rc or not rt:
            return 999
        r = self.route(current_hall, target_hall)
        return r["minutes"] if r.get("minutes") is not None else 999


# 全局单例（app 启动时构建）
STORE: Optional[DataStore] = None


def init_store() -> DataStore:
    global STORE
    if STORE is None:
        STORE = DataStore()
    return STORE


def get_store() -> DataStore:
    if STORE is None:
        return init_store()
    return STORE
