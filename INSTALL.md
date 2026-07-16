# WAIC 2026 参展指南 Skill 安装说明

## 一句话

把本目录的 `SKILL.md` 放进你的 Skill 目录，把 `bundle.tar.gz` 解压到工作目录的 `WAIC2026/` 子目录，即可开始问答。

## 步骤

1. 下载 `SKILL.md`，放到你的 AI Agent Skill 目录。
2. 下载 `bundle.tar.gz`，解压到当前工作目录：
   ```bash
   mkdir -p WAIC2026
   tar -xzf bundle.tar.gz -C WAIC2026
   ```
3. 现在可以问 AI 关于 WAIC 2026 的任何问题。

## 数据来源

- `WAIC2026/data/activities.json`：175 场论坛完整信息。
- `WAIC2026/data/themes.json`：13 个赛道、7 个场馆分类。

## 示例问题

- "7月18日世博中心上午有哪些论坛？"
- "帮我找所有跟 RISC-V 相关的论坛。"
- "规划一条 Day 2 不冲突的观展路线，重点看大模型和算力。"
