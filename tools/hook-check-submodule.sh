#!/usr/bin/env bash
# =============================================================================
# hook-check-submodule.sh
#
# Claude Code Stop フック用ラッパー。
# セッション終了時に creations-db の追従待ち更新を検知して通知する。
#
# 動作:
#   1. origin/addon-ai-tag を fetch（ネットワークエラーは無視）
#   2. check-creations-db-update.sh で判定
#   3. UPDATE_AVAILABLE の場合のみターミナルに通知を出力
#
# 終了コード: 常に 0（フック失敗でセッション終了をブロックしない）
# =============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# ネットワーク非依存スクリプトの前に fetch を実行
git -C creations-db fetch origin addon-ai-tag --quiet 2>/dev/null || true

result=$(bash "${DIR}/check-creations-db-update.sh" 2>&1)
code=$?

case $code in
  0)
    echo ""
    echo "┌─────────────────────────────────────────────────────┐"
    echo "│  [creations-db] 追従待ちの更新があります           │"
    echo "└─────────────────────────────────────────────────────┘"
    echo "  ${result}"
    echo ""
    echo "  反映するには:"
    echo "    git submodule update --remote --merge creations-db"
    echo "    node scripts/build-dataset.js --verbose"
    echo ""
    ;;
  10)
    # UP_TO_DATE — 何も出力しない
    ;;
  *)
    echo "[creations-db] サブモジュールチェックでエラーが発生しました: ${result}" >&2
    ;;
esac

exit 0
