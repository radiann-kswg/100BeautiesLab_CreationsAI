#!/usr/bin/env node
/**
 * validate-dataset.js (ESM)
 * =========================
 * 生成済み ai-dataset/ の不変条件を検証する。違反が 1 件でもあれば exit 1。
 *
 * なぜ必要か:
 * 2026-07-17 に、上流のデータ変更で AI 学習許可レコードが 211 → 307 へ増えたことが
 * 誰にも気づかれずに CI で自動コミットされた。当時の検証は title_ja の非空と
 * total_characters >= 1 しか見ておらず、**全 532 件が誤って許可されても素通りする**状態だった。
 * 同意に関わる退行を機械的に止めるのがこのスクリプトの役目。
 *
 * 使い方:
 *   node scripts/validate-dataset.js
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { buildProgressUnreadySet, getTextRPInferencePolicy } from './lib/policy.js';
import { buildRecordIdentity, recordIdentityKey, buildTextRPReference } from './lib/text-rp.js';
import { collectSourceImagePermissions, filterRecordImageData, loadCostumeRows, projectArtAppearances, resolveCharacterImages } from './build-dataset.js';
import { CreationsDBClient } from '../creations-db/pkg/nodejs/index.mjs';
import { applyCommons } from '../creations-db/pkg/cloudflare/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR   = path.resolve(process.env.CREATIONS_AI_OUT_DIR || path.join(REPO_ROOT, 'ai-dataset'));
const SOURCE_ROOT = path.resolve(process.env.CREATIONS_DB_ROOT || path.join(REPO_ROOT, 'creations-db'));
const DATA_DIR  = path.join(SOURCE_ROOT, 'data');

const failures = [];
const fail = (msg) => failures.push(msg);

const readJSON  = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readJSONL = (p) => fs.readFileSync(p, 'utf8').split('\n')
  .filter(l => l.trim()).map(l => JSON.parse(l));

const index    = readJSON(path.join(OUT_DIR, 'index.json'));
const buildInfo = readJSON(path.join(OUT_DIR, 'build-info.json'));
const manifest = readJSONL(path.join(OUT_DIR, 'manifest.jsonl'));
const training = readJSONL(path.join(OUT_DIR, 'manifest-training.jsonl'));
const imageIndex = readJSON(path.join(OUT_DIR, 'image-index.json'));
const globalMeta = readJSON(path.join(DATA_DIR, 'db_meta.json'));

const chars = manifest.filter(r => r._type === 'character');
const allowedChars = chars.filter(r => r.ai_training?.allowed === true);
const client = new CreationsDBClient(SOURCE_ROOT, { includePrivate: true });
const imagePolicy = await import(pathToFileURL(path.join(SOURCE_ROOT, 'pkg/ai-image-policy.mjs')).href);
const { filterAIImageReferences, filterCostumeOptouts } = imagePolicy;
const artAppearances = new Map();
const imagePermissions = await collectSourceImagePermissions(client, globalMeta.CreationWorks,
  buildProgressUnreadySet(globalMeta).values, imagePolicy, artAppearances);
const permittedImage = value => imagePermissions.has(value);

// --- RP 推論の許諾・正規複合識別・テキスト限定投影 ---------------------------
const rpStats = { allowed: 0, denied: 0, unknown: 0, with_reference: 0, unidentified: 0 };
const workSources = new Map(index.works.map(work => {
  const top = globalMeta.CreationWorks[work.work_key];
  const dir = top.Works_Dir || work.dir_name;
  const base = path.join(DATA_DIR, dir, ...(top.Works_Dir ? [] : ['DataBases']));
  return [work.work_key, {
    top, workDir: path.join(DATA_DIR, dir), imageRoot: top.Works_ImagesDir ? path.join(DATA_DIR, top.Works_ImagesDir) : path.join(DATA_DIR, dir, 'Images'),
    meta: readJSON(path.join(base, 'db_meta.json')), type: readJSON(path.join(base, 'db_type.json')),
  }];
}));
const originalRecords = new Map();
const sourcePositions = new Map();
for (const r of chars) {
  const key = `${r.work_key}/${r.db_key}`;
  if (!originalRecords.has(key)) {
    let records;
    try { records = await client.getRecords(r.work_key, r.db_key, { applyCommons: true }); }
    catch { records = applyCommons(readJSON(path.join(SOURCE_ROOT, r.db_source)), workSources.get(r.work_key).meta, r.db_key.replace(/^#(DB|Ref)_/, '')); }
    originalRecords.set(key, records.filter(record => record && typeof record === 'object'));
  }
  const position = sourcePositions.get(key) ?? 0;
  const source = originalRecords.get(key)[position];
  sourcePositions.set(key, position + 1);
  if (!source) { fail(`${key}/${r.id}: 原レコードが見つかりません`); continue; }
  const recordPermittedImage = value => r.ai_training?.allowed === true && permittedImage(value);
  const costumeRows = loadCostumeRows(workSources.get(r.work_key).workDir);
  const expected = filterRecordImageData(source, workSources.get(r.work_key).workDir, r.db_key, recordPermittedImage, costumeRows, workSources.get(r.work_key).imageRoot);
  if (!isDeepStrictEqual(r.data.Images, expected.Images) || !isDeepStrictEqual(r.data.AIHints, expected.AIHints)
    || r.data.Images_AIOptout !== undefined || r.data.Images_Appearance !== undefined) fail(`${key}/${r.id}: 原データの画像除外が不一致`);
  const original = resolveCharacterImages(workSources.get(r.work_key).workDir, r.id, source, r.db_key);
  for (const [category, values] of Object.entries(original)) {
    const permitted = values.filter(value => recordPermittedImage(typeof value === 'string' ? value : value.path));
    const projected = projectArtAppearances(permitted, artAppearances, r.work_key, r.db_key, r.id);
    if (!isDeepStrictEqual(r.images?.[category] ?? [], projected)) fail(`${key}/${r.id}: ${category} の形態・登場人物が原本と不一致`);
  }
  if (!isDeepStrictEqual(r.data.AppearanceDetail, expected.AppearanceDetail)
    || !isDeepStrictEqual(r.ai_hints, filterCostumeOptouts({ AppearanceDetail: source.AppearanceDetail, AIHints: r.ai_hints }, costumeRows).AIHints)) {
    fail(`${key}/${r.id}: AI除外衣装の記述が混入`);
  }
  const designAlt = new Set((r.images?.design_alt ?? []).map(value => typeof value === 'string' ? value : value.path));
  if (['main', 'design_sheet'].some(field => designAlt.has(r.preferred_reference_images?.common?.[field]))) fail(`${key}/${r.id}: 衣装差分が代表参照画像になっています`);
  for (const values of Object.values(r.images ?? {})) {
    if (values.some(value => !recordPermittedImage(typeof value === 'string' ? value : value.path))) fail(`${key}/${r.id}: 不許可画像がimagesに混入`);
  }
  for (const [field, references] of Object.entries({ ai_hints: r.ai_hints, preferred_reference_images: { reference_images: r.preferred_reference_images } })) {
    if (!isDeepStrictEqual(references, filterAIImageReferences(references, recordPermittedImage))) fail(`${key}/${r.id}: 不許可画像が${field}に混入`);
  }
}
const expectedIdentities = chars.map(r => {
  const { top, type } = workSources.get(r.work_key);
  const dbName = r.db_key?.replace(/^#(DB|Ref)_/, '');
  const def = type?.[`$IndexDef_${dbName}`] ?? type?.$IndexDef ?? top.$DefType_Index ?? top.$Def_Index;
  return buildRecordIdentity(r.work_key, r.db_key, def, r.data);
});
const identityCounts = new Map();
for (const identity of expectedIdentities) {
  const k = recordIdentityKey(identity);
  if (k) identityCounts.set(k, (identityCounts.get(k) ?? 0) + 1);
}
for (const [i, r] of chars.entries()) {
  const { top, meta } = workSources.get(r.work_key);
  const db = meta.Databases?.[r.db_key];
  const expectedPolicy = getTextRPInferencePolicy(top.Works_Hidden === true, db, r.data);
  const candidate = expectedIdentities[i];
  const expectedIdentity = identityCounts.get(recordIdentityKey(candidate)) === 1 ? candidate : null;
  if (!db || !isDeepStrictEqual(r.text_rp_inference, expectedPolicy)) {
    fail(`${r.work_key}/${r.id}: RP 推論許諾が原本の明示値・公開状態と不一致`);
  }
  if (!isDeepStrictEqual(r.record_identity, expectedIdentity)) {
    fail(`${r.work_key}/${r.id}: 正規 work/DB/全Index の識別が不一致`);
  }
  if (!isDeepStrictEqual(r.text_rp_reference, buildTextRPReference(r.data, expectedIdentity, expectedPolicy))) {
    fail(`${r.work_key}/${r.id}: RP テキスト限定投影が不一致（対象外フィールド・不許可本文の混入を確認）`);
  }
  rpStats[expectedPolicy.status]++;
  if (r.text_rp_reference) rpStats.with_reference++;
  if (!expectedIdentity) rpStats.unidentified++;
}
if (!isDeepStrictEqual(buildInfo.text_rp_inference_stats, rpStats)) {
  fail('build-info.text_rp_inference_stats が manifest の実数と不一致');
}
for (const work of index.works) {
  const expectedPath = `works/${work.dir_name}.json`;
  if (work.character_catalog_path !== expectedPath) fail(`${work.work_key}: カタログパスが不一致`);
  const catalog = readJSON(path.join(OUT_DIR, expectedPath));
  const expected = chars.filter(r => r.work_key === work.work_key).map(r => ({
    id: r.id, db_key: r.db_key, display_name: r.display_name, record_identity: r.record_identity,
    text_rp_inference: r.text_rp_inference, text_rp_reference: r.text_rp_reference,
  }));
  if (!isDeepStrictEqual(catalog.characters, expected)) fail(`${work.work_key}: カタログとmanifestが不一致`);
}

// 新しい RP メタデータを training に混ぜず、旧レコードの集合・内容・順序を維持する。
const legacyAllowed = allowedChars.map(r => {
  const { db_key, display_name, record_identity, text_rp_inference, text_rp_reference, ...legacy } = r;
  return legacy;
});
if (!isDeepStrictEqual(training.filter(r => r._type === 'character'), legacyAllowed)) {
  fail('manifest-training のキャラクター内容・集合・順序が旧学習ゲートと不一致');
}

// --- 既存の検証（作品タイトル・総数） -------------------------------------
for (const work of index.works) {
  if (!work.title_ja) fail(`${work.work_key}: title_ja が空`);
  if (!work.title_en) fail(`${work.work_key}: title_en が空`);
}
if (!index.total_characters || index.total_characters < 1) {
  fail('total_characters が 0 またはなし');
}

// --- allowed_db_keys が実判定と整合するか ---------------------------------
// DB 層が allowed でも、カテゴリ別 AI_Optout / isPrivate / Progress で全レコードが
// 弾かれることがある。そんな DB を allowed_db_keys に載せると、オプトアウト済みの
// 画像を「学習可」と伝えてしまう（2026-07-17 以前の #DB_Secondary がまさにこれ）。
const allowedCountByDb = new Map();
for (const r of chars) {
  const key = `${r.work_key}\u0000${(r.db_source || '').split('/').pop()}`;
  if (!allowedCountByDb.has(key)) allowedCountByDb.set(key, 0);
  if (r.ai_training?.allowed) allowedCountByDb.set(key, allowedCountByDb.get(key) + 1);
}
for (const work of index.works) {
  for (const dbKey of (work.ai_training?.allowed_db_keys ?? [])) {
    const base = dbKey.replace(/^#(DB|Ref)_/, '');
    const file = (dbKey.startsWith('#Ref_') ? 'ref_' : 'db_') + base + '.json';
    const n = allowedCountByDb.get(`${work.work_key}\u0000${file}`) ?? 0;
    if (n === 0) {
      fail(`${work.work_key}: allowed_db_keys に ${dbKey} が載っているが、許可レコードが 0 件`);
    }
  }
}

// --- 不許可フラグを持つ DB・作品から許可レコードが出ていないか ------------
for (const r of allowedChars) {
  const reason = r.ai_training?.reason ?? '';
  if (/Works_Hidden: true|DB_Hidden: true|AI_Optout: true/.test(reason)) {
    fail(`${r.work_key}/${r.id}: allowed=true なのに理由が不許可フラグを示している: ${reason.slice(0, 60)}`);
  }
}

// --- Progress の AI_Unready なレコードが許可されていないか ------------------
const { values: unready } = buildProgressUnreadySet(globalMeta);
for (const r of allowedChars) {
  const p = r.data?.Progress;
  if (p != null && unready.has(p)) {
    fail(`${r.work_key}/${r.id}: Progress=${JSON.stringify(p)} は AI_Unready なのに allowed=true`);
  }
}

// --- manifest-training が manifest の許可集合と厳密に一致するか -------------
const key = (r) => `${r.work_key}\u0000${r.id}`;
const trainingChars = training.filter(r => r._type === 'character');
const allowedKeys  = new Set(allowedChars.map(key));
const trainingKeys = new Set(trainingChars.map(key));
for (const k of allowedKeys) {
  if (!trainingKeys.has(k)) fail(`manifest-training に許可レコードが欠けている: ${k.replace('\u0000', '/')}`);
}
for (const r of trainingChars) {
  if (r.ai_training?.allowed !== true) {
    fail(`manifest-training に不許可レコードが混入: ${r.work_key}/${r.id}`);
  }
  if (!allowedKeys.has(key(r))) fail(`manifest-training に manifest 側に無いレコード: ${r.work_key}/${r.id}`);
}

// --- build-info の統計が manifest の実数と一致するか ------------------------
const stats = buildInfo.ai_training_stats ?? {};
if (stats.allowed_characters !== allowedChars.length) {
  fail(`build-info.ai_training_stats.allowed_characters=${stats.allowed_characters} が manifest の実数 ${allowedChars.length} と不一致`);
}
if (stats.disallowed_characters !== chars.length - allowedChars.length) {
  fail(`build-info.ai_training_stats.disallowed_characters=${stats.disallowed_characters} が manifest の実数 ${chars.length - allowedChars.length} と不一致`);
}
if (buildInfo.total_characters !== chars.length) {
  fail(`build-info.total_characters=${buildInfo.total_characters} が manifest の実数 ${chars.length} と不一致`);
}

// --- ロールプレイプロンプト（2026-07-18 導入）の整合 ---------------------------
// 本文は埋め込まずパス参照のみ。フラグと path の対応、参照先ファイルの実在、統計の一致を確かめる。
// 不許可レコードの本文が training に漏れていないことは、上記 manifest-training 一致チェックが
// レコード丸ごとの単位で保証している（roleplay_prompt はレコードに相乗りするだけ）。
const SUBMODULE_DIR = SOURCE_ROOT;
let roleplayCount = 0;
for (const r of chars) {
  if (!r.has_roleplay_prompt) {
    if (r.roleplay_prompt != null) {
      fail(`${r.work_key}/${r.id}: has_roleplay_prompt=false なのに roleplay_prompt が付与されている`);
    }
    continue;
  }
  roleplayCount++;
  const rel = r.roleplay_prompt?.path;
  if (!rel) {
    fail(`${r.work_key}/${r.id}: has_roleplay_prompt=true なのに roleplay_prompt.path が無い`);
    continue;
  }
  if (!fs.existsSync(path.join(SUBMODULE_DIR, rel.replace(/\//g, path.sep)))) {
    fail(`${r.work_key}/${r.id}: roleplay_prompt.path の参照先が存在しない: ${rel}`);
  }
}
const roleplayStat = buildInfo.roleplay_prompt_stats?.with_roleplay_prompt;
if (roleplayStat !== roleplayCount) {
  fail(`build-info.roleplay_prompt_stats.with_roleplay_prompt=${roleplayStat} が manifest の実数 ${roleplayCount} と不一致`);
}

// --- 画像パスの整合（2026-08-02 導入） ---------------------------------------
// 画像は「DB 側の宣言 → 実ファイル名」の名前解決で紐付けるため、上流のリネームや
// フォルダ規約の変更があると静かに欠ける。実際 conceptAlt_PNGName の格納先を
// concept/ と取り違えて 22 件、解決対象に入っていない作品固有フィールドで 47 件が、
// 誰にも気づかれないまま長期間落ちていた。
// ここでは (1) 載せたパスが実在すること (2) build-info の統計が実数と一致することを押さえる。
// 「未解決が 0 件であること」は検証しない（上流側の未配置など、こちらで直せない要因が混ざるため）。
// 未解決の内訳はビルドログと build-info.image_ref_stats.unresolved で追うこと。
const IMAGE_OUT_KEYS = [
  'concept', 'concept_alt', 'corefolder', 'humanoid', 'arts', 'design_alt',
  'design', 'catalog', 'card_design', 'new_year', 'weakening', 'keycapper', 'tails_unit',
];
let resolvedImageRefs = 0;
let missingImageFiles = 0;
for (const r of chars) {
  for (const key of IMAGE_OUT_KEYS) {
    const entries = r.images?.[key];
    if (!Array.isArray(entries)) continue;
    resolvedImageRefs += entries.length;
    for (const e of entries) {
      const rel = typeof e === 'string' ? e : e?.path;
      if (!rel) {
        fail(`${r.work_key}/${r.id}: images.${key} にパスを持たない要素がある`);
        continue;
      }
      if (!fs.existsSync(path.join(SUBMODULE_DIR, rel.replace(/\//g, path.sep)))) {
        missingImageFiles++;
        // 上流の大規模リネーム時に全件を並べても読めないので、先頭数件だけ具体名を出す
        if (missingImageFiles <= 5) {
          fail(`${r.work_key}/${r.id}: images.${key} の参照先が存在しない: ${rel}`);
        }
      }
    }
  }
}
if (missingImageFiles > 5) {
  fail(`画像の参照先欠落は他にも ${missingImageFiles - 5} 件あります（ビルドし直して image_ref_stats を確認してください）`);
}
const imageStats = buildInfo.image_ref_stats ?? {};
if (imageStats.resolved !== resolvedImageRefs) {
  fail(`build-info.image_ref_stats.resolved=${imageStats.resolved} が manifest の実数 ${resolvedImageRefs} と不一致`);
}

// --- AIHints の source / derived 区別 -----------------------------------------
// derived は「上流に AIHints が無い NumberTales の allowed レコード」にだけ付く生成物。
// 対象範囲が広がると、合成物が上流データと見分けられないまま配布される。
let curatedHints = 0;
let derivedHints = 0;
for (const r of chars) {
  const src = r.ai_hints_source ?? null;
  if (src !== null && src !== 'source' && src !== 'derived') {
    fail(`${r.work_key}/${r.id}: 未知の ai_hints_source "${src}"`);
    continue;
  }
  if (r.has_ai_hints !== (src !== null) || r.has_ai_hints !== !!r.ai_hints) {
    fail(`${r.work_key}/${r.id}: has_ai_hints=${r.has_ai_hints} が ai_hints_source=${src} / ai_hints の有無と不一致`);
  }
  if (src === 'source') curatedHints++;
  if (src === 'derived') {
    derivedHints++;
    if (r.work_key !== '#Works_NumberTales' || r.ai_training?.allowed !== true) {
      fail(`${r.work_key}/${r.id}: derived AIHints が対象外レコードに付いている (allowed=${r.ai_training?.allowed})`);
    }
  }
}
const hintStats = buildInfo.ai_hints_stats ?? {};
if (hintStats.with_curated_ai_hints !== curatedHints) {
  fail(`build-info.ai_hints_stats.with_curated_ai_hints=${hintStats.with_curated_ai_hints} が実数 ${curatedHints} と不一致`);
}
if (hintStats.with_derived_ai_hints !== derivedHints) {
  fail(`build-info.ai_hints_stats.with_derived_ai_hints=${hintStats.with_derived_ai_hints} が実数 ${derivedHints} と不一致`);
}
if (hintStats.with_ai_hints !== curatedHints + derivedHints) {
  fail(`build-info.ai_hints_stats.with_ai_hints=${hintStats.with_ai_hints} が source+derived の ${curatedHints + derivedHints} と不一致`);
}

// --- image-index の allowed_db_keys が index.json と一致するか ---------------
for (const work of index.works) {
  const a = JSON.stringify(work.ai_training?.allowed_db_keys ?? []);
  const b = JSON.stringify(imageIndex.works?.[work.work_key]?.ai_training?.allowed_db_keys ?? []);
  if (a !== b) fail(`${work.work_key}: index.json と image-index.json で allowed_db_keys が不一致`);
}

// --- image-index のフラット画像リストの形式・実在・メタ整合 ------------------
// 2026-09-06 に文字列配列から { path, category, 解像度メタ } のオブジェクト配列へ変更。
// category は格納フォルダから、解像度は PNG の IHDR から導出するため、上流のフォルダ構成変更や
// 画像差し替えで黙って値が変わる。形式・実在・既知カテゴリ語彙・解像度フラグの整合を押さえる。
let flatImages = 0;
let flatImagesMissing = 0;
let largeOriginals = 0;
const indexedImages = new Set();
const checkFlatImages = (label, list) => {
  if (list == null) return;
  for (const e of list) {
    flatImages++;
    if (typeof e?.path !== 'string') {
      fail(`${label}: { path, category } 形式でない要素がある: ${JSON.stringify(e)}`);
      continue;
    }
    indexedImages.add(e.path);
    if (!permittedImage(e.path)) fail(`${label}: 不許可画像が混入: ${e.path}`);
    if (e.category != null && !IMAGE_OUT_KEYS.includes(e.category)) {
      fail(`${label}: 未知の category "${e.category}": ${e.path}`);
    }
    // long_edge_px は width/height の大きい方。is_large_original_candidate はその 1024px 判定。
    if (e.long_edge_px != null && e.long_edge_px !== Math.max(e.width, e.height)) {
      fail(`${label}: long_edge_px が width/height と不一致 (${e.width}x${e.height} → ${e.long_edge_px}): ${e.path}`);
    }
    if (e.is_large_original_candidate !== (e.long_edge_px != null && e.long_edge_px >= 1024)) {
      fail(`${label}: is_large_original_candidate が long_edge_px=${e.long_edge_px} と不一致: ${e.path}`);
    }
    if (e.is_large_original_candidate) largeOriginals++;
    if (e.is_language_variant !== (e.language_variant != null)) {
      fail(`${label}: is_language_variant が language_variant=${e.language_variant} と不一致: ${e.path}`);
    }
    if (!fs.existsSync(path.join(SUBMODULE_DIR, e.path.replace(/\//g, path.sep)))) {
      flatImagesMissing++;
      if (flatImagesMissing <= 5) fail(`${label}: 参照先が存在しない: ${e.path}`);
    }
  }
};
for (const [workKey, w] of Object.entries(imageIndex.works ?? {})) {
  checkFlatImages(`image-index.works["${workKey}"].images`, w.images);
  checkFlatImages(`image-index.works["${workKey}"].references`, w.references);
}
checkFlatImages('image-index.general_images', imageIndex.general_images);
for (const image of imagePermissions.paths()) {
  if (image.includes('/attr/') && !indexedImages.has(image)) fail(`image-index に許可された部位図がありません: ${image}`);
}
if (flatImagesMissing > 5) {
  fail(`image-index の参照先欠落は他にも ${flatImagesMissing - 5} 件あります`);
}

// --- 辞書レコードが Dictionaries/ 配下の全 JSON を網羅しているか ---------------
// 上流は辞書を Dictionaries/<keyField>/ のサブフォルダへ移すことがある。直下しか読まないと
// エラーにならず静かに欠ける（2026-11-15 に Class 辞書 12 本が落ちた）ので、実ファイルと突き合わせる。
const listJson = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? listJson(path.join(dir, e.name))
    : e.name.endsWith('.json') ? [path.relative(SUBMODULE_DIR, path.join(dir, e.name)).replace(/\\/g, '/')] : []);
const dictFiles = listJson(path.join(DATA_DIR, 'Dictionaries')).sort();
for (const [label, records] of [['manifest', manifest], ['manifest-training', training]]) {
  const sources = records.filter(r => r._type === 'dictionary').map(r => r.source).sort();
  if (!isDeepStrictEqual(sources, dictFiles)) {
    fail(`${label} の dictionary レコード (${sources.length} 本) が Dictionaries/ 配下の JSON (${dictFiles.length} 本) と不一致`);
  }
}

// --- 結果 -------------------------------------------------------------------
if (failures.length > 0) {
  console.error('[validate] 検証に失敗しました:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('[validate] OK'
  + ` — 作品 ${index.works.length} / キャラ ${chars.length}`
  + ` (許可 ${allowedChars.length} / 不許可 ${chars.length - allowedChars.length})`
  + ` / 画像参照 ${resolvedImageRefs} 件すべて実在`
  + (imageStats.unresolved ? ` (未解決 ${imageStats.unresolved} 件)` : '')
  + ` / AIHints ${curatedHints} 件 (+ derived ${derivedHints} 件)`
  + ` / image-index ${flatImages} 件 (原寸相当 ${largeOriginals} 件)`
  + ` / 辞書 ${dictFiles.length} 本`);
