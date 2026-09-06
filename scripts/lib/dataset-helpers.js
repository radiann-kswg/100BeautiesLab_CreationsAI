import fs from 'node:fs';
import path from 'node:path';

export const PUBLIC_IMAGE_ORIGIN = 'https://database.numbertales-radiann.net';

export const COREFOLDER_DEFAULT_IMMUTABLE_CONSTRAINTS = [
  'do not render arms or hands',
  'do not render legs or feet',
  'do not dress in humanoid casual / fashion outfit',
];

export const COREFOLDER_DEFAULT_NEGATIVE_KEYWORDS = [
  'feet', 'legs', 'shoes', 'high heels',
  'arms', 'hands',
  'hoodie', 'blazer', 'fashion outfit',
  'bound by rope',
];

/** 文字列配列 / {path} 配列のどちらからでもパスだけを取り出す */
export function extractImagePaths(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry;
    return typeof entry?.path === 'string' ? entry.path : null;
  }).filter(Boolean);
}

/** arts / design_alt のような { path, form, characters } 配列から form を優先して 1 件選ぶ */
export function findFirstImagePath(entries, { form = null, pathIncludes = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const hasMatcher = !!(form || pathIncludes);

  const fromObjects = entries.find((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    if (typeof entry.path !== 'string') return false;
    if (form && entry.form === form) return true;
    if (pathIncludes && entry.path.includes(pathIncludes)) return true;
    return false;
  });
  if (fromObjects?.path) return fromObjects.path;

  const fromStrings = entries.find((entry) => typeof entry === 'string' && (!pathIncludes || entry.includes(pathIncludes)));
  if (fromStrings) return fromStrings;
  if (hasMatcher) return null;
  return extractImagePaths(entries)[0] ?? null;
}

function firstPath(entries) {
  return extractImagePaths(entries)[0] ?? null;
}

function toPublicImageUrl(relPath) {
  return `${PUBLIC_IMAGE_ORIGIN}/${String(relPath).replace(/^\/+/, '')}`;
}

function buildPalettePriority(colorPalette) {
  if (!Array.isArray(colorPalette) || colorPalette.length === 0) return null;
  const out = {};
  for (const entry of colorPalette) {
    if (!entry || typeof entry !== 'object') continue;
    const role = String(entry.Role ?? '').replace(/^#ColorRole_/, '');
    const hex = typeof entry.Hex === 'string' ? entry.Hex.trim() : '';
    if (!hex) continue;
    if (role === 'Primary') out.primary = hex;
    else if (role === 'Sub' || role === 'Secondary') out.secondary = hex;
    else if (role === 'Accent') out.accent = hex;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 参照画像として使いやすいローカル画像パスを、カテゴリー優先順つきで抜き出す。
 * main は「高解像度の原典寄り画像」を優先し、corefolder / humanoid は形態の直接参照を残す。
 */
export function buildPreferredReferenceImages(images) {
  if (!images || typeof images !== 'object') return null;

  const concept = firstPath(images.concept);
  const conceptAlt = extractImagePaths(images.concept_alt);
  const catalog = firstPath(images.catalog);
  const designSheet = firstPath(images.design) ?? firstPath(images.design_alt);
  const corefolderDirect = firstPath(images.corefolder);
  const humanoidDirect = firstPath(images.humanoid);
  const corefolderArt = findFirstImagePath(images.arts, { form: 'corefolder', pathIncludes: '/arts/corefolders/' });
  const humanoidArt = findFirstImagePath(images.arts, { form: 'humanoid', pathIncludes: '/arts/humanoids/' });
  const genericArt = firstPath(images.arts);

  const common = {};
  common.main = catalog ?? designSheet ?? concept ?? genericArt ?? corefolderArt ?? humanoidArt ?? corefolderDirect ?? humanoidDirect ?? null;
  if (concept) common.concept = concept;
  if (catalog) common.catalog = catalog;
  if (designSheet) common.design_sheet = designSheet;
  if (conceptAlt.length > 0) common.concept_variants = conceptAlt;

  const forms = {};
  const corefolderMain = catalog ?? corefolderArt ?? concept ?? genericArt ?? corefolderDirect ?? designSheet ?? null;
  if (corefolderMain || corefolderDirect) {
    forms.corefolder = {
      main: corefolderMain ?? corefolderDirect,
      ...(corefolderDirect ? { corefolder: corefolderDirect } : {}),
    };
  }

  const humanoidMain = humanoidArt ?? concept ?? genericArt ?? catalog ?? humanoidDirect ?? designSheet ?? null;
  if (humanoidMain || humanoidDirect) {
    forms.humanoid = {
      main: humanoidMain ?? humanoidDirect,
      ...(humanoidDirect ? { humanoid: humanoidDirect } : {}),
    };
  }

  if (Object.keys(common).length === 0 && Object.keys(forms).length === 0) return null;
  return {
    ...(Object.keys(common).length > 0 ? { common } : {}),
    ...(Object.keys(forms).length > 0 ? { forms } : {}),
  };
}

/** source AIHints が無い NumberTales の allowed レコード向けに、参照画像中心の最小 scaffold を作る */
export function buildDerivedAiHints({ workKey, charData, images, aiTrainingAllowed }) {
  if (workKey !== '#Works_NumberTales' || aiTrainingAllowed !== true) return null;

  const preferred = buildPreferredReferenceImages(images);
  if (!preferred) return null;

  const common = {
    identity_tags: [],
    silhouette_features: [],
    immutable_traits: [],
    expression_tendency: [],
  };
  if (charData?.Num != null) common.immutable_traits.push(`number '${charData.Num}' marking`);
  const palettePriority = buildPalettePriority(charData?.ColorPalette);
  if (palettePriority) common.palette_priority = palettePriority;
  if (preferred.common) {
    common.reference_images = Object.fromEntries(
      Object.entries(preferred.common).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(toPublicImageUrl) : toPublicImageUrl(value),
      ]),
    );
  }

  const forms = {};
  if (preferred.forms?.corefolder) {
    forms.corefolder = {
      form_tags: ['corefolder form'],
      outfit_features: [],
      silhouette_notes: { body_description: [], attached_items: [] },
      immutable_constraints: [...COREFOLDER_DEFAULT_IMMUTABLE_CONSTRAINTS],
      negative_keywords: [...COREFOLDER_DEFAULT_NEGATIVE_KEYWORDS],
      ai_tags: ['corefolder form'],
      negative_visuals: [...COREFOLDER_DEFAULT_NEGATIVE_KEYWORDS],
      prompt_export: 'corefolder form',
      negative_prompt_export: COREFOLDER_DEFAULT_NEGATIVE_KEYWORDS.join(', '),
      reference_images: Object.fromEntries(
        Object.entries(preferred.forms.corefolder).map(([key, value]) => [key, toPublicImageUrl(value)]),
      ),
    };
  }
  if (preferred.forms?.humanoid) {
    forms.humanoid = {
      form_tags: ['humanoid form'],
      outfit_features: [],
      silhouette_notes: { body_description: [], attached_items: [] },
      immutable_constraints: [],
      negative_keywords: [],
      ai_tags: ['humanoid form'],
      negative_visuals: [],
      prompt_export: 'humanoid form',
      negative_prompt_export: '',
      reference_images: Object.fromEntries(
        Object.entries(preferred.forms.humanoid).map(([key, value]) => [key, toPublicImageUrl(value)]),
      ),
    };
  }

  if (Object.keys(forms).length === 0 && !common.reference_images) return null;
  return { common, forms };
}

/** image-index 用のカテゴリを path から推定する */
export function inferImageCategory(relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  const imagesIdx = parts.indexOf('Images');
  if (imagesIdx >= 0) {
    const tail = parts.slice(imagesIdx + 1);
    if (tail.length === 0) return 'images';
    if (/^(DB|Ref)_[^/]+$/.test(tail[0])) return tail[1] ?? 'root';
    return tail[0] ?? 'root';
  }

  const generalIdx = parts.indexOf('GeneralImages');
  if (generalIdx >= 0) return parts[generalIdx + 1] ?? 'general';

  const refsIdx = parts.indexOf('References');
  if (refsIdx >= 0) return parts[refsIdx + 1] ?? 'references';

  return 'unknown';
}

/** `_lang_EN` のようなディレクトリ規約から言語変種コードを抜く */
export function detectLanguageVariant(relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  const langSegment = parts.find((part) => /^_lang_[A-Za-z0-9-]+$/.test(part));
  if (!langSegment) return null;
  return langSegment.replace(/^_lang_/, '') || null;
}

/** PNG の IHDR だけを読んで寸法を返す */
export function readPngDimensions(absPath) {
  const buf = fs.readFileSync(absPath);
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height, long_edge_px: Math.max(width, height) };
}

/** 既存の images 配列と互換なまま、追加メタ付きエントリ一覧を作る */
export function buildImageIndexEntries(relPaths, submoduleRoot) {
  return relPaths.map((relPath) => {
    const absPath = path.join(submoduleRoot, relPath.replace(/\//g, path.sep));
    const size = readPngDimensions(absPath);
    const languageVariant = detectLanguageVariant(relPath);
    return {
      path: relPath,
      category: inferImageCategory(relPath),
      ...(size ?? { width: null, height: null, long_edge_px: null }),
      is_large_original_candidate: typeof size?.long_edge_px === 'number' ? size.long_edge_px >= 1024 : false,
      language_variant: languageVariant,
      is_language_variant: languageVariant != null,
    };
  });
}
