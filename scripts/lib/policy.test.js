/**
 * AI 学習利用ポリシー判定のテスト。
 *
 * 何を守るためのテストか:
 * 2026-07-17 に、上流のデータ変更で AI 学習許可レコードが 211 → 307 へ増えたことが
 * 誰にも気づかれずに CI で自動コミットされた。ポリシー判定のテストが 1 件も無く、
 * CI の検証も title_ja の非空しか見ていなかったため。同意に関わる判定が黙って変わる状態を
 * 二度と作らないよう、各レイヤーの発火条件と優先順位をここで固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TRAINING_ALLOWED_REASON,
  AI_TRAINING_DISALLOWED_DB_HIDDEN,
  AI_TRAINING_DISALLOWED_IS_PRIVATE,
  AI_TRAINING_DISALLOWED_NO_META_REASON,
  AI_TRAINING_DISALLOWED_REASON,
  AI_TRAINING_DISALLOWED_SECONDARY_CATEGORY,
  AI_TRAINING_DISALLOWED_WORKS_HIDDEN,
  assertDirectReadSafe,
  buildProgressUnreadySet,
  buildSecondaryOptoutMap,
  getAITrainingPolicy,
  getCharacterAIPolicy,
} from './policy.js';

/** $EnumDef_Progress を組み立てるヘルパ */
const metaWithProgressEnum = (entries) => ({ General: { $VarsDef: { $EnumDef_Progress: entries } } });

// ---------------------------------------------------------------------------
// DB 層
// ---------------------------------------------------------------------------

test('DB 層: Works_Hidden が最優先で false になる', () => {
  // AI_Optout が未設定でも作品全体が非公開なら許可しない
  const p = getAITrainingPolicy(true, { AI_Optout: false });
  assert.equal(p.allowed, false);
  assert.equal(p.reason, AI_TRAINING_DISALLOWED_WORKS_HIDDEN);
});

test('DB 層: db_meta にエントリが無ければ保守的に false', () => {
  for (const entry of [null, undefined, 'not-an-object']) {
    const p = getAITrainingPolicy(false, entry);
    assert.equal(p.allowed, false, `entry=${JSON.stringify(entry)}`);
    assert.equal(p.reason, AI_TRAINING_DISALLOWED_NO_META_REASON);
  }
});

test('DB 層: DB_Hidden / AI_Optout がそれぞれ false にする', () => {
  assert.equal(getAITrainingPolicy(false, { DB_Hidden: true }).reason, AI_TRAINING_DISALLOWED_DB_HIDDEN);
  assert.equal(getAITrainingPolicy(false, { AI_Optout: true }).reason, AI_TRAINING_DISALLOWED_REASON);
});

test('DB 層: フラグが無い / false なら許可', () => {
  assert.equal(getAITrainingPolicy(false, {}).allowed, true);
  assert.equal(getAITrainingPolicy(false, { AI_Optout: false, DB_Hidden: false }).allowed, true);
  assert.equal(getAITrainingPolicy(false, {}).reason, AI_TRAINING_ALLOWED_REASON);
});

test('DB 層: フラグは厳密に true のときだけ発火する（truthy では発火しない）', () => {
  // "true" や 1 のような truthy 値をオプトアウトとして扱うと、データの型崩れで
  // 意図せず全件不許可になる。逆に緩めると意図せず許可になる。=== true で固定する。
  assert.equal(getAITrainingPolicy(false, { AI_Optout: 'true' }).allowed, true);
  assert.equal(getAITrainingPolicy(false, { DB_Hidden: 1 }).allowed, true);
});

// ---------------------------------------------------------------------------
// _Secondaries 層
// ---------------------------------------------------------------------------

test('_Secondaries: AI_Optout: true のカテゴリだけがマップに載る', () => {
  const { map, defaultOptout } = buildSecondaryOptoutMap({
    _Secondaries: [
      { sec_SeriesTitle: 'A', AI_Optout: true },
      { sec_SeriesTitle: 'B', AI_Optout: false },
      { sec_SeriesTitle: 'C' },
    ],
  });
  assert.deepEqual([...map.keys()], ['A']);
  assert.equal(defaultOptout, false);
});

