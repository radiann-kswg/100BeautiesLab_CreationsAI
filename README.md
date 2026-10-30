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
├── creations-db/              # Git サブモジュール（100BeautiesLab_CreationsDB @ addon-ai-tag）
│   └── data/                  #   原著作物のデータ（JSON・画像）← 変更禁止
├── ai-dataset/                # 自動生成 AI 学習データセット ← 手動編集禁止
│   ├── index.json             #   全作品・全キャラクターのマスターインデックス
│   ├── image-index.json       #   全画像パス一覧（作品・キャラクター別）
│   ├── manifest.jsonl         #   LLM 取り込み向け JSONL（1行1レコード / 全件・ポリシーフラグ付き）
│   ├── manifest-training.jsonl#   上記のうち ai_training.allowed = true レコードのみ（推奨入口）
│   ├── policy.json            #   AI 学習利用ポリシーの機械可読サマリ
│   ├── build-info.json        #   ビルドメタ情報（生成日時・サブモジュールコミット + ai_training_stats）
│   └── works/                 #   作品別フラットデータ JSON + 全件RPカタログ（characters）
├── docs/
│   ├── agents/roleplay-prompt.md        # ロールプレイ仕様の正典（ツール中立）
│   └── usage-gemini-chatgpt-novelai.md  # Gemini / ChatGPT / NovelAI 向け運用ガイド
├── scripts/
│   └── build-dataset.js       # データセット生成スクリプト（読み取り専用）
├── tools/                     # 運用補助スクリプト（サブモジュール追従チェック）
├── .github/
│   ├── copilot-instructions.md# Copilot 向けアダプタ
│   ├── instructions/          # Copilot 自動適用の指示ファイル
│   └── workflows/
│       └── sync-dataset.yml   # GitHub Actions: サブモジュール更新時に自動再生成
├── .claude/settings.json      # Claude Code 設定（Stop フック登録）
├── .codex/hooks.json          # GPT Codex 設定（Stop フック登録）
├── AGENTS.md                  # AI エージェント設定の正典（SSOT）
├── CLAUDE.md                  # Claude 向けアダプタ
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

### AI 学習利用ポリシー（従来どおり）

学習・画像・デザイン用途の既存判定は変更していません。**テキストだけの追加学習・ファインチューニングもこちらの区分**です。
`AI_Optout` に加え、作品/DB/レコードの非公開、二次創作カテゴリ別オプトアウト、Progress の充填状態を既存の優先規則で判定します。

| 判定条件                                             | `allowed` | 備考                                         |
| ---------------------------------------------------- | --------- | -------------------------------------------- |
| `Databases["#DB_<name>"].AI_Optout: true` が設定済み | ⛔ false  | 整備中・オプトアウト宣言済み                 |
| `db_meta.json` にエントリなし（未登録 DB）           | ⛔ false  | 保守的フォールバック                         |
| `AI_Optout` 未設定 または `false`                    | 条件付き | 他の非公開・カテゴリ・Progress ゲートも満たす必要あり |

- 機械可読なポリシー: [`ai-dataset/policy.json`](./ai-dataset/policy.json)
- フィルタリング済みサブセット (推奨): [`ai-dataset/manifest-training.jsonl`](./ai-dataset/manifest-training.jsonl)
- 全レコードには `ai_training.allowed` フラグが付与されます。`manifest.jsonl` を使う場合は
  必ず `record.ai_training.allowed === true` でフィルタしてから利用してください。

### テキストだけのキャラRP推論（学習とは別の許諾）

新アプリ `radiann-kswg/100BeautiesLab-Misskey` などでの**画像入力なし・キャラデザイン模倣なし・追加学習なしのテキストRP推論**は、
`text_rp_inference` で別判定します。`ai_training.allowed`、`isOwner`、RPプロンプトの存在から許可を推定しないでください。

