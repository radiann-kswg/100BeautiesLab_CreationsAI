#!/usr/bin/env bash
# =============================================================================
# check-creations-db-update.sh
#
# サブモジュール `creations-db` の「追従待ち更新」をネットワーク非依存で検知する
# ゲートスクリプト。
#
# 役割（分業型）:
#   fetch / `git submodule update --remote` はネットワークが通る側
#   （ローカル Windows の git、または GitHub Actions）が担当する前提。
#   このスクリプトは「サブモジュールの作業ツリー HEAD が、スーパープロジェクトの
#   記録している gitlink より進んでいる（= 追従待ち）」状態だけを判定する。
#   ネットワークアクセスは一切行わない。
#
# 終了コード:
#   10 : UP_TO_DATE       追従済み。やることなし。
#    0 : UPDATE_AVAILABLE 追従すべき更新あり。標準出力に
#                         "UPDATE_AVAILABLE <recorded> <working>" を出力。
#    1 : ERROR            実行環境やリポジトリの異常。
#
# 使い方:
#   bash tools/check-creations-db-update.sh
# =============================================================================
set -uo pipefail

SUBMODULE="creations-db"

# リポジトリのルート（このスクリプトの 1 つ上の階層）を基準にする
REPO="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
if [ -z "${REPO:-}" ] || [ ! -d "${REPO}/.git" ] && [ ! -f "${REPO}/.git" ]; then
  echo "ERROR: リポジトリのルートを特定できませんでした" >&2
  exit 1
fi
cd "$REPO" || { echo "ERROR: リポジトリのルートへ移動できませんでした" >&2; exit 1; }

# サブモジュールのディレクトリが存在するか
if [ ! -d "${REPO}/${SUBMODULE}" ]; then
  echo "ERROR: サブモジュール ${SUBMODULE} が見つかりません" >&2
  exit 1
fi

# スーパープロジェクト HEAD が記録している gitlink コミット
RECORDED="$(git ls-tree HEAD "$SUBMODULE" 2>/dev/null | awk '{print $3}')"
if [ -z "$RECORDED" ]; then
  echo "ERROR: 記録済み gitlink を取得できませんでした（${SUBMODULE} はサブモジュールとして登録されていますか）" >&2
  exit 1
fi

# サブモジュール作業ツリーの現 HEAD
# `git rev-parse HEAD` は HEAD を解決できない場合でも標準出力へリテラル "HEAD" を返すため、
# 空チェックだけでは通り抜けて RECORDED との比較が誤って UPDATE_AVAILABLE になる
# （2026-06-25 の誤検知事例: サブモジュール git が壊れ HEAD が unborn 扱いになった環境）。
# SHA として解決できたことを明示的に検証し、できなければ ERROR とする。
WORKING="$(git -C "$SUBMODULE" rev-parse --verify --quiet HEAD^{commit} 2>/dev/null)"
if ! printf '%s' "$WORKING" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "ERROR: サブモジュール作業ツリーの HEAD を SHA として解決できませんでした" >&2
  exit 1
fi

if [ "$RECORDED" = "$WORKING" ]; then
  echo "UP_TO_DATE ${RECORDED}"
  exit 10
fi

# 追従待ち。念のため WORKING が RECORDED の子孫（＝前進）かを確認しておく。
# 祖先関係が確認できなくても更新ありとして扱うが、情報として注記する。
if git -C "$SUBMODULE" merge-base --is-ancestor "$RECORDED" "$WORKING" 2>/dev/null; then
  RELATION="forward"
else
  RELATION="diverged-or-unknown"
fi

echo "UPDATE_AVAILABLE ${RECORDED} ${WORKING} (${RELATION})"
exit 0
