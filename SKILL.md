# WAIC 2026 参展指南 Skill

## 触发条件

当用户询问 WAIC 2026、世界人工智能大会、参展指南、论坛日程、场馆信息、时间规划等话题时，使用本 Skill。

## 可用数据

当前工作目录下应有 `WAIC2026/` 子目录，内含：

- `data/activities.json`：175 场论坛，字段包括 id、title、title_en、start_time、end_time、day、venue、container（赛道）、honeycomb（场馆）、search_text。
- `data/themes.json`：13 个赛道分类和 7 个场馆的统计信息。

## 核心能力

1. **列表查询**：按日期、赛道、场馆列出论坛。
2. **全文搜索**：用 grep 搜索 `search_text` 字段，匹配标题、地点、赛道、场馆。
3. **时间规划**：检查论坛时间是否冲突，为用户生成日程表。
4. **详情查询**：根据 id 找到单条论坛，返回时间、地点、赛道、场馆。

## 工具命令示例

```bash
# 列出所有论坛标题
cat WAIC2026/data/activities.json | jq '.activities[].title'

# 搜索包含"RISC-V"的论坛
cat WAIC2026/data/activities.json | jq '.activities[] | select(.search_text | contains("risc-v")) | {id,title,day,start_time,end_time,venue}'

# 按日期和场馆筛选
cat WAIC2026/data/activities.json | jq '.activities[] | select(.day == 2 and .honeycomb.id == "世博中心") | {title,start_time,end_time,venue}'
```

## 回答风格

- 简洁直接，给出用户要的时间/地点/主题。
- 若涉及规划，给出可执行的时间表，标注每场地点。
- 不确定时说明"根据当前数据..."，并建议用户查看官方 Hi WAIC APP。