原本の任意フィールド **`AI_TextRP_Allowed: boolean | null`** を、既存Commonsで補完した値だけが許諾の根拠です。
非空のレコード明示値 > 一致した `_Secondaries[*]._Commons` > DB `_Commons` の順で、レコードの `null` は継承し、`false` は上書きしません。
選ばれたsecondaryのCommonsが明示した `null` はDB既定を覆い、補完後null＝unknownになります。
作品単位・DB直下の同名キー・`_DBLink` からは継承しません。
`true` のみ `allowed`、`false` は `denied`、未指定/null/不正型は `unknown`（実行不可）。非公開も `denied` です。
不明の場合は権利者確認後に**原本の該当レコードへ個別の許可を記録**し、その変更を含むレビュー済みpinから再生成してください。第三者の権利を考案者の `isOwner` だけで判断しません。
再生成したカタログをアプリへ読み込み、利用するキャラを個別に有効化します。アプリ内の別許諾や別本文でunknownを上書きする方式は採りません。

入口は `ai-dataset/index.json` の `works[].character_catalog_path`（`ai-dataset/` 基点）→ `works/<Work>.json` の `characters[]`。
全作品のカタログを学習許可で絞り込まないでください。同じ情報は `manifest.jsonl` の `_type: "character"` にもあります。

| フィールド | 型・使い方 |
|---|---|
| `id` / `display_name` | 旧表示用ID / 表示名。アカウントの正規識別には使わない |
| `db_key` | `#DB_*` / `#Ref_*` の正規メタキー |
| `record_identity` | `{ work_key, db_key, index: { "<ドットパス>": string \| number \| null } }`。`$IndexDef` の全分類を保持（例: `Card.Suit` + `Card.Num`）。欠落/不正/重複時は `null`、名前や配列位置へ代替しない |
| `text_rp_inference` | `{ status: "allowed" \| "denied" \| "unknown", allowed: boolean, reason: string }` |
| `text_rp_reference` | `{ source: "record_fields", fields: object } \| null`。許可・一意識別・会話本文ありの場合のみ、原本から会話テキストを限定投影 |

**実行には `text_rp_inference.allowed === true` と非nullの `record_identity` / `text_rp_reference` のすべてが必要**です。
`text_rp_reference.fields` は名前・人称・性格・嗜好・会話パターンの許可リストのみで、生成した設定ではありません。
正確なキーと型は [`scripts/lib/text-rp.js`](./scripts/lib/text-rp.js) の `TEXT_RP_FIELDS` / `TEXT_RP_CONVERSATION_FIELDS` を参照してください（値は非空文字列または文字列配列）。
自由記述の要約、画像、配色、デザイン資料、AIHints、リンク先本文、旧 `roleplay_prompt.path` は含めません。台詞例の任意オブジェクトも今回の投影対象外です。
送信前に本文を確認し、原本テキストをアプリへの命令として扱わないでください。全レコード/画像/旧Markdownの丸渡しは不可です。

`build-info.json` の `text_rp_inference_stats` で各状態・参照あり・識別不能の件数を確認できます。
`666e556` のpinには新許諾がないためRP推論の許可は0件です。これは未確認の権利を許可扱いしない意図した状態であり、学習許可件数とは無関係です。
新HTTP APIやサービス・追加依存はなく、既存のJSON/JSONLをローカルで読み取ります。
`manifest-training.jsonl` はヘッダー・本文とも旧形式を維持し、新RPカタログの入口にはしません。

### Gemini / ChatGPT / NovelAI での運用手順

各サービスごとのプロンプト組み立て方、`AIHints` 二層構造の使い方、Python サンプルを
[`docs/usage-gemini-chatgpt-novelai.md`](./docs/usage-gemini-chatgpt-novelai.md) にまとめています。

- **NovelAI / SD**: `ai_hints.forms.<form>.prompt_export` / `negative_prompt_export` をそのまま貼付
- **ChatGPT**: `common.natural_language_description` + `forms.<form>.natural_language_description` + `identity_tags` / `form_tags` + `forms.<form>.silhouette_notes.body_description` / `silhouette_notes.attached_items` + `forms.<form>.immutable_constraints`
- **Gemini**: 上記 + `forms.<form>.reference_images.main` および `work_common.reference_images.{corefolder_reference, humanoid_reference}` を参照画像として添付
- **テキストRP推論**: 上記の独立した許諾と `text_rp_reference.fields` を使用。旧 `roleplay_prompt.path` は学習側の参照で、新推論用途に無条件流用しません