test('_Secondaries: sec_SeriesTitle: null の AI_Optout はデフォルト適用になる', () => {
  const { map, defaultOptout } = buildSecondaryOptoutMap({
    _Secondaries: [{ sec_SeriesTitle: null, AI_Optout: true }],
  });
  assert.equal(map.size, 0);
  assert.equal(defaultOptout, true);
});

test('_Secondaries: _Secondaries が無い DB でも安全に空を返す', () => {
  const { map, defaultOptout } = buildSecondaryOptoutMap({});
  assert.equal(map.size, 0);
  assert.equal(defaultOptout, false);
});

test('キャラ層: sec_SeriesTitle がマップに一致すると不許可', () => {
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const optout = buildSecondaryOptoutMap({ _Secondaries: [{ sec_SeriesTitle: 'A', AI_Optout: true }] });
  assert.equal(getCharacterAIPolicy(dbPolicy, { sec_SeriesTitle: 'A' }, optout).allowed, false);
  assert.equal(getCharacterAIPolicy(dbPolicy, { sec_SeriesTitle: 'A' }, optout).reason, AI_TRAINING_DISALLOWED_SECONDARY_CATEGORY);
  assert.equal(getCharacterAIPolicy(dbPolicy, { sec_SeriesTitle: 'B' }, optout).allowed, true);
});

test('キャラ層: DB 層が既に不許可なら _Secondaries は判定を覆さない', () => {
  const dbPolicy = { allowed: false, reason: AI_TRAINING_DISALLOWED_REASON };
  const optout = buildSecondaryOptoutMap({ _Secondaries: [{ sec_SeriesTitle: 'A', AI_Optout: true }] });
  assert.equal(getCharacterAIPolicy(dbPolicy, { sec_SeriesTitle: 'X' }, optout).allowed, false);
});

// ---------------------------------------------------------------------------
// isPrivate 層
// ---------------------------------------------------------------------------

test('キャラ層: isPrivate: true は他のどのレイヤーより先に不許可にする', () => {
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const p = getCharacterAIPolicy(dbPolicy, { isPrivate: true, Progress: 'released' }, null, new Set(['notProceeded']));
  assert.equal(p.allowed, false);
  assert.equal(p.reason, AI_TRAINING_DISALLOWED_IS_PRIVATE);
});

// ---------------------------------------------------------------------------
// Progress ゲート（$EnumDef_Progress からのスキーマ駆動）
// ---------------------------------------------------------------------------

test('Progress: AI_Unready の明示が isForSecondary より優先される', () => {
  // isForSecondary: true でも AI_Unready: false が明示されていれば許可側
  const { values } = buildProgressUnreadySet(metaWithProgressEnum({
    '#A': { Progress: 'a', AI_Unready: false, isForSecondary: true },
    '#B': { Progress: 'b', AI_Unready: true, isForSecondary: false },
  }));
  assert.deepEqual([...values], ['b']);
});

test('Progress: AI_Unready 未宣言なら isForSecondary === true をフォールバックに使う', () => {
  const { values, explicit, fallback } = buildProgressUnreadySet(metaWithProgressEnum({
    '#A': { Progress: 'a', isForSecondary: true },
    '#B': { Progress: 'b', AI_Unready: false, isForSecondary: false },
  }));
  assert.deepEqual([...values], ['a']);
  assert.equal(explicit, 1);
  assert.equal(fallback, 1);
});

test('Progress: どちらの網にもかからないエントリがあれば例外を投げる', () => {
  // 上流が 455cc8b 以前に #Progress_Archived で踏んだ失敗モード。
  // isForSecondary: null は「フォールバックにも該当しない」ため、黙って許可側へ落としてはいけない。
  assert.throws(
    () => buildProgressUnreadySet(metaWithProgressEnum({
      '#Archived': { Progress: 'archived', isForSecondary: null },
    })),
    /#Archived/,
  );
});

