# 100BeautiesLab_CreationsAI

> **非公式・非営利** の AI 学習データセットリポジトリ
> サークル「百花繚乱研究所」（RadianN_kswg）の一次創作作品を、生成 AI・機械学習モデルが直接取得・学習できるよう整形して提供します。

---

## ⚠️ 重要: 帰属表示・利用条件

原著作物の権利はすべて **RadianN_kswg（ラジアン/柏木主税）** に帰属します。

| 項目                   | 内容                                                           |
| ---------------------- | -------------------------------------------------------------- |
| **ライセンス**         | [CC BY-NC 4.0](http://creativecommons.org/licenses/by-nc/4.0/) |
| **原著者**             | RadianN_kswg（ラジアン/柏木主張）                              |
| **原リポジトリ**       | https://github.com/radiann-kswg/100BeautiesLab_CreationsDB     |
| **本リポジトリの状態** | 非公式・非営利                                                 |

詳細は [NOTICE.md](./NOTICE.md) および [LICENCE](./LICENCE) を参照してください。

---

## リポジトリ構成

```
100BeautiesLab_CreationsAI/
├── creations-db/              # Git サブモジュール（100BeautiesLab_CreationsDB @ develop / addon-ai-tag）
│   └── data/                  #   原著作物のデータ（JSON・画像）← 変更禁止
├── ai-dataset/                # 自動生成 AI 学習データセット ← 手動編集禁止
│   ├── index.json             #   全作品・全キャラクターのマスターインデックス
│   ├── image-index.json       #   全画像パス一覧（作品・キャラクター別）
│   ├── manifest.jsonl         #   LLM 取り込み向け JSONL（1行1レコード / 全件・ポリシーフラグ付き）
│   ├── manifest-training.jsonl#   上記のうち ai_training.allowed = true レコードのみ（推奨入口）
│   ├── policy.json            #   AI 学習利用ポリシーの機械可読サマリ
│   ├── build-info.json        #   ビルドメタ情報（生成日時・サブモジュールコミット + ai_training_stats）
│   └── works/                 #   作品別フラットデータ JSON
├── docs/
│   └── usage-gemini-chatgpt-novelai.md  # Gemini / ChatGPT / NovelAI 向け運用ガイド
├── scripts/
│   └── build-dataset.js       # データセット生成スクリプト（読み取り専用）
├── .github/workflows/
│   └── sync-dataset.yml       # GitHub Actions: サブモジュール更新時に自動再生成
├── LICENCE                    # CC BY-NC 4.0（サブモジュールから継承）
└── NOTICE.md                  # 帰属表示・AI 学習利用条件
```

---

## 収録作品

以下の作品データが `creations-db/data/` サブモジュール経由で参照されます。

| キー                           | 作品タイトル（日本語） | 英語タイトル               |
| ------------------------------ | ---------------------- | -------------------------- |
| `#Works_NumberTales`           | ナンバーテールズ       | NumberTales                |
| `#Works_DestinyFoxRecords`     | 運命線狐の記録         | Destiny Fox's Records      |
| `#Works_FLInvestigator78`      | 運命線探偵 78          | Fate-Line Investigators 78 |
| `#Works_ShouArRiders`          | 獣爾騎兵               | Shau'er Riders             |
| `#Works_SinisterChangingGirls` | 豹変系女子             | Sinister Changing Girls    |
| `#Works_PastDivers`            | パストダイヴァー       | PastDivers                 |
| `#Works_UnauthedLogica`        | アンオースドロジカ     | UnauthedLogica             |
| `#Works_Proxies`               | ラジアン代理           | Proxies                    |

最新の作品一覧は `ai-dataset/index.json` を参照してください。

---

## AI サービス向けクイックスタート

### ⚠️ AI 学習利用ポリシー（暫定）

本リポジトリでは、創作 DB 側で正規の AI フラグ実装が完了するまでの **暫定対応** として、
以下の作品×DB のみ AI 学習・生成への利用を許可しています。

| 作品                 | DB                | AI 学習・生成     | 備考                                                                 |
| -------------------- | ----------------- | ----------------- | -------------------------------------------------------------------- |
| `#Works_NumberTales` | `db_Primary.json` | ✅ 許可           | AIHints 二層構造 (`common` + `forms.{corefolder,humanoid}`) 実装済み |
| 上記以外の作品・DB   | 全て              | ⛔ 抑止（整備中） | 上流リポジトリで正規フラグ実装後に解除予定                           |

- 機械可読なポリシー: [`ai-dataset/policy.json`](./ai-dataset/policy.json)
- フィルタリング済みサブセット (推奨): [`ai-dataset/manifest-training.jsonl`](./ai-dataset/manifest-training.jsonl)
- 全レコードには `ai_training.allowed` フラグが付与されます。`manifest.jsonl` を使う場合は
  必ず `record.ai_training.allowed === true` でフィルタしてから利用してください。

### Gemini / ChatGPT / NovelAI での運用手順

各サービスごとのプロンプト組み立て方、`AIHints` 二層構造の使い方、Python サンプルを
[`docs/usage-gemini-chatgpt-novelai.md`](./docs/usage-gemini-chatgpt-novelai.md) にまとめています。

- **NovelAI / SD**: `ai_hints.forms.<form>.prompt_export` / `negative_prompt_export` をそのまま貼付
- **ChatGPT**: `common.natural_language_description` + `forms.<form>.natural_language_description` + `identity_tags` / `form_tags`
- **Gemini**: 上記 + `forms.<form>.reference_images.main` を参照画像として添付

### リポジトリ全体を取得（サブモジュール込み）

```bash
git clone --recurse-submodules https://github.com/<your-account>/100BeautiesLab_CreationsAI.git
```

### データセットの主要エントリポイント

| ファイル                             | 用途                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `ai-dataset/manifest-training.jsonl` | **AI 学習許可済み**レコードのみの JSONL（推奨入口）                          |
| `ai-dataset/manifest.jsonl`          | LLM の学習・RAG 用 JSONL（1行1レコード、`ai_training` フラグ付き）           |
| `ai-dataset/policy.json`             | AI 学習利用ポリシーの機械可読サマリ                                          |
| `ai-dataset/index.json`              | 全作品・全キャラクターの一覧インデックス（`ai_training` 付き）               |
| `ai-dataset/image-index.json`        | 全画像の相対パス一覧（`creations-db/` を基点とするパス、`ai_training` 付き） |
| `ai-dataset/works/<WorkDir>.json`    | 作品別フラットデータ（`ai_training` 付き）                                   |

### 画像ファイルへのアクセス

画像パスは `creations-db/` を基点とした相対パスで記録されています。

```python
import json, os

with open("ai-dataset/image-index.json") as f:
    idx = json.load(f)

# 例: ナンバーテールズの全画像パス
for img_path in idx["works"]["#Works_NumberTales"]["images"]:
    full_path = os.path.join("creations-db", img_path)
    # full_path を画像ローダーに渡す
```

### JSONL の読み込み例

```python
import json

# 推奨: フィルタ済みの training サブセットを使う
with open("ai-dataset/manifest-training.jsonl") as f:
    for line in f:
        record = json.loads(line)
        if record["_type"] == "character":
            print(record["work_title_ja"], record["id"])
            hints = record.get("ai_hints")    # = data.AIHints と同一
            if hints:
                corefolder = hints["forms"].get("corefolder", {})
                print("prompt:", corefolder.get("prompt_export"))

# manifest.jsonl を直接使う場合は ai_training.allowed でフィルタを忘れずに
with open("ai-dataset/manifest.jsonl") as f:
    for line in f:
        record = json.loads(line)
        if record["_type"] != "character":
            continue
        if not record["ai_training"]["allowed"]:
            continue   # 整備中のレコードはスキップ
        # record["data"] に原著作物のキャラクターデータが格納されています
        # record["images"] に画像パス（作品カテゴリ別）が格納されています
```

---

## サブモジュールの更新と自動再生成

サブモジュール (`creations-db`) の参照コミットを更新すると、
GitHub Actions ワークフロー ([sync-dataset.yml](./.github/workflows/sync-dataset.yml)) が
自動的にビルドスクリプトを実行して `ai-dataset/` を再生成・コミットします。

### 手動でサブモジュールを最新に更新する手順

```bash
# 1. サブモジュールを develop ブランチの最新に更新
git submodule update --remote --merge creations-db

# 2. 更新をコミット（これが GitHub Actions のトリガーになる）
git add creations-db
git commit -m "chore: update creations-db submodule"
git push
```

または GitHub Actions の手動実行 (workflow_dispatch) から
「サブモジュールを develop ブランチの最新に更新する」オプションを有効にして実行できます。

### ローカルでビルドスクリプトを実行する

```bash
# Node.js 18+ が必要
node scripts/build-dataset.js --verbose
```

---

## データ不変性の保証

- `creations-db/` 以下のすべてのファイル（JSON・画像）は **読み取り専用** です。
- ビルドスクリプト (`scripts/build-dataset.js`) は `creations-db/` への書き込みを一切行いません。
- `ai-dataset/` 内のファイルはビルドスクリプトによる **派生生成物** であり、原データを加工したものではありません。

---

## 関連リンク

- [運用ガイド (Gemini / ChatGPT / NovelAI)](./docs/usage-gemini-chatgpt-novelai.md)
- [原リポジトリ (100BeautiesLab_CreationsDB)](https://github.com/radiann-kswg/100BeautiesLab_CreationsDB)
- [AIHints 仕様 (上流 docs)](./creations-db/docs/ai-hints-usage.md)
- [百花繚乱研究所 データベース UI](https://database.numbertales-radiann.net/)
- [ナンバーテールズ公式サイト](http://www.numbertales-radiann.com/)
- [第三者の運用規約（原リポジトリ）](https://github.com/radiann-kswg/100BeautiesLab_CreationsDB/blob/develop/docs/third-party-policy.md)
- [ガイドライン（原リポジトリ）](https://github.com/radiann-kswg/100BeautiesLab_CreationsDB#%E4%B8%80%E6%AC%A1%E5%89%B5%E4%BD%9C%E4%BD%9C%E5%93%81%E3%81%AB%E3%81%8A%E3%81%91%E3%82%8B%E3%82%AC%E3%82%A4%E3%83%89%E3%83%A9%E3%82%A4%E3%83%B3%E6%97%A5%E6%9C%AC%E8%AA%9E%E7%89%88)
