#!/usr/bin/env node
/**
 * build-dataset.js (ESM)
 * ======================
 * 100BeautiesLab_CreationsDB サブモジュールのデータを読み取り専用で参照し、
 * AI 学習向けのインデックス・マニフェストファイルを ai-dataset/ に生成します。
 *
 * 重要: このスクリプトは creations-db/ 以下のファイルを一切変更しません。
 *       生成先は ai-dataset/ のみです。
 *
 * データ読み取りには creations-db/pkg/nodejs/index.mjs の CreationsDBClient を使用します。
 *
 * 出力ファイル:
 *   ai-dataset/index.json          - 全作品・全キャラクターのマスターインデックス
 *   ai-dataset/image-index.json    - 全画像パス一覧（作品・キャラクター別）
 *   ai-dataset/manifest.jsonl      - LLM 取り込み向け JSONL（1行1レコード）
 *   ai-dataset/works/<WorkKey>.json - 作品別フラットデータ
 *   ai-dataset/build-info.json     - ビルドメタ情報
 *
 * 利用条件: NOTICE.md 参照
 */

import fs             from 'node:fs';
import path           from 'node:path';
import { execSync }   from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CreationsDBClient } from '../creations-db/pkg/nodejs/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const REPO_ROOT    = path.resolve(__dirname, '..');
const SUBMODULE    = path.join(REPO_ROOT, 'creations-db');
const DATA_DIR     = path.join(SUBMODULE, 'data');
const OUT_DIR      = path.join(REPO_ROOT, 'ai-dataset');
const WORKS_OUT    = path.join(OUT_DIR, 'works');

const VERBOSE = process.argv.includes('--verbose');

const SOURCE_REPO_URL = 'https://github.com/radiann-kswg/100BeautiesLab_CreationsDB';
const LICENCE_URL     = 'http://creativecommons.org/licenses/by-nc/4.0/';

// 画像として扱う拡張子
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ---------------------------------------------------------------------------
// AI 学習利用ポリシー
// ---------------------------------------------------------------------------
// 以下フラグを参照し、粗度に応じた別々のレイヤーで AI 学習・生成への利用可否を判定する。
//
//  「作品」レイヤー——トップレベル data/db_meta.json 内の CreationWorks["#Works_X"]
//    Works_Hidden: true  → 作品全体が非公開（API 退出禁止）→ allowed: false
//
//  「DB」レイヤー——作品の DataBases/db_meta.json 内の Databases["#DB_X"]
//    DB_Hidden:  true  → DB 全体が非公開 → allowed: false
//    AI_Optout:  true  → AI 学習・生成を抑止 → allowed: false
//    エントリなし  → 保守的フォールバック → allowed: false
//    上記以外　→ allowed: true
//
//  「キャラクター」レイヤー——個別キャラクターレコード直下
//    isPrivate:  true  → レコード単位で非公開 → allowed: false
//
// 詳細は上流リポジトリ docs/api-sw-spec.md §5.3“5.5 を参照。

const AI_TRAINING_DISALLOWED_WORKS_HIDDEN =
  'Works_Hidden: true is set in db_meta.json for this work. The entire work is non-public and opted out of AI training/generation use.';
const AI_TRAINING_DISALLOWED_DB_HIDDEN =
  'DB_Hidden: true is set in db_meta.json for this DB. This DB is non-public and opted out of AI training/generation use.';
const AI_TRAINING_DISALLOWED_REASON =
  'AI_Optout: true is set in db_meta.json for this DB. This DB is opted out of AI training/generation use.';
const AI_TRAINING_DISALLOWED_NO_META_REASON =
  'No Databases entry found in db_meta.json for this DB key. Treating as opted out (conservative fallback).';
const AI_TRAINING_DISALLOWED_IS_PRIVATE =
  'isPrivate: true is set on this character record. This record is non-public and opted out of AI training/generation use.';
const AI_TRAINING_DISALLOWED_SECONDARY_CATEGORY =
  'AI_Optout: true is set in _Secondaries category for this record\'s sec_SeriesTitle. This record is opted out of AI training/generation use.';
const AI_TRAINING_ALLOWED_REASON =
  'AI_Optout / DB_Hidden / Works_Hidden are not set for this DB. This DB is opted in for AI training/generation use.';

/**
 * _Secondaries の各カテゴリが持つ AI_Optout を集約して返す。
 * sec_SeriesTitle → true のマップと、null タイトルのデフォルトフラグを返す。
 *
 * @param {object|null} dbEntry  DataBases/db_meta.json の Databases["#DB_X"] エントリ
 * @returns {{ map: Map<string,boolean>, defaultOptout: boolean }}
 */
