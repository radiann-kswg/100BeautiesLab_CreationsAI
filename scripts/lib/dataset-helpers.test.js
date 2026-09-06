import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import {
  buildDerivedAiHints,
  buildImageEntries,
  buildPreferredReferenceImages,
  detectLanguageVariant,
  readPngDimensions,
} from './dataset-helpers.js';

const FOLDER_TO_CATEGORY = {
  concept: 'concept',
  conceptAlt: 'concept_alt',
  corefolder: 'corefolder',
  catalog: 'catalog',
  arts: 'arts',
  'attr/tailsUnit': 'tails_unit',
};

/** 幅 1200 x 高さ 800 の PNG ヘッダーだけを持つ一時ファイルを作る（IHDR しか読まないため中身は不要） */
function writeFakePng(dir, name, width, height) {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, head);
  return full;
}

test('buildPreferredReferenceImages: corefolder main は catalog を優先し、humanoid main は humanoid art を優先する', () => {
  const refs = buildPreferredReferenceImages({
    concept: ['data/Works_NumberTales/Images/DB_Primary/concept/cnsp_imgNTS-222.png'],
    corefolder: ['data/Works_NumberTales/Images/DB_Primary/corefolder/222/emstk_corefolderNTS-222-1.png'],
    catalog: ['data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-222.png'],
    arts: [
      { path: 'data/Works_NumberTales/Images/DB_Primary/arts/corefolders/2024/art_imgNTS-222-corefolderA.png', form: 'corefolder', characters: null },
      { path: 'data/Works_NumberTales/Images/DB_Primary/arts/humanoids/2024/art_imgNTS-222-humanoidA.png', form: 'humanoid', characters: null },
    ],
  });

  assert.equal(refs.common.main, 'data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-222.png');
  assert.equal(refs.forms.corefolder.main, 'data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-222.png');
  assert.equal(refs.forms.corefolder.corefolder, 'data/Works_NumberTales/Images/DB_Primary/corefolder/222/emstk_corefolderNTS-222-1.png');
  assert.equal(refs.forms.humanoid.main, 'data/Works_NumberTales/Images/DB_Primary/arts/humanoids/2024/art_imgNTS-222-humanoidA.png');
});

test('buildDerivedAiHints: NumberTales の allowed レコードにだけ scaffold を補う', () => {
  const images = {
    concept: ['data/Works_NumberTales/Images/DB_SemiPrimary/concept/cnsp_imgNTS-222.png'],
    corefolder: ['data/Works_NumberTales/Images/DB_SemiPrimary/corefolder/222/emstk_corefolderNTS-222-1.png'],
  };
  const aiHints = buildDerivedAiHints({
    workKey: '#Works_NumberTales',
    aiTrainingAllowed: true,
    charData: {
      Num: '222',
      ColorPalette: [
        { Role: '#ColorRole_Primary', Hex: '#112233' },
        { Role: '#ColorRole_Sub', Hex: '#445566' },
      ],
    },
    images,
  });

  assert.equal(aiHints.common.immutable_traits[0], "number '222' marking");
  assert.deepEqual(aiHints.common.palette_priority, { primary: '#112233', secondary: '#445566' });
  assert.equal(aiHints.forms.corefolder.form_tags[0], 'corefolder form');
  assert.ok(aiHints.forms.corefolder.immutable_constraints.length > 0);

  // 不許可レコード・他作品には決して付けない（合成物が上流データと混ざらないための境界）
  assert.equal(buildDerivedAiHints({ workKey: '#Works_NumberTales', aiTrainingAllowed: false, charData: { Num: '222' }, images }), null);
  assert.equal(buildDerivedAiHints({ workKey: '#Works_CommonReferences', aiTrainingAllowed: true, charData: { Num: '222' }, images }), null);
});

test('detectLanguageVariant: _lang_ ディレクトリ規約から言語コードを抜く', () => {
  assert.equal(detectLanguageVariant('data/Works_NumberTales/Images/DB_Primary/arts/x/_lang_EN/art[EN]_x.png'), 'EN');
  assert.equal(detectLanguageVariant('data/Works_NumberTales/Images/DB_Primary/arts/x/art_x.png'), null);
});

test('buildImageEntries: category は対応表からのみ決め、解像度は PNG の IHDR から実測する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgidx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const rels = [
    'data/Works_X/Images/DB_Primary/catalog/big.png',           // 既知カテゴリ・原寸相当
    'data/Works_X/Images/DB_Primary/corefolder/1/small.png',    // 既知カテゴリ・縮小版
    'data/Works_X/Images/DB_Primary/attr/tailsUnit/tail.png',   // 2 階層で 1 カテゴリ
    'data/Works_X/Images/DB_Primary/attr/numberMark/mark.png',  // 未知フォルダ → null
    'data/Works_X/Images/DB_Primary/arts/_lang_EN/en.png',      // 言語変種
  ];
  writeFakePng(root, rels[0].replace(/\//g, path.sep), 9000, 6000);
  writeFakePng(root, rels[1].replace(/\//g, path.sep), 480, 320);
  writeFakePng(root, rels[2].replace(/\//g, path.sep), 528, 400);
  writeFakePng(root, rels[3].replace(/\//g, path.sep), 165, 165);
  writeFakePng(root, rels[4].replace(/\//g, path.sep), 1200, 800);

  const entries = buildImageEntries(rels, root, FOLDER_TO_CATEGORY);

  assert.deepEqual(entries.map(e => e.category), ['catalog', 'corefolder', 'tails_unit', null, 'arts']);
  assert.equal(entries[0].long_edge_px, 9000);
  assert.equal(entries[0].is_large_original_candidate, true);
  assert.equal(entries[1].long_edge_px, 480);
  assert.equal(entries[1].is_large_original_candidate, false);
  assert.equal(entries[4].language_variant, 'EN');
  assert.equal(entries[4].is_language_variant, true);
  assert.equal(entries[0].is_language_variant, false);
});

test('readPngDimensions: PNG でないファイルは null を返す', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgidx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notPng = path.join(root, 'not.png');
  fs.writeFileSync(notPng, Buffer.alloc(64, 0x41));

  assert.equal(readPngDimensions(notPng), null);
  assert.equal(readPngDimensions(path.join(root, 'missing.png')), null);
});
