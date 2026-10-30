/**
 * テキスト RP 推論専用の識別・参照投影。
 * 旧学習レコードや画像用 AIHints には手を入れない。
 */

/** 外見・画像・自由記述の要約を混ぜず、会話に必要な原本フィールドだけを採る。 */
export const TEXT_RP_FIELDS = [
  'FormalName_JP', 'FormalName_JPReading', 'FormalName_EN',
  'FirstPersonCalling', 'SecondPersonCalling', 'ThirdPersonCalling',
  'Character_JP', 'Character_EN',
  'Hobby_JP', 'Hobby_EN', 'Favor_JP', 'Favor_EN', 'Unlike_JP', 'Unlike_EN',
];
export const TEXT_RP_CONVERSATION_FIELDS = [
  'TalkingTone_JP', 'TalkingTone_EN', 'TopicPreference_JP', 'TopicPreference_EN',
  'TalkFrequency_JP', 'TalkFrequency_EN', 'PreferredTopics_JP', 'PreferredTopics_EN',
  'AvoidedTopics_JP', 'AvoidedTopics_EN', 'ConversationNotes_JP', 'ConversationNotes_EN',
];

/** hideText・参照ラッパー・任意オブジェクトを本文へ展開しない。 */
function textValue(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && value.length && value.every(v => typeof v === 'string')) {
    return value.filter(v => v.trim());
  }
  return null;
}

/**
 * $IndexDef の全分類をドットパスで保持する。名前や配列位置への代替はしない。
 * null の枝は残すが、全枝が空・オブジェクト値・スキーマ未定義なら識別不能を返す。
 */
export function buildRecordIdentity(workKey, dbKey, indexDef, record) {
  if (!indexDef || typeof indexDef.hashTag !== 'string') return null;
  const index = {};
  const visit = (def, prefix) => {
    if (typeof def?.hashTag !== 'string') return false;
    const key = prefix ? `${prefix}.${def.hashTag}` : def.hashTag;
    if (Array.isArray(def.$type)) return def.$type.every(child => visit(child, key));
    const value = key.split('.').reduce((obj, part) => obj?.[part], record) ?? null;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') return false;
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    index[key] = value;
    return true;
  };
  if (!visit(indexDef, '') || !Object.values(index).some(v => v !== null && v !== '')) return null;
  return { work_key: workKey, db_key: dbKey, index };
}

/** 並び順に依存しない、正規複合識別の比較キー。 */
export function recordIdentityKey(identity) {
  if (!identity) return null;
  return JSON.stringify([identity.work_key, identity.db_key,
    Object.entries(identity.index).sort(([a], [b]) => a.localeCompare(b, 'en'))]);
}

/**
 * 許可済みかつ一意に識別できるキャラに限り、原本の会話テキストを投影する。
 * 旧 Markdown は外見等も含みうるため、この推論経路からは参照しない。
 */
export function buildTextRPReference(record, identity, policy) {
  if (policy.allowed !== true || !identity) return null;
  const fields = {};
  for (const key of TEXT_RP_FIELDS) {
    const value = textValue(record[key]);
    if (value != null && (!Array.isArray(value) || value.length)) fields[key] = value;
  }
  const conversation = {};
  for (const key of TEXT_RP_CONVERSATION_FIELDS) {
    const value = textValue(record.ConversationPattern?.[key]);
    if (value != null && (!Array.isArray(value) || value.length)) conversation[key] = value;
  }
  if (Object.keys(conversation).length) fields.ConversationPattern = conversation;
  if (!Object.keys(fields).some(k => !k.startsWith('FormalName'))) return null;
  return { source: 'record_fields', fields };
}
