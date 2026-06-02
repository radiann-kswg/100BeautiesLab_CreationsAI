#!/usr/bin/env node
/**
 * build-dataset.js
 * ================
 * 100BeautiesLab_CreationsDB サブモジュールのデータを読み取り専用で参照し、
 * AI 学習向けのインデックス・マニフェストファイルを ai-dataset/ に生成します。
 *
 * 重要: このスクリプトは creations-db/ 以下のファイルを一切変更しません。
 *       生成先は ai-dataset/ のみです。
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

'use strict';

const fs   = require('fs');
const path = require('path');

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

// DB ファイル名の優先順（一次 → 準一次 → 自二次 → 二次）
const DB_FILE_ORDER = [
  'db_Primary.json',
  'db_SemiPrimary.json',
  'db_SelfSecondary.json',
  'db_Secondary.json',
  'db_UnprocessedSecondary.json',
];

// 画像として扱う拡張子
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// ---------------------------------------------------------------------------
// AI 学習利用ポリシー
// ---------------------------------------------------------------------------
// 創作 DB 側で正規のフラグ実装が完了するまでの暫定対応として、本リポジトリでは
// 「整備済み」と確認された (workKey, dbFileName) の組み合わせのみ AI 学習利用を
// 許可する。それ以外は `ai_training.allowed = false` を付与してオプトアウト扱い
// とし、生成 AI・学習ジョブ側で自動的に除外できるようにする。
//
// 2026-06 時点での整備済み:
//   - #Works_NumberTales × db_Primary.json (AIHints 二層構造を完備)
//
// 上記以外はすべて「整備中」として AI 学習利用を抑止する。
const AI_TRAINING_ALLOWLIST = {
  '#Works_NumberTales': new Set(['db_Primary.json']),
};

const AI_TRAINING_DISALLOWED_REASON =
  'work-in-progress: this work/DB is still being curated for AI use. ' +
  'Pending an official flag in the upstream CreationsDB, the dataset opts this record out of AI training.';
const AI_TRAINING_ALLOWED_REASON =
  'curated: this work/DB has been reviewed and includes AIHints (two-layer: common + forms) for image-generation use.';

/** (workKey, dbFileName) -> { allowed: boolean, reason: string } */
function getAITrainingPolicy(workKey, dbFileName) {
  const allowed = !!(AI_TRAINING_ALLOWLIST[workKey] && AI_TRAINING_ALLOWLIST[workKey].has(dbFileName));
  return {
    allowed,
    reason: allowed ? AI_TRAINING_ALLOWED_REASON : AI_TRAINING_DISALLOWED_REASON,
  };
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

// ---------------------------------------------------------------------------
// サブモジュールのコミットハッシュを取得
// ---------------------------------------------------------------------------

function getSubmoduleCommit() {
  try {
    const gitModulesPath = path.join(REPO_ROOT, '.git', 'modules', 'creations-db', 'HEAD');
    if (fs.existsSync(gitModulesPath)) {
      return fs.readFileSync(gitModulesPath, 'utf8').trim();
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

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

function main() {
  info('=== 100BeautiesLab_CreationsAI dataset build start ===');

  // サブモジュールが存在するか確認
  if (!fs.existsSync(DATA_DIR)) {
    console.error('[build] ERROR: creations-db/data が見つかりません。');
    console.error('  git submodule update --init --recursive を実行してください。');
    process.exit(1);
  }

  ensureDir(OUT_DIR);
  ensureDir(WORKS_OUT);

  // -----------------------------------------------------------------------
  // 1. トップレベル db_meta.json を読む（作品一覧）
  // -----------------------------------------------------------------------

  const topMeta = readJSON(path.join(DATA_DIR, 'db_meta.json')) || {};
  const creationWorks = topMeta.CreationWorks || {};
  const workKeys = Object.keys(creationWorks); // "#Works_NumberTales" 等

  info(`作品数: ${workKeys.length}`);

  // -----------------------------------------------------------------------
  // 2. 各作品ディレクトリを処理
  // -----------------------------------------------------------------------

  const masterIndex = {
    _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
    _generated_at: new Date().toISOString(),
    _submodule_commit: getSubmoduleCommit(),
    works: [],
  };

  const imageIndex = {
    _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
    _generated_at: new Date().toISOString(),
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
    note: '創作DB側の正規フラグ実装までの暫定対応。allowed=true のレコードのみ AI 学習・生成に使用してください。',
    allowed: [
      { work_key: '#Works_NumberTales', db_files: ['db_Primary.json'] },
    ],
    disallowed_default: true,
    disallowed_reason: AI_TRAINING_DISALLOWED_REASON,
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
    generated_at: new Date().toISOString(),
    submodule_commit: getSubmoduleCommit(),
    usage_conditions: [
      '非営利目的に限定',
      '出典（' + SOURCE_REPO_URL + '）を明記',
      '改変した場合はその旨を明記',
    ],
    ai_training_policy: aiTrainingPolicySummary,
    target_environments: {
      novelai_sd: '各キャラクターレコード data.AIHints.forms.<form>.prompt_export / negative_prompt_export を貼付',
      chatgpt:    'common.natural_language_description + forms.<form>.natural_language_description + identity_tags / form_tags を貼付',
      gemini:     '上記に加え forms.<form>.reference_images.main を参照画像として添付',
    },
  };
  appendJSONL(manifestStream, headerRecord);
  appendJSONL(trainingStream, headerRecord);

  let totalCharacters = 0;
  let totalAllowedCharacters = 0;

  for (const workKey of workKeys) {
    const workMeta = creationWorks[workKey];
    // workKey 例: "#Works_NumberTales" → dirName: "Works_NumberTales"
    const dirName = workKey.replace(/^#/, '');
    const workDir = path.join(DATA_DIR, dirName);

    if (!fs.existsSync(workDir)) {
      log(`スキップ (ディレクトリなし): ${dirName}`);
      continue;
    }

    info(`処理中: ${dirName} (${workMeta.Title || ''} / ${workMeta.Title_EN || ''})`);

    // --- 作品メタ情報 ---
    const workEntry = {
      work_key: workKey,
      dir_name: dirName,
      title_ja: workMeta.Title || '',
      title_en: workMeta.Title_EN || '',
      summary: workMeta.Works_Summary || '',
      layout: workMeta.$DetailLayout || null,
      characters: [],
      db_files: [],
    };

    // --- キャラクター DB ファイルを順番に読む ---
    const dbDir = path.join(workDir, 'DataBases');
    if (fs.existsSync(dbDir)) {
      // 作品固有の db_type / db_meta も読んでおく
      const workDbType = readJSON(path.join(dbDir, 'db_type.json'));
      const workDbMeta = readJSON(path.join(dbDir, 'db_meta.json'));

      for (const dbFileName of DB_FILE_ORDER) {
        const dbFilePath = path.join(dbDir, dbFileName);
        if (!fs.existsSync(dbFilePath)) continue;

        const dbData = readJSON(dbFilePath);
        if (!dbData) continue;

        const dbRelPath = path.relative(SUBMODULE, dbFilePath).replace(/\\/g, '/');
        const dbPolicy  = getAITrainingPolicy(workKey, dbFileName);
        workEntry.db_files.push({ path: dbRelPath, ai_training: dbPolicy });

        // DB ファイルのルートキーを走査（キャラクターエントリ）
        for (const [charId, charData] of Object.entries(dbData)) {
          if (typeof charData !== 'object' || charData === null) continue;
          // メタキー（$ や _ で始まるもの）はスキップ
          if (charId.startsWith('$') || charId.startsWith('_')) continue;

          // 画像パスを解決
          const images = resolveCharacterImages(workDir, charId, charData);

          // AIHints を data から取り出してトップレベルにも露出する
          // （AI 消費側が data.AIHints まで辿らずアクセスできるようにする）
          const aiHints = (charData && typeof charData === 'object' && charData.AIHints)
            ? charData.AIHints
            : null;

          const charEntry = {
            id: charId,
            work_key: workKey,
            work_title_ja: workMeta.Title || '',
            work_title_en: workMeta.Title_EN || '',
            db_source: dbRelPath,
            ai_training: dbPolicy,
            ai_hints: aiHints,
            has_ai_hints: !!aiHints,
            // 原データを変更せずそのまま参照
            data: charData,
            images,
          };

          workEntry.characters.push({ id: charId, images, has_ai_hints: !!aiHints, ai_training_allowed: dbPolicy.allowed });
          totalCharacters++;
          if (dbPolicy.allowed) totalAllowedCharacters++;

          // JSONL レコード（1キャラクター = 1行）
          const record = { _type: 'character', ...charEntry };
          appendJSONL(manifestStream, record);
          if (dbPolicy.allowed) appendJSONL(trainingStream, record);
        }

        // Dictionaries なども JSONL に追加
        if (workDbType) {
          const typeRecord = {
            _type: 'work_type_definitions',
            work_key: workKey,
            source: path.relative(SUBMODULE, path.join(dbDir, 'db_type.json')).replace(/\\/g, '/'),
            ai_training: dbPolicy,
            data: workDbType,
          };
          appendJSONL(manifestStream, typeRecord);
          if (dbPolicy.allowed) appendJSONL(trainingStream, typeRecord);
        }
      }
    }

    // --- 画像インデックス ---
    // 画像は DB 別ディレクトリ (DB_Primary / DB_Secondary 等) に格納されているため、
    // ai_training ポリシーは「いずれかの DB が allowed なら work 単位で参照可」として
    // 概要のみ提示する。詳細なフィルタリングは manifest-training.jsonl を参照。
    const imagesDir = path.join(workDir, 'Images');
    const workImages = collectImages(imagesDir, SUBMODULE);
    const workHasAllowedDb = !!AI_TRAINING_ALLOWLIST[workKey];
    imageIndex.works[workKey] = {
      title_ja: workMeta.Title || '',
      title_en: workMeta.Title_EN || '',
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_files: workHasAllowedDb ? [...AI_TRAINING_ALLOWLIST[workKey]] : [],
        note: workHasAllowedDb
          ? '画像パスのうち DB_Primary 配下 (Images/DB_Primary/...) のみが AI 学習許可対象です。'
          : AI_TRAINING_DISALLOWED_REASON,
      },
      images: workImages,
      count: workImages.length,
    };

    // --- References ---
    const refsDir = path.join(workDir, 'References');
    const refImages = collectImages(refsDir, SUBMODULE);
    if (refImages.length > 0) {
      if (!imageIndex.works[workKey].references) imageIndex.works[workKey].references = [];
      imageIndex.works[workKey].references = refImages;
    }

    masterIndex.works.push({
      work_key: workKey,
      dir_name: dirName,
      title_ja: workMeta.Title || '',
      title_en: workMeta.Title_EN || '',
      character_count: workEntry.characters.length,
      image_count: workImages.length,
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_files: workHasAllowedDb ? [...AI_TRAINING_ALLOWLIST[workKey]] : [],
        reason: workHasAllowedDb ? AI_TRAINING_ALLOWED_REASON : AI_TRAINING_DISALLOWED_REASON,
      },
    });

    // --- 作品別 JSON を出力 ---
    // （タイトル等メタ + キャラクター一覧。画像パス含む）
    const workOutPath = path.join(WORKS_OUT, `${dirName}.json`);
    fs.writeFileSync(workOutPath, JSON.stringify({
      _notice: '原著作物: 百花繚乱研究所 一次創作作品 / CC BY-NC 4.0 / ' + SOURCE_REPO_URL,
      _generated_at: new Date().toISOString(),
      work_key: workKey,
      dir_name: dirName,
      title_ja: workMeta.Title || '',
      title_en: workMeta.Title_EN || '',
      summary: workMeta.Works_Summary || '',
      layout: workMeta.$DetailLayout || null,
      ai_training: {
        allowed: workHasAllowedDb,
        allowed_db_files: workHasAllowedDb ? [...AI_TRAINING_ALLOWLIST[workKey]] : [],
        reason: workHasAllowedDb ? AI_TRAINING_ALLOWED_REASON : AI_TRAINING_DISALLOWED_REASON,
      },
      db_files: workEntry.db_files,
      character_ids: workEntry.characters.map(c => c.id),
      character_ids_with_ai_hints: workEntry.characters.filter(c => c.has_ai_hints).map(c => c.id),
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
    _generated_at: new Date().toISOString(),
    ai_training_policy: aiTrainingPolicySummary,
    target_environments: headerRecord.target_environments,
    schema: {
      ai_training_field: {
        allowed: 'boolean — true なら AI 学習・生成に利用可',
        reason:  'string — allowed の判定理由（整備中/整備済等）',
      },
      ai_hints_field: {
        common: '形態を問わない素体特徴 (identity_tags / palette_priority / natural_language_description 等)',
        forms:  '形態別 (corefolder / humanoid) の outfit_features / ai_tags / prompt_export / negative_prompt_export / reference_images',
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
    generated_at: new Date().toISOString(),
    submodule_commit: getSubmoduleCommit(),
    source_repo: SOURCE_REPO_URL,
    licence: LICENCE_URL,
    total_works: masterIndex.works.length,
    total_characters: totalCharacters,
    total_general_images: imageIndex.general_images.length,
    ai_training_stats: aiTrainingStats,
  }, null, 2), 'utf8');
  info(`build-info.json を書き込みました`);

  info('=== build complete ===');
}

// ---------------------------------------------------------------------------
// キャラクター画像パスを解決するヘルパー
// ---------------------------------------------------------------------------

/**
 * キャラクター JSON データ内の画像参照フィールドを読み取り、
 * サブモジュール相対パスのリストを返す。
 * 画像ファイルの実在確認は行わない（パス生成のみ）。
 */
function resolveCharacterImages(workDir, charId, charData) {
  const images = {};

  // DB の Images 以下を走査して charId に一致するフォルダを探す
  const imagesBase = path.join(workDir, 'Images');
  if (!fs.existsSync(imagesBase)) return images;

  // DB_Primary / DB_SemiPrimary / DB_Secondary / DB_SelfSecondary のそれぞれに
  // charId ディレクトリが存在することがある
  for (const dbImgDir of fs.readdirSync(imagesBase, { withFileTypes: true })) {
    if (!dbImgDir.isDirectory()) continue;
    const charImgDir = path.join(imagesBase, dbImgDir.name, charId);
    if (fs.existsSync(charImgDir)) {
      const imgs = collectImages(charImgDir, null);
      // collectImages は SUBMODULE 相対パスを返すが、ここでは imagesBase 相対で呼ぶ
      const imgPaths = imgs.length > 0
        ? imgs
        : collectImages(charImgDir, SUBMODULE).map(p => p); // fallback
      // 再取得: SUBMODULE 基準
      const relPaths = collectImages(charImgDir, null).map(
        p => path.relative(SUBMODULE, path.join(charImgDir, p)).replace(/\\/g, '/')
      );
      // 正しい相対パス取得
      const correctPaths = [];
      collectImagesRaw(charImgDir).forEach(abs => {
        correctPaths.push(path.relative(SUBMODULE, abs).replace(/\\/g, '/'));
      });
      if (correctPaths.length > 0) {
        images[dbImgDir.name] = correctPaths;
      }
    }
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

main();
