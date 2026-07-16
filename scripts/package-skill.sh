#!/bin/bash
# 打包 skill：把 agent-skill/ 复制进 build-output/skill/ 并生成 tar + SKILL_VERSION
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="$ROOT/agent-skill"
OUT="$ROOT/build-output"

mkdir -p "$OUT/skill"
rsync -a --delete --exclude='.DS_Store' "$SKILL_SRC/" "$OUT/skill/"

# 发布用：根目录也放一份 SKILL.md + SKILL_VERSION（供 curl 安装/自检）
cp "$SKILL_SRC/SKILL.md" "$OUT/SKILL.md"
grep -m1 '^version:' "$SKILL_SRC/SKILL.md" | awk '{print $2}' > "$OUT/SKILL_VERSION"

# skill 安装包
tar -C "$OUT" -czf "$OUT/waic-2026-skill.tar.gz" skill
echo "✓ skill 打包完成：$OUT/skill/ + waic-2026-skill.tar.gz (v$(cat "$OUT/SKILL_VERSION"))"
