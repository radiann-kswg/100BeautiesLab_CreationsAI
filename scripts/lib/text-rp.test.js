import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CreationsDBClient } from '../../creations-db/pkg/nodejs/index.mjs';
import {
  buildRecordIdentity, recordIdentityKey, buildTextRPReference,
} from './text-rp.js';
import {
  getTextRPInferencePolicy, getAITrainingPolicy, getCharacterAIPolicy, assertDirectReadSafe,
} from './policy.js';

test('RP 許諾は厳密な true/false/unknown。旧学習許諾・考案者から推定しない', () => {
  for (const value of [undefined, null, '', 'true', 'false', 0, 1, [], {}]) {
    const policy = getTextRPInferencePolicy(false, { AI_Optout: false }, {
      AI_TextRP_Allowed: value, isOwner: true, Progress: 'released',
    });
    assert.equal(policy.status, 'unknown');
    assert.equal(policy.allowed, false);
  }
  assert.equal(getTextRPInferencePolicy(false, {}, { AI_TextRP_Allowed: true }).status, 'allowed');
  assert.equal(getTextRPInferencePolicy(false, {}, { AI_TextRP_Allowed: false }).status, 'denied');
  assert.equal(getTextRPInferencePolicy(false, null, { AI_TextRP_Allowed: true }).status, 'unknown');
});

test('RP 許諾は作品/DB直下ではなく補完済みレコードだけを読む。非公開は停止', () => {
  const record = { AI_TextRP_Allowed: true };
  assert.equal(getTextRPInferencePolicy(false, { AI_TextRP_Allowed: true }, {}).status, 'unknown');
  assert.equal(getTextRPInferencePolicy(true, {}, record).status, 'denied');
  assert.equal(getTextRPInferencePolicy(false, { DB_Hidden: true }, record).status, 'denied');
  assert.equal(getTextRPInferencePolicy(false, {}, { ...record, isPrivate: true }).status, 'denied');
});

test('RP の true/false は既存 AI_Optout / Progress 学習ゲートを一切変えない', () => {
  for (const allowed of [true, false, null]) {
    const r = { AI_TextRP_Allowed: allowed, Progress: 'unready' };
    const db = { AI_Optout: true };
    assert.equal(getCharacterAIPolicy(getAITrainingPolicy(false, db), r).allowed, false);
    assert.equal(getCharacterAIPolicy(getAITrainingPolicy(false, {}), r, null, new Set(['unready'])).allowed, false);
    assert.equal(getAITrainingPolicy(false, { AI_TextRP_Allowed: allowed }).allowed, true);
  }
  assert.equal(getTextRPInferencePolicy(false, { AI_Optout: true }, {
    AI_TextRP_Allowed: true, Progress: 'unready',
  }).allowed, true);
});

test('直接読み込みで RP の Commons 継承を失う場合はビルドを止める', () => {
  for (const value of [true, false, null]) {
    assert.throws(() => assertDirectReadSafe({ _Commons: { AI_TextRP_Allowed: value } }, 'ctx'), /AI_TextRP_Allowed/);
    assert.throws(() => assertDirectReadSafe({
      _Secondaries: [{ _Commons: { AI_TextRP_Allowed: value } }],
    }, 'ctx'), /AI_TextRP_Allowed/);
  }
});

