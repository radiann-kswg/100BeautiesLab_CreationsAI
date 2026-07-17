/**
 * AI 学習利用ポリシーの判定層。
 *
 * 以下フラグを参照し、粗度に応じた別々のレイヤーで AI 学習・生成への利用可否を判定する。
 *
 *  「作品」レイヤー——トップレベル data/db_meta.json 内の CreationWorks["#Works_X"]
 *    Works_Hidden: true  → 作品全体が非公開 → allowed: false
 *
 *  「DB」レイヤー——作品の DataBases/db_meta.json 内の Databases["#DB_X"]
 *    DB_Hidden:  true  → DB 全体が非公開 → allowed: false
 *    AI_Optout:  true  → AI 学習・生成を抑止 → allowed: false
 *    エントリなし  → 保守的フォールバック → allowed: false
 *
 *  「二次創作カテゴリ」レイヤー——Databases["#DB_X"]._Secondaries[*]
 *    AI_Optout:  true  → 該当カテゴリのレコードを抑止 → allowed: false
 *
 *  「キャラクター」レイヤー——個別キャラクターレコード直下
 *    isPrivate:  true  → レコード単位で非公開 → allowed: false
 *    Progress    → $EnumDef_Progress で AI_Unready と宣言された値なら allowed: false
 *
 * **AI_Optout（権利軸）と AI_Unready（充填軸）は別物**。前者は「権利上 AI 学習へ供してはならない」
 * という表明で、後者は「制作が進んでおらず AI 学習へ供する内容が無い」という状態にすぎない。
 * AI_Unready: false は AI 学習の許諾を意味しない。権利上の可否を表明するのは AI_Optout のみ。
 *
 * 判定の正典は上流 creations-db 側にある。本モジュールは db_meta.json の宣言を読むだけで、
 * Progress の語彙リスト等をここに持たない（上流とうちで二重実装すると必ず食い違うため）。
 *
 * 詳細は上流リポジトリ docs/api-sw-spec.md §5.5 を参照。
 */

export const AI_TRAINING_DISALLOWED_WORKS_HIDDEN =
  'Works_Hidden: true is set in db_meta.json for this work. The entire work is non-public and opted out of AI training/generation use.';
export const AI_TRAINING_DISALLOWED_DB_HIDDEN =
  'DB_Hidden: true is set in db_meta.json for this DB. This DB is non-public and opted out of AI training/generation use.';
export const AI_TRAINING_DISALLOWED_REASON =
  'AI_Optout: true is set in db_meta.json for this DB. This DB is opted out of AI training/generation use.';
export const AI_TRAINING_DISALLOWED_NO_META_REASON =
  'No Databases entry found in db_meta.json for this DB key. Treating as opted out (conservative fallback).';
export const AI_TRAINING_DISALLOWED_IS_PRIVATE =
  'isPrivate: true is set on this character record. This record is non-public and opted out of AI training/generation use.';
export const AI_TRAINING_DISALLOWED_SECONDARY_CATEGORY =
  'AI_Optout: true is set in _Secondaries category for this record\'s sec_SeriesTitle. This record is opted out of AI training/generation use.';
export const AI_TRAINING_ALLOWED_REASON =
  'AI_Optout / DB_Hidden / Works_Hidden are not set for this DB. This DB is opted in for AI training/generation use.';

/**
 * Progress による除外理由。AI_Optout（権利軸）と読み違えられないよう、
 * 権利上の opt-out ではないことを理由文自体に明記する。
 */
export function aiTrainingDisallowedProgressUnready(progress) {
  return `Progress: ${JSON.stringify(progress)} is declared AI_Unready in $EnumDef_Progress `
    + '(creation not advanced enough to provide content, or a secondary-work progress state). '
    + 'This is NOT a rights-based opt-out: rights are expressed only by AI_Optout.';
}

/** ポリシー判定に効く値のうち、_Commons が供給しうるもの */
const COMMONS_SUPPLIED_POLICY_FIELDS = ['Progress', 'isPrivate'];

