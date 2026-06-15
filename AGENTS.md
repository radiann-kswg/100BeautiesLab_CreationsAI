# AGENTS.md — AI エージェント向け作業手順書

このファイルは Claude Code 等の AI エージェントが定期的な更新作業を行うための手順書です。
**本ファイルは定期更新作業の「手順の正典」です。** `CLAUDE.md` と `.github/copilot-instructions.md` は手順を再掲せず本ファイルを参照します。エージェント設定の相互同期ルールは両設定書を参照してください。

---

## 作業: `creations-db/addon-ai-tag` の変更をAIデータセットに反映する

### トリガー
以下のいずれか。

- 「サブモジュール `creations-db` の `addon-ai-tag` ブランチの変更に基づいて、このリポジトリのAIタグ機能を更新してください」というユーザー指示。
- **Claude Code セッション終了時の Stop フック通知**: `tools/hook-check-submodule.sh` が「[creations-db] 追従待ちの更新があります」と表示した場合。これはサブモジュール作業ツリーの HEAD が親リポジトリの記録より進んでいることを示す（下記「自動チェックの仕組み」参照）。
- **GitHub Actions の自動実行**: `sync-dataset.yml` が毎朝 6:00 JST（cron `0 21 * * *` UTC）に自動でサブモジュール更新＋再ビルド＋コミットを行う。手動で作業する前に、CI 側で既に反映済みでないかを確認すること。

### 背景
- サブモジュール `creations-db` は `addon-ai-tag` ブランチで AI 学習可否フラグ（`AI_Optout` / `AI_Output`）を管理している
- このリポジトリの `ai-dataset/` は `scripts/build-dataset.js` によって `creations-db` のデータから生成される
- `addon-ai-tag` に変更があった場合、サブモジュールを更新してデータセットを再ビルドする必要がある

### 手順

#### 1. サブモジュールの変更内容を確認する
```powershell
git -C creations-db log --oneline origin/addon-ai-tag -10
git -C creations-db diff HEAD..origin/addon-ai-tag
```

#### 2. `.gitmodules` が `addon-ai-tag` を追跡しているか確認する
```powershell
cat .gitmodules
```
`branch = addon-ai-tag` になっていない場合は修正する:
```
[submodule "creations-db"]
    path = creations-db
    url = https://github.com/radiann-kswg/100BeautiesLab_CreationsDB.git
    branch = addon-ai-tag
```

#### 3. サブモジュールを `addon-ai-tag` の最新コミットに更新する
```powershell
git -C creations-db fetch origin
git -C creations-db checkout origin/addon-ai-tag --detach
# または
git submodule update --remote --merge creations-db
# ただし --remote は .gitmodules の branch 設定に従うため、addon-ai-tag であることを確認してから実行
```

#### 4. AIデータセットを再ビルドする
```powershell
cd scripts
node build-dataset.js --verbose
cd ..
```
正常終了時のログ例:
```
[build] === build complete ===
```

#### 5. 変更をコミットする
```powershell
git add .gitmodules creations-db ai-dataset/
git commit -m "Update AI dataset for addon-ai-tag changes: <変更内容の要約>"
```

### 注意事項

- **`--remote` フラグの罠**: `git submodule update --remote` は `.gitmodules` の `branch` 設定に従う。`branch = develop` のままで実行すると develop ブランチが反映されてしまう。必ず `branch = addon-ai-tag` であることを確認してから実行する。
- **`Works_Hidden: true` の優先**: `creations-db/data/db_meta.json` でワークス全体が `Works_Hidden: true` になっている作品（例: `UnibyteLive`, `UnauthedLogica`）は、DB レベルで `AI_Optout: false` を設定しても `ai_training.allowed: false` のまま。これは正しい動作。
- **前回コミットの誤り検出**: `git submodule status` で `+` プレフィックスが表示される場合、ワーキングディレクトリのサブモジュールが親リポジトリの記録と異なる。`git ls-tree HEAD creations-db` で記録済みコミットを確認し、必要であれば正しいコミットを `git add creations-db` で修正する。

### 自動チェックの仕組み（tools/ と Stop フック）

サブモジュールの「追従待ち」を検知するための仕組みが 2 段構成で用意されている。

| ファイル | 役割 |
|---|---|
| `tools/check-creations-db-update.sh` | **ネットワーク非依存**のゲートスクリプト。親リポジトリの記録 gitlink（`git ls-tree HEAD creations-db`）とサブモジュール作業ツリーの HEAD を比較するだけ。終了コード `10`=追従済み / `0`=更新あり（`UPDATE_AVAILABLE <recorded> <working>` を出力） / `1`=エラー。 |
| `tools/hook-check-submodule.sh` | Claude Code **Stop フック用ラッパー**。`origin/addon-ai-tag` を fetch（失敗は無視）してから上記スクリプトを呼び、追従待ちのときだけ通知と反映コマンドを表示する。常に終了コード 0 でセッション終了をブロックしない。 |

- フックは `.claude/settings.json` の `hooks.Stop` に登録されている。
- 設計方針: fetch や `git submodule update --remote` といったネットワーク操作はネットワークが通る側（ローカル Windows の git、または GitHub Actions）が担当し、`check-creations-db-update.sh` は判定のみを担う分業型。
- 通知が出たら、本手順書の「#### 3〜5」（サブモジュール更新 → 再ビルド → コミット）を実行する。

### ビルド出力ファイル一覧
| ファイル | 内容 |
|---|---|
| `ai-dataset/index.json` | 全作品のマスターインデックス（`ai_training.allowed` ステータス含む） |
| `ai-dataset/works/Works_*.json` | 作品別フラットデータ |
| `ai-dataset/manifest.jsonl` | LLM 取り込み向け JSONL |
| `ai-dataset/manifest-training.jsonl` | AI 学習許可データのみの JSONL |
| `ai-dataset/image-index.json` | 全画像パス一覧 |
| `ai-dataset/build-info.json` | ビルドメタ情報（サブモジュールコミット等） |