test('実clientの継承: record > secondary Commons > DB Commons、null継承/false明示維持', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creationsai-rp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbDir = path.join(root, 'data', 'Works_Test', 'DataBases');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'db_meta.json'), JSON.stringify({
    CreationWorks: { '#Works_Test': {} },
  }));
  const databases = {};
  for (const [db, fallback] of [['Allow', true], ['Deny', false]]) {
    databases[`#DB_${db}`] = {
      AI_Optout: true,
      _Commons: { AI_TextRP_Allowed: fallback },
      _Secondaries: [
        { sec_SeriesTitle: 'match', _Commons: { AI_TextRP_Allowed: !fallback } },
        { sec_SeriesTitle: 'reset', _Commons: { AI_TextRP_Allowed: null } },
      ],
    };
    fs.writeFileSync(path.join(dbDir, `db_${db}.json`), JSON.stringify([
      { Num: 1, AI_TextRP_Allowed: true, sec_SeriesTitle: 'match' },
      { Num: 2, AI_TextRP_Allowed: false, sec_SeriesTitle: 'match' },
      { Num: 3, AI_TextRP_Allowed: null, sec_SeriesTitle: 'match' },
      { Num: 4, sec_SeriesTitle: 'other' },
      { Num: 5, AI_TextRP_Allowed: 'true', sec_SeriesTitle: 'match' },
      { Num: 6, sec_SeriesTitle: 'reset' },
      { Num: 7, AI_TextRP_Allowed: true, sec_SeriesTitle: 'reset' },
    ]));
  }
  fs.writeFileSync(path.join(dbDir, 'db_meta.json'), JSON.stringify({ Databases: databases }));
  const client = new CreationsDBClient(root);
  for (const [db, fallback] of [['Allow', true], ['Deny', false]]) {
    const records = await client.getRecords('#Works_Test', `#DB_${db}`, { applyCommons: true });
    const states = records.map(r => getTextRPInferencePolicy(false, databases[`#DB_${db}`], r).status);
    assert.deepEqual(states, [
      'allowed', 'denied', fallback ? 'denied' : 'allowed', fallback ? 'allowed' : 'denied',
      'unknown', 'unknown', 'allowed',
    ]);
    assert.ok(records.every(r => !getCharacterAIPolicy(getAITrainingPolicy(false, databases[`#DB_${db}`]), r).allowed));
  }
});

const cardIndex = {
  hashTag: 'Card', $type: [
    { hashTag: 'Suit' }, { hashTag: 'Num' },
  ],
};

test('正規識別は作品/DB/複合Indexを保持し、同じ数値や別DBを混同しない', () => {
  const a = buildRecordIdentity('#Works_W', '#DB_A', cardIndex, { Card: { Suit: 'Wands', Num: 1 } });
  const b = buildRecordIdentity('#Works_W', '#DB_A', cardIndex, { Card: { Suit: 'Cups', Num: 1 } });
  const c = buildRecordIdentity('#Works_W', '#DB_B', cardIndex, { Card: { Suit: 'Wands', Num: 1 } });
  assert.deepEqual(a.index, { 'Card.Suit': 'Wands', 'Card.Num': 1 });
  assert.notEqual(recordIdentityKey(a), recordIdentityKey(b));
  assert.notEqual(recordIdentityKey(a), recordIdentityKey(c));
  assert.equal(recordIdentityKey(a), recordIdentityKey({ ...a, index: { 'Card.Num': 1, 'Card.Suit': 'Wands' } }));
});

test('正規Indexのnull枝は残すが全空・不正型やスキーマ欠落に名前で代替しない', () => {
  const r = { Card: { Suit: null, Num: 0 }, Name: 'display only' };
  assert.deepEqual(buildRecordIdentity('W', 'D', cardIndex, r).index, { 'Card.Suit': null, 'Card.Num': 0 });
  assert.equal(buildRecordIdentity('W', 'D', cardIndex, { Name: 'display only' }), null);
  assert.equal(buildRecordIdentity('W', 'D', null, r), null);
  assert.equal(buildRecordIdentity('W', 'D', cardIndex, { Card: { Num: {} } }), null);
});

test('許可されたRP投影だけを返し、画像/デザイン/リンク/Markdown/マスクを展開しない', () => {
  const record = {
    FormalName_JP: ['name'], Character_JP: 'personality',
    FirstPersonCalling: { hideText: 'private' },
    Summary_JP: 'not an RP-only field', AIHints: { images: 'no' },
    Images: { concept: 'no' }, AppearanceDetail: ['no'], ColorPalette: ['no'],
    _DBLink: { Character_JP: 'do not inherit' },
    ConversationPattern: { TalkingTone_JP: 'tone', DialogueExamples: [{ image: 'no' }] },
  };
  const identity = { work_key: 'W', db_key: 'D', index: { Num: 1 } };
  assert.deepEqual(buildTextRPReference(record, identity, { allowed: true }), {
    source: 'record_fields',
    fields: {
      FormalName_JP: ['name'], Character_JP: 'personality',
      ConversationPattern: { TalkingTone_JP: 'tone' },
    },
  });
  for (const allowed of [false, undefined]) {
    assert.equal(buildTextRPReference(record, identity, { allowed }), null);
  }
  assert.equal(buildTextRPReference(record, null, { allowed: true }), null);
  assert.equal(buildTextRPReference({ FormalName_JP: 'name' }, identity, { allowed: true }), null);
});
