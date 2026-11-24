# 変更履歴

## 2026-11-24 — 画像ごとの形態・衣装・参考用区分（CreationsDB #63）

- `Images_Appearance` の `arts_PNGPath` 以外の画像フィールドと、`Costume` / `ReferenceOnly` を受け付ける。辞書コード＝確認済み、`null`＝共通、キー無し＝未確認を区別し、未定義コード・不明な項目・真偽値でない `ReferenceOnly` は生成を停止する。
- `images.arts` / `images.design_alt` に `form_common` / `costume` / `costumes` / `costume_common` / `reference_only` を投影する。いずれも許諾は変えない。
- `preferred_reference_images` は参考用の画像と、形態の手がかりが無い未確認の arts を代表に選ばない（従来は concept が無いとき未確認の arts を両形態の代表へ回していた）。共通指定の画像はどの形態にも選べる。
- 上流の新しい対応表を読むため、サブモジュールは CreationsDB #63 の取り込み後のコミットへ更新する。

## 2026-11-22 — 完成絵の形態と登場人物（CreationsDB #28）

- 上流の `addon-ai-tag` が生成した登場記録を、利用許可済み画像の `form`・`characters` に反映。1枚に同じ人物の複数形態が登場する場合は `forms` に全形態を保持し、形態別の代表画像の選択にも使う。
- 検証器は画像参照を原本から再解決し、形態・登場人物と共有画像の除外を照合する。

## 2026-11-20 — 部位図の索引復元（Issue #4）

- `AppearanceDetail[].img_PNGName` を同じDBの `attr/**` の実名と照合し、既存のレコード許可・共有拒否に従って画像許可表へ登録する。部位図に `Images.*` 用の画像単位指定や衣装除外を転用せず、61の共用番号図も維持する。
- 未宣言画像・別DBの同名画像は補完しない。同じDBで名前が曖昧なら生成を停止し、symlinkを実画像として許可しない。
- 許可された部位図が索引から欠落した場合にvalidatorを失敗させる。回帰テストを拡張し、AGENTS.mdと機械可読ポリシーを同期した。
- 再生成で許可部位図119件を復元し、画像索引は481→600件（attrは11→130件）。許可187/732件、D-Vines4人と61の衣装・説明・対象画像3件の除外は維持する。

検証と未宣言10件の調査: [_work_in_progress/2026-11-20_progress_attr-image-index.md](_work_in_progress/2026-11-20_progress_attr-image-index.md)。
