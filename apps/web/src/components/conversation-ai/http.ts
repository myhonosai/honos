import {
  CONVERSATION_AI_ITEM_SAVE_COMMAND, CONVERSATION_AI_ITEM_STATUS_COMMAND, CONVERSATION_AI_SETTINGS_COMMAND, CONVERSATION_AI_TEST_ASK_COMMAND,
  CONVERSATION_AI_UPLOAD_COMMAND, SAAS_COMMANDS, validateConversationAiTestAsk, verifyConversationAiTestState, verifyConversationAiTestView,
  type ConversationAiTestState, type ConversationAiTestView,
  validateConversationAiItemInput, validateConversationAiItemStatusInput, validateConversationAiProgram, validateConversationAiProgramInput,
  validateConversationAiProgramReceipt, validateConversationAiSettingsInput, validateConversationAiUploadInput,
  verifyConversationAiFileContent, verifyConversationAiItemReceipt, verifyConversationAiKnowledge, verifyConversationAiOverview,
  verifyConversationAiSettingsReceipt, verifyConversationAiUploadReceipt,
  type ConversationAiFileContent, type ConversationAiItemInput, type ConversationAiItemReceipt, type ConversationAiItemStatusInput,
  type ConversationAiKnowledge, type ConversationAiOverview, type ConversationAiProgram, type ConversationAiProgramInput,
  type ConversationAiProgramReceipt, type ConversationAiSettingsInput, type ConversationAiSettingsReceipt, type ConversationAiUploadInput,
  type ConversationAiUploadReceipt,
} from '@hon/contracts';

/**
 * Train AI (0420): same-origin browser calls only. The shell's school scope is sent and checked again by the server
 * (conversation.read to look, conversation.ai.configure to change); nothing here decides permission, and no AI is called.
 * Reads are plain GETs with no command marker or Idempotency-Key; every change sends its own X-HON-Human-Command and one.
 */
export class TrainAiAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN', readonly status: number, readonly code = '') { super(reason); } }
/** A definite refusal (nothing stored). A retry is a new command. */
export class TrainAiRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown: the change may or may not have been saved. */
export class TrainAiUnknown extends Error {}
export type TrainAiScope = Readonly<{ organizationId: string; schoolId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
/** Codes the server returns for a definite refusal. Anything else is treated as unknown. */
export const TRAIN_AI_REFUSALS = [
  'VALIDATION_FAILED', 'CONVERSATION_VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'CONVERSATION_AI_ITEM_NOT_FOUND',
  'CONVERSATION_AI_FILE_TYPE_MISMATCH', 'CONVERSATION_AI_LIBRARY_FULL', 'CONVERSATION_AI_SELECTORS_NOT_ACCEPTED',
  'INVALID_SAAS_INPUT', 'SAAS_VERSION_CONFLICT', 'CONVERSATION_AI_PROGRAM_UNCHANGED',
  'CONVERSATION_AI_TEST_INVALID', 'CONVERSATION_AI_TEST_BUSY',
] as const;
const REFUSAL = new Set<string>(TRAIN_AI_REFUSALS);
function invalid(): never { throw new TrainAiUnknown('unverified'); }
/** An answer that fails its check is an unknown outcome, never a success. */
function checked<T>(fn: () => T): T { try { return fn(); } catch (error) { if (error instanceof TrainAiUnknown) throw error; invalid(); } }

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new TrainAiUnknown('network'); }
  if (response.status === 401) throw new TrainAiAccessError('SESSION', 401);
  if (response.status === 403) {
    // The refusal code says why (for the test chat: not included, or AI spend stopped); it never grants anything.
    const body: unknown = JSON_TYPE.test(response.headers.get('content-type') ?? '') ? await response.json().catch(() => null) : null;
    const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : '';
    throw new TrainAiAccessError('FORBIDDEN', 403, /^[A-Z][A-Z_]{1,63}$/.test(code) ? code : '');
  }
  if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (REFUSAL.has(String(root.code))) throw new TrainAiRefusal(String(root.code));
    throw new TrainAiUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}
