# 部位図の画像索引復元（CreationsAI Issue #4）

## 目的と原因

[Issue #4](https://github.com/radiann-kswg/100BeautiesLab_CreationsAI/issues/4) の部位図欠落を修正する。前回f037968の画像許可表は `Images.*` と `TailsUnit` を集計したが、既存の `AppearanceDetail[].img_PNGName` を画像宣言として登録していなかった。

GeneratorsAIは索引に載った実名だけを部位図として使用するため、この欠落で部位図を選べなくなった。今回の修正はCreationsAI内に閉じ、読み取り専用の `creations-db/` は編集しない。

## 実装と影響範囲

- `scripts/build-dataset.js`: DBごとに `Images/<DB>/attr/**` の実ファイルを一度列挙し、宣言された名前本体と完全一致させる。拡張子は省略可・大小文字を無視する。番号・種類名・別DBから推定せず、同じDBで複数の実ファイルに一致した場合は出力開始前に失敗する。
- 部位図の許否は既存のレコード判定と共有画像の拒否優先に従う。`Images.*` の画像単位指定・衣装除外は部位図へ転用しない。61は通常フードとidolの番号が同じ部位図を使うので、通常側の図まで消さない。衣装のAD項目・AIHints文章・Imagesの3画像の除外は従来経路で維持する。
- `collectImagesRaw()` は実ファイルだけを収集し、拒否画像へのsymlinkを別パスで許可する抜け道を防ぐ。
- `scripts/validate-dataset.js`: 許可表にあるattr画像が索引に存在することを検査し、欠落を検出する。
- `scripts/lib/image-policy.test.js`: 実ビルドfixtureを拡張。Imagesなしの宣言、任意の入れ子フォルダ、実体.PNG、レコード/DB/非公開/Progress拒否、共有拒否、衣装間の共用、別DB同名、未宣言、曖昧名、symlink、索引欠落を確認する。
- `AGENTS.md` / `CHANGELOG.md` / 生成ポリシーへ契約を記録。新しいimages出力キーや画像カテゴリは追加せず、従来の `image_ref_stats` も維持する。
- `ai-dataset/` はスクリプトで再生成し、手動編集しない。

## 未宣言10件の調査

全203 JSONとfa26d38・6f5b37dのmanifestを探索し、大小文字・拡張子・Commons・別DBを考慮しても、以下の実名宣言はなかった。全画像列挙の旧索引に載っていただけなので、番号から補完せず未収録を維持する。これは権利拒否とは別で、利用するには上流で明示参照を追加する必要がある。

| 画像 | 根拠 |
| --- | --- |
| `attr/tailsUnit/attr_tailsUnitNTS-{2B,5,50,58,63,75,87}.png`（7件） | 候補レコードのTailsUnitに形状・本数はあるが `TailsUnit_PNGName` は未指定。2Bの実キーは `2-alt` |
| `attr/numberMark/attr_numberMarkNTS-28-earingBack.png` | 28は `earingFront` のみ宣言 |
| `DB_SelfSecondary/attr/numberMark/attr_numberMarkNTS-{223-lot,753-lot}.png`（2件） | 両レコードにAppearanceDetail自体がなく実名参照なし |

調査証跡はDB作業環境 `.cache/issue4/attr-unreferenced.json` と `attr-path-sets.json`。上流の設定・参照は追加していない。

## 検証

- 修正前の拡張fixtureで、許可された部位図が索引から落ちる失敗を再現。修正後は成功。
- `npm test` は40件成功、失敗・省略0。symlink fixtureもこの環境で実行できた。
- 通常pinからの `node scripts/build-dataset.js` と `node scripts/validate-dataset.js` は成功。11作品/732件、AI利用可187件、画像索引600件。既存の未解決concept参照2件は不変。
- 旧索引481件を維持し、許可部位図119件を復元。attrは11→130件。NumberTales93の番号図を含む。不許可だけが宣言する4件と未宣言10件は追加しない。
- 独立leak auditは19項目すべて成功。旧画像の削除0、新規119は独立分類の許可集合と完全一致。全732レコードの分類・権利・識別とmanifest/training本文は不変で、headerの仕様注記だけ追加した。D-Vines4人、61の衣装4項目・説明・対象3画像、代表画像へのdesignAlt混入はすべて0。証跡は `.cache/issue4/leak-audit.json` / `.md`。
- Ponytail Reviewでsymlinkの迂回を検出し、実ファイル制約とfixtureで修正。最終レビューは追加指摘なし。

## 残作業・対象外

- commit/push後のCI・公開生成物を検証する。
- GeneratorsAI / ShapeChangerAIのローカル同期と下流テストは、その作業環境で行う。今回CreationsDBのschemaや原データ、attr単位の新しいオプトアウト指定は追加しない。