function buildSecondaryOptoutMap(dbEntry) {
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
 * DB 層のポリシーを返す。Works_Hidden → DB_Hidden → AI_Optout → エントリなし の順に判定。
 *
 * @param {boolean}     worksHidden  トップレベル db_meta.json の Works_Hidden 値
 * @param {object|null} dbEntry      DataBases/db_meta.json の Databases["#DB_X"] エントリ
 * @returns {{ allowed: boolean, reason: string }}
 */
function getAITrainingPolicy(worksHidden, dbEntry) {
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
 * isPrivate チェック後、_Secondaries カテゴリ別 AI_Optout を適用する。
 *
 * @param {{ allowed: boolean, reason: string }} dbPolicy  DB 層ポリシー
 * @param {object}  charData  キャラクターレコードオブジェクト
 * @param {{ map: Map<string,boolean>, defaultOptout: boolean }|null} secondaryOptout  _Secondaries のオプトアウトマップ
 * @returns {{ allowed: boolean, reason: string }}
 */
function getCharacterAIPolicy(dbPolicy, charData, secondaryOptout = null) {
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
  return dbPolicy;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function log(...args) { if (VERBOSE) console.log('[build]', ...args); }
function info(...args) { console.log('[build]', ...args); }

/** JSON を安全に読む（パース失敗時は null） */
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (VERBOSE) console.warn(`[build] WARN: failed to parse ${filePath}: ${e.message}`);
    return null;
  }
}

/** ディレクトリを再帰的に走査して画像パスを収集 */
function collectImages(dir, base) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectImages(full, base));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      // パスは常に forward-slash、サブモジュールルートからの相対パス
      results.push(path.relative(SUBMODULE, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

/** 出力ディレクトリを用意する */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** JSONL の 1 行を追加書き込み */
function appendJSONL(stream, obj) {
  stream.write(JSON.stringify(obj, null, 0) + '\n');
}

/**
 * silhouette_notes が「非空」かを判定する。
 * 2026-06-09 の AIHints 強化により以下 2 形式が併存しうる:
 *   - 旧: #String[]                                          (length > 0)
 *   - 新: { body_description: #String[], attached_items: #String[] }  (どちらかが length > 0)
 * @param {unknown} v
 * @returns {boolean}
 */
function hasSilhouetteNotes(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    const body = Array.isArray(v.body_description) ? v.body_description.length : 0;
    const att  = Array.isArray(v.attached_items)   ? v.attached_items.length   : 0;
    return (body + att) > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// サブモジュールのコミットハッシュを取得
// ---------------------------------------------------------------------------

function getSubmoduleCommit() {
  try {
    const gitModulesPath = path.join(REPO_ROOT, '.git', 'modules', 'creations-db', 'HEAD');
    if (fs.existsSync(gitModulesPath)) {
      const head = fs.readFileSync(gitModulesPath, 'utf8').trim();
      // HEAD が `ref: refs/heads/<branch>` の場合は参照解決して実コミット SHA を返す
      const refMatch = head.match(/^ref:\s*(.+)$/);
      if (refMatch) {
        const refRel = refMatch[1].trim();
        const refPath = path.join(REPO_ROOT, '.git', 'modules', 'creations-db', refRel);
        if (fs.existsSync(refPath)) {
          return fs.readFileSync(refPath, 'utf8').trim();
        }
        // packed-refs から探索
        const packed = path.join(REPO_ROOT, '.git', 'modules', 'creations-db', 'packed-refs');
        if (fs.existsSync(packed)) {
          for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
            if (line.startsWith('#') || line.startsWith('^')) continue;
            const [sha, ref] = line.split(/\s+/);
            if (ref === refRel) return sha;
          }
        }
        return head; // fallback: 解決失敗なら ref 文字列のまま返す
      }
      return head;
    }
    // fallback: packed-refs or FETCH_HEAD
    const fetchHead = path.join(SUBMODULE, '.git', 'FETCH_HEAD');
    if (fs.existsSync(fetchHead)) {
      const line = fs.readFileSync(fetchHead, 'utf8').split('\n')[0];
      return line.split(/\s+/)[0];
    }
  } catch (_) { /* ignore */ }
  return 'unknown';
}

/**
 * サブモジュール HEAD のコミット日時を ISO 8601 で返す。
 * ビルド出力の _generated_at をソース由来の決定論的値にすることで、
 * ソース無変更時のビルドが同一出力を生み、不要な git diff を発生させない。
 * git が利用不可の場合は現在時刻にフォールバックする。
 */
function getSubmoduleCommitDate() {
  try {
    const iso = execSync('git log -1 --format=%cI HEAD', {
      cwd: SUBMODULE,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return iso || new Date().toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

async function main() {
  info('=== 100BeautiesLab_CreationsAI dataset build start ===');

  // サブモジュールが存在するか確認
  if (!fs.existsSync(DATA_DIR)) {
    console.error('[build] ERROR: creations-db/data が見つかりません。');
    console.error('  git submodule update --init --recursive を実行してください。');
    process.exit(1);
  }

  // ソース由来の決定論的タイムスタンプ（同一ソースで2回ビルドしても同じ値になる）
  const buildTimestamp = getSubmoduleCommitDate();

  ensureDir(OUT_DIR);
  ensureDir(WORKS_OUT);

  // CreationsDBClient を初期化
  // includePrivate: true でプライベートレコードも取得（ai_training ポリシーを付与するため）
  const client = new CreationsDBClient(SUBMODULE, { includePrivate: true });

  // -----------------------------------------------------------------------
  // 1. グローバルメタを読む（全作品一覧、Works_Hidden 含む）
  // -----------------------------------------------------------------------
  const globalMeta = await client.getMeta();
  const creationWorks = globalMeta.CreationWorks || {};
  const workKeys = Object.keys(creationWorks); // "#Works_NumberTales" 等

  info(`作品数: ${workKeys.length}`);

  // -----------------------------------------------------------------------
  // 2. 各作品ディレクトリを処理
  // -----------------------------------------------------------------------

  const masterIndex = {
    _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
    _generated_at: buildTimestamp,
    _submodule_commit: getSubmoduleCommit(),
    works: [],
  };

  const imageIndex = {
    _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
    _generated_at: buildTimestamp,
    _path_base: 'creations-db/',
    works: {},
    general_images: [],
  };

  // JSONL マニフェスト (ストリーム書き込み)
  // manifest.jsonl       : 全レコード（policy フラグ付き）
  // manifest-training.jsonl: AI 学習利用が許可されたレコードのみを抽出したサブセット
  const manifestPath        = path.join(OUT_DIR, 'manifest.jsonl');
  const trainingPath        = path.join(OUT_DIR, 'manifest-training.jsonl');
  const manifestStream      = fs.createWriteStream(manifestPath, { encoding: 'utf8' });
  const trainingStream      = fs.createWriteStream(trainingPath, { encoding: 'utf8' });

  // ポリシーサマリ (header / policy.json に共有)
  const aiTrainingPolicySummary = {
    note: '以下のフラグを参照し、粒度に応じた多層判定で AI 学習・生成への利用可否を決定します。',
    policy_source: {
      works_hidden:           'data/db_meta.json — CreationWorks["#Works_<Name>"].Works_Hidden（作品単位の非公開）',
      db_hidden:              'data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"].DB_Hidden（DB単位の非公開）',
      ai_optout:              'data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"].AI_Optout（DB単位の AI 学習オプトアウト）',
      secondary_category_optout: 'data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"]._Secondaries[*].AI_Optout（二次創作カテゴリ別 AI 学習オプトアウト）',
      is_private:             'data/Works_<work>/DataBases/db_*.json — <record>.isPrivate（レコード単位の非公開）',
    },
    disallowed_priority: 'Works_Hidden → DB_Hidden → AI_Optout → db_meta エントリなし → _Secondaries カテゴリ別 AI_Optout → isPrivate（いずれか true で allowed=false）',
    disallowed_default: false,
    consumer_guidance: [
      'manifest.jsonl をそのまま使う場合: record.ai_training.allowed === true のレコードのみを採用してください。',
      'あるいは manifest-training.jsonl を使えば、許可済みレコードのみが含まれます。',
      'image-index.json / works/<Work>.json にも ai_training フラグが付与されています。',
    ],
  };

  // ヘッダーレコード（LLM への文脈提供用）
  const headerRecord = {
    _type: 'dataset_header',
    dataset_name: '100BeautiesLab_CreationsAI',
    description: 'サークル「百花繚乱研究所」の一次創作作品データセット（非公式・非営利）',
    source: SOURCE_REPO_URL,
    licence: LICENCE_URL,
    author: 'RadianN_kswg（ラジアン/柏木主税）',
    generated_at: buildTimestamp,
    submodule_commit: getSubmoduleCommit(),
    usage_conditions: [
      '非営利目的に限定',
      '出典（' + SOURCE_REPO_URL + '）を明記',
      '改変した場合はその旨を明記',
    ],
    ai_training_policy: aiTrainingPolicySummary,
    target_environments: {
      novelai_sd: '各キャラクターレコード data.AIHints.forms.<form>.prompt_export / negative_prompt_export + forms.<form>.negative_keywords (corefolder の腕・脚等 structural NG 含む) を貼付',
      chatgpt:    'common.natural_language_description + forms.<form>.natural_language_description + identity_tags / form_tags + forms.<form>.silhouette_notes.body_description / silhouette_notes.attached_items + forms.<form>.immutable_constraints を貼付',
      gemini:     '上記に加え forms.<form>.reference_images.main および work_common.reference_images.{corefolder_reference, humanoid_reference} を参照画像として添付',
    },
  };
  appendJSONL(manifestStream, headerRecord);
  appendJSONL(trainingStream, headerRecord);

  let totalCharacters = 0;
  let totalAllowedCharacters = 0;
  let totalWithAiHints = 0;
  let totalWithSilhouetteNotes = 0;
  let totalWithImmutableConstraints = 0;
  let totalWithNegativeKeywords = 0;
  let totalWithWorkCommon = 0;
  let totalWithConceptFormsMeta = 0;

  for (const workKey of workKeys) {
    const workTopMeta = creationWorks[workKey];
    // workKey 例: "#Works_NumberTales" → dirName: "Works_NumberTales"
    const dirName = workKey.replace(/^#/, '');
    const workDir = path.join(DATA_DIR, dirName);

    if (!fs.existsSync(workDir)) {
      log(`スキップ (ディレクトリなし): ${dirName}`);
      continue;
    }

    info(`処理中: ${dirName} (${workTopMeta.Title_JP || ''} / ${workTopMeta.Title_EN || ''})`);

    // Works_Hidden フラグを取得——作品全体が非公開の場合 AI 学習抑止
    const worksHidden = !!(workTopMeta.Works_Hidden === true);

    // 作品別メタを取得（Databases エントリ・_Commons を含む）
    let fullWorkMeta = {};
    try {
      fullWorkMeta = await client.getWorkMeta(workKey);
    } catch (e) {
      log(`WARN: getWorkMeta 失敗 (${workKey}): ${e.message}`);
    }
    const databases = fullWorkMeta.Databases || {};

    // db_type.json は直接読む（型定義レコード生成用。ライブラリ API 外）
    const dbDir = path.join(workDir, 'DataBases');
    const workDbType = readJSON(path.join(dbDir, 'db_type.json'));

    const workEntry = {
      work_key: workKey,
      dir_name: dirName,
      title_ja: workTopMeta.Title_JP || '',
      title_en: workTopMeta.Title_EN || '',
      summary: workTopMeta.Works_Summary_JP || '',
      layout: workTopMeta.$DetailLayout || null,
      characters: [],
      db_files: [],
    };

    const allowedDbKeys = [];   // この作品内で AI 学習が許可された DB キー一覧

    // databases の各エントリを処理（#DB_* / #Ref_* キーのみ対象）
    for (const [dbMetaKey, dbEntry] of Object.entries(databases)) {
      if (!dbMetaKey.startsWith('#DB_') && !dbMetaKey.startsWith('#Ref_')) continue;
      if (!dbEntry || typeof dbEntry !== 'object' || Array.isArray(dbEntry)) continue;

      const dbPolicy = getAITrainingPolicy(worksHidden, dbEntry);
      const secondaryOptout = buildSecondaryOptoutMap(dbEntry);

      // DB ファイルパスを db_meta エントリから解決
      const layer = (typeof dbEntry.DB_Layer === 'string' && dbEntry.DB_Layer.trim()) || 'DataBases';
      const dbBaseName = dbMetaKey.replace(/^#(DB|Ref)_/, '');
      const prefix = dbMetaKey.startsWith('#Ref_') ? 'ref_' : 'db_';
      const fileName = (typeof dbEntry.DB_File === 'string' && /^[A-Za-z0-9_.-]+\.json$/.test(dbEntry.DB_File.trim()))
        ? dbEntry.DB_File.trim()
        : `${prefix}${dbBaseName}.json`;
      const dbRelPath = `data/${dirName}/${layer}/${fileName}`;

      // ファイルが存在しない DB はスキップ
      const dbAbsPath = path.join(SUBMODULE, dbRelPath.replace(/\//g, path.sep));
      if (!fs.existsSync(dbAbsPath)) {
        log(`スキップ (DBファイルなし): ${dbRelPath}`);
        continue;
      }

      // _Secondaries の null-title カテゴリのみが全て AI_Optout: true の場合（=全レコードがデフォルトでブロック）は
      // DB レベルでも allowed_db_keys に含めない
      const isFullyDefaultOptedOut = secondaryOptout.defaultOptout && secondaryOptout.map.size === 0;
      if (dbPolicy.allowed && !isFullyDefaultOptedOut) allowedDbKeys.push(dbMetaKey);
      workEntry.db_files.push({ path: dbRelPath, ai_training: dbPolicy });

      // レコードを取得（_Commons 補完済み・isPrivate 含む）
      let records = [];
      try {
        records = await client.getRecords(workKey, dbMetaKey, { applyCommons: true });
      } catch (e) {
        log(`WARN: getRecords 失敗 (${workKey} / ${dbMetaKey}): ${e.message}`);
        continue;
      }

      for (const [idx, charData] of records.entries()) {
        if (typeof charData !== 'object' || charData === null) continue;

        // 安定した識別子を導出（Num → ID → id → Name → 配列インデックス の優先順）
        const charId = String(
          charData.Num ?? charData.ID ?? charData.Id ?? charData.id ??
          charData.Key ?? charData.Code ?? charData.Name_JP ?? charData.Name ?? idx
        );

        // 画像パスを解決
        const images = resolveCharacterImages(workDir, charId, charData);

        // AIHints を data から取り出してトップレベルにも露出する
        const aiHints = charData.AIHints ?? null;

        // isPrivate および _Secondaries カテゴリ別 AI_Optout を考慮してポリシーを決定
        const charPolicy = getCharacterAIPolicy(dbPolicy, charData, secondaryOptout);

        // AIHints 新フィールド (2026-06-08 addon-ai-tag) の存在確認
        const aiFormsCorefolder = aiHints?.forms?.corefolder;
        const aiFormsHumanoid   = aiHints?.forms?.humanoid;
        // silhouette_notes は 2026-06-09 の AIHints 強化で
        //   旧: #String[]
        //   新: { body_description: #String[], attached_items: #String[] }
        // の 2 形式が併存しうるため、どちらでも「非空」を検出する。
        const hasAnySilhouetteNotes = !!(
          hasSilhouetteNotes(aiFormsCorefolder?.silhouette_notes) ||
          hasSilhouetteNotes(aiFormsHumanoid?.silhouette_notes)
        );
        const hasAnyImmutableConstraints = !!(
          (Array.isArray(aiFormsCorefolder?.immutable_constraints) && aiFormsCorefolder.immutable_constraints.length > 0) ||
          (Array.isArray(aiFormsHumanoid?.immutable_constraints)   && aiFormsHumanoid.immutable_constraints.length > 0)
        );
        const hasAnyNegativeKeywords = !!(
          (Array.isArray(aiFormsCorefolder?.negative_keywords)     && aiFormsCorefolder.negative_keywords.length > 0) ||
          (Array.isArray(aiFormsHumanoid?.negative_keywords)       && aiFormsHumanoid.negative_keywords.length > 0)
        );
        const hasWorkCommonBlock = !!(aiHints?.work_common);
        // concept_contains_forms: AIHints に形態リストが明示されているかどうか (2026-06-19 案B)
        const hasConceptFormsMeta = !!(
          Array.isArray(aiHints?.concept_contains_forms) && aiHints.concept_contains_forms.length > 0
        );

        const charEntry = {
          id: charId,
          work_key: workKey,
          work_title_ja: workTopMeta.Title_JP || '',
          work_title_en: workTopMeta.Title_EN || '',
          db_source: dbRelPath,
          ai_training: charPolicy,
          ai_hints: aiHints,
          has_ai_hints: !!aiHints,
          has_silhouette_notes: hasAnySilhouetteNotes,
          has_immutable_constraints: hasAnyImmutableConstraints,
          has_negative_keywords: hasAnyNegativeKeywords,
          has_work_common: hasWorkCommonBlock,
          has_concept_forms_metadata: hasConceptFormsMeta,
          // 原データを変更せずそのまま参照
          data: charData,
          images,
        };

        workEntry.characters.push({ id: charId, images, has_ai_hints: !!aiHints, has_silhouette_notes: hasAnySilhouetteNotes, has_immutable_constraints: hasAnyImmutableConstraints, has_negative_keywords: hasAnyNegativeKeywords, has_work_common: hasWorkCommonBlock, has_concept_forms_metadata: hasConceptFormsMeta, ai_training_allowed: charPolicy.allowed });
        totalCharacters++;
        if (charPolicy.allowed) totalAllowedCharacters++;
        if (aiHints) totalWithAiHints++;
        if (hasAnySilhouetteNotes)       totalWithSilhouetteNotes++;
        if (hasAnyImmutableConstraints)  totalWithImmutableConstraints++;
        if (hasAnyNegativeKeywords)      totalWithNegativeKeywords++;
        if (hasWorkCommonBlock)          totalWithWorkCommon++;
        if (hasConceptFormsMeta)         totalWithConceptFormsMeta++;

        // JSONL レコード（1キャラクター = 1行）
        const record = { _type: 'character', ...charEntry };
        appendJSONL(manifestStream, record);
        if (charPolicy.allowed) appendJSONL(trainingStream, record);
      }

      // 型定義レコード（db_type.json）を DB ごとのポリシーで JSONL に追加
      if (workDbType) {
        const typeRecord = {
          _type: 'work_type_definitions',
          work_key: workKey,
          source: `data/${dirName}/DataBases/db_type.json`,
          ai_training: dbPolicy,
          data: workDbType,
        };
        appendJSONL(manifestStream, typeRecord);
        if (dbPolicy.allowed) appendJSONL(trainingStream, typeRecord);
      }
    }

    // --- 画像インデックス ---
    // 画像は DB 別ディレクトリ (DB_Primary / DB_Secondary 等) に格納されているため、
    // ai_training ポリシーは「いずれかの DB が allowed なら work 単位で参照可」として
    // 概要のみ提示する。詳細なフィルタリングは manifest-training.jsonl を参照。
    const imagesDir = path.join(workDir, 'Images');
    const workImages = collectImages(imagesDir, SUBMODULE);
    const workHasAllowedDb = allowedDbKeys.length > 0;
    imageIndex.works[workKey] = {
      title_ja: workTopMeta.Title_JP || '',
      title_en: workTopMeta.Title_EN || '',
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_keys: allowedDbKeys,
        note: workHasAllowedDb
          ? '画像パスのうち許可された DB に対応するサブディレクトリ (Images/DB_<name>/...) のみが AI 学習許可対象です。'
          : AI_TRAINING_DISALLOWED_REASON,
      },
      images: workImages,
      count: workImages.length,
    };

    // --- References ---
    const refsDir = path.join(workDir, 'References');
    const refImages = collectImages(refsDir, SUBMODULE);
    if (refImages.length > 0) {
      imageIndex.works[workKey].references = refImages;
    }

    masterIndex.works.push({
      work_key: workKey,
      dir_name: dirName,
      title_ja: workTopMeta.Title_JP || '',
      title_en: workTopMeta.Title_EN || '',
      character_count: workEntry.characters.length,
      image_count: workImages.length,
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_keys: allowedDbKeys,
        reason: workHasAllowedDb ? AI_TRAINING_ALLOWED_REASON : AI_TRAINING_DISALLOWED_REASON,
      },
    });

    // --- 作品別 JSON を出力 ---
    // （タイトル等メタ + キャラクター一覧。画像パス含む）
    const workOutPath = path.join(WORKS_OUT, `${dirName}.json`);
    fs.writeFileSync(workOutPath, JSON.stringify({
      _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
      _generated_at: buildTimestamp,
      work_key: workKey,
      dir_name: dirName,
      title_ja: workTopMeta.Title_JP || '',
      title_en: workTopMeta.Title_EN || '',
      summary: workTopMeta.Works_Summary_JP || '',
      layout: workTopMeta.$DetailLayout || null,
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_keys: allowedDbKeys,
        reason: workHasAllowedDb ? AI_TRAINING_ALLOWED_REASON : AI_TRAINING_DISALLOWED_REASON,
      },
      db_files: workEntry.db_files,
      character_ids: workEntry.characters.map(c => c.id),
      character_ids_with_ai_hints: workEntry.characters.filter(c => c.has_ai_hints).map(c => c.id),
      character_ids_with_silhouette_notes: workEntry.characters.filter(c => c.has_silhouette_notes).map(c => c.id),
      character_ids_with_immutable_constraints: workEntry.characters.filter(c => c.has_immutable_constraints).map(c => c.id),
      character_ids_with_negative_keywords: workEntry.characters.filter(c => c.has_negative_keywords).map(c => c.id),
      character_ids_with_work_common: workEntry.characters.filter(c => c.has_work_common).map(c => c.id),
      image_paths: workImages,
    }, null, 2), 'utf8');
  }

  // -----------------------------------------------------------------------
  // 3. GeneralImages / Dictionaries / References（トップレベル）
  // -----------------------------------------------------------------------

  const generalImgDir = path.join(DATA_DIR, 'GeneralImages');
  imageIndex.general_images = collectImages(generalImgDir, SUBMODULE);

  const dictDir = path.join(DATA_DIR, 'Dictionaries');
  if (fs.existsSync(dictDir)) {
    for (const entry of fs.readdirSync(dictDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const dictData = readJSON(path.join(dictDir, entry.name));
        if (dictData) {
          // 辞書はすべての作品から参照される共通情報なので、AI 学習許可済 (=manifest-training)
          // にも含める。
          const dictRecord = {
            _type: 'dictionary',
            source: path.relative(SUBMODULE, path.join(dictDir, entry.name)).replace(/\\/g, '/'),
            ai_training: { allowed: true, reason: 'shared dictionary; safe to include for AI consumers.' },
            data: dictData,
          };
          appendJSONL(manifestStream, dictRecord);
          appendJSONL(trainingStream, dictRecord);
        }
      }
    }
  }

  const topRefsDir = path.join(DATA_DIR, 'References');
  const topRefImages = collectImages(topRefsDir, SUBMODULE);
  if (topRefImages.length > 0) {
    imageIndex.general_images = imageIndex.general_images.concat(topRefImages);
  }

  // -----------------------------------------------------------------------
  // 4. ファイルを書き出す
  // -----------------------------------------------------------------------

  manifestStream.end();
  trainingStream.end();
  info(`manifest.jsonl / manifest-training.jsonl を書き込みました`);

  // ポリシーサマリ JSON を独立して出力（消費側がフラグ確認に使う）
  fs.writeFileSync(path.join(OUT_DIR, 'policy.json'), JSON.stringify({
    _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
    _generated_at: buildTimestamp,
    ai_training_policy: aiTrainingPolicySummary,
    target_environments: headerRecord.target_environments,
    schema: {
      ai_training_field: {
        allowed: 'boolean — true なら AI 学習・生成に利用可',
        reason:  'string — allowed の判定理由（整備中/整備済等）',
      },
      ai_hints_field: {
        common: '形態を問わない素体特徴 (identity_tags / palette_priority / natural_language_description / immutable_traits 等)',
        forms:  '形態別 (corefolder / humanoid) の outfit_features / silhouette_notes / immutable_constraints / negative_keywords / ai_tags / prompt_export / negative_prompt_export / reference_images / natural_language_description',
        forms_silhouette_notes: 'silhouette_notes は 2026-06-09 以降 { body_description: string[], attached_items: string[] } 形式 (旧 #String[] 形式とも互換)。本体素体と装着付属品を分離して保持する。',
        work_common: '作品共通の参照画像まとめ (reference_images.corefolder_reference[] / humanoid_reference[]) — 2026-06-08 追加',
        alt_modes:   '将来予約モード格納 (corefolder_dressed.allowed / outfit_source) — 2026-06-08 追加',
      },
      images_field: {
        'DB_Primary (等)': 'charId ディレクトリ配下の画像 (corefolder / humanoid 等、形態別フォルダスキャン結果)',
        concept:      '両形態を含む概念イラスト 1 枚 (DB_Primary/concept/cnsp_img{N}.png 等) — 2026-06-19 追加',
        concept_alt:  '概念イラストのバリアント群 (conceptAlt_PNGName[] 由来、複数形態・複数キャラ構図を含む場合あり) — 2026-06-19 追加',
        corefolder:   'コアフォルダ形態の正規イラスト (corefolder_PNGPath[] 由来、DB_Primary/corefolder/{path}) — 2026-06-23 追加',
        humanoid:     '人型形態の正規イラスト (humanoid_PNGPath[] 由来、DB_Primary/humanoid/{path}) — 2026-06-23 追加',
        arts:         'キャラクター個別アートワーク (arts_PNGPath[] 由来) — 2026-06-19 追加',
        design_alt:   '衣装差分・デザインバリアント (designAlt_PNGPath[] 由来、形態注記なし) — 2026-06-19 追加',
        note:         'パスは creations-db サブモジュールルートからの相対パス。ファイルが実在しない場合はキー自体が省略される。',
      },
    },
  }, null, 2), 'utf8');
  info(`policy.json を書き込みました`);

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
    ...masterIndex,
    total_characters: totalCharacters,
    total_works: masterIndex.works.length,
  }, null, 2), 'utf8');
  info(`index.json を書き込みました (${masterIndex.works.length} 作品, ${totalCharacters} キャラクター)`);

  fs.writeFileSync(path.join(OUT_DIR, 'image-index.json'), JSON.stringify(imageIndex, null, 2), 'utf8');
  info(`image-index.json を書き込みました`);

  // 注: allowed_characters は DB 単位の判定なので、masterIndex の作品数 (character_count) ではなく
  // ループ中に集計した totalAllowedCharacters を使用する。
  const aiTrainingStats = {
    allowed_works:        masterIndex.works.filter(w => w.ai_training && w.ai_training.allowed).length,
    disallowed_works:     masterIndex.works.filter(w => !(w.ai_training && w.ai_training.allowed)).length,
    allowed_characters:    totalAllowedCharacters,
    disallowed_characters: totalCharacters - totalAllowedCharacters,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'build-info.json'), JSON.stringify({
    generated_at: buildTimestamp,
    submodule_commit: getSubmoduleCommit(),
    source_repo: SOURCE_REPO_URL,
    licence: LICENCE_URL,
    total_works: masterIndex.works.length,
    total_characters: totalCharacters,
    total_general_images: imageIndex.general_images.length,
    ai_training_stats: aiTrainingStats,
    ai_hints_stats: {
      with_ai_hints:              totalWithAiHints,
      with_silhouette_notes:      totalWithSilhouetteNotes,
      with_immutable_constraints: totalWithImmutableConstraints,
      with_negative_keywords:     totalWithNegativeKeywords,
      with_work_common:           totalWithWorkCommon,
      with_concept_forms_metadata: totalWithConceptFormsMeta,
    },
  }, null, 2), 'utf8');
  info(`build-info.json を書き込みました`);

  info('=== build complete ===');
}

// ---------------------------------------------------------------------------
// キャラクター画像パスを解決するヘルパー
// ---------------------------------------------------------------------------

/**
 * 拡張子なしのベースパスに対して IMAGE_EXTS を順に試し、
 * 最初に実在したファイルのサブモジュール相対パスを返す。見つからない場合は null。
 *
 * @param {string} baseNoExt  拡張子を除いた絶対パス
 * @returns {string|null}
 */
function resolveImagePath(baseNoExt) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']) {
    const absPath = `${baseNoExt}${ext}`;
    if (fs.existsSync(absPath)) {
      return path.relative(SUBMODULE, absPath).replace(/\\/g, '/');
    }
  }
  return null;
}

/**
 * キャラクター JSON データ内の画像参照フィールドを読み取り、
 * サブモジュール相対パスのリストを返す。
 *
 * 返却オブジェクトのキー:
 *   DB_Primary / DB_SemiPrimary 等  charId ディレクトリスキャン結果 (corefolder 等)
 *   concept                         concept_PNGName (両形態を含む概念イラスト)
 *   concept_alt                     conceptAlt_PNGName[] (概念イラストバリアント)
 *   corefolder                      corefolder_PNGPath[] (コアフォルダ形態の正規イラスト)
 *   humanoid                        humanoid_PNGPath[] (人型形態の正規イラスト)
 *   arts                            arts_PNGPath[] (キャラ個別アートワーク)
 *   design_alt                      designAlt_PNGPath[] (衣装差分・デザインバリアント)
 */
function resolveCharacterImages(workDir, charId, charData) {
  const images = {};

  // --- 既存: charId ディレクトリスキャン (corefolder / humanoid 等の形態別画像) ---
  const imagesBase = path.join(workDir, 'Images');
  if (!fs.existsSync(imagesBase)) return images;

  // DB_Primary / DB_SemiPrimary / DB_Secondary / DB_SelfSecondary のそれぞれに
  // charId ディレクトリが存在することがある
  for (const dbImgDir of fs.readdirSync(imagesBase, { withFileTypes: true })) {
    if (!dbImgDir.isDirectory()) continue;
    const charImgDir = path.join(imagesBase, dbImgDir.name, charId);
    if (fs.existsSync(charImgDir)) {
      const correctPaths = [];
      collectImagesRaw(charImgDir).forEach(abs => {
        correctPaths.push(path.relative(SUBMODULE, abs).replace(/\\/g, '/'));
      });
      if (correctPaths.length > 0) {
        images[dbImgDir.name] = correctPaths;
      }
    }
  }

  // --- Phase 1: charData.Images の構造化フィールドから画像パスを解決 ---
  // concept / conceptAlt / arts / designAlt は DB_Primary 配下に格納される。
  const charImages = charData.Images;
  if (!charImages || typeof charImages !== 'object') return images;

  const dbPrimaryBase = path.join(imagesBase, 'DB_Primary');

  // concept (単一): 両形態を描いた概念イラスト。
  // concept_PNGName → Images/DB_Primary/concept/{name}.<ext>
  if (typeof charImages.concept_PNGName === 'string') {
    const rel = resolveImagePath(path.join(dbPrimaryBase, 'concept', charImages.concept_PNGName));
    if (rel) images.concept = [rel];
  }

  // concept_alt (複数): 概念イラストのバリアント（複数形態・複数キャラ構図など）。
  // conceptAlt_PNGName[] → Images/DB_Primary/concept/{name}.<ext>
  if (Array.isArray(charImages.conceptAlt_PNGName) && charImages.conceptAlt_PNGName.length > 0) {
    const paths = charImages.conceptAlt_PNGName
      .map(name => resolveImagePath(path.join(dbPrimaryBase, 'concept', name)))
      .filter(Boolean);
    if (paths.length > 0) images.concept_alt = paths;
  }

  // corefolder (複数): コアフォルダ形態の正規イラスト。
  // corefolder_PNGPath[] → Images/DB_Primary/corefolder/{path}.<ext>
  // 形態フォルダ (corefolder/) が charId の 1 階層上に挟まるため、charId ディレクトリ
  // スキャン (上の DB_* ループ) では拾えない。構造化フィールドとして明示解決する。
  if (Array.isArray(charImages.corefolder_PNGPath) && charImages.corefolder_PNGPath.length > 0) {
    const paths = charImages.corefolder_PNGPath
      .map(rel => resolveImagePath(path.join(dbPrimaryBase, 'corefolder', rel)))
      .filter(Boolean);
    if (paths.length > 0) images.corefolder = paths;
  }

  // humanoid (複数): 人型形態の正規イラスト。
  // humanoid_PNGPath[] → Images/DB_Primary/humanoid/{path}.<ext>
  // corefolder と同じく形態フォルダ (humanoid/) が 1 階層挟まる。現状ファイル未配置でも
  // resolveImagePath が null を返すだけなので将来の追加に備えて先行対応する。
  if (Array.isArray(charImages.humanoid_PNGPath) && charImages.humanoid_PNGPath.length > 0) {
    const paths = charImages.humanoid_PNGPath
      .map(rel => resolveImagePath(path.join(dbPrimaryBase, 'humanoid', rel)))
      .filter(Boolean);
    if (paths.length > 0) images.humanoid = paths;
  }

  // arts (複数): キャラクター個別に紐付けられたアートワーク。
  // arts_metadata が存在する場合はそちらを優先し { path, form, characters } 形式で出力。
  // なければ arts_PNGPath[] からパスのみで補完。
  // パスは DB_Primary/arts/ 相対。../../DB_SemiPrimary/... など親ディレクトリ参照も path.join で正規化される。
  {
    const artsMeta = Array.isArray(charImages.arts_metadata) && charImages.arts_metadata.length > 0
      ? charImages.arts_metadata
      : null;
    if (artsMeta) {
      const entries = artsMeta.flatMap(({ path: rel, form, characters }) => {
        const resolved = resolveImagePath(path.join(dbPrimaryBase, 'arts', rel));
        if (!resolved) return [];
        return [{ path: resolved, form: form ?? null, characters: Array.isArray(characters) ? characters : null }];
      });
      if (entries.length > 0) images.arts = entries;
    } else if (Array.isArray(charImages.arts_PNGPath) && charImages.arts_PNGPath.length > 0) {
      const entries = charImages.arts_PNGPath.flatMap(rel => {
        const resolved = resolveImagePath(path.join(dbPrimaryBase, 'arts', rel));
        return resolved ? [{ path: resolved, form: null, characters: null }] : [];
      });
      if (entries.length > 0) images.arts = entries;
    }
  }

  // design_alt (複数): 衣装差分・デザインバリアント。
  // designAlt_metadata が存在する場合はそちらを優先し { path, form, characters } 形式で出力。
  // なければ designAlt_PNGPath[] からパスのみで補完。
  // パスは DB_Primary/designAlt/ 相対（arts/ ではない点に注意）。
  {
    const daltMeta = Array.isArray(charImages.designAlt_metadata) && charImages.designAlt_metadata.length > 0
      ? charImages.designAlt_metadata
      : null;
    if (daltMeta) {
      const entries = daltMeta.flatMap(({ path: rel, form, characters }) => {
        const resolved = resolveImagePath(path.join(dbPrimaryBase, 'designAlt', rel));
        if (!resolved) return [];
        return [{ path: resolved, form: form ?? null, characters: Array.isArray(characters) ? characters : null }];
      });
      if (entries.length > 0) images.design_alt = entries;
    } else if (Array.isArray(charImages.designAlt_PNGPath) && charImages.designAlt_PNGPath.length > 0) {
      const entries = charImages.designAlt_PNGPath.flatMap(rel => {
        const resolved = resolveImagePath(path.join(dbPrimaryBase, 'designAlt', rel));
        return resolved ? [{ path: resolved, form: null, characters: null }] : [];
      });
      if (entries.length > 0) images.design_alt = entries;
    }
  }

  // corefolder (複数): コアフォルダ形態の画像。
  // corefolder_PNGPath[] → Images/DB_Primary/corefolder/{path}.<ext>
  if (Array.isArray(charImages.corefolder_PNGPath) && charImages.corefolder_PNGPath.length > 0) {
    const paths = charImages.corefolder_PNGPath
      .map(p => resolveImagePath(path.join(dbPrimaryBase, 'corefolder', p)))
      .filter(Boolean);
    if (paths.length > 0) images.corefolder = paths;
  }

  // humanoid (複数): ヒューマノイド形態の画像。
  // humanoid_PNGPath[] → Images/DB_Primary/humanoid/{path}.<ext>
  if (Array.isArray(charImages.humanoid_PNGPath) && charImages.humanoid_PNGPath.length > 0) {
    const paths = charImages.humanoid_PNGPath
      .map(p => resolveImagePath(path.join(dbPrimaryBase, 'humanoid', p)))
      .filter(Boolean);
    if (paths.length > 0) images.humanoid = paths;
  }

  return images;
}

/** ファイルの絶対パスを再帰収集 */
function collectImagesRaw(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectImagesRaw(full));
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

main().catch(e => { console.error('[build] FATAL:', e); process.exit(1); });
