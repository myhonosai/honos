import {
  CUSTOM_TOOL_CHANGE_COMMAND, CUSTOM_TOOL_RECORD_COMMAND, CUSTOM_TOOL_SAVE_COMMAND,
  validateCustomToolChangeInput, validateCustomToolDraftInput, validateCustomToolRecordInput,
  verifyCustomToolDashboard, verifyCustomToolDesign, verifyCustomToolLinkOptions, verifyCustomToolList, verifyCustomToolRecord, verifyCustomToolRecordList,
  type CustomToolChangeInput, type CustomToolDashboard, type CustomToolDesign, type CustomToolDraftInput, type CustomToolLinkOptions,
  type CustomToolList, type CustomToolRecord, type CustomToolRecordInput, type CustomToolRecordList,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * AI Customizer custom tools (0362). Reads are same-origin GETs with no Idempotency-Key; each command sends its own
 * X-HON-Human-Command and a fresh Idempotency-Key, so no call can be replayed as another. The server validates every
 * design and every record value again and decides every permission; nothing in this file is authority.
 */
export type ToolErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The tool, version or record is not available here. */ | 'GONE'
  /** Someone changed it first. Nothing changed; read again. */ | 'CHANGED'
  /** The tool is not in a state that allows this (for example, a draft is open). Nothing changed. */ | 'STATE'
  /** The tool key is already used at this school. Nothing changed. */ | 'TAKEN'
  /** The design breaks a rule; `detail` names the part. Nothing changed. */ | 'DESIGN'
  /** A value does not fit its field; `detail` names the field. Nothing changed. */ | 'VALUE'
  /** A school limit was reached. Nothing changed. */ | 'LIMIT'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ToolError extends Error {
  constructor(readonly kind: ToolErrorKind, readonly code: string | null = null, readonly detail: string | null = null) { super(kind); }
}
export type Owned = () => boolean;
export type ToolScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

type Answer = { status: number; value: unknown };
const field = (v: unknown, name: string): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>)[name] === 'string' ? (v as Record<string, string>)[name]! : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function base(scope: ToolScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ToolError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/custom-tools`;
}
function toolPath(scope: ToolScope, toolId: string): string {
  if (!UUID.test(toolId)) throw new ToolError('INVALID');
  return `${base(scope)}/${toolId.toLowerCase()}`;
}
const qs = (params: Record<string, string | undefined>) => {
  const kept = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return kept.length ? `?${new URLSearchParams(kept)}` : '';
};

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<Answer> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ToolError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ToolError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function toolErrorFor(status: number, value: unknown): ToolError {
  const code = field(value, 'code');
  if (status === 403) return new ToolError('DENIED', code);
  if (status === 404) return new ToolError('GONE', code);
  if (status === 429) return new ToolError('LIMIT', code);
  if (status === 400) {
    if (code === 'CUSTOM_TOOL_DEFINITION_INVALID') return new ToolError('DESIGN', code, field(value, 'path'));
    if (code === 'CUSTOM_TOOL_RECORD_INVALID') return new ToolError('VALUE', code, field(value, 'field'));
    return new ToolError('INVALID', code);
  }
  if (status === 409) {
    if (code === 'CUSTOM_TOOL_VERSION_CONFLICT') return new ToolError('CHANGED', code);
    if (code === 'CUSTOM_TOOL_STATE' || code === 'CUSTOM_TOOL_DRAFT_OPEN') return new ToolError('STATE', code);
    if (code === 'CUSTOM_TOOL_KEY_TAKEN') return new ToolError('TAKEN', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED') return new ToolError('INVALID', code);
  }
  // CUSTOM_TOOL_BUSY, 5xx: the same request may be sent again.
  return new ToolError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: Answer;
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof ToolError || signal.aborted) throw error; throw new ToolError('UNKNOWN'); }
  if (answer.status !== 200) throw toolErrorFor(answer.status, answer.value);
  try { return verify(data(answer.value)); } catch { throw new ToolError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ToolError('INVALID');
  let answer: Answer;
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ToolError) throw error; throw new ToolError('UNKNOWN'); }
  if (answer.status !== 200) throw toolErrorFor(answer.status, answer.value);
  try { return verify(data(answer.value)); } catch { throw new ToolError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new ToolError('INVALID'); } }
const sameTool = (toolId: string) => (v: unknown): CustomToolDesign => {
  const design = verifyCustomToolDesign(v);
  if (design.tool.toolId.toLowerCase() !== toolId.toLowerCase()) throw new Error('tool');
  return design;
};

export const customToolApi = {
  /** The tools this staff member can see (all of them, drafts included, for a designer). */
  list(scope: ToolScope, signal: AbortSignal, owned: Owned): Promise<CustomToolList> {
    return Promise.resolve().then(() => read(base(scope), verifyCustomToolList, signal, owned));
  },
  /** One tool's design: a designer gets the draft (or a named version) with its history; anyone else gets the published version only. */
  design(scope: ToolScope, toolId: string, version: number | null, signal: AbortSignal, owned: Owned): Promise<CustomToolDesign> {
    return Promise.resolve().then(() => {
      if (version !== null && (!Number.isInteger(version) || version < 1)) throw new ToolError('INVALID');
      return read(`${toolPath(scope, toolId)}${qs({ version: version === null ? undefined : String(version) })}`, sameTool(toolId), signal, owned);
    });
  },
  records(scope: ToolScope, toolId: string, q: Readonly<{ entity: string; preview: boolean; archived: boolean; limit: number }>, signal: AbortSignal, owned: Owned): Promise<CustomToolRecordList> {
    return Promise.resolve().then(() => {
      if (!KEY.test(q.entity) || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200) throw new ToolError('INVALID');
      return read(`${toolPath(scope, toolId)}/records${qs({ entity: q.entity, preview: q.preview ? 'true' : undefined, archived: q.archived ? 'true' : undefined, limit: String(q.limit) })}`,
        verifyCustomToolRecordList, signal, owned);
    });
  },
  dashboard(scope: ToolScope, toolId: string, view: string, preview: boolean, signal: AbortSignal, owned: Owned): Promise<CustomToolDashboard> {
    return Promise.resolve().then(() => {
      if (!KEY.test(view)) throw new ToolError('INVALID');
      return read(`${toolPath(scope, toolId)}/dashboards/${view}${qs({ preview: preview ? 'true' : undefined })}`, (v) => {
        const d = verifyCustomToolDashboard(v);
        if (d.view !== view) throw new Error('view');
        return d;
      }, signal, owned);
    });
  },
  linkOptions(scope: ToolScope, toolId: string, q: Readonly<{ kind: 'STUDENT' | 'STAFF' | 'RECORD'; entity: string | null; search: string; preview: boolean }>, signal: AbortSignal, owned: Owned): Promise<CustomToolLinkOptions> {
    return Promise.resolve().then(() => {
      if (!['STUDENT', 'STAFF', 'RECORD'].includes(q.kind) || (q.entity !== null && !KEY.test(q.entity)) || q.search.length > 60) throw new ToolError('INVALID');
      return read(`${toolPath(scope, toolId)}/link-options${qs({ kind: q.kind, entity: q.entity ?? undefined, search: q.search.trim() || undefined, preview: q.preview ? 'true' : undefined })}`,
        verifyCustomToolLinkOptions, signal, owned);
    });
  },
  async saveDraft(scope: ToolScope, input: CustomToolDraftInput, key: string, signal: AbortSignal, owned: Owned): Promise<CustomToolDesign> {
    const body = checked(() => validateCustomToolDraftInput(input));
    return command(`${base(scope)}/drafts`, CUSTOM_TOOL_SAVE_COMMAND, body, key, (v) => {
      const design = verifyCustomToolDesign(v);
      if (body.toolId !== null && design.tool.toolId.toLowerCase() !== body.toolId.toLowerCase()) throw new Error('tool');
      return design;
    }, signal, owned);
  },
  async change(scope: ToolScope, toolId: string, input: CustomToolChangeInput, key: string, signal: AbortSignal, owned: Owned): Promise<CustomToolDesign> {
    const body = checked(() => validateCustomToolChangeInput(input));
    return command(`${toolPath(scope, toolId)}/changes`, CUSTOM_TOOL_CHANGE_COMMAND, body, key, sameTool(toolId), signal, owned);
  },
  async writeRecord(scope: ToolScope, toolId: string, input: CustomToolRecordInput, key: string, signal: AbortSignal, owned: Owned): Promise<CustomToolRecord> {
    const body = checked(() => validateCustomToolRecordInput(input));
    return command(`${toolPath(scope, toolId)}/records`, CUSTOM_TOOL_RECORD_COMMAND, body, key, (v) => {
      const record = verifyCustomToolRecord(v);
      if (record.entity !== body.entity || record.preview !== body.preview || (body.recordId !== null && record.recordId.toLowerCase() !== body.recordId.toLowerCase())) throw new Error('record');
      return record;
    }, signal, owned);
  },
};
export type CustomToolApi = typeof customToolApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known. */
export const keepForRetry = (error: unknown) => !(error instanceof ToolError) || error.kind === 'UNKNOWN';
export const toolErrorKind = (error: unknown): ToolErrorKind => error instanceof ToolError ? error.kind : 'UNKNOWN';