/**
 * _Secondaries の各カテゴリが持つ AI_Optout を集約して返す。
 * sec_SeriesTitle → true のマップと、null タイトルのデフォルトフラグを返す。
 *
 * 注: 上流は b2fd210 でこの判定を sec_SeriesTitle 単独キーから 3 軸マッチャ
 * (sec_SeriesTitle / sec_Category / sec_DesignedBy) へ作り替えている。本実装は旧方式のままで、
 * 「AI_Optout: true のカテゴリ」と「sec_SeriesTitle: null だが sec_Category を持つ opt-in カテゴリ」が
 * 同一 DB に共存すると誤判定する。現行データでは共存しないため出力は上流と一致する。
 * 移植する場合の参照元: creations-db/tools/patch-aihints.mjs の findSecondaryDef()。
 *
 * @param {object|null} dbEntry  DataBases/db_meta.json の Databases["#DB_X"] エントリ
 * @returns {{ map: Map<string,boolean>, defaultOptout: boolean }}
 */
export function buildSecondaryOptoutMap(dbEntry) {
  const map = new Map();
  let defaultOptout = false;
  for (const sec of (dbEntry?._Secondaries ?? [])) {
    if (sec.AI_Optout !== true) continue;
    if (sec.sec_SeriesTitle != null) {
      map.set(sec.sec_SeriesTitle, true);
    } else {
      defaultOptout = true;
    }
  }
  return { map, defaultOptout };
}

/**
 * $EnumDef_Progress から「AI 学習へ供する内容が無い」Progress 値の集合を導出する。
 *
 * 解決順は上流 (creations-db) の設計に従う:
 *   ① AI_Unready が boolean で宣言されていればそれを使う
 *   ② 未宣言なら isForSecondary === true をフォールバックとして使う
 * isForSecondary は true / false / null の 3 値を取るため、厳密に === true で判定する。
 *
 * どちらの網にもかからないエントリがあれば **例外を投げる**。黙って許可側へ落ちるのは
 * 同意に関わる判定として最悪の失敗であり、上流も 455cc8b 以前に #Progress_Archived で
 * 同じ穴を踏んでいる。新しい進捗段階が増えたら、宣言するまでビルドを止める。
 *
 * @param {object} globalMeta  トップレベル data/db_meta.json の内容
 * @returns {{ values: Set<string>, explicit: number, fallback: number }}
 */
export function buildProgressUnreadySet(globalMeta) {
  const enumDef = globalMeta?.General?.$VarsDef?.$EnumDef_Progress;
  if (!enumDef || typeof enumDef !== 'object') {
    throw new Error(
      'AI 学習ポリシー: data/db_meta.json の General.$VarsDef.$EnumDef_Progress を読めませんでした。'
      + ' Progress ゲートを評価できないため中断します（読めないまま許可するのは危険なため）。'
    );
  }

  const values = new Set();
  const uncovered = [];
  let explicit = 0;
  let fallback = 0;

  for (const [key, entry] of Object.entries(enumDef)) {
    if (!entry || typeof entry !== 'object') continue;

    let unready;
    if (typeof entry.AI_Unready === 'boolean') {
      unready = entry.AI_Unready;
      explicit++;
    } else if (entry.isForSecondary === true) {
      unready = true;
      fallback++;
    } else {
      uncovered.push(key);
      continue;
    }

    if (unready && entry.Progress != null) values.add(entry.Progress);
  }

  if (uncovered.length > 0) {
    throw new Error(
      `AI 学習ポリシー: $EnumDef_Progress の ${uncovered.join(', ')} が AI_Unready を boolean で宣言しておらず、`
      + ' isForSecondary === true でもありません。どちらの網にもかからない値は黙って許可側へ落ちるため中断します。'
      + ' 上流の data/db_meta.json で AI_Unready を宣言してください。'
    );
  }

  return { values, explicit, fallback };
}

/**
 * 直接読み込みパス（_Commons 継承が適用されない）で処理してよい DB かを検証する。
 *
 * client.getRecords({ applyCommons: true }) を経由しない経路では _Commons が展開されないため、
 * _Commons が Progress や isPrivate を供給している DB を直接読むと、継承前の値でポリシーを
 * 判定してしまい誤って許可しうる。該当したら例外を投げる。
 *
 * @param {object|null} dbEntry  Databases["#DB_X"] エントリ
 * @param {string}      context  エラーメッセージに含める識別子（"作品 / DB" 等）
 */
