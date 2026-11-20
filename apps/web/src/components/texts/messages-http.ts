import {
  SCHOOL_TEMPLATE_SAVE_COMMAND, SCHOOL_TEMPLATE_STATUS_COMMAND,
  validateSaveSchoolTemplateInput, validateSchoolMessageHistoryQuery, validateSchoolOptedOutQuery, validateSchoolTemplatesQuery,
  validateSetSchoolTemplateStatusInput, verifySchoolMessageHistory, verifySchoolOptedOut, verifySchoolTemplate, verifySchoolTemplateList,
  type SaveSchoolTemplateInput, type SchoolMessageHistory, type SchoolMessageHistoryQuery, type SchoolOptedOut, type SchoolOptedOutQuery,
  type SchoolTemplate, type SchoolTemplateList, type SchoolTemplateStatus, type SchoolTemplatesQuery,
} from '@hon/contracts';

/**
 * Texts and Email pages, History / Templates / Opted out (TE1 0585, TE2 0586). Same-origin browser calls only. The shell's
 * school scope is sent and checked again by the server (communication.message.read, communication.consent.read,
 * communication.template.read/manage); nothing here decides permission. Templates are text only: nothing here sends.
 */
export class MessagesAccessError extends Error { constructor(readonly reason: 'SESSION' | 'FORBIDDEN') { super(reason); } }
/** A definite refusal (nothing stored); the code picks the plain message. A retry is a new command. */
export class MessagesRefusal extends Error { constructor(readonly code: string) { super(code); } }
/** The answer could not be checked or the outcome is unknown: a save may or may not have been stored. */
export class MessagesUnknown extends Error {}
export type MessagesScope = Readonly<{ organizationId: string; schoolId: string }>;

/** Server codes for a definite refusal. Anything else is unknown. */
export const MESSAGES_REFUSALS = [
  'VALIDATION_FAILED', 'MESSAGE_TEMPLATE_NOT_FOUND', 'MESSAGE_TEMPLATE_ARCHIVED', 'MESSAGE_TEMPLATE_STATUS_UNCHANGED',
  'MESSAGE_TEMPLATE_NAME_TAKEN', 'MESSAGE_TEMPLATE_LIMIT', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED',
] as const;
const REFUSAL = new Set<string>(MESSAGES_REFUSALS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new MessagesUnknown('unverified'); }

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown; meta?: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; headers['Idempotency-Key'] = key!; }
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new MessagesUnknown('network'); }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new MessagesAccessError('SESSION');
    if (response.status === 403) throw new MessagesAccessError('FORBIDDEN');
    if (REFUSAL.has(String(root.code))) throw new MessagesRefusal(String(root.code));
    throw new MessagesUnknown(String(response.status));
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown; meta?: unknown };
}
function base(scope: MessagesScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/communications`;
}
function withQuery(path: string, params: URLSearchParams): string { const text = params.toString(); return text ? `${path}?${text}` : path; }
function replayed(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || typeof (meta as { replayed?: unknown }).replayed !== 'boolean') invalid();
  return (meta as { replayed: boolean }).replayed;
}

/** Every sent text or email of the school, newest first. The cursor is the previous page's nextCursor, unchanged. */
export async function loadHistory(scope: MessagesScope, filters: SchoolMessageHistoryQuery = {}): Promise<SchoolMessageHistory> {
  const query = validateSchoolMessageHistoryQuery(filters);
  const params = new URLSearchParams();
  for (const key of ['channel', 'outcome', 'origin', 'range', 'search'] as const) if (query[key] !== undefined) params.set(key, query[key]!);
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  try { return verifySchoolMessageHistory((await call(withQuery(`${base(scope)}/history`, params), 'GET')).data, query); }
  catch (error) { if (error instanceof MessagesAccessError || error instanceof MessagesRefusal || error instanceof MessagesUnknown) throw error; return invalid(); }
}
/** Contacts whose consent for the channel is OPTED_OUT now, newest first. */
export async function loadOptedOut(scope: MessagesScope, filters: SchoolOptedOutQuery = {}): Promise<SchoolOptedOut> {
  const query = validateSchoolOptedOutQuery(filters);
  const params = new URLSearchParams();
  if (query.channel) params.set('channel', query.channel);
  if (query.search) params.set('search', query.search);
  if (query.before) { params.set('beforeAt', query.before.at); params.set('beforeId', query.before.id); }
  try { return verifySchoolOptedOut((await call(withQuery(`${base(scope)}/opted-out`, params), 'GET')).data, query); }
  catch (error) { if (error instanceof MessagesAccessError || error instanceof MessagesRefusal || error instanceof MessagesUnknown) throw error; return invalid(); }
}
export async function loadTemplates(scope: MessagesScope, filters: SchoolTemplatesQuery = {}): Promise<SchoolTemplateList> {
  const query = validateSchoolTemplatesQuery(filters);
  const params = new URLSearchParams();
  if (query.channel) params.set('channel', query.channel);
  if (query.status) params.set('status', query.status);
  try { return verifySchoolTemplateList((await call(withQuery(`${base(scope)}/templates`, params), 'GET')).data, query); }
  catch (error) { if (error instanceof MessagesAccessError || error instanceof MessagesRefusal || error instanceof MessagesUnknown) throw error; return invalid(); }
}
/** Creates (templateId null, expectedVersion 0) or changes one template at its exact version. */
export async function saveTemplate(scope: MessagesScope, input: SaveSchoolTemplateInput, key: string): Promise<{ template: SchoolTemplate; replayed: boolean }> {
  const checked = validateSaveSchoolTemplateInput(input);
  const out = await call(`${base(scope)}/templates`, 'POST', SCHOOL_TEMPLATE_SAVE_COMMAND, checked, key);
  let template: SchoolTemplate;
  try { template = verifySchoolTemplate(out.data); } catch { return invalid(); }
  if (template.version !== checked.expectedVersion + 1 || template.channel !== checked.channel || template.status !== 'ACTIVE'
    || (checked.templateId !== null && template.templateId !== checked.templateId)
    || template.name !== checked.name || template.body !== checked.body || template.subject !== checked.subject) invalid();
  return { template, replayed: replayed(out.meta) };
}
export async function setTemplateStatus(scope: MessagesScope, templateId: string, expectedVersion: number, status: SchoolTemplateStatus, key: string):
  Promise<{ template: SchoolTemplate; replayed: boolean }> {
  const checked = validateSetSchoolTemplateStatusInput({ templateId: templateId.toLowerCase(), expectedVersion, status });
  const out = await call(`${base(scope)}/templates/${checked.templateId}/status`, 'POST', SCHOOL_TEMPLATE_STATUS_COMMAND,
    { expectedVersion: checked.expectedVersion, status: checked.status }, key);
  let template: SchoolTemplate;
  try { template = verifySchoolTemplate(out.data); } catch { return invalid(); }
  if (template.templateId !== checked.templateId || template.version !== checked.expectedVersion + 1 || template.status !== checked.status) invalid();
  return { template, replayed: replayed(out.meta) };
}
