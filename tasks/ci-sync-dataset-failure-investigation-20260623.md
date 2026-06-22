# CI失敗 調査・修正方針 提案ログ — `Sync & Format AI Dataset`

- **作成日**: 2026-06-23
- **対象ワークフロー**: `.github/workflows/sync-dataset.yml`（`name: Sync & Format AI Dataset`）
- **検出元**: GitHub 通知メール（6/22 の実行が失敗、最新実行が失敗のまま）
- **調査範囲**: ワークフロー定義 / `scripts/build-dataset.js` / サブモジュール `creations-db` の到達性 / git 履歴
- **ステータス**: ✅ 修正適用済み（A案: concurrency追加 / B案: push耐性化）— コミット・push は未実施（手動で行うこと）

> 本ファイルは `tasks/`（作業メモ置き場）に保存。`ai-dataset/` `creations-db/` `.github/workflows/` は不変ルールに従い未編集。

---

## 1. 結論（要約）

- **ビルド自体は壊れていない。** `scripts/build-dataset.js` は新旧どちらのバージョンでも、現行サブモジュール（`creations-db@05ea255`）に対し **終了コード 0** で完走した。
- 6/22 の失敗の最有力原因は、**「Commit and push if changed」ステップでの `git push` 非 fast-forward 競合（push race）**。ビルドは成功しているのに push 段でリジェクトされて run が赤くなった、という型。
- これは **ワークフローに concurrency 制御が無い**こと、および **毎回コミットが発生する設計**（生成物に毎ビルド変わる `_generated_at` タイムスタンプが埋まる）に起因する構造的な脆さ。ユーザの手動 push（`774b39e` / `6fac3d1`）が CI run の実行中に master に着地したことが引き金。
- 失敗は**実質的に一過性**で、その後の run（`e44ee81`、`f616f9e`＝6/23 06:00 JST のスケジュール実行）は成功し、データセット同期は機能している。ただし**現設計のままでは再発する**。

---

## 2. ワークフローが何をしているか

`sync-dataset.yml` のジョブ `build-dataset`（`ubuntu-latest`）のステップ：

1. **Checkout（submodules: recursive, fetch-depth: 0）** — 親リポジトリと `creations-db` を取得。
2. **Update submodule**（`schedule` / `repository_dispatch` / 手動かつ `update_submodule==true` のときのみ） — `git submodule update --remote --merge creations-db`。
3. **Setup Node.js**（v20）。
4. **Run build** — `node scripts/build-dataset.js --verbose`。`ai-dataset/` を再生成。
5. **Stage** — `git add ai-dataset/`（+ `git add creations-db || true`）。
6. **Commit and push if changed** — 差分があれば `chore: sync ai-dataset (creations-db@<hash>) [skip ci]` でコミットし `git push`。

トリガーは4つ：`push`(master, paths: `creations-db`/`scripts/**`) / `repository_dispatch`(`creations-db-updated`) / `schedule`(`0 21 * * *` UTC=06:00 JST) / `workflow_dispatch`。

---

## 3. 切り分け（どのステップで失敗しうるか）

| ステップ | 失敗しうるか | 本件での評価 |
|---|---|---|
| 1. Checkout（submodule 取得） | gitlink が上流に無いと失敗 | **否定**。記録 gitlink `05ea2551` は上流 `addon-ai-tag` の先端と一致（`git ls-remote` で確認済み）。到達性問題なし。 |
| 2. Update submodule（`--remote --merge`） | マージ競合・ローカル merge commit 生成のリスク | 現状は gitlink == 上流先端のため非アクティブ。ただし `--merge` は潜在リスク（後述 §6-E）。 |
| 3. Setup Node | ほぼ無い | 影響なし（engines `>=18`、CI=20、ローカル=22）。 |
| 4. Run build | スクリプト例外で `process.exit(1)` | **否定（ハード失敗ではない）**。新旧スクリプトとも exit 0 で完走。旧版は `title_ja` が空になる**データ劣化**を起こすのみ（クラッシュしない）。 |
| 5. Stage | ほぼ無い | 影響なし。 |
| 6. Commit and push | **`git push` 非 fast-forward でリジェクト → 非0終了** | **最有力**。concurrency 無し＋毎回コミット設計で競合が起きやすい。 |

### 検証で得た一次情報

