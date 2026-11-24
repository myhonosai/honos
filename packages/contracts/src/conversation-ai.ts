/**
 * Conversation AI training (0420, piece CA2a; docs/architecture/CONVERSATION_AI.md §7). The switches and the school's
 * training material: an HQ program switch (OFF, TEST_MODE, LIVE), per-school settings (on/off, a mode per channel,
 * hand-off words, an after-hours text, a length cap per channel, languages), and a training library (FAQ, document, image,
 * instruction and coaching items with an on/off switch, plus the original file). Nothing here calls an AI provider.
 */

export const CONVERSATION_AI_LIMITS = {
  items: 200, title: 120, question: 500, body: 8000, staffNote: 500, summary: 300, afterHours: 320,
  handoffWords: 20, handoffWord: 30, fileBytes: 1_048_576, fileName: 200, reasonMin: 10, reasonMax: 500,
} as const;
export const CONVERSATION_AI_PROGRAM_STATUSES = ['OFF', 'TEST_MODE', 'LIVE'] as const;
export type ConversationAiProgramStatus = (typeof CONVERSATION_AI_PROGRAM_STATUSES)[number];
export const CONVERSATION_AI_MODES = ['OFF', 'ASSIST', 'AUTOMATIC'] as const;
export type ConversationAiMode = (typeof CONVERSATION_AI_MODES)[number];
export const CONVERSATION_AI_CHANNELS = ['SMS', 'WEB_CHAT', 'EMAIL'] as const;
export type ConversationAiChannel = (typeof CONVERSATION_AI_CHANNELS)[number];
export const CONVERSATION_AI_LANGUAGES = ['en', 'ko', 'es'] as const;
export type ConversationAiLanguage = (typeof CONVERSATION_AI_LANGUAGES)[number];
export const CONVERSATION_AI_ITEM_KINDS = ['FAQ', 'DOCUMENT', 'IMAGE', 'INSTRUCTION', 'COACHING'] as const;
export type ConversationAiItemKind = (typeof CONVERSATION_AI_ITEM_KINDS)[number];
export const CONVERSATION_AI_ITEM_STATUSES = ['ACTIVE', 'PAUSED', 'DELETED'] as const;
export type ConversationAiItemStatus = (typeof CONVERSATION_AI_ITEM_STATUSES)[number];
export const CONVERSATION_AI_MEDIA_TYPES = ['text/plain', 'text/csv', 'text/markdown', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type ConversationAiMediaType = (typeof CONVERSATION_AI_MEDIA_TYPES)[number];
export const CONVERSATION_AI_DEFAULT_HANDOFF_WORDS = ['human', 'manager', 'cancel', 'refund', 'billing'] as const;

/** Same-origin browser command names (the X-HON-Human-Command header), one per call. */
export const CONVERSATION_AI_READ_COMMAND = 'conversation.ai.read';
export const CONVERSATION_AI_KNOWLEDGE_COMMAND = 'conversation.ai.knowledge';
export const CONVERSATION_AI_SETTINGS_COMMAND = 'conversation.ai.settings';
export const CONVERSATION_AI_UPLOAD_COMMAND = 'conversation.ai.upload';
export const CONVERSATION_AI_FILE_COMMAND = 'conversation.ai.file';
export const CONVERSATION_AI_ITEM_SAVE_COMMAND = 'conversation.ai.item.save';
export const CONVERSATION_AI_ITEM_STATUS_COMMAND = 'conversation.ai.item.status';

export interface ConversationAiSettings {
  enabled: boolean; modes: Record<ConversationAiChannel, ConversationAiMode>; handoffWords: string[]; afterHoursText: string | null;
  smsMaxChars: number; chatMaxChars: number; languages: ConversationAiLanguage[]; enabledAt: string | null; enabledBy: string | null; version: number;
}
export interface ConversationAiFile { fileId: string; fileName: string; mediaType: ConversationAiMediaType; byteSize: number }
export interface ConversationAiItem {
  itemId: string; kind: ConversationAiItemKind; title: string; question: string | null; body: string; staffNote: string | null; summary: string | null;
  status: 'ACTIVE' | 'PAUSED'; version: number; updatedAt: string; updatedBy: string | null; file: ConversationAiFile | null;
}
export interface ConversationAiDeletedItem { itemId: string; status: 'DELETED'; version: number }
export interface ConversationAiOverview { program: ConversationAiProgramStatus; settings: ConversationAiSettings; items: ConversationAiItem[]; canConfigure: boolean }
export interface ConversationAiKnowledge {
  school: { name: string } | null; tone: string; languages: ConversationAiLanguage[];
  instructions: { source: string; text: string }[];
  faqs: { source: string; kind: 'FAQ' | 'COACHING'; question: string; answer: string }[];
  documents: { source: string; title: string; text: string }[];
  articles: { source: string; title: string; text: string }[];
  plans: { source: string; name: string; description: string | null; currency: string; priceMinor: number; billing: string; termMonths: number | null }[];
  bookingTypes: { source: string; name: string; description: string | null; template: string; durationMinutes: number }[];
}
export interface ConversationAiSettingsInput {
  expectedVersion: number; enabled: boolean; modes: Record<ConversationAiChannel, ConversationAiMode>; handoffWords: string[];
  afterHoursText: string | null; smsMaxChars: number; chatMaxChars: number; languages: ConversationAiLanguage[];
}
export interface ConversationAiUploadInput { fileName: string; mediaType: ConversationAiMediaType; contentBase64: string }
export interface ConversationAiItemInput {
  itemId?: string; expectedVersion?: number; kind: ConversationAiItemKind; title: string; body: string;
  question?: string; staffNote?: string; summary?: string; fileId?: string;
}
export interface ConversationAiItemStatusInput { itemId: string; expectedVersion: number; status: ConversationAiItemStatus }
export interface ConversationAiSettingsReceipt { settings: ConversationAiSettings }
export interface ConversationAiUploadReceipt { file: ConversationAiFile; extractedText: string | null }
export interface ConversationAiItemReceipt { item: ConversationAiItem | ConversationAiDeletedItem }
export interface ConversationAiFileContent extends ConversationAiFile { contentBase64: string }
export interface ConversationAiProgramChange { from: ConversationAiProgramStatus; to: ConversationAiProgramStatus; version: number; reason: string; changedAt: string; changedBy: string | null }
export interface ConversationAiProgram {
  status: ConversationAiProgramStatus; version: number; updatedAt: string; updatedBy: string | null; schoolsEnabled: number; recentChanges: ConversationAiProgramChange[];
}
export interface ConversationAiProgramInput { status: ConversationAiProgramStatus; expectedVersion: number; reason: string }
export interface ConversationAiProgramReceipt { status: ConversationAiProgramStatus; version: number; changedAt: string; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WORD = /^[\p{L}\p{N}](?:[\p{L}\p{N} -]{0,28}[\p{L}\p{N}])?$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(): never { throw new Error('Invalid conversation AI data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function count(value: unknown, minimum = 0, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
/** A single-line label (no line breaks or control characters). */
function label(value: unknown, max = 300): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function nullableLabel(value: unknown, max = 300): string | null { return value === null ? null : label(value, max); }
function prose(value: unknown, max: number): string { if (!conversationAiTextOk(value, max)) invalid(); return value; }
function nullableProse(value: unknown, max: number): string | null { return value === null ? null : prose(value, max); }
function list<T>(value: unknown, max: number, each: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map(each);
}

/** True when the database will store this text: 1..max characters, not blank, no control characters but line breaks and tabs. */
export function conversationAiTextOk(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() !== '' && !CONTROL.test(value);
}
/** At most 20 distinct lower-case hand-off words or short phrases (letters, digits, spaces, dashes; 1-30 characters). */
export function conversationAiHandoffWordsOk(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CONVERSATION_AI_LIMITS.handoffWords
    && value.every(w => typeof w === 'string' && WORD.test(w) && w === w.toLowerCase()) && new Set(value).size === value.length;
}
export function conversationAiLanguagesOk(value: unknown): value is ConversationAiLanguage[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 && value.every(l => (CONVERSATION_AI_LANGUAGES as readonly unknown[]).includes(l))
    && new Set(value).size === value.length;
}
export function conversationAiFileNameOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CONVERSATION_AI_LIMITS.fileName && value.trim() === value
    && !/[\u0000-\u001f\u007f/\\]/.test(value);
}
function modes(value: unknown): Record<ConversationAiChannel, ConversationAiMode> {
  const row = record(value, CONVERSATION_AI_CHANNELS);
  return { SMS: oneOf(row.SMS, CONVERSATION_AI_MODES), WEB_CHAT: oneOf(row.WEB_CHAT, CONVERSATION_AI_MODES), EMAIL: oneOf(row.EMAIL, CONVERSATION_AI_MODES) };
}

export function validateConversationAiSettingsInput(value: unknown): ConversationAiSettingsInput {
  const row = record(value, ['expectedVersion', 'enabled', 'modes', 'handoffWords', 'afterHoursText', 'smsMaxChars', 'chatMaxChars', 'languages']);
  if (!conversationAiHandoffWordsOk(row.handoffWords) || !conversationAiLanguagesOk(row.languages)) invalid();
  return {
    expectedVersion: count(row.expectedVersion, 0), enabled: bool(row.enabled), modes: modes(row.modes), handoffWords: [...row.handoffWords],
    afterHoursText: nullableProse(row.afterHoursText, CONVERSATION_AI_LIMITS.afterHours),
    smsMaxChars: count(row.smsMaxChars, 160, 1600), chatMaxChars: count(row.chatMaxChars, 160, 1600), languages: [...row.languages],
  };
}
export function validateConversationAiUploadInput(value: unknown): ConversationAiUploadInput {
  const row = record(value, ['fileName', 'mediaType', 'contentBase64']);
  if (!conversationAiFileNameOk(row.fileName)) invalid();
  const content = row.contentBase64;
  // 1 MB of bytes is at most 1,398,104 base64 characters.
  if (typeof content !== 'string' || content.length < 4 || content.length > 1_398_104 || content.length % 4 !== 0 || !BASE64.test(content)) invalid();
  return { fileName: row.fileName, mediaType: oneOf(row.mediaType, CONVERSATION_AI_MEDIA_TYPES), contentBase64: content };
}
export function validateConversationAiItemInput(value: unknown): ConversationAiItemInput {
  const row = record(value, ['kind', 'title', 'body'], ['itemId', 'expectedVersion', 'question', 'staffNote', 'summary', 'fileId']);
  if (('itemId' in row) !== ('expectedVersion' in row)) invalid();
  const kind = oneOf(row.kind, CONVERSATION_AI_ITEM_KINDS);
  const title = row.title;
  if (typeof title !== 'string' || title.length < 1 || title.length > CONVERSATION_AI_LIMITS.title || title.trim() !== title || /[\u0000-\u001f\u007f]/.test(title)) invalid();
  const out: ConversationAiItemInput = { kind, title, body: prose(row.body, CONVERSATION_AI_LIMITS.body) };
  if ('itemId' in row) { out.itemId = uuid(row.itemId); out.expectedVersion = count(row.expectedVersion, 1); }
  // A FAQ and a coaching card are a question and its answer; only coaching carries a staff note; files only for documents and images.
  if ((kind === 'FAQ' || kind === 'COACHING') !== ('question' in row)) invalid();
  if ('question' in row) out.question = prose(row.question, CONVERSATION_AI_LIMITS.question);
  if ('staffNote' in row) { if (kind !== 'COACHING') invalid(); out.staffNote = prose(row.staffNote, CONVERSATION_AI_LIMITS.staffNote); }
  if ('summary' in row) out.summary = prose(row.summary, CONVERSATION_AI_LIMITS.summary);
  if ('fileId' in row) { if (kind !== 'DOCUMENT' && kind !== 'IMAGE') invalid(); out.fileId = uuid(row.fileId); }
  return out;
}
export function validateConversationAiItemStatusInput(value: unknown): ConversationAiItemStatusInput {
  const row = record(value, ['itemId', 'expectedVersion', 'status']);
  return { itemId: uuid(row.itemId), expectedVersion: count(row.expectedVersion, 1), status: oneOf(row.status, CONVERSATION_AI_ITEM_STATUSES) };
}
export function validateConversationAiProgramInput(value: unknown): ConversationAiProgramInput {
  const row = record(value, ['status', 'expectedVersion', 'reason']);
  const reason = row.reason;
  if (typeof reason !== 'string' || reason.trim() !== reason || reason.length < CONVERSATION_AI_LIMITS.reasonMin || reason.length > CONVERSATION_AI_LIMITS.reasonMax
    || /[\u0000-\u001f\u007f]/.test(reason)) invalid();
  return { status: oneOf(row.status, CONVERSATION_AI_PROGRAM_STATUSES), expectedVersion: count(row.expectedVersion, 1), reason };
}

export function verifyConversationAiSettings(value: unknown): ConversationAiSettings {
  const row = record(value, ['enabled', 'modes', 'handoffWords', 'afterHoursText', 'smsMaxChars', 'chatMaxChars', 'languages', 'enabledAt', 'enabledBy', 'version']);
  if (!conversationAiHandoffWordsOk(row.handoffWords) || !conversationAiLanguagesOk(row.languages)) invalid();
  const out: ConversationAiSettings = {
    enabled: bool(row.enabled), modes: modes(row.modes), handoffWords: [...row.handoffWords], afterHoursText: nullableProse(row.afterHoursText, CONVERSATION_AI_LIMITS.afterHours),
    smsMaxChars: count(row.smsMaxChars, 160, 1600), chatMaxChars: count(row.chatMaxChars, 160, 1600), languages: [...row.languages],
    enabledAt: nullableInstant(row.enabledAt), enabledBy: nullableLabel(row.enabledBy), version: count(row.version, 0),
  };
  if (out.enabled && out.enabledAt === null) invalid();
  return out;
}
function verifyFile(value: unknown): ConversationAiFile {
  const row = record(value, ['fileId', 'fileName', 'mediaType', 'byteSize']);
  if (!conversationAiFileNameOk(row.fileName)) invalid();
  return { fileId: uuid(row.fileId), fileName: row.fileName, mediaType: oneOf(row.mediaType, CONVERSATION_AI_MEDIA_TYPES), byteSize: count(row.byteSize, 1, CONVERSATION_AI_LIMITS.fileBytes) };
}
export function verifyConversationAiItem(value: unknown): ConversationAiItem {
  const row = record(value, ['itemId', 'kind', 'title', 'question', 'body', 'staffNote', 'summary', 'status', 'version', 'updatedAt', 'updatedBy', 'file']);
  const kind = oneOf(row.kind, CONVERSATION_AI_ITEM_KINDS);
  const out: ConversationAiItem = {
    itemId: uuid(row.itemId), kind, title: label(row.title, CONVERSATION_AI_LIMITS.title), question: nullableProse(row.question, CONVERSATION_AI_LIMITS.question),
    body: prose(row.body, CONVERSATION_AI_LIMITS.body), staffNote: nullableProse(row.staffNote, CONVERSATION_AI_LIMITS.staffNote),
    summary: nullableProse(row.summary, CONVERSATION_AI_LIMITS.summary), status: oneOf(row.status, ['ACTIVE', 'PAUSED'] as const), version: count(row.version, 1),
    updatedAt: instant(row.updatedAt), updatedBy: nullableLabel(row.updatedBy), file: row.file === null ? null : verifyFile(row.file),
  };
  if ((kind === 'FAQ' || kind === 'COACHING') !== (out.question !== null) || (kind !== 'COACHING' && out.staffNote !== null)
    || (out.file !== null && kind !== 'DOCUMENT' && kind !== 'IMAGE')) invalid();
  return out;
}
export function verifyConversationAiOverview(value: unknown): ConversationAiOverview {
  const row = record(value, ['program', 'settings', 'items', 'canConfigure']);
  const items = list(row.items, CONVERSATION_AI_LIMITS.items, verifyConversationAiItem);
  if (new Set(items.map(i => i.itemId)).size !== items.length) invalid();
  if (items.some((item, i) => i > 0 && item.updatedAt > items[i - 1]!.updatedAt)) invalid();
  return { program: oneOf(row.program, CONVERSATION_AI_PROGRAM_STATUSES), settings: verifyConversationAiSettings(row.settings), items, canConfigure: bool(row.canConfigure) };
}
const SOURCE = /^(?:TRAINING|ARTICLE|BOOKING_TYPE):[0-9a-f-]{36}$|^PLAN:[0-9a-f-]{36}:\d{1,9}$/;
function source(value: unknown, prefix: string): string {
  if (typeof value !== 'string' || !SOURCE.test(value) || !value.startsWith(prefix + ':')) invalid();
  return value;
}
export function verifyConversationAiKnowledge(value: unknown): ConversationAiKnowledge {
  const row = record(value, ['school', 'tone', 'languages', 'instructions', 'faqs', 'documents', 'articles', 'plans', 'bookingTypes']);
  if (!conversationAiLanguagesOk(row.languages)) invalid();
  const longText = (v: unknown) => { if (typeof v !== 'string' || v.length > 100_000 || v.includes('\u0000')) invalid(); return v; };
  const nullableLongText = (v: unknown) => (v === null ? null : longText(v));
  return {
    school: row.school === null ? null : { name: label(record(row.school, ['name']).name) }, tone: label(row.tone, 40), languages: [...row.languages],
    instructions: list(row.instructions, CONVERSATION_AI_LIMITS.items, v => { const r = record(v, ['source', 'text']); return { source: source(r.source, 'TRAINING'), text: longText(r.text) }; }),
    faqs: list(row.faqs, CONVERSATION_AI_LIMITS.items, v => {
      const r = record(v, ['source', 'kind', 'question', 'answer']);
      return { source: source(r.source, 'TRAINING'), kind: oneOf(r.kind, ['FAQ', 'COACHING'] as const), question: longText(r.question), answer: longText(r.answer) };
    }),
    documents: list(row.documents, CONVERSATION_AI_LIMITS.items, v => { const r = record(v, ['source', 'title', 'text']); return { source: source(r.source, 'TRAINING'), title: longText(r.title), text: longText(r.text) }; }),
    articles: list(row.articles, 10_000, v => { const r = record(v, ['source', 'title', 'text']); return { source: source(r.source, 'ARTICLE'), title: longText(r.title), text: longText(r.text) }; }),
    plans: list(row.plans, 10_000, v => {
      const r = record(v, ['source', 'name', 'description', 'currency', 'priceMinor', 'billing', 'termMonths']);
      return { source: source(r.source, 'PLAN'), name: longText(r.name), description: nullableLongText(r.description), currency: label(r.currency, 3),
        priceMinor: count(r.priceMinor), billing: label(r.billing, 40), termMonths: r.termMonths === null ? null : count(r.termMonths, 0, 1200) };
    }),
    bookingTypes: list(row.bookingTypes, 10_000, v => {
      const r = record(v, ['source', 'name', 'description', 'template', 'durationMinutes']);
      return { source: source(r.source, 'BOOKING_TYPE'), name: longText(r.name), description: nullableLongText(r.description), template: label(r.template, 40),
        durationMinutes: count(r.durationMinutes, 1, 1440) };
    }),
  };
}
export function verifyConversationAiSettingsReceipt(value: unknown): ConversationAiSettingsReceipt {
  const row = record(value, ['settings']);
  const settings = verifyConversationAiSettings(row.settings);
  if (settings.version < 1) invalid();
  return { settings };
}
export function verifyConversationAiUploadReceipt(value: unknown): ConversationAiUploadReceipt {
  const row = record(value, ['file', 'extractedText']);
  return { file: verifyFile(row.file), extractedText: nullableProse(row.extractedText, CONVERSATION_AI_LIMITS.body) };
}
export function verifyConversationAiItemReceipt(value: unknown, expected?: { itemId?: string; status?: ConversationAiItemStatus }): ConversationAiItemReceipt {
  const row = record(value, ['item']);
  const raw = record(row.item, [], ['itemId', 'kind', 'title', 'question', 'body', 'staffNote', 'summary', 'status', 'version', 'updatedAt', 'updatedBy', 'file']);
  let item: ConversationAiItem | ConversationAiDeletedItem;
  if (raw.status === 'DELETED') {
    const d = record(raw, ['itemId', 'status', 'version']);
    item = { itemId: uuid(d.itemId), status: 'DELETED', version: count(d.version, 2) };
  } else item = verifyConversationAiItem(raw);
  if ((expected?.itemId && item.itemId !== expected.itemId) || (expected?.status && item.status !== expected.status)) invalid();
  return { item };
}
export function verifyConversationAiFileContent(value: unknown, fileId: string): ConversationAiFileContent {
  const row = record(value, ['fileId', 'fileName', 'mediaType', 'byteSize', 'contentBase64']);
  const file = verifyFile({ fileId: row.fileId, fileName: row.fileName, mediaType: row.mediaType, byteSize: row.byteSize });
  const content = row.contentBase64;
  if (file.fileId !== fileId || typeof content !== 'string' || !BASE64.test(content.replace(/\n/g, ''))) invalid();
  return { ...file, contentBase64: content.replace(/\n/g, '') };
}
export function validateConversationAiProgram(value: unknown): ConversationAiProgram {
  const row = record(value, ['status', 'version', 'updatedAt', 'updatedBy', 'schoolsEnabled', 'recentChanges']);
  return {
    status: oneOf(row.status, CONVERSATION_AI_PROGRAM_STATUSES), version: count(row.version, 1), updatedAt: instant(row.updatedAt), updatedBy: nullableLabel(row.updatedBy),
    schoolsEnabled: count(row.schoolsEnabled),
    recentChanges: list(row.recentChanges, 10, v => {
      const r = record(v, ['from', 'to', 'version', 'reason', 'changedAt', 'changedBy']);
      return { from: oneOf(r.from, CONVERSATION_AI_PROGRAM_STATUSES), to: oneOf(r.to, CONVERSATION_AI_PROGRAM_STATUSES), version: count(r.version, 2),
        reason: label(r.reason, CONVERSATION_AI_LIMITS.reasonMax), changedAt: instant(r.changedAt), changedBy: nullableLabel(r.changedBy) };
    }),
  };
}
export function validateConversationAiProgramReceipt(value: unknown): ConversationAiProgramReceipt {
  const row = record(value, ['status', 'version', 'changedAt', 'replayed']);
  return { status: oneOf(row.status, CONVERSATION_AI_PROGRAM_STATUSES), version: count(row.version, 2), changedAt: instant(row.changedAt), replayed: bool(row.replayed) };
}
