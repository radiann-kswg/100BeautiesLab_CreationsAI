# 運用ガイド — Gemini / ChatGPT / NovelAI

> 本書は **100BeautiesLab_CreationsAI** データセットを Gemini, ChatGPT (DALL-E系画像生成), NovelAI (Stable Diffusion 系) で
> 実際にどう運用するかをまとめた手順書です。
> 各キャラクターレコードに添付される `AIHints`（二層構造: `common` + `forms.<form>`）を最大限活用します。

---

## 0. はじめに — 必ず読んでください

### 0.1 ライセンス・利用条件

- ライセンス: **[CC BY-NC 4.0](http://creativecommons.org/licenses/by-nc/4.0/)**
- 原著者: **RadianN_kswg（ラジアン/柏木主税）**
- 出典: <https://github.com/radiann-kswg/100BeautiesLab_CreationsDB>
- 商用モデルの学習・商用サービスへの組み込みは **原則禁止**。
- 利用時は **出典を明記**し、改変した場合は **改変内容を明記**してください。
- 詳細は [NOTICE.md](../NOTICE.md) を参照。

### 0.2 AI 学習利用ポリシー（重要）

**AI 学習・生成への利用可否は `creations-db` サブモジュールの `db_meta.json` に設定された `AI_Optout` フラグに基づき DB 単位で自動判定されます。**
`AI_Optout: true` の DB は `ai_training.allowed = false`、未設定は `allowed = true` です。
現時点では `Works_NumberTales / DB_Primary` のみが `allowed=true` です。

許可状況の機械可読版は [`ai-dataset/policy.json`](../ai-dataset/policy.json) を参照してください。

```jsonc
// ai-dataset/policy.json (抜粋)
{
  "ai_training_policy": {
    "note": "db_meta.json の AI_Optout フラグに基づき DB 単位で利用可否を判定します。",
    "policy_source": "data/Works_<work>/DataBases/db_meta.json — Databases[\"#DB_<Name>\"].AI_Optout",
    "disallowed_default": false,
  },
}
```

利用者側で **必ず以下のフィルタリング**を行ってください:

```python
import json

with open("ai-dataset/manifest.jsonl", encoding="utf-8") as f:
    for line in f:
        rec = json.loads(line)
        if rec.get("_type") == "character" and rec["ai_training"]["allowed"]:
            # ここだけが学習・生成に使ってよいレコード
            ...
```

もしくは、最初からフィルタ済みのサブセット [`ai-dataset/manifest-training.jsonl`](../ai-dataset/manifest-training.jsonl) を読み込めば同等の結果になります。

---

## 1. データセットの構造（要点）

```
ai-dataset/
├── index.json                 # 作品一覧（ai_training フラグ付き）
├── image-index.json           # 画像パス一覧（作品別、ai_training フラグ付き）
├── manifest.jsonl             # 全レコード（policy フィルタは各 record.ai_training で）
├── manifest-training.jsonl    # AI 学習許可済みレコードのみ（推奨入口）
├── policy.json                # 機械可読の運用ポリシー
├── build-info.json            # ビルドメタ情報
└── works/<WorkDir>.json       # 作品別フラットビュー
```

### 1.1 キャラクターレコードのスキーマ（manifest 系 JSONL）

```jsonc
{
  "_type": "character",
  "id": "14",                                  // db のキー
  "work_key": "#Works_NumberTales",
  "work_title_ja": "ナンバーテールズ",
  "work_title_en": "NumberTales",
  "db_source": "data/Works_NumberTales/DataBases/db_Primary.json",

  // 👇 利用可否（db_meta.json の AI_Optout フラグ由来）
  "ai_training": {
    "allowed": true,
    "reason": "curated: ... AIHints (two-layer: common + forms) ..."
  },

  // 👇 AIHints をトップレベルにも露出（data.AIHints と同一参照）
  "ai_hints": {
    "common": { /* identity_tags, palette_priority, natural_language_description, ... */ },
    "forms": {
      "corefolder": { /* form_tags, outfit_features, ai_tags, prompt_export, reference_images, ... */ },
      "humanoid":   { /* 同上 */ }
    }
  },
  "has_ai_hints": true,

  // 👇 キャラなりきり用ロールプレイプロンプト（2026-07-19 追加。本文はパス参照のみ）
  "has_roleplay_prompt": true,
  "roleplay_prompt": { "path": "data/Works_NumberTales/RoleplayPrompts/DB_Primary/roleplay-prompt-14.md" },

  // 原データ（変更なし）
  "data": { /* Num, Name, Character, Summary, AIHints (=ai_hints と同じ), ... */ },

  // 画像パス（DB 種別ごと）
  "images": {
    "DB_Primary": ["data/Works_NumberTales/Images/DB_Primary/14/emstk_corefolder14-1.png", ...]
  }
}
```

> **2026-07-19 追加 (ロールプレイプロンプト)**: 各レコードに `has_roleplay_prompt` / `roleplay_prompt` が付きます。
> `true` のレコードは `roleplay_prompt.path`（`creations-db/` 基点）にキャラ単位のロールプレイプロンプト Markdown があり、
> ChatGPT 等のキャラなりきり用システムプロンプトとしてそのまま貼付できます（本文は非埋め込み・パス参照のみ）。
> 上流 `tools/build-roleplay-prompts.mjs` が `ConversationPattern` 等の充填済みフィールドから機械生成したものです。
> 採否はレコードの `ai_training` ゲートに従い、不許可レコードの生成物は `manifest-training.jsonl` には含まれません。

### 1.2 `AIHints` 二層構造の早見表

| 層                 | 主な用途                       | 主なフィールド                                                                                                                                                                                             |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common`           | 形態を問わない素体特徴         | `identity_tags`, `silhouette_features`, `immutable_traits`, `expression_tendency`, `age_appearance`, `palette_priority`, `natural_language_description`                                                    |
| `work_common`      | 作品共通の参照画像・設計図     | `reference_images.corefolder_reference[]`, `reference_images.humanoid_reference[]` （2026-06-08 追加）                                                                                                     |
| `forms.corefolder` | 装備姿 (コアフォルダ形態) 固有 | `form_tags`, `outfit_features`, `silhouette_notes`, `immutable_constraints`, `negative_keywords`, `ai_tags`, `prompt_export`, `negative_prompt_export`, `reference_images`, `natural_language_description` |
| `forms.humanoid`   | 人型通常姿 固有                | 同上                                                                                                                                                                                                       |
| `alt_modes`        | 将来予約モード格納             | `corefolder_dressed.allowed`, `corefolder_dressed.outfit_source` （2026-06-08 追加、現状全件 `null`）                                                                                                      |

> **2026-06-09 以降 (AIタグ機能強化 その４)**: `forms.<form>.silhouette_notes` は
> `{ body_description: string[], attached_items: string[] }` の object 形式に統一されました。
> `body_description` は素体（球体本体・人型上半身・頭部等）の記述、`attached_items` は装着付属品（ハーネス・スカーフ・リボン・首輪・髪飾り等）の記述を保持します。
> `manifest-training.jsonl` を読む際は以下のように二つの配列を連結して使うと使いやすい:
>
> ```python
> sn = (form.get("silhouette_notes") or {}) or {}
> notes = (sn.get("body_description") or []) + (sn.get("attached_items") or [])
> ```

詳細は 上流の [`docs/ai-hints-usage.md`](../creations-db/docs/ai-hints-usage.md) を参照してください。

---

## 2. NovelAI / Stable Diffusion 系での運用

`forms.<form>.prompt_export` / `negative_prompt_export` を **そのまま貼り付ける**だけで動きます。

### 2.1 最短手順

1. キャラクター ID と形態 (`corefolder` or `humanoid`) を決める。
2. `ai-dataset/manifest-training.jsonl` から該当レコードを取り出す。
3. `ai_hints.forms.<form>.prompt_export` を Positive、`negative_prompt_export` を Negative に貼付。

### 2.2 Python サンプル

```python
import json

TARGET_WORK = "#Works_NumberTales"
TARGET_ID   = "14"   # NumberTales #15 (配列上は id=14 が "15" を指す場合あり。 work.json で確認)
FORM        = "corefolder"

with open("ai-dataset/manifest-training.jsonl", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        if r.get("_type") != "character": continue
        if r["work_key"] != TARGET_WORK:  continue
        if r["id"] != TARGET_ID:           continue
        hints = r.get("ai_hints") or {}
        form  = (hints.get("forms") or {}).get(FORM) or {}
        print("POSITIVE:", form.get("prompt_export", ""))
        print("NEGATIVE:", form.get("negative_prompt_export", ""))
        break
```

### 2.3 注意

- `prompt_export` は **Danbooru/NovelAI 互換語**に正規化済み（例: `multiple fox tails`）。
  プロジェクト固有の造語 (`branching fox tails` 等) は `identity_tags` 側に隔離されています。
- 画像が無いキャラ (`Progress: "notProceeded"` など) は `AIHints` 自体が未付与の場合があります。
  `has_ai_hints === false` のレコードは生成スキップしてください。

---

## 3. ChatGPT (DALL-E 系) での運用

自然文プロンプトに **`common` の素体特徴**と **`forms.<form>` の形態特徴**を分けて貼ります。

### 3.1 プロンプト テンプレート

```
このキャラクターを描いてください。

[素体特徴]
{common.natural_language_description}

[今回の姿]
{forms.<form>.natural_language_description}

[シルエット / 外見ノート] （2026-06-09 以降、object 形式）
- 素体: {forms.<form>.silhouette_notes.body_description をカンマ区切り}
- 装着品: {forms.<form>.silhouette_notes.attached_items をカンマ区切り}

[識別記号 (必ず満たしてください)]
- {common.identity_tags をカンマ区切り}
- {forms.<form>.form_tags をカンマ区切り}

[不変制約]
{forms.<form>.immutable_constraints をカンマ区切り}

[避けるべき要素]
{forms.<form>.negative_keywords / forms.<form>.negative_visuals をカンマ区切り}
```

### 3.2 Python での組み立てサンプル

```python
def build_chatgpt_prompt(record, form="corefolder"):
    h    = record["ai_hints"]
    c    = h["common"]
    f    = h["forms"][form]
    sn   = f.get("silhouette_notes") or {}
    body = sn.get("body_description") or []
    att  = sn.get("attached_items")  or []
    return f"""このキャラクターを描いてください。

[素体特徴]
{c.get("natural_language_description", "")}

[今回の姿]
{f.get("natural_language_description", "")}

[シルエット / 外見ノート]
- 素体: {", ".join(body)}
- 装着品: {", ".join(att)}

[識別記号 (必ず満たしてください)]
- {", ".join(c.get("identity_tags", []))}
- {", ".join(f.get("form_tags", []))}

[不変制約]
{", ".join(f.get("immutable_constraints") or [])}

[避けるべき要素]
{", ".join((f.get("negative_keywords") or []) + (f.get("negative_visuals") or []))}
"""
```

### 3.3 注意

- `identity_tags` は 3〜5 個に絞られています。**すべて維持**することが識別保持の条件です。
- 形態識別タグの先頭 (`corefolder form` / `humanoid form`) は **必須**。省略すると形態混在が起きやすくなります。

---

## 4. Gemini での運用

Gemini は画像参照を取り込めるので、`reference_images.main` を **添付**して指示すると最も精度が高くなります。

### 4.1 プロンプト テンプレート

```
以下の参照画像と同じキャラクターを、別のポーズで描いてください。

参照画像 (キャラ個別): {forms.<form>.reference_images.main}
参照画像 (作品共通設計図, 2026-06-08 以降):
  - {work_common.reference_images.corefolder_reference の各 URL}
  - {work_common.reference_images.humanoid_reference   の各 URL}

[素体特徴]
{common.natural_language_description}

[今回の姿]
{forms.<form>.natural_language_description}

[シルエット / 外見ノート] （2026-06-09 以降 object 形式）
- 素体: {forms.<form>.silhouette_notes.body_description}
- 装着品: {forms.<form>.silhouette_notes.attached_items}

[識別記号 (必ず満たしてください)]
- {common.identity_tags}
- {forms.<form>.form_tags}

[不変制約]
- {forms.<form>.immutable_constraints}

[パレット参考]
primary: {common.palette_priority.primary}
secondary: {common.palette_priority.secondary}
accent: {common.palette_priority.accent}
```

### 4.2 参照画像 URL について

`reference_images.*` は GitHub Pages の公開ドメイン (`https://database.numbertales-radiann.net/...`) を指します。
ローカル画像を使う場合は `image-index.json` の `creations-db/...` 相対パスから組み立ててください。

```python
import os, json
with open("ai-dataset/image-index.json", encoding="utf-8") as f:
    idx = json.load(f)

# 例: NumberTales のローカル画像
for rel in idx["works"]["#Works_NumberTales"]["images"]:
    local = os.path.join("creations-db", rel)
    # local を Gemini API のファイル添付に使う
```

---

## 5. 共通: AI 学習許可フィルタの実装パターン

### 5.1 manifest-training を使う（推奨）

```python
import json

records = []
with open("ai-dataset/manifest-training.jsonl", encoding="utf-8") as f:
    for line in f:
        records.append(json.loads(line))

# header と dictionary を除外して character のみ取り出す
chars = [r for r in records if r.get("_type") == "character"]
print(f"AI 学習許可済みキャラクター: {len(chars)}")
```

### 5.2 manifest.jsonl から動的にフィルタ

```python
with open("ai-dataset/manifest.jsonl", encoding="utf-8") as f:
    chars = [
        r for line in f
        if (r := json.loads(line)).get("_type") == "character"
           and r.get("ai_training", {}).get("allowed")
    ]
```

### 5.3 policy.json でホワイトリストを確認

```python
with open("ai-dataset/policy.json", encoding="utf-8") as f:
    policy = json.load(f)

print(policy["ai_training_policy"]["policy_source"])
# → 'creations-db サブモジュール: data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"].AI_Optout'
```

---

## 6. 整備中作品の取り扱い

以下の作品/DB は `db_meta.json` に `AI_Optout: true` が設定されているため、
`ai_training.allowed = false` が付き、`manifest-training.jsonl` には含まれません。

- `#Works_NumberTales` × `db_SemiPrimary.json` / `db_SelfSecondary.json` / `db_Secondary.json`
- `#Works_NumberTales` × `db_UnprocessedSecondary.json`（`db_meta.json` にエントリなし → 保守的フォールバック）
- `#Works_DestinyFoxRecords` (全 DB)
- `#Works_FLInvestigator78` (全 DB)
- `#Works_ShouArRiders` (全 DB)
- `#Works_SinisterChangingGirls` (全 DB)
- `#Works_PastDivers` (全 DB)
- `#Works_UnauthedLogica` (全 DB)
- `#Works_Proxies` (全 DB)
- `#Works_UnibyteLive` (全 DB)

各作品の整備が完了し `AI_Optout` フラグが解除された時点で、次回ビルド時に自動的に `allowed=true` に移行します。
`scripts/build-dataset.js` 側の変更は不要です（`AI_TRAINING_ALLOWLIST` は削除済み）。

---

## 7. よくある運用パターン

### 7.1 RAG 用の前処理（ChatGPT / Gemini）

```python
import json

docs = []
with open("ai-dataset/manifest-training.jsonl", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        if r.get("_type") != "character": continue
        d = r["data"]
        # 検索/埋め込みに使うテキストを抽出
        docs.append({
            "id": f'{r["work_key"]}::{r["id"]}',
            "title": d.get("FormalName") or d.get("Name") or r["id"],
            "summary": d.get("Summary", ""),
            "character": d.get("Character", ""),
            "ai_tags": (r.get("ai_hints", {}).get("forms", {}).get("corefolder", {}) or {}).get("ai_tags", []),
        })
```

### 7.2 一括画像生成（NovelAI バッチ）

```python
import json
from pathlib import Path

out = Path("prompts/")
out.mkdir(exist_ok=True)

with open("ai-dataset/manifest-training.jsonl", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        if r.get("_type") != "character": continue
        if not r.get("has_ai_hints"): continue
        for form_name, form in (r["ai_hints"].get("forms") or {}).items():
            pos = form.get("prompt_export")
            neg = form.get("negative_prompt_export", "")
            if not pos: continue
            (out / f'{r["id"]}-{form_name}.txt').write_text(
                f"# {r['data'].get('FormalName','')}\nPOSITIVE: {pos}\nNEGATIVE: {neg}\n",
                encoding="utf-8",
            )
```

---

## 8. 参考リンク

- 上流 `creations-db` の AIHints 仕様: [`docs/ai-hints-usage.md`](../creations-db/docs/ai-hints-usage.md)
- 上流の第三者ポリシー: [`docs/third-party-policy.md`](../creations-db/docs/third-party-policy.md)
- 本リポジトリの帰属表示: [NOTICE.md](../NOTICE.md)
- ビルドスクリプト本体: [`scripts/build-dataset.js`](../scripts/build-dataset.js)
