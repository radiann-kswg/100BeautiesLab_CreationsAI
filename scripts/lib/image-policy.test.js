/** 実ビルド・検証を通して、画像の除外がどの出力経路にも漏れないことを確かめる。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('画像ポリシー: typedef・個別・上位・連名の拒否を全出力で守り、不正な指定を停止する', t => {
  const cache = path.join(repo, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cache, 'image-policy-'));
  t.after(() => {
    if (!temp.startsWith(`${cache}${path.sep}`)) throw new Error('一時出力の削除先が不正です');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const source = path.join(temp, 'source');
  const output = path.join(temp, 'output');
  const write = (relative, data) => {
    const filename = path.join(source, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(data));
  };
  const helper = path.join(process.env.CREATIONS_DB_ROOT || path.join(repo, 'creations-db'), 'pkg/ai-image-policy.mjs');
  fs.mkdirSync(path.join(source, 'pkg'), { recursive: true });
  fs.copyFileSync(helper, path.join(source, 'pkg/ai-image-policy.mjs'));
  fs.mkdirSync(path.join(source, 'data/Dictionaries'), { recursive: true });
  const image = (db, folder, name) => `data/Works_Test/Images/DB_${db}/${folder}/${name}.png`;
  const makeImage = (db, folder, name) => {
    const filename = path.join(source, image(db, folder, name));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.write('IHDR', 12); header.writeUInt32BE(1200, 16); header.writeUInt32BE(900, 20);
    fs.writeFileSync(filename, header);
  };
  write('data/db_meta.json', {
    CreationWorks: { '#Works_Test': { Title_JP: '試験', Title_EN: 'Test' },
      '#Works_Hidden': { Title_JP: '非公開試験', Title_EN: 'Hidden Test', Works_Hidden: true } },
    General: { $VarsDef: { $EnumDef_Progress: {
      '#Progress_Ready': { Progress: 'ready', AI_Unready: false },
      '#Progress_Draft': { Progress: 'draft', AI_Unready: true },
    } } },
  });
  write('data/db_type.json', { $DefType: [] });
  write('data/Works_Test/Dictionaries/dict_Costume.json', [
    { Costume: 'usual', Costume_EN: 'Usual Costume' },
    { Costume: 'stage', Costume_JP: '舞台衣装', Costume_EN: 'Stage Costume', AI_Optout: true },
  ]);
  write('data/Works_Test/DataBases/db_meta.json', { Databases: {
    '#DB_Primary': { DB_Layer: 'DataBases', AI_Optout: false },
    '#DB_Secondary': { DB_Layer: 'DataBases', AI_Optout: true },
  } });
  write('data/Works_Test/DataBases/db_type.json', { $IndexDef: { hashTag: 'Num', $type: '#Number' }, $DefType: [
    { hashTag: 'Images', $type: [
      { hashTag: 'concept_PNGName', $type: '#PNGFileName' },
      { hashTag: 'conceptAlt_PNGName', $type: '#PNGFileName[]', AI_Optout: true },
      { hashTag: 'corefolder_PNGPath', $type: '#PNGFilePath[]' },
      { hashTag: 'arts_PNGPath', $type: '#PNGFilePath[]' },
    ] },
  ] });
  const referenceImage = 'data/Works_Test/Images/Ref_Vocabulary/concept-figure/body.png';
  const localizationImage = 'data/Works_Test/Images/Loc_Label/custom/label.png';
  write('data/Works_Test/References/db_meta.json', { Databases: { '#Ref_Vocabulary': { DB_Layer: 'References', AI_Optout: false } } });
  write('data/Works_Test/References/db_type.json', { $DefType: [{ hashTag: 'Images', $type: [{ hashTag: 'concept-figure_PNGName', $type: '#PNGFileName[]' }] }] });
  write('data/Works_Test/References/ref_Vocabulary.json', [{ Term_JP: '資料', Images: { 'concept-figure_PNGName': ['body'] } }]);
  write('data/Works_Test/Localization/db_meta.json', { Databases: {
    '#Loc_Label': { DB_Layer: 'Localization', AI_Optout: false }, '#Loc_Private': { DB_Layer: 'Localization', AI_Optout: true },
  } });
  write('data/Works_Test/Localization/db_type.json', { $DefType: [{ hashTag: 'Images', $type: [{ hashTag: 'custom_PNGName', $type: '#PNGFileName' }] }] });
  write('data/Works_Test/Localization/trans_Label.json', [{ Term_JP: '呼称', Images: { custom_PNGName: 'label' } }]);
  write('data/Works_Test/Localization/trans_Private.json', [{ Term_JP: '除外', Images: { custom_PNGName: 'private' } }]);
  // 参照元の拒否は権利軸だけ伝わり、充填軸（draft = AI_Unready）は持ち主の許可を消さない（Issue #5）
  const crossLink = name => ({ _DBCrossLinkPath: { _DB: 'Primary', _Field: 'concept_PNGName', _IsoPath: name } });
  const records = [
    { Num: 1, Progress: 'ready', Images: {
      concept_PNGName: 'joint', conceptAlt_PNGName: ['typed'], corefolder_PNGPath: ['keep', 'file'],
      arts_PNGPath: [{ _DBCrossLinkPath: { _DB: 'Secondary', _Field: 'concept_PNGName', _IsoPath: 'upper' } }],
    }, Images_AIOptout: { corefolder_PNGPath: ['file'] }, AppearanceDetail: [
      { Costume: 'usual', img_PNGName: 'detail.PNG', Attrs: [{ value_EN: 'regular jacket' }] },
      { Costume: 'usual', img_PNGName: 'shared-detail' },
      { Costume: 'usual', img_PNGName: 'stage-detail' },
      { Costume: 'usual', img_PNGName: 'linked-denied' },
      { Costume: 'stage', img_PNGName: 'stage-detail', Attrs: [{ value_EN: 'unique golden ribbon (stage outfit)' }] },
    ], AIHints: { common: {
      identity_tags: ['preserved', 'unique golden ribbon (stage outfit)'], reference_images: Object.fromEntries([
        ['main', image('Primary', 'corefolder', 'keep')], ['joint', image('Primary', 'concept', 'joint')],
        ['typed', image('Primary', 'conceptAlt', 'typed')], ['file', image('Primary', 'corefolder', 'file')],
        ['upper', image('Secondary', 'concept', 'upper')],
        ['stageDetail', image('Primary', 'attr/numberMark', 'stage-detail')],
      ].map(([key, value]) => [key, `https://database.numbertales-radiann.net/${value}`])),
    }, forms: { humanoid: { prompt_export: 'regular jacket, unique golden ribbon (stage outfit)' } },
    _meta: { structuralEntries: { 'common.identity_tags': ['unique golden ribbon (stage outfit)'] } },
    work_common: { reference_images: { main: `https://database.numbertales-radiann.net/${referenceImage}` } } } },
    { Num: 2, Progress: 'ready', Images: { concept_PNGName: 'joint' }, Images_AIOptout: { concept_PNGName: ['joint'] } },
    { Num: 3, Progress: 'ready', AI_Optout: true, Images: { corefolder_PNGPath: [crossLink('optout-ref')] },
      AppearanceDetail: [{ img_PNGName: 'record-denied' }, { img_PNGName: 'shared-detail.png' }] },
    { Num: 4, Progress: 'ready', isPrivate: true, AppearanceDetail: [{ img_PNGName: 'private-detail' }] },
    { Num: 5, Progress: 'draft', Images: { corefolder_PNGPath: [crossLink('unready-ref')] },
      AppearanceDetail: [{ img_PNGName: 'draft-detail' }] },
    { Num: 6, Progress: 'ready', Images: { concept_PNGName: 'unready-ref' },
      AppearanceDetail: [{ img_PNGName: 'standalone' }, { img_PNGName: 'detail-missing' }] },
    { Num: 7, Progress: 'ready', Images: { concept_PNGName: 'optout-ref' } },
  ];
  write('data/Works_Test/Dictionaries/dict_Formation.json', [{ Formation: 'corefolder' }, { Formation: 'humanoid' }]);
  for (const [i, Formation] of ['corefolder', 'humanoid'].entries()) {
    const raw = records[i].Images.arts_PNGPath ?? [];
    records[i].Images.arts_PNGPath = [...raw, 'pair', 'blocked-pair'];
    records[i].Images_Appearance = { arts_PNGPath: [{ value: 'pair', Formation }, { value: 'blocked-pair' }] };
  }
  records[1].Images_AIOptout.arts_PNGPath = ['blocked-pair'];
  records[1].Images_Appearance.arts_PNGPath.push({ value: 'pair', Formation: 'corefolder' });
  makeImage('Primary', 'arts', 'pair');
  makeImage('Primary', 'arts', 'blocked-pair');
  write('data/Works_Test/DataBases/db_Primary.json', records);
  write('data/Works_Test/DataBases/db_Secondary.json', [{ Num: 3, Progress: 'ready', Images: { concept_PNGName: 'upper' },
    AppearanceDetail: [{ img_PNGName: 'db-denied' }, { img_PNGName: 'detail' }] }]);
  write('data/Works_Test/DataBases/.private/db_Primary.json', [{ Num: 5, Images: { corefolder_PNGPath: ['keep'] } }]);
  write('data/Works_Test/References/db_Primary.json', [{ Num: 6, Images: { concept_PNGName: 'unregistered' } }]);
  write('data/Works_Test/DataBases/db_temp.json', {});
  write('data/Works_Hidden/DataBases/db_meta.json', { Databases: { '#DB_Primary': {
    DB_Layer: 'DataBases', _Commons: { Progress: 'ready' },
  } } });
  write('data/Works_Hidden/DataBases/db_type.json', { $IndexDef: { hashTag: 'Num', $type: '#Number' }, $DefType: [] });
  write('data/Works_Hidden/DataBases/db_Primary.json', [{ Num: 4 }]);
  for (const [db, folder, name] of [['Primary', 'concept', 'joint'], ['Primary', 'conceptAlt', 'typed'],
    ['Primary', 'corefolder', 'keep'], ['Primary', 'corefolder', 'file'], ['Secondary', 'concept', 'upper'],
    ['Primary', 'concept', 'orphan'], ['Primary', 'concept', 'unready-ref'], ['Primary', 'concept', 'optout-ref'],
    ['Primary', 'attr/custom/nested', 'detail'],
    ['Primary', 'attr/wing', 'standalone'], ['Secondary', 'attr/custom', 'detail'],
    ['Secondary', 'attr/numberMark', 'detail-missing'],
    ...['shared-detail', 'record-denied', 'private-detail', 'draft-detail', 'stage-detail', 'orphan-detail']
      .map(name => ['Primary', 'attr/numberMark', name]),
    ['Secondary', 'attr/halo', 'db-denied']]) makeImage(db, folder, name);
  const detailImage = image('Primary', 'attr/custom/nested', 'detail').replace(/\.png$/, '.PNG');
  fs.renameSync(path.join(source, image('Primary', 'attr/custom/nested', 'detail')), path.join(source, detailImage));
  try {
    fs.symlinkSync(path.join(source, image('Secondary', 'concept', 'upper')),
      path.join(source, image('Primary', 'attr/numberMark', 'linked-denied')), 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('この環境ではsymlinkを作成できないため、そのfixtureのみ省略。Linux CIで検査する。');
  }
  for (const relative of [referenceImage, localizationImage, 'data/Works_Test/Images/Loc_Private/custom/private.png']) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.copyFileSync(path.join(source, image('Primary', 'corefolder', 'keep')), path.join(source, relative));
  }
  const run = script => spawnSync(process.execPath, [path.join(repo, 'scripts', script)], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, CREATIONS_DB_ROOT: source, CREATIONS_AI_OUT_DIR: output },
  });
  const build = run('build-dataset.js');
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const validation = run('validate-dataset.js');
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  const manifest = fs.readFileSync(path.join(output, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const character = manifest.find(record => record._type === 'character' && record.id === '1');
  const pair = image('Primary', 'arts', 'pair');
  assert.deepEqual(character.images, { corefolder: [image('Primary', 'corefolder', 'keep')],
    arts: [{ path: pair, form: 'corefolder', characters: ['1', '2'] }] });
  const second = manifest.find(record => record._type === 'character' && record.id === '2');
  assert.deepEqual(second.images.arts, [{ path: pair, form: null, forms: ['corefolder', 'humanoid'], characters: ['1', '2'] }]);
  assert.equal(character.data.Images_Appearance, undefined);
  assert.deepEqual(character.data.Images.corefolder_PNGPath, ['keep']);
  assert.deepEqual(character.ai_hints.common.identity_tags, ['preserved']);
  assert.deepEqual(character.data.AppearanceDetail.map(item => item.Costume), ['usual', 'usual', 'usual', 'usual']);
  assert.equal(character.ai_hints.forms.humanoid.prompt_export, null);
  assert.deepEqual(character.ai_hints._meta.structuralEntries['common.identity_tags'], []);
  assert.equal(character.ai_hints.work_common.reference_images.main, `https://database.numbertales-radiann.net/${referenceImage}`);
  assert.deepEqual(Object.keys(character.ai_hints.common.reference_images), ['main', 'stageDetail']);
  const primary = id => manifest.find(record => record._type === 'character' && record.id === id && record.db_key === '#DB_Primary');
  assert.equal(primary('6').data.Images.concept_PNGName, 'unready-ref');
  assert.equal(primary('7').data.Images.concept_PNGName, null);
  const index = JSON.parse(fs.readFileSync(path.join(output, 'image-index.json'), 'utf8'));
  assert.deepEqual(index.works['#Works_Test'].images.map(entry => entry.path).sort(),
    [pair, image('Primary', 'corefolder', 'keep'), image('Primary', 'concept', 'unready-ref'),
      detailImage, image('Primary', 'attr/wing', 'standalone'),
      image('Primary', 'attr/numberMark', 'stage-detail'), referenceImage, localizationImage].sort());
  const detailEntry = index.works['#Works_Test'].images.find(entry => entry.path === detailImage);
  assert.equal(detailEntry.category, null);
  index.works['#Works_Test'].images = index.works['#Works_Test'].images.filter(entry => entry.path !== detailImage);
  fs.writeFileSync(path.join(output, 'image-index.json'), JSON.stringify(index));
  assert.notEqual(run('validate-dataset.js').status, 0, '許可された部位図の欠落を検出する');
  index.works['#Works_Test'].images.push(detailEntry);
  fs.writeFileSync(path.join(output, 'image-index.json'), JSON.stringify(index));
  character.images.concept = [image('Primary', 'concept', 'joint')];
  fs.writeFileSync(path.join(output, 'manifest.jsonl'), manifest.map(record => JSON.stringify(record)).join('\n'));
  assert.notEqual(run('validate-dataset.js').status, 0);
  records[0].Images_AIOptout.corefolder_PNGPath = ['typo'];
  write('data/Works_Test/DataBases/db_Primary.json', records);
  const invalid = run('build-dataset.js');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /元画像にありません/);
  records[0].Images_AIOptout.corefolder_PNGPath = ['file'];
  records[0].AppearanceDetail.push({ img_PNGName: 'ambiguous' });
  makeImage('Primary', 'attr/halo', 'ambiguous');
  makeImage('Primary', 'attr/motif', 'ambiguous');
  write('data/Works_Test/DataBases/db_Primary.json', records);
  const ambiguous = run('build-dataset.js');
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /部位図の実ファイル名が曖昧/);
  records[0].AppearanceDetail.pop();
  const appearance = records[0].Images_Appearance;
  for (const invalid of [{ typo: [] }, { arts_PNGPath: [{ value: 'not-in-gallery' }] },
    { arts_PNGPath: [{ value: 'pair', Formation: 'typo' }] }]) {
    records[0].Images_Appearance = invalid;
    write('data/Works_Test/DataBases/db_Primary.json', records);
    const failure = run('build-dataset.js');
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Images_Appearance/);
  }
  records[0].Images_Appearance = appearance;
  write('data/Works_Test/DataBases/db_Primary.json', records);
  write('data/Works_Test/Dictionaries/dict_Costume.json', [{ Costume: 'stage', AI_Optout: 'true' }]);
  const oldManifest = fs.readFileSync(path.join(output, 'manifest.jsonl'), 'utf8');
  assert.notEqual(run('build-dataset.js').status, 0);
  assert.equal(fs.readFileSync(path.join(output, 'manifest.jsonl'), 'utf8'), oldManifest);
});