export function assertDirectReadSafe(dbEntry, context) {
  const pools = [['_Commons', dbEntry?._Commons]];
  for (const [i, sec] of (dbEntry?._Secondaries ?? []).entries()) {
    pools.push([`_Secondaries[${i}]._Commons`, sec?._Commons]);
  }
  for (const [where, commons] of pools) {
    if (!commons || typeof commons !== 'object') continue;
    for (const field of COMMONS_SUPPLIED_POLICY_FIELDS) {
      if (commons[field] !== undefined) {
        throw new Error(
          `AI 学習ポリシー: ${context} は直接読み込みパスで処理されますが、${where}.${field} が宣言されています。`
          + ' このパスでは _Commons 継承が適用されないため、継承前の値で判定して誤って許可する恐れがあります。'
        );
      }
    }
  }
}

/**
 * DB 層のポリシーを返す。Works_Hidden → エントリなし → DB_Hidden → AI_Optout の順に判定。
 *
 * @param {boolean}     worksHidden  トップレベル db_meta.json の Works_Hidden 値
 * @param {object|null} dbEntry      DataBases/db_meta.json の Databases["#DB_X"] エントリ
 * @returns {{ allowed: boolean, reason: string }}
 */
export function getAITrainingPolicy(worksHidden, dbEntry) {
  // 1. 作品全体が非公開
  if (worksHidden) {
    return { allowed: false, reason: AI_TRAINING_DISALLOWED_WORKS_HIDDEN };
  }

  // 2. db_meta にエントリがない場合は保守的に disallowed 扱い
  if (!dbEntry || typeof dbEntry !== 'object') {
    return { allowed: false, reason: AI_TRAINING_DISALLOWED_NO_META_REASON };
  }

  // 3. DB 単位の非公開フラグ
  if (dbEntry.DB_Hidden === true) {
    return { allowed: false, reason: AI_TRAINING_DISALLOWED_DB_HIDDEN };
  }

  // 4. AI 学習オプトアウトフラグ
  if (dbEntry.AI_Optout === true) {
    return { allowed: false, reason: AI_TRAINING_DISALLOWED_REASON };
  }

  return { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
}

/**
 * キャラクターレコード層のポリシーを返す。
 * isPrivate → _Secondaries カテゴリ別 AI_Optout → Progress の AI_Unready の順に適用する。
 *
 * charData は **_Commons 継承済み**である必要がある。Progress も isPrivate も _Commons から
 * 供給されうるため（例: #DB_Primary._Commons.Progress = "notProceeded"、#DB_Secondary の
 * 31 件が _Secondaries[*]._Commons から archived を継承）、継承前のレコードを渡すと取りこぼす。
 *
 * @param {{ allowed: boolean, reason: string }} dbPolicy  DB 層ポリシー
 * @param {object}  charData  キャラクターレコード（_Commons 継承済み）
 * @param {{ map: Map<string,boolean>, defaultOptout: boolean }|null} secondaryOptout
 * @param {Set<string>|null} progressUnready  buildProgressUnreadySet().values
 * @returns {{ allowed: boolean, reason: string }}
 */
export function getCharacterAIPolicy(dbPolicy, charData, secondaryOptout = null, progressUnready = null) {
  if (charData && charData.isPrivate === true) {
    return { allowed: false, reason: AI_TRAINING_DISALLOWED_IS_PRIVATE };
  }
  if (dbPolicy.allowed && secondaryOptout) {
    const { map, defaultOptout } = secondaryOptout;
    if (map.size > 0 || defaultOptout) {
      const seriesTitle = charData?.sec_SeriesTitle ?? null;
      const isOptout = seriesTitle != null
        ? map.get(seriesTitle) === true
        : defaultOptout;
      if (isOptout) {
        return { allowed: false, reason: AI_TRAINING_DISALLOWED_SECONDARY_CATEGORY };
      }
    }
  }
  if (dbPolicy.allowed && progressUnready) {
    // Progress を持たないレコード（共通資料の語彙・種族等）にはゲートを適用しない
    const progress = charData?.Progress;
    if (progress != null && progressUnready.has(progress)) {
      return { allowed: false, reason: aiTrainingDisallowedProgressUnready(progress) };
    }
  }
  return dbPolicy;
}