- 現行サブモジュールに対するビルド：`9 作品 / 431 キャラクター`、`=== build complete ===`、exit 0。
- 修正前ビルドスクリプト（`774b39e~1`）の実行：exit 0。ただしログは `処理中: Works_NumberTales ( / NumberTales)` のように **JP タイトルが空**。
- 修正コミット `774b39e` の本質：上流の「JP/EN 命名標準化（Phase 2〜5）」で全フィールドに言語サフィックスが付いたことへの追従。
  - `workTopMeta.Title` → `Title_JP`
  - `workTopMeta.Works_Summary` → `Works_Summary_JP`
  - `charData.Name`（ID フォールバック）→ `Name_JP`（旧 `Name` も保持）
- `git ls-remote`：上流 `addon-ai-tag` 先端 = `05ea2551`（記録 gitlink と一致）。
- `origin/master` 履歴（修正後）：
  - `6fac3d1`（17:39 JST / 08:39 UTC）マージ競合解決（ユーザ）
  - `e44ee81`（08:39 UTC）`chore: sync ... (creations-db@05ea255) [skip ci]`（CI、成功）
  - `f616f9e`（21:45 UTC ≒ 6/23 06:00 JST スケジュール）`chore: sync ... (creations-db@05ea255) [skip ci]`（CI、成功）

---

## 4. 6/22 当日の推定タイムライン（UTC）

- `08:29` `e5e8f0c` CI が sync commit（creations-db@54091ec）を push。
- `08:37` ユーザが `774b39e`（ビルド修正）を push → **`scripts/**` 変更で push トリガー発火**。
- `08:39` ユーザが `6fac3d1`（マージ競合解決）を push。**競合自体が、CI の `e5e8f0c` とローカル作業が `ai-dataset/` で衝突した証跡**。
- この前後で、`774b39e` 起点の CI run が build 成功後に push しようとした時点で master が `6fac3d1` まで進んでおり、**非 fast-forward で push リジェクト → run が赤化（失敗通知メール）**、という筋が最も整合的。
- その後の run（`e44ee81` / `f616f9e`）は競合解消後に成功 → 同期は復旧。

> 注意: 「どのステップが赤か」の最終確定には GitHub Actions の当該 run ログ参照が必要（本環境では Actions ログ取得用コネクタが未接続のため未確認）。§6 の検証手順1で確認のこと。

---

## 5. 原因仮説の整理（カテゴリ別）

- **依存（dependency）**: ❌ 主因ではない。Node バージョン差（CI 20 / ローカル 22）も影響なし。
- **認証情報（auth）**: ❌ 主因ではない。`permissions: contents: write` と `GITHUB_TOKEN` は設定済み。ただし push race の「リジェクト」を「権限エラー」と誤読しないこと。
- **データ不整合（data）**: △ 副次。上流 Phase 2-5 のフィールド改名で、修正前スクリプトは全作品の `title_ja` / `summary` を**空文字**にしていた（クラッシュはしない silent degradation）。`774b39e` で解消済み・既に master 反映済み。
- **パス（path）**: ❌ 主因ではない。`References` の `ref_*.json` 不在による `スキップ` / `getRecords 失敗` WARN は出るが、`log()`（VERBOSE）/`continue` で握っており非致命。
- **API egress / ネットワーク**: △ ビルドは完全ローカル（`CreationsDBClient` はファイル読取のみ、ネットワーク無し）。ネットワークが要るのは submodule の fetch と最終 `git push` のみ。**push 段の競合**が今回の本丸。
- **並行実行（concurrency）**: ✅ **主因**。`concurrency:` 未設定 ＋ 毎回コミット設計（`_generated_at` タイムスタンプで毎回差分発生）＋ 多重トリガーにより push race が発生しやすい。

---

## 6. 修正方針（A・B は適用済み）

> A・B は `.github/workflows/sync-dataset.yml` に適用済み（未コミット）。C〜E は今後の改善として残す。

### A. ワークフローに concurrency 制御を追加（最優先・低リスク）
同一ブランチの run を直列化し、push race を構造的に防ぐ。

```yaml
concurrency:
  group: sync-dataset-${{ github.ref }}
  cancel-in-progress: false   # 走行中 run は完走させ、後続はキュー
```

### B. push ステップを競合耐性化（最優先・低リスク）
push 前に rebase してリトライ。A と併用で堅牢。

