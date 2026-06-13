# AGENTS.md — AI エージェント向け作業手順書

このファイルは Claude Code 等の AI エージェントが定期的な更新作業を行うための手順書です。

---

## 作業: `creations-db/addon-ai-tag` の変更をAIデータセットに反映する

### トリガー
「サブモジュール `creations-db` の `addon-ai-tag` ブランチの変更に基づいて、このリポジトリのAIタグ機能を更新してください」というユーザー指示。

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

### ビルド出力ファイル一覧
| ファイル | 内容 |
|---|---|
| `ai-dataset/index.json` | 全作品のマスターインデックス（`ai_training.allowed` ステータス含む） |
| `ai-dataset/works/Works_*.json` | 作品別フラットデータ |
| `ai-dataset/manifest.jsonl` | LLM 取り込み向け JSONL |
| `ai-dataset/manifest-training.jsonl` | AI 学習許可データのみの JSONL |
| `ai-dataset/image-index.json` | 全画像パス一覧 |
| `ai-dataset/build-info.json` | ビルドメタ情報（サブモジュールコミット等） |
