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
import {
  AI_TRAINING_DISALLOWED_REASON,
  AI_TRAINING_ALLOWED_REASON,
  assertDirectReadSafe,
  buildProgressUnreadySet,
  buildSecondaryOptoutMap,
  getAITrainingPolicy,
  getCharacterAIPolicy,
} from './lib/policy.js';

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

// AI 学習利用ポリシーの判定は scripts/lib/policy.js に切り出してある（テストから import するため）。

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

/**
 * ディレクトリエントリを名前のバイト順（UTF-8）に整列して返す。
 *
 * fs.readdirSync の戻り順はファイルシステム依存（Linux/ext4 は概ねバイト順、
 * Windows/NTFS は大文字化した照合順）のため、明示的に整列しないと同一ソースでも
 * プラットフォーム間で出力順が変わり、CI とローカルで往復し続ける差分になる。
 * git のパス順と同じバイト順に固定することで、既存の CI 生成物とも一致する。
 */
function readdirSorted(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
}

/** ディレクトリを再帰的に走査して画像パスを収集 */
function collectImages(dir, base) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of readdirSorted(dir)) {
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
  // ソース側で作品が削除・統合された場合（例: 2026-07-11 Works_Proxies → Works_DestinyFoxRecords 統合）に
  // 古い works/<WorkKey>.json が残留しないよう、既存の *.json 一覧を控えておき今回書き込まなかった分を後で削除する
  // （.gitkeep 等 *.json 以外のファイルはそのまま残す）
  const preexistingWorksFiles = new Set(fs.readdirSync(WORKS_OUT).filter(f => f.endsWith('.json')));
  const writtenWorksFiles = new Set();

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

  // AI 学習へ供する内容が無い Progress 値を $EnumDef_Progress から導出する。
  // 語彙はここに持たず上流の宣言だけを読む（判定の正典を creations-db に一本化するため）。
  const progressUnready = buildProgressUnreadySet(globalMeta);
  log(`Progress ゲート: AI_Unready 明示 ${progressUnready.explicit} 件 / isForSecondary フォールバック ${progressUnready.fallback} 件`);
  log(`Progress ゲート: 除外する値 (${progressUnready.values.size}) = ${[...progressUnready.values].map(v => JSON.stringify(v)).join(', ')}`);

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
      ai_optout:              'data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"].AI_Optout（DB単位の AI 学習オプトアウト。権利軸）',
      secondary_category_optout: 'data/Works_<work>/DataBases/db_meta.json — Databases["#DB_<Name>"]._Secondaries[*].AI_Optout（二次創作カテゴリ別 AI 学習オプトアウト。権利軸）',
      is_private:             'data/Works_<work>/DataBases/db_*.json — <record>.isPrivate（レコード単位の非公開）',
      progress_unready:       'data/db_meta.json — General.$VarsDef.$EnumDef_Progress[*].AI_Unready（進捗段階ごとの「AI 学習へ供する内容が無い」宣言。充填軸。未宣言のエントリは isForSecondary === true をフォールバックとして使う）',
    },
    // AI_Optout（権利軸）と AI_Unready（充填軸）は意味が異なる。両者を混同しないこと。
    axis_semantics: {
      ai_optout: 'AI_Optout: true は「権利上 AI 学習・生成へ供してはならない」という原著作者の表明です。',
      ai_unready: 'AI_Unready: true は「制作が進んでおらず AI 学習へ供する内容が無い」という状態を表すだけで、権利上の可否とは無関係です。'
        + ' AI_Unready: false は AI 学習の許諾を意味しません。権利上の可否を表明するのは AI_Optout のみです。',
    },
    disallowed_priority: 'Works_Hidden → DB_Hidden → AI_Optout → db_meta エントリなし → _Secondaries カテゴリ別 AI_Optout → isPrivate → Progress の AI_Unready（いずれか該当で allowed=false）',
    disallowed_default: false,
    consumer_guidance: [
      'manifest.jsonl をそのまま使う場合: record.ai_training.allowed === true のレコードのみを採用してください。',
      'あるいは manifest-training.jsonl を使えば、許可済みレコードのみが含まれます。',
      'image-index.json / works/<Work>.json にも ai_training フラグが付与されています。',
      'image-index.json の allowed_db_keys は「許可レコードを 1 件以上含む DB」を示す粗いフィルタです。'
        + '同じ DB でも許可・不許可はレコード単位で分かれるため、画像の利用可否は manifest.jsonl の各レコードの images と ai_training で判断してください。',
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
      chatgpt:    'common.natural_language_description + forms.<form>.natural_language_description + identity_tags / form_tags + forms.<form>.silhouette_notes.body_description / silhouette_notes.attached_items + forms.<form>.immutable_constraints を貼付。外見の構造化情報は data.AppearanceDetail (has_appearance_detail: true のレコード) も参照可能',
      gemini:     '上記に加え forms.<form>.reference_images.main および work_common.reference_images.{corefolder_reference, humanoid_reference} を参照画像として添付',
      structured_appearance: 'data.AppearanceDetail[] (has_appearance_detail: true のレコード) から BodyPart / DesignElement / Attrs を参照することで外見パーツの構造化データを取得可能。将来的に AIHints.forms.*.silhouette_notes の源泉データとして統合予定',
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
  let totalWithAppearanceDetail = 0;
  let totalWithTailsUnit = 0;

  for (const workKey of workKeys) {
    const workTopMeta = creationWorks[workKey];
    // workKey 例: "#Works_NumberTales" → dirName: "Works_NumberTales"
    const dirName = workKey.replace(/^#/, '');

    // 2026-07-11 addon-ai-tag: Works_Dir/Works_ImagesDir/Works_Shared による物理レイアウトオーバーライド
    // （例: 共通資料 #Works_CommonReferences は Works_<Name>/DataBases/ 規約に従わず、
    //   data/References 直下にフラットに配置される「疑似作品」）。
    // creations-db/pkg/nodejs/index.mjs の CreationsDBClient はこのオーバーライドに未対応
    // （lib/sw-common.js 側にのみ実装済み）のため、該当作品は client を経由せず直接ファイルを読む。
    const worksDirOverride = (typeof workTopMeta.Works_Dir === 'string' && workTopMeta.Works_Dir.trim()) || null;
    const worksImagesDirOverride = (typeof workTopMeta.Works_ImagesDir === 'string' && workTopMeta.Works_ImagesDir.trim()) || null;
    const effectiveDirName = worksDirOverride || dirName;
    const workDir = path.join(DATA_DIR, effectiveDirName);

    if (!fs.existsSync(workDir)) {
      log(`スキップ (ディレクトリなし): ${effectiveDirName}`);
      continue;
    }

    info(`処理中: ${effectiveDirName} (${workTopMeta.Title_JP || ''} / ${workTopMeta.Title_EN || ''})`);

    // Works_Hidden フラグを取得——作品全体が非公開の場合 AI 学習抑止
    const worksHidden = !!(workTopMeta.Works_Hidden === true);

    // 作品別メタを取得（Databases エントリ・_Commons を含む）
    let fullWorkMeta = {};
    if (worksDirOverride) {
      // DataBases/ サブフォルダを持たないフラットレイアウトのため直接読み込む
      fullWorkMeta = readJSON(path.join(workDir, 'db_meta.json')) || {};
    } else {
      try {
        fullWorkMeta = await client.getWorkMeta(workKey);
      } catch (e) {
        log(`WARN: getWorkMeta 失敗 (${workKey}): ${e.message}`);
      }
    }
    const databases = fullWorkMeta.Databases || {};

    // db_type.json は直接読む（型定義レコード生成用。ライブラリ API 外）
    // Works_Dir オーバーライド作品は DataBases/ サブフォルダを持たず直下に配置される
    const dbDir = worksDirOverride ? workDir : path.join(workDir, 'DataBases');
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

    const allowedDbKeys = [];   // この作品内で AI 学習が許可された DB キー一覧（レコードの実判定から導出）
    const dbRecordStats = [];   // DB ごとの allowed / total 件数（利用者が allow/deny の混在を判別できるように出す）

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
      // DB_Layer が作品の物理ディレクトリ名（Works_Dir 解決後）自身と一致する場合は
      // DataBases/ のような追加サブフォルダを持たないフラットレイアウトのため、レイヤーセグメントを畳み込む
      // （例: 共通資料 Works_Dir="References" + DB_Layer="References" → data/References/ref_*.json、
      //   data/References/References/... の二重化を避ける）
      const dbRelPath = (layer === effectiveDirName)
        ? `data/${effectiveDirName}/${fileName}`
        : `data/${effectiveDirName}/${layer}/${fileName}`;

      // ファイルが存在しない DB はスキップ
      const dbAbsPath = path.join(SUBMODULE, dbRelPath.replace(/\//g, path.sep));
      if (!fs.existsSync(dbAbsPath)) {
        log(`スキップ (DBファイルなし): ${dbRelPath}`);
        continue;
      }

      workEntry.db_files.push({ path: dbRelPath, ai_training: dbPolicy });

      // レコードを取得（_Commons 補完済み・isPrivate 含む）
      let records = [];
      try {
        records = await client.getRecords(workKey, dbMetaKey, { applyCommons: true });
      } catch (e) {
        // 既知の CreationsDBClient 側の制約: readDBRecords() の prefix 剥がし正規表現が
        // `Ref_` を考慮しないため、#Ref_* かつ DB_Layer が非既定 (例: References) の DB では
        // ファイルが実在しても "DB file not found" になることがある。
        // dbAbsPath は本スクリプト側で独自に解決済み（かつ存在確認済み）なので、直接読み込みで救済する。
        // ただしこの経路では _Commons 継承が適用されないため、継承前の値でポリシーを判定して
        // 誤って許可しないよう、_Commons がポリシー値を供給していないことを確かめてから使う。
        const fallback = readJSON(dbAbsPath);
        if (Array.isArray(fallback)) {
          assertDirectReadSafe(dbEntry, `${workKey} / ${dbMetaKey}`);
          log(`WARN: client.getRecords 失敗のため直接読み込みにフォールバック (${workKey} / ${dbMetaKey}): ${e.message}`);
          records = fallback;
        } else {
          log(`WARN: getRecords 失敗 (${workKey} / ${dbMetaKey}): ${e.message}`);
          continue;
        }
      }

      // この DB で実際に許可されたレコード数。allowed_db_keys の導出に使う（下記参照）
      let dbAllowedRecords = 0;
      let dbTotalRecords = 0;

      for (const [idx, charData] of records.entries()) {
        if (typeof charData !== 'object' || charData === null) continue;

        // 安定した識別子を導出（Num → ID → id → Name → 配列インデックス の優先順）
        // Term_JP: 共通資料 (#Works_CommonReferences) の Ref_* レコードが使う主インデックス
        const charId = String(
          charData.Num ?? charData.ID ?? charData.Id ?? charData.id ??
          charData.Key ?? charData.Code ?? charData.Name_JP ?? charData.Term_JP ?? charData.Name ?? idx
        );

        // 画像パスを解決
        const images = resolveCharacterImages(workDir, charId, charData, dbMetaKey);

        // AIHints を data から取り出してトップレベルにも露出する
        const aiHints = charData.AIHints ?? null;

        // isPrivate / _Secondaries カテゴリ別 AI_Optout / Progress の AI_Unready を考慮して決定
        const charPolicy = getCharacterAIPolicy(dbPolicy, charData, secondaryOptout, progressUnready.values);
        dbTotalRecords++;
        if (charPolicy.allowed) dbAllowedRecords++;

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
        // AppearanceDetail: 外見デザイン詳細の構造化データが存在するかどうか
        const hasAppearanceDetail = !!(
          Array.isArray(charData.AppearanceDetail) && charData.AppearanceDetail.length > 0
        );
        // TailsUnit: 尻尾ユニットの構造化データ (形状/本数/節数/分岐配置 + 参考画像) が存在するかどうか
        // (2026-07-10 addon-ai-tag: $Def_TailsUnit[] 専用型 + TailsUnit_PNGName 参考画像フィールド追加)
        const hasTailsUnit = !!(
          Array.isArray(charData.TailsUnit) && charData.TailsUnit.length > 0
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
          has_appearance_detail: hasAppearanceDetail,
          has_tails_unit: hasTailsUnit,
          // 原データを変更せずそのまま参照
          data: charData,
          images,
        };

        workEntry.characters.push({ id: charId, images, has_ai_hints: !!aiHints, has_silhouette_notes: hasAnySilhouetteNotes, has_immutable_constraints: hasAnyImmutableConstraints, has_negative_keywords: hasAnyNegativeKeywords, has_work_common: hasWorkCommonBlock, has_concept_forms_metadata: hasConceptFormsMeta, has_appearance_detail: hasAppearanceDetail, has_tails_unit: hasTailsUnit, ai_training_allowed: charPolicy.allowed });
        totalCharacters++;
        if (charPolicy.allowed) totalAllowedCharacters++;
        if (aiHints) totalWithAiHints++;
        if (hasAnySilhouetteNotes)       totalWithSilhouetteNotes++;
        if (hasAnyImmutableConstraints)  totalWithImmutableConstraints++;
        if (hasAnyNegativeKeywords)      totalWithNegativeKeywords++;
        if (hasWorkCommonBlock)          totalWithWorkCommon++;
        if (hasConceptFormsMeta)         totalWithConceptFormsMeta++;
        if (hasAppearanceDetail)         totalWithAppearanceDetail++;
        if (hasTailsUnit)                totalWithTailsUnit++;

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

      // allowed_db_keys は「実際に許可されたレコードを 1 件以上含む DB」だけを載せる。
      // DB 層が allowed でも、カテゴリ別 AI_Optout や isPrivate、Progress の AI_Unready によって
      // 全レコードが弾かれることがある（例: #DB_Secondary は 38 件すべて disallowed）。
      // DB 層のフラグだけを見て載せると、オプトアウト済みの画像を「学習可」と伝えてしまう。
      dbRecordStats.push({ key: dbMetaKey, allowed: dbAllowedRecords, total: dbTotalRecords });
      if (dbPolicy.allowed && dbAllowedRecords > 0) allowedDbKeys.push(dbMetaKey);
    }

    // --- 画像インデックス ---
    // 画像は DB 別ディレクトリ (DB_Primary / DB_Secondary 等) に格納されているため、
    // ai_training ポリシーは「いずれかの DB が allowed なら work 単位で参照可」として
    // 概要のみ提示する。詳細なフィルタリングは manifest-training.jsonl を参照。
    // Works_ImagesDir オーバーライド作品（例: 共通資料 → data/GeneralImages）は画像ルートが workDir/Images でない
    const imagesDir = worksImagesDirOverride ? path.join(DATA_DIR, worksImagesDirOverride) : path.join(workDir, 'Images');
    const workImages = collectImages(imagesDir, SUBMODULE);
    const workHasAllowedDb = allowedDbKeys.length > 0;
    imageIndex.works[workKey] = {
      title_ja: workTopMeta.Title_JP || '',
      title_en: workTopMeta.Title_EN || '',
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_keys: allowedDbKeys,
        // allowed_db_keys は「許可レコードを含む DB」を示す粗いフィルタに過ぎない。
        // 1 つの DB の中で許可・不許可が混在するため（例: 未着手キャラは Progress で除外される）、
        // 画像単位で厳密に判定するにはレコード側の ai_training を参照する必要がある。
        note: workHasAllowedDb
          ? 'allowed_db_keys は「AI 学習許可レコードを 1 件以上含む DB」の一覧です。'
            + '同じ DB の中でも許可・不許可はレコード単位で分かれるため、この一覧だけで画像の利用可否を判断しないでください。'
            + '正典は manifest.jsonl / manifest-training.jsonl の各レコードの ai_training と images です。'
            + 'db_records に DB ごとの許可件数を載せています。'
          : AI_TRAINING_DISALLOWED_REASON,
      },
      db_records: dbRecordStats,
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
    const workOutFileName = `${dirName}.json`;
    writtenWorksFiles.add(workOutFileName);
    const workOutPath = path.join(WORKS_OUT, workOutFileName);
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
      character_ids_with_appearance_detail: workEntry.characters.filter(c => c.has_appearance_detail).map(c => c.id),
      character_ids_with_tails_unit: workEntry.characters.filter(c => c.has_tails_unit).map(c => c.id),
      image_paths: workImages,
    }, null, 2), 'utf8');
  }

  // ソース側で削除・統合された作品（例: 2026-07-11 Works_Proxies → Works_DestinyFoxRecords 統合）の
  // 古い works/<WorkKey>.json を掃除する
  for (const staleFile of preexistingWorksFiles) {
    if (writtenWorksFiles.has(staleFile)) continue;
    fs.unlinkSync(path.join(WORKS_OUT, staleFile));
    info(`削除 (作品消滅): works/${staleFile}`);
  }

  // -----------------------------------------------------------------------
  // 3. GeneralImages / Dictionaries / References（トップレベル）
  // -----------------------------------------------------------------------

  const generalImgDir = path.join(DATA_DIR, 'GeneralImages');
  imageIndex.general_images = collectImages(generalImgDir, SUBMODULE);

  const dictDir = path.join(DATA_DIR, 'Dictionaries');
  if (fs.existsSync(dictDir)) {
    for (const entry of readdirSorted(dictDir)) {
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
      appearance_detail_field: {
        description: 'AppearanceDetail: 外見デザイン詳細の構造化データ ($Def_AppearanceDetail[]|#Null)。Formation / BodyPart / Laterality / DesignElement / Attrs / img_PNGName / Note_JP / Note_EN の各フィールドを持つオブジェクト配列。将来的に AIHints.forms.*.silhouette_notes の自然言語記述の源泉データとして統合予定。',
        consumer_guidance: '有無は has_appearance_detail フラグで確認。各エントリの DesignElement / Attrs に外見パーツ・属性の構造化情報が格納される。AIHints の silhouette_notes と併用することで構造化 + 自然言語の両面から外見を参照できる。',
      },
      tails_unit_field: {
        description: 'TailsUnit: 尻尾ユニットの構造化データ ($Def_TailsUnit[]|#Null、2026-07-10 addon-ai-tag 専用型化)。TailShapeType / Count / Segment / Branches (分岐配置) / LayoutDirection (LayoutFrom/LayoutTo) / TailsUnit_PNGName (参考画像・$subfolder: attr/tailsUnit) / Note_JP / Note_EN の各フィールドを持つオブジェクト配列。',
        consumer_guidance: '有無は has_tails_unit フラグで確認。参考画像は images.tails_unit (存在する場合のみ) を参照。AppearanceDetail と同様、将来的に AIHints.forms.*.silhouette_notes の源泉データ候補。',
      },
      images_field: {
        'DB_Primary (等)': 'charId ディレクトリ配下の画像 (corefolder / humanoid 等、形態別フォルダスキャン結果)',
        concept:      '両形態を含む概念イラスト 1 枚 (DB_Primary/concept/cnsp_img{N}.png 等) — 2026-06-19 追加',
        concept_alt:  '概念イラストのバリアント群 (conceptAlt_PNGName[] 由来、複数形態・複数キャラ構図を含む場合あり) — 2026-06-19 追加',
        corefolder:   'コアフォルダ形態の正規イラスト (corefolder_PNGPath[] 由来、DB_Primary/corefolder/{path}) — 2026-06-23 追加',
        humanoid:     '人型形態の正規イラスト (humanoid_PNGPath[] 由来、DB_Primary/humanoid/{path}) — 2026-06-23 追加',
        arts:         'キャラクター個別アートワーク (arts_PNGPath[] 由来) — 2026-06-19 追加',
        design_alt:   '衣装差分・デザインバリアント (designAlt_PNGPath[] 由来、形態注記なし) — 2026-06-19 追加',
        tails_unit:   '尻尾ユニット参考画像 (TailsUnit[*].TailsUnit_PNGName 由来、DB_Primary/attr/tailsUnit/{name}) — 2026-07-10 追加',
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
    appearance_detail_stats: {
      with_appearance_detail: totalWithAppearanceDetail,
    },
    tails_unit_stats: {
      with_tails_unit: totalWithTailsUnit,
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
 * 実在判定は「推測した拡張子を付けて existsSync」ではなく、実ディレクトリのエントリ名との
 * 突き合わせで行い、拡張子の大文字小文字は無視して照合したうえで **実ファイル名をそのまま**
 * 返す。前者の方式では、case-sensitive な FS（CI の Linux）が実体 `.PNG` を取りこぼす一方、
 * case-insensitive な FS（Windows）は実体と綴りの異なるパスを記録してしまい、
 * 同一ソースでもプラットフォームで出力が食い違うため。
 *
 * @param {string} baseNoExt  拡張子を除いた絶対パス
 * @returns {string|null}
 */
function resolveImagePath(baseNoExt) {
  const dir = path.dirname(baseNoExt);
  if (!fs.existsSync(dir)) return null;
  const wanted = path.basename(baseNoExt);
  const files = readdirSorted(dir).filter(e => e.isFile());
  for (const ext of IMAGE_EXTS) {
    const hit = files.find(e =>
      e.name.slice(0, wanted.length) === wanted &&
      e.name.slice(wanted.length).toLowerCase() === ext);
    if (hit) {
      return path.relative(SUBMODULE, path.join(dir, hit.name)).replace(/\\/g, '/');
    }
  }
  return null;
}

// フィールド名 → Images/DB_Primary 配下のフォルダヒント。
// _DBCrossLinkPath 解決時、参照先レコードにスキーマ (imagePathHints) を問い合わせられないため、
// 自作品で使う固定の対応表で代用する（2026-07-11 addon-ai-tag 追加分の既知フィールドのみ）。
const IMAGE_FIELD_FOLDER_HINTS = {
  concept_PNGName: 'concept',
  conceptAlt_PNGName: 'concept',
  corefolder_PNGPath: 'corefolder',
  humanoid_PNGPath: 'humanoid',
  arts_PNGPath: 'arts',
  designAlt_PNGPath: 'designAlt',
};

/**
 * `_DBCrossLinkPath` wrapper（2026-07-11 addon-ai-tag 追加。他Work/他DBの画像を isoPath 経由で
 * 直接参照する仕組み）を解決する。creations-db/lib/data-common.js の
 * EnrichmentProcessor.resolveDbCrossLinkPathEntry() 相当の簡易版で、schema 側の imagePathHints
 * が引けないため IMAGE_FIELD_FOLDER_HINTS の固定表で folderHint を代用する。
 * @param {object} wrapper - `{ _DB, _Work?, _Field?, _IsoPath }`
 * @param {string} defaultFieldName - wrapper が出現したフィールド名（`_Field` 省略時の既定値）
 * @param {string} currentDirName - 参照元キャラクターの作品ディレクトリ名（`_Work` 省略時の既定値）
 * @returns {string|null} サブモジュール相対パス
 */
function resolveDbCrossLinkPath(wrapper, defaultFieldName, currentDirName) {
  if (!wrapper || typeof wrapper !== 'object') return null;
  const targetDB = typeof wrapper._DB === 'string' ? wrapper._DB.trim() : '';
  const isoPath = typeof wrapper._IsoPath === 'string' ? wrapper._IsoPath.trim() : '';
  if (!targetDB || !isoPath) return null;
  const targetWorkRaw = typeof wrapper._Work === 'string' ? wrapper._Work.trim() : '';
  const targetDirName = targetWorkRaw ? `Works_${targetWorkRaw}` : currentDirName;
  const targetField = (typeof wrapper._Field === 'string' && wrapper._Field.trim()) || defaultFieldName;
  const folderHint = IMAGE_FIELD_FOLDER_HINTS[targetField];
  if (!folderHint) return null; // 未知のフィールドは安全側で未解決のまま
  const targetDbImgBase = path.join(DATA_DIR, targetDirName, 'Images', `DB_${targetDB}`);
  return resolveImagePath(path.join(targetDbImgBase, folderHint, isoPath));
}

/**
 * Images.* 配列/単一要素（通常の文字列パス、または `_DBCrossLinkPath` wrapper）を解決する共通ヘルパー。
 * @param {unknown} entry - 配列要素または単一値
 * @param {string} baseDir - 文字列パス時に使う基準ディレクトリ（dbImagesBase/<folderHint>）
 * @param {string} fieldName - `_DBCrossLinkPath` の `_Field` 省略時の既定値
 * @param {string} currentDirName - `_DBCrossLinkPath` の `_Work` 省略時の既定値
 * @returns {string|null}
 */
function resolveImageArrayEntry(entry, baseDir, fieldName, currentDirName) {
  if (typeof entry === 'string') return resolveImagePath(path.join(baseDir, entry));
  if (entry && typeof entry === 'object' && entry._DBCrossLinkPath) {
    return resolveDbCrossLinkPath(entry._DBCrossLinkPath, fieldName, currentDirName);
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
 *   tails_unit                      TailsUnit[*].TailsUnit_PNGName (尻尾ユニット参考画像) — 2026-07-10 追加
 */
function resolveCharacterImages(workDir, charId, charData, dbMetaKey) {
  const images = {};
  // _DBCrossLinkPath の _Work 省略時に「自作品」として使う作品ディレクトリ名
  const dirName = path.basename(workDir);

  // --- 既存: charId ディレクトリスキャン (corefolder / humanoid 等の形態別画像) ---
  const imagesBase = path.join(workDir, 'Images');
  if (!fs.existsSync(imagesBase)) return images;

  // DB_Primary / DB_SemiPrimary / DB_Secondary / DB_SelfSecondary のそれぞれに
  // charId ディレクトリが存在することがある
  for (const dbImgDir of readdirSorted(imagesBase)) {
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

  // 各 DB は自前の画像ディレクトリを持つ（Images/DB_SelfSecondary/concept/ 等）ため、
  // *_PNGName / *_PNGPath はレコードが属する DB の配下で解決する。DB_Primary 決め打ちだと
  // 非 Primary DB のレコードが宣言した画像を取りこぼす（#DB_SelfSecondary / #DB_SemiPrimary の 16 件）。
  // 見つからないときに DB_Primary へフォールバックしてはいけない。他 DB の同名画像を誤って
  // 結び付ける危険があり、他 DB を参照する正規の手段は _DBCrossLinkPath wrapper の方である。
  const dbImagesBase = path.join(imagesBase, String(dbMetaKey).replace(/^#/, ''));

  // --- TailsUnit (複数): 尻尾ユニット参考画像 ---
  // TailsUnit[*].TailsUnit_PNGName → Images/<DB>/attr/tailsUnit/{name}.<ext>
  // charData.Images とは独立したトップレベルフィールドのため、下記の charImages 早期 return より前に解決する。
  // TailsUnit_PNGName は他の *_PNGName/*_PNGPath と異なり拡張子込みで格納されている (db_meta.json の
  // $type: "#PNGFileName|#Null" 準拠) ため、resolveImagePath に渡す前に既知の拡張子を取り除く。
  if (Array.isArray(charData.TailsUnit) && charData.TailsUnit.length > 0) {
    const tailsUnitPaths = charData.TailsUnit
      .map(entry => (entry && typeof entry.TailsUnit_PNGName === 'string') ? entry.TailsUnit_PNGName : null)
      .filter(Boolean)
      .map(name => resolveImagePath(path.join(dbImagesBase, 'attr/tailsUnit', name.replace(/\.(png|jpe?g|gif|webp|svg)$/i, ''))))
      .filter(Boolean);
    if (tailsUnitPaths.length > 0) images.tails_unit = tailsUnitPaths;
  }

  // --- Phase 1: charData.Images の構造化フィールドから画像パスを解決 ---
  // concept / conceptAlt / arts / designAlt は DB_Primary 配下に格納される。
  const charImages = charData.Images;
  if (!charImages || typeof charImages !== 'object') return images;

  // concept (単一): 両形態を描いた概念イラスト。
  // concept_PNGName → Images/DB_Primary/concept/{name}.<ext>（文字列 or _DBCrossLinkPath wrapper）
  if (charImages.concept_PNGName) {
    const rel = resolveImageArrayEntry(charImages.concept_PNGName, path.join(dbImagesBase, 'concept'), 'concept_PNGName', dirName);
    if (rel) images.concept = [rel];
  }

  // concept_alt (複数): 概念イラストのバリアント（複数形態・複数キャラ構図など）。
  // conceptAlt_PNGName[] → Images/DB_Primary/concept/{name}.<ext>（要素は文字列 or _DBCrossLinkPath wrapper）
  if (Array.isArray(charImages.conceptAlt_PNGName) && charImages.conceptAlt_PNGName.length > 0) {
    const paths = charImages.conceptAlt_PNGName
      .map(name => resolveImageArrayEntry(name, path.join(dbImagesBase, 'concept'), 'conceptAlt_PNGName', dirName))
      .filter(Boolean);
    if (paths.length > 0) images.concept_alt = paths;
  }

  // corefolder (複数): コアフォルダ形態の正規イラスト。
  // corefolder_PNGPath[] → Images/DB_Primary/corefolder/{path}.<ext>（要素は文字列 or _DBCrossLinkPath wrapper）
  // 形態フォルダ (corefolder/) が charId の 1 階層上に挟まるため、charId ディレクトリ
  // スキャン (上の DB_* ループ) では拾えない。構造化フィールドとして明示解決する。
  if (Array.isArray(charImages.corefolder_PNGPath) && charImages.corefolder_PNGPath.length > 0) {
    const paths = charImages.corefolder_PNGPath
      .map(rel => resolveImageArrayEntry(rel, path.join(dbImagesBase, 'corefolder'), 'corefolder_PNGPath', dirName))
      .filter(Boolean);
    if (paths.length > 0) images.corefolder = paths;
  }

  // humanoid (複数): 人型形態の正規イラスト。
  // humanoid_PNGPath[] → Images/DB_Primary/humanoid/{path}.<ext>（要素は文字列 or _DBCrossLinkPath wrapper）
  // corefolder と同じく形態フォルダ (humanoid/) が 1 階層挟まる。現状ファイル未配置でも
  // resolveImagePath が null を返すだけなので将来の追加に備えて先行対応する。
  if (Array.isArray(charImages.humanoid_PNGPath) && charImages.humanoid_PNGPath.length > 0) {
    const paths = charImages.humanoid_PNGPath
      .map(rel => resolveImageArrayEntry(rel, path.join(dbImagesBase, 'humanoid'), 'humanoid_PNGPath', dirName))
      .filter(Boolean);
    if (paths.length > 0) images.humanoid = paths;
  }

  // arts (複数): キャラクター個別に紐付けられたアートワーク。
  // arts_metadata が存在する場合はそちらを優先し { path, form, characters } 形式で出力。
  // なければ arts_PNGPath[] からパスのみで補完（要素は文字列 or _DBCrossLinkPath wrapper）。
  // パスは DB_Primary/arts/ 相対。../../DB_SemiPrimary/... など親ディレクトリ参照も path.join で正規化される。
  {
    const artsMeta = Array.isArray(charImages.arts_metadata) && charImages.arts_metadata.length > 0
      ? charImages.arts_metadata
      : null;
    if (artsMeta) {
      const entries = artsMeta.flatMap(({ path: rel, form, characters }) => {
        const resolved = resolveImageArrayEntry(rel, path.join(dbImagesBase, 'arts'), 'arts_PNGPath', dirName);
        if (!resolved) return [];
        return [{ path: resolved, form: form ?? null, characters: Array.isArray(characters) ? characters : null }];
      });
      if (entries.length > 0) images.arts = entries;
    } else if (Array.isArray(charImages.arts_PNGPath) && charImages.arts_PNGPath.length > 0) {
      const entries = charImages.arts_PNGPath.flatMap(rel => {
        const resolved = resolveImageArrayEntry(rel, path.join(dbImagesBase, 'arts'), 'arts_PNGPath', dirName);
        return resolved ? [{ path: resolved, form: null, characters: null }] : [];
      });
      if (entries.length > 0) images.arts = entries;
    }
  }

  // design_alt (複数): 衣装差分・デザインバリアント。
  // designAlt_metadata が存在する場合はそちらを優先し { path, form, characters } 形式で出力。
  // なければ designAlt_PNGPath[] からパスのみで補完（要素は文字列 or _DBCrossLinkPath wrapper）。
  // パスは DB_Primary/designAlt/ 相対（arts/ ではない点に注意）。
  {
    const daltMeta = Array.isArray(charImages.designAlt_metadata) && charImages.designAlt_metadata.length > 0
      ? charImages.designAlt_metadata
      : null;
    if (daltMeta) {
      const entries = daltMeta.flatMap(({ path: rel, form, characters }) => {
        const resolved = resolveImageArrayEntry(rel, path.join(dbImagesBase, 'designAlt'), 'designAlt_PNGPath', dirName);
        if (!resolved) return [];
        return [{ path: resolved, form: form ?? null, characters: Array.isArray(characters) ? characters : null }];
      });
      if (entries.length > 0) images.design_alt = entries;
    } else if (Array.isArray(charImages.designAlt_PNGPath) && charImages.designAlt_PNGPath.length > 0) {
      const entries = charImages.designAlt_PNGPath.flatMap(rel => {
        const resolved = resolveImageArrayEntry(rel, path.join(dbImagesBase, 'designAlt'), 'designAlt_PNGPath', dirName);
        return resolved ? [{ path: resolved, form: null, characters: null }] : [];
      });
      if (entries.length > 0) images.design_alt = entries;
    }
  }

  return images;
}

/** ファイルの絶対パスを再帰収集 */
function collectImagesRaw(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of readdirSorted(dir)) {
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