test('Progress: $EnumDef_Progress が読めなければ例外を投げる', () => {
  // 読めないまま許可するのは同意に関わる判定として最悪の失敗なので、必ず止める。
  assert.throws(() => buildProgressUnreadySet({}), /\$EnumDef_Progress/);
  assert.throws(() => buildProgressUnreadySet({ General: { $VarsDef: {} } }), /\$EnumDef_Progress/);
});

test('Progress: 除外対象の値を持つレコードが不許可になり、理由が値を名指しする', () => {
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const p = getCharacterAIPolicy(dbPolicy, { Progress: 'notProceeded' }, null, new Set(['notProceeded']));
  assert.equal(p.allowed, false);
  assert.match(p.reason, /notProceeded/);
});

test('Progress: 除外理由は権利上の opt-out ではないと明示する', () => {
  // AI_Unready を AI_Optout と読み違えられると、権利表明を歪めて伝えることになる。
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const p = getCharacterAIPolicy(dbPolicy, { Progress: 'notProceeded' }, null, new Set(['notProceeded']));
  assert.match(p.reason, /NOT a rights-based opt-out/);
});

test('Progress: 改行を含む値も完全一致で扱える', () => {
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const gate = new Set(['accepted\nnowRemaking']);
  assert.equal(getCharacterAIPolicy(dbPolicy, { Progress: 'accepted\nnowRemaking' }, null, gate).allowed, false);
  // 前半だけ一致する値を巻き込まない
  assert.equal(getCharacterAIPolicy(dbPolicy, { Progress: 'accepted' }, null, gate).allowed, true);
});

test('Progress: Progress を持たないレコードにはゲートを適用しない', () => {
  // 共通資料の語彙・種族などは制作進捗の概念を持たない
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const gate = new Set(['notProceeded']);
  assert.equal(getCharacterAIPolicy(dbPolicy, { Term_JP: '管理主' }, null, gate).allowed, true);
  assert.equal(getCharacterAIPolicy(dbPolicy, { Progress: null }, null, gate).allowed, true);
});

test('Progress: 許可対象の値はそのまま通る', () => {
  const dbPolicy = { allowed: true, reason: AI_TRAINING_ALLOWED_REASON };
  const gate = new Set(['notProceeded']);
  assert.equal(getCharacterAIPolicy(dbPolicy, { Progress: 'released' }, null, gate).allowed, true);
});

// ---------------------------------------------------------------------------
// 直接読み込みパスのガード
// ---------------------------------------------------------------------------

test('直接読み込み: _Commons がポリシー値を供給していなければ通す', () => {
  assert.doesNotThrow(() => assertDirectReadSafe({ _Commons: { Belonging: ['X'] } }, 'ctx'));
  assert.doesNotThrow(() => assertDirectReadSafe({}, 'ctx'));
  assert.doesNotThrow(() => assertDirectReadSafe(null, 'ctx'));
});

test('直接読み込み: _Commons.Progress / isPrivate があれば例外を投げる', () => {
  // このパスでは _Commons 継承が適用されないため、継承前の値で判定すると誤って許可しうる
  assert.throws(() => assertDirectReadSafe({ _Commons: { Progress: 'notProceeded' } }, 'W / DB'), /_Commons\.Progress/);
  assert.throws(() => assertDirectReadSafe({ _Commons: { isPrivate: true } }, 'W / DB'), /_Commons\.isPrivate/);
});

test('直接読み込み: _Secondaries[*]._Commons のポリシー値も検出する', () => {
  assert.throws(
    () => assertDirectReadSafe({ _Secondaries: [{ _Commons: { Progress: 'archived' } }] }, 'W / DB'),
    /_Secondaries\[0\]\._Commons\.Progress/,
  );
});