function base(scope: TrainAiScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/conversation-ai`;
}
function id(value: string): string { if (!UUID.test(value)) invalid(); return value.toLowerCase(); }

export async function loadTrainAi(scope: TrainAiScope): Promise<ConversationAiOverview> {
  const { data } = await call(base(scope), 'GET');
  return checked(() => verifyConversationAiOverview(data));
}
/** What the AI will be given to answer from: school facts, plans, booking types and the active training items. */
export async function loadKnowledge(scope: TrainAiScope): Promise<ConversationAiKnowledge> {
  const { data } = await call(`${base(scope)}/knowledge`, 'GET');
  return checked(() => verifyConversationAiKnowledge(data));
}
/** The original uploaded file, exactly as stored, checked to be the file asked for. */
export async function loadTrainingFile(scope: TrainAiScope, fileId: string): Promise<ConversationAiFileContent> {
  const fid = id(fileId);
  const { data } = await call(`${base(scope)}/files/${fid}`, 'GET');
  return checked(() => verifyConversationAiFileContent(data, fid));
}
export async function saveSettings(scope: TrainAiScope, input: ConversationAiSettingsInput, key: string): Promise<{ receipt: ConversationAiSettingsReceipt; replayed: boolean }> {
  const body = validateConversationAiSettingsInput(input);
  const out = await call(`${base(scope)}/settings`, 'POST', CONVERSATION_AI_SETTINGS_COMMAND, body, key);
  return { receipt: checked(() => verifyConversationAiSettingsReceipt(out.data)), replayed: replayed(out.meta) };
}
export async function uploadTrainingFile(scope: TrainAiScope, input: ConversationAiUploadInput, key: string): Promise<{ receipt: ConversationAiUploadReceipt; replayed: boolean }> {
  const body = validateConversationAiUploadInput(input);
  const out = await call(`${base(scope)}/files`, 'POST', CONVERSATION_AI_UPLOAD_COMMAND, body, key);
  const receipt = checked(() => verifyConversationAiUploadReceipt(out.data));
  // The server keeps one copy of identical bytes and returns that file under its first name, so the name may differ;
  // the type and the exact byte count must match what was sent.
  const bytes = body.contentBase64.length / 4 * 3 - (body.contentBase64.endsWith('==') ? 2 : body.contentBase64.endsWith('=') ? 1 : 0);
  if (receipt.file.mediaType !== body.mediaType || receipt.file.byteSize !== bytes) invalid();
  return { receipt, replayed: replayed(out.meta) };
}
export async function saveTrainingItem(scope: TrainAiScope, input: ConversationAiItemInput, key: string): Promise<{ receipt: ConversationAiItemReceipt; replayed: boolean }> {
  const body = validateConversationAiItemInput(input);
  const out = await call(`${base(scope)}/items`, 'POST', CONVERSATION_AI_ITEM_SAVE_COMMAND, body, key);
  const receipt = checked(() => verifyConversationAiItemReceipt(out.data, body.itemId ? { itemId: body.itemId } : undefined));
  if (receipt.item.status === 'DELETED' || receipt.item.kind !== body.kind || receipt.item.title !== body.title) invalid();
  return { receipt, replayed: replayed(out.meta) };
}
export async function setTrainingItemStatus(scope: TrainAiScope, input: ConversationAiItemStatusInput, key: string): Promise<{ receipt: ConversationAiItemReceipt; replayed: boolean }> {
  const body = validateConversationAiItemStatusInput(input);
  const out = await call(`${base(scope)}/items/status`, 'POST', CONVERSATION_AI_ITEM_STATUS_COMMAND, body, key);
  return { receipt: checked(() => verifyConversationAiItemReceipt(out.data, { itemId: body.itemId, status: body.status })), replayed: replayed(out.meta) };
}

/** CE2 (0667): whether the AI can answer a test now, and the signed-in staff member's own last 10 tests. */
export async function loadTestChat(scope: TrainAiScope): Promise<ConversationAiTestState> {
  const { data } = await call(`${base(scope)}/test`, 'GET');
  return checked(() => verifyConversationAiTestState(data));
}
/** One test question. The answer is shown only to the asker and never sent; the same key never makes a second AI call. */
export async function askTestQuestion(scope: TrainAiScope, question: string, key: string): Promise<ConversationAiTestView> {
  const body = validateConversationAiTestAsk({ question });
  if (!UUID.test(key)) invalid();
  const { data } = await call(`${base(scope)}/test`, 'POST', CONVERSATION_AI_TEST_ASK_COMMAND, body, key);
  const view = checked(() => verifyConversationAiTestView(data));
  if (view.question !== body.question) invalid();
  return view;
}

/** HQ program switch. The database decides who may read (HQ readers) and who may change it (a human HQ owner). */
export async function loadProgram(): Promise<ConversationAiProgram> {
  const { data } = await call('/api/v1/hq/conversation-ai/program', 'GET');
  return checked(() => validateConversationAiProgram(data));
}
export async function setProgram(input: ConversationAiProgramInput, key: string): Promise<ConversationAiProgramReceipt> {
  const body = validateConversationAiProgramInput(input);
  if (!UUID.test(key)) invalid();
  const { data } = await call('/api/v1/hq/conversation-ai/program', 'POST', SAAS_COMMANDS.conversationAiProgram, body, key);
  const receipt = checked(() => validateConversationAiProgramReceipt(data));
  if (receipt.status !== body.status) invalid();
  return receipt;
}

/** Keep the idempotency key only while the same command is retried; any change starts a new command. */
export function commandAttempt(fingerprint: string, previous: { fingerprint: string; key: string } | null, newKey: () => string): { fingerprint: string; key: string } {
  return previous && previous.fingerprint === fingerprint ? previous : { fingerprint, key: newKey() };
}

/** File type from the chosen file, matched against the allowed list; the server checks the bytes again. */
const BY_EXTENSION: Record<string, ConversationAiUploadInput['mediaType']> = {
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
export function mediaTypeFor(fileName: string): ConversationAiUploadInput['mediaType'] | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? null;
}
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