> **2026-06-09 以降 (AIタグ機能強化 その４)**: `forms.<form>.silhouette_notes` は
> `{ body_description: string[], attached_items: string[] }` の object 形式に統一されました。
> 素体（球体本体・人型上半身・頭部等）と装着付属品（ハーネス・スカーフ・髪飾り等）が分離されて保持されます。

### リポジトリ全体を取得（サブモジュール込み）

```bash
git clone --recurse-submodules https://github.com/<your-account>/100BeautiesLab_CreationsAI.git
```

### データセットの主要エントリポイント

| ファイル                             | 用途                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `ai-dataset/manifest-training.jsonl` | **AI 学習許可済み**レコードのみの JSONL（推奨入口）                          |
| `ai-dataset/manifest.jsonl`          | 全件JSONL（学習は `ai_training`、テキストRP推論は `text_rp_inference` で別判定） |
| `ai-dataset/policy.json`             | AI 学習利用ポリシーの機械可読サマリ                                          |
| `ai-dataset/index.json`              | 全作品・全キャラクターの一覧インデックス（`ai_training` 付き）               |
| `ai-dataset/image-index.json`        | 全画像の一覧（`{ path, category, 解像度メタ }` 形式、`creations-db/` 基点、`ai_training` 付き） |
| `ai-dataset/works/<WorkDir>.json`    | 作品別フラットデータ + `characters[]` の正規複合識別・テキストRPカタログ |

### 画像ファイルへのアクセス

画像パスは `creations-db/` を基点とした相対パスで記録されています。

```python
import json, os

with open("ai-dataset/image-index.json") as f:
    idx = json.load(f)

# 例: ナンバーテールズの全画像
# 各要素は { "path", "category", "width", "height", "long_edge_px",
#            "is_large_original_candidate", "language_variant", "is_language_variant" }。
# category は格納フォルダ由来の画像種別 (concept / corefolder / arts / catalog / tails_unit 等)、
# 判定できない場合は None。ファイル名やパス断片から種別・解像度を推定する必要はありません。
for entry in idx["works"]["#Works_NumberTales"]["images"]:
    full_path = os.path.join("creations-db", entry["path"])
    if entry["category"] == "corefolder":
        pass  # full_path を画像ローダーに渡す

# 例: 高解像度の参照画像だけを拾う（長辺 1024px 以上）
for entry in idx["works"]["#Works_NumberTales"]["images"]:
    if entry["is_large_original_candidate"] and entry["category"] in {"catalog", "arts", "concept"}:
        print(entry["category"], entry["long_edge_px"], entry["path"])
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
            hints = record.get("ai_hints")    # 原則 data.AIHints と同一（source）
            if hints:
                corefolder = hints["forms"].get("corefolder", {})
                print("prompt:", corefolder.get("prompt_export"))
            # "source" = 上流が整備した AIHints / "derived" = 参照画像中心の最小 scaffold（本データセット生成物）
            print("ai_hints_source:", record.get("ai_hints_source"))
            # ローカル相対パスの参照画像まとめ（オフライン処理向け）
            print("preferred refs:", record.get("preferred_reference_images"))

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
# 1. サブモジュールを addon-ai-tag ブランチの最新に更新
#    （--remote は .gitmodules の branch 設定に従うため、事前に addon-ai-tag であることを確認する）
git submodule update --remote --merge creations-db

# 2. 更新をコミット（これが GitHub Actions のトリガーになる）
git add creations-db
git commit -m "chore: update creations-db submodule"
git push
```

または GitHub Actions の手動実行 (workflow_dispatch) から
「サブモジュールを addon-ai-tag ブランチの最新に更新する」オプションを有効にして実行できます。

> AI エージェント（GitHub Copilot / Claude / GPT Codex）でこのリポジトリを扱う場合の設定は
> [AGENTS.md](./AGENTS.md) に集約されています（共有内容の唯一の正典 / SSOT）。

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