```yaml
- name: Commit and push if changed
  run: |
    git config user.name  "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    if git diff --cached --quiet; then
      echo "変更なし。スキップ"; exit 0
    fi
    SUBMODULE_COMMIT=$(git -C creations-db rev-parse --short HEAD)
    git commit -m "chore: sync ai-dataset (creations-db@${SUBMODULE_COMMIT}) [skip ci]"
    for i in 1 2 3; do
      git pull --rebase --autostash origin "${GITHUB_REF_NAME}" \
        && git push && exit 0
      echo "push retry ${i}"; sleep $((i*5))
    done
    echo "push に失敗"; exit 1
```

### C. 生成物のタイムスタンプを決定論化（中優先・チャーン削減の本命）
`build-dataset.js` は `_generated_at` 等に `new Date().toISOString()` を多数埋め込むため、**ソース無変更でも毎ビルドで差分が出て毎回コミット**する。これが push race の発生窓を広げ、コミット履歴も汚す。
- 対策案: `_generated_at` を**サブモジュールのコミット日時**（決定論的）から導出、または当該フィールドを撤廃。
- 効果: ソース無変更時は `git diff --cached --quiet` が真 → コミット・push をスキップ → 競合窓が消える。
- 留意: `ai-dataset/` は派生物。変更は `build-dataset.js` 側で行い、再ビルドで反映（手動編集禁止に抵触しない）。

### D. データ劣化を“早期にCI失敗”として検出（中優先・再発防止）
今回の Title→Title_JP 系は silent degradation だった。CI に軽量アサーションを追加し、空タイトル等を**ハード失敗**として早期検知する。
- 例: 既知作品の `title_ja` 非空チェック、`node --check scripts/build-dataset.js`、生成 JSON の最小スキーマ検証。

### E. submodule 更新の安全化（低優先・潜在リスク対策）
`schedule`/`dispatch` の `git submodule update --remote --merge` はローカル merge commit を生み、gitlink が上流先端と乖離する罠（AGENTS.md §注意事項参照）。
- 対策案: `--merge` を `--checkout`（detached, merge commit を作らない）に変更し、`.gitmodules` の `branch = addon-ai-tag` を前提に上流先端をそのまま gitlink 化。
- 併せて step 2 の後に「gitlink == 上流先端」を assert。

---

## 7. 確認手順（ユーザ向け）

1. **赤いステップの最終確認**: GitHub → Actions → `Sync & Format AI Dataset` → 6/22 の失敗 run → 失敗ステップを確認。**「Commit and push if changed」**が赤で、ログに `Updates were rejected because the remote contains work that you do not have locally`（= 非 fast-forward）が出ていれば本提案の主因仮説が確定。build ステップが赤ならログ末尾の例外を §5 データ仮説と突合。
2. **現状ステータス確認**: 最新 run（`e44ee81`/`f616f9e` を生んだ run）が緑であることを確認 → パイプラインは稼働中＝「恒久ブロック」ではなく「再発する一過性」と判断。
3. **修正の検証（A+B 適用後）**: `push` と `workflow_dispatch` をほぼ同時に発火させ、push リジェクトが起きないことを確認。
4. **チャーン検証（C 適用後）**: ローカルで `node scripts/build-dataset.js --verbose` を2回連続実行し、ソース無変更時に `git status` が差分ゼロになることを確認。

---

## 8. 付記: 調査中に発生したローカル git index 破損（要・Windows 側対応）

本調査の bash 操作（Windows マウント上での `git stash`）を契機に、**ローカル作業ツリーの `.git/index` が破損**しました（`error: bad signature 0x00000000 / index file corrupt`）。サンドボックス側からは `.git/index` を削除できず（権限制約）、復旧できていません。

- **影響範囲**: index ファイル単体の破損のみ。**コミット済み履歴・オブジェクト・作業ファイルの内容には未影響**（`git ls-tree`/`git log`/`git show` は正常動作）。破損前の未ステージ変更は `ai-dataset/` の再ビルド差分（タイムスタンプ中心）と `creations-db` のポインタのみで、**失われて困る成果物は無し**。
- **Windows 側での復旧手順**（リポジトリルートで）:
  ```powershell
  del .git\index
  git reset            # HEAD から index を再構築（作業ツリーは保持）
  git status           # 正常表示を確認
  ```
- なお `origin/master` は `f616f9e` まで進んでいるため、ローカルは `git pull`（または `git fetch && git rebase origin/master`）で追従推奨。
