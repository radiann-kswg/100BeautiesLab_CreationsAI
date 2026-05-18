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
  const manifestPath = path.join(OUT_DIR, 'manifest.jsonl');
  const manifestStream = fs.createWriteStream(manifestPath, { encoding: 'utf8' });

  // ヘッダーレコード（LLM への文脈提供用）
  appendJSONL(manifestStream, {
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
  });

  let totalCharacters = 0;

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
        workEntry.db_files.push(dbRelPath);

        // DB ファイルのルートキーを走査（キャラクターエントリ）
        for (const [charId, charData] of Object.entries(dbData)) {
          if (typeof charData !== 'object' || charData === null) continue;
          // メタキー（$ や _ で始まるもの）はスキップ
          if (charId.startsWith('$') || charId.startsWith('_')) continue;

          // 画像パスを解決
          const images = resolveCharacterImages(workDir, charId, charData);

          const charEntry = {
            id: charId,
            work_key: workKey,
            work_title_ja: workMeta.Title || '',
            work_title_en: workMeta.Title_EN || '',
            db_source: dbRelPath,
            // 原データを変更せずそのまま参照
            data: charData,
            images,
          };

          workEntry.characters.push({ id: charId, images });
          totalCharacters++;

          // JSONL レコード（1キャラクター = 1行）
          appendJSONL(manifestStream, {
            _type: 'character',
            ...charEntry,
          });
        }

        // Dictionaries なども JSONL に追加
        if (workDbType) {
          appendJSONL(manifestStream, {
            _type: 'work_type_definitions',
            work_key: workKey,
            source: path.relative(SUBMODULE, path.join(dbDir, 'db_type.json')).replace(/\\/g, '/'),
            data: workDbType,
          });
        }
      }
    }

    // --- 画像インデックス ---
    const imagesDir = path.join(workDir, 'Images');
    const workImages = collectImages(imagesDir, SUBMODULE);
    imageIndex.works[workKey] = {
      title_ja: workMeta.Title || '',
      title_en: workMeta.Title_EN || '',
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
      db_files: workEntry.db_files,
      character_ids: workEntry.characters.map(c => c.id),
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
          appendJSONL(manifestStream, {
            _type: 'dictionary',
            source: path.relative(SUBMODULE, path.join(dictDir, entry.name)).replace(/\\/g, '/'),
            data: dictData,
          });
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
  info(`manifest.jsonl を書き込みました`);

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
    ...masterIndex,
    total_characters: totalCharacters,
    total_works: masterIndex.works.length,
  }, null, 2), 'utf8');
  info(`index.json を書き込みました (${masterIndex.works.length} 作品, ${totalCharacters} キャラクター)`);

  fs.writeFileSync(path.join(OUT_DIR, 'image-index.json'), JSON.stringify(imageIndex, null, 2), 'utf8');
  info(`image-index.json を書き込みました`);

  // ビルドメタ情報
  fs.writeFileSync(path.join(OUT_DIR, 'build-info.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    submodule_commit: getSubmoduleCommit(),
    source_repo: SOURCE_REPO_URL,
    licence: LICENCE_URL,
    total_works: masterIndex.works.length,
    total_characters: totalCharacters,
    total_general_images: imageIndex.general_images.length,
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
