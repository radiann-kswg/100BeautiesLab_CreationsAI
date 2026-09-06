import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDerivedAiHints,
  buildImageIndexEntries,
  buildPreferredReferenceImages,
  detectLanguageVariant,
  inferImageCategory,
} from './dataset-helpers.js';

test('preferred_reference_images: corefolder main は catalog を優先し、humanoid main は humanoid art を優先する', () => {
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

test('buildDerivedAiHints: NumberTales の allowed レコードにだけ参照画像中心 scaffold を補う', () => {
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
    images: {
      concept: ['data/Works_NumberTales/Images/DB_SemiPrimary/concept/cnsp_imgNTS-222.png'],
      corefolder: ['data/Works_NumberTales/Images/DB_SemiPrimary/corefolder/222/emstk_corefolderNTS-222-1.png'],
    },
  });

  assert.equal(aiHints.common.immutable_traits[0], "number '222' marking");
  assert.deepEqual(aiHints.common.palette_priority, { primary: '#112233', secondary: '#445566' });
  assert.equal(aiHints.forms.corefolder.form_tags[0], 'corefolder form');
  assert.match(aiHints.forms.corefolder.reference_images.main, /catalog|concept|corefolder/);
  assert.equal(
    buildDerivedAiHints({
      workKey: '#Works_NumberTales',
      aiTrainingAllowed: false,
      charData: { Num: '222' },
      images: { concept: ['data/Works_NumberTales/Images/DB_SemiPrimary/concept/cnsp_imgNTS-222.png'] },
    }),
    null,
  );
  assert.equal(
    buildDerivedAiHints({
      workKey: '#Works_CommonReferences',
      aiTrainingAllowed: true,
      charData: { Num: '222' },
      images: { concept: ['data/Works_NumberTales/Images/DB_SemiPrimary/concept/cnsp_imgNTS-222.png'] },
    }),
    null,
  );
});

test('image-index helpers: category / language metadata と PNG 寸法を付与する', () => {
  assert.equal(
    inferImageCategory('data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-61.png'),
    'catalog',
  );
  assert.equal(
    inferImageCategory('data/Works_NumberTales/Images/DB_Primary/arts/corefolders/sphericateDay/_lang_EN/art[EN]_sphericateDay202202.png'),
    'arts',
  );
  assert.equal(
    detectLanguageVariant('data/Works_NumberTales/Images/DB_Primary/arts/corefolders/sphericateDay/_lang_EN/art[EN]_sphericateDay202202.png'),
    'EN',
  );

  const submoduleRoot = '/home/runner/work/100BeautiesLab_CreationsAI/100BeautiesLab_CreationsAI/creations-db';
  const [entry] = buildImageIndexEntries([
    'data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-61.png',
  ], submoduleRoot);
  assert.equal(entry.category, 'catalog');
  assert.equal(entry.path, 'data/Works_NumberTales/Images/DB_Primary/catalog/chr-dsgn_catalogNTS-61.png');
  assert.equal(entry.is_large_original_candidate, true);
  assert.ok(entry.long_edge_px >= 1024);
});
