#!/usr/bin/env bash
# =============================================================================
# hook-check-submodule.sh
#
# エージェント共用の Stop フック用ラッパー。
# セッション終了時に creations-db と親リポジトリの gitlink のずれを検知して通知する。
#
# 登録先（同一スクリプトを両者が呼ぶ。判定ロジックを複製しないこと）:
#   - Claude Code CLI: .claude/settings.json の hooks.Stop
#   - GPT Codex:       .codex/hooks.json      の hooks.Stop
#
# 動作:
#   1. origin/addon-ai-tag を fetch（ネットワークエラーは無視）。
#      判定自体には不要だが、記録 gitlink のコミットが手元に無いと
#      check スクリプト側の ancestry 判定が ERROR になるため先に取得しておく。
#   2. check-creations-db-update.sh で判定
#   3. ずれがある場合のみ、その種別に応じた対処コマンドを出力
#
# 終了コード: 常に 0（フック失敗でセッション終了をブロックしない）
# =============================================================================
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# ネットワーク非依存スクリプトの前に fetch を実行
git -C creations-db fetch origin addon-ai-tag --quiet 2>/dev/null || true

result=$(bash "${DIR}/check-creations-db-update.sh" 2>&1)
code=$?

# 見出しと判定結果を出す（$1 = 見出し文）。
# 枠は右端を閉じない。見出しに日本語が入るため右端を揃えるには表示幅の計算が要るが、
# bash から CJK の桁数を正しく数える移植性のある手段が無い（wc -L はロケール非対応）。
notice_header() {
  echo ""
  echo "┌─────────────────────────────────────────────────────"
  echo "│  [creations-db] $1"
  echo "└─────────────────────────────────────────────────────"
  echo "  ${result}"
  echo ""
}

case $code in
  0)
    # 作業ツリーが記録より進んでいる。gitlink を前進させてコミットする必要がある。
    notice_header "追従待ちの更新があります"
    echo "  反映するには:"
    echo "    git submodule update --remote --merge creations-db"
    echo "    node scripts/build-dataset.js --verbose"
    echo "    git add creations-db ai-dataset/ && git commit"
    echo ""
    ;;
  11)
    # 作業ツリーが記録より遅れているだけ。記録側が正しいのでコミットするものは無い。
    notice_header "ローカルのチェックアウトが遅れています"
    echo "  記録済みの gitlink に追いつくには（コミットは不要）:"
    echo "    git submodule update --init creations-db"
    echo ""
    ;;
  12)
    # 機械的な正解が無いため、対処コマンドは提示しない。
    notice_header "記録と作業ツリーが分岐しています"
    echo "  どちらを正とするか判断が必要です。まず差分を確認してください:"
    echo "    git -C creations-db log --oneline --graph --left-right \\"
    echo "      \$(git ls-tree HEAD creations-db | awk '{print \$3}')...HEAD"
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
