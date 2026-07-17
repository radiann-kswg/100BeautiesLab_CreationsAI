# creations-db サブモジュール同期タスク 実行ログ

- **実行日時**: 2026-06-25 09:06 UTC（18:06 JST）
- **実行モード**: 自動実行（スケジュールタスク / ネットワーク非依存サンドボックス）
- **結論**: **追従すべき実質的な更新なし。再ビルド・コミットは一切行っていない（ゲートの誤検知）。**

## 1. ゲート判定

`bash tools/check-creations-db-update.sh` の結果:

```
UPDATE_AVAILABLE 6df9d2728434c23507e6c9c08539514e15baacf6 HEAD (diverged-or-unknown)
EXIT=0
```

形式上は「更新あり（exit 0）」だが、第2引数の WORKING が SHA ではなくリテラル文字列 `HEAD` になっている点に注目し、内容を精査した。

## 2. 精査結果（誤検知と判断した根拠）

サブモジュール `creations-db` に関する正典リファレンスはすべて同一コミットを指している:

| 参照 | コミット |
|---|---|
| スーパープロジェクト記録 gitlink | `6df9d27` |
| ブランチ `refs/heads/addon-ai-tag` | `6df9d27` |
| `refs/remotes/origin/addon-ai-tag` | `6df9d27` |

- `git submodule status` → ` 6df9d2728434c23507e6c9c08539514e15baacf6 creations-db (heads/addon-ai-tag)`
  先頭は **スペース**（`+` でも `-` でもない）＝ スーパープロジェクトはサブモジュールが記録 gitlink と一致した状態にあると認識している。

つまり「サブモジュール作業ツリーが記録 gitlink より前進している」という追従待ち状態は**実在しない**。

### 誤検知の原因

このサンドボックス内では `creations-db` のサブモジュール用 git（`.git/modules/creations-db`）が壊れた状態にある:

- `git -C creations-db rev-parse HEAD` が `fatal: ... unknown revision` で失敗し、git の仕様により標準出力へリテラル `HEAD` を出力（gate は `2>/dev/null` で stderr を握り潰すため、WORKING に `HEAD` が入る）。
- `git status` が「No commits yet」「Failed to resolve HEAD as a valid ref」を返す（HEAD 解決不能で unborn branch 扱い）。
- `refs/heads/addon-ai-tag` ファイル自体には正しく `6df9d27`（40hex + 改行）が格納されており、コミットオブジェクトも存在（`git cat-file -t 6df9d27` → commit）。SHA を明示する `git diff --stat 6df9d27` 等は正常に動作する。
- `.git/modules/creations-db/index.lock` が「Operation not permitted」で残存しており、サンドボックスでサブモジュール git 内部が degraded であることを裏付ける。

要するに gate の `rev-parse HEAD` が壊れた HEAD 参照のせいで SHA を返せず、`HEAD`（≠ recorded）として比較された結果の **誤検知**。上流（origin/addon-ai-tag）も記録 gitlink も同じ `6df9d27` であり、ネットワーク側が前進させた新コミットは存在しない。

## 3. 実施しなかったこと とその理由

- **データセット再ビルド（build-dataset.js）**: 実施せず。追従すべき更新が無く、再ビルドは不要かつ有害（下記の未コミット作業を上書きする恐れ）。
- **コミット**: 実施せず。
  - 記録 gitlink は既に `6df9d27` で、ポインタ前進の余地がない（空コミット相当になる）。
  - 親リポジトリにこのタスクと無関係な**既存の未コミット変更**が存在し、自動コミットで巻き込むべきでない:
    - `M scripts/build-dataset.js`
    - `M ai-dataset/image-index.json` / `manifest.jsonl` / `manifest-training.jsonl` / `works/Works_NumberTales.json` / `works/Works_Proxies.json` / `works/Works_UnauthedLogica.json` / `works/Works_UnibyteLive.json`
    - `?? tasks/github-triage-20260624.md` / `?? tasks/github-triage-20260625.md`
  - サブモジュール内部（読み取り専用）の git 状態が壊れているため、いかなる submodule git 操作も安全でない。

## 4. 申し送り（次回・運用者向け）

1. **本タスクは何も変更していない。** リポジトリは実行前のまま（上記の既存未コミット変更も手付かず）。
2. 実際の追従要否は、**ネットワークが通る側（ローカル Windows の git、または GitHub Actions `sync-dataset.yml`）**で `git fetch` → `git submodule update --remote --merge creations-db` を実行して判断すること。サンドボックスの壊れた HEAD 参照は健全な環境では再現しない見込み。
3. **gate スクリプトの堅牢化（推奨・未適用）**: `tools/check-creations-db-update.sh` は `rev-parse HEAD` 失敗時にリテラル `HEAD` を WORKING として扱い、ERROR ではなく UPDATE_AVAILABLE を誤って返す。WORKING が 40 桁 hex の SHA であることを検証し、非 SHA の場合は exit 1（ERROR）とするガードを追加すると、同種の誤検知を防げる。例:

   ```bash
   WORKING="$(git -C "$SUBMODULE" rev-parse --verify --quiet HEAD^{commit} 2>/dev/null)"
   if ! printf '%s' "$WORKING" | grep -Eq '^[0-9a-f]{40}$'; then
     echo "ERROR: サブモジュール HEAD を SHA として解決できませんでした" >&2
     exit 1
   fi
   ```

   ※ サンドボックス固有の環境異常であり、収録データ構造の変更ではないため、本自動実行ではコード変更・コミットは行わず推奨に留めた。
