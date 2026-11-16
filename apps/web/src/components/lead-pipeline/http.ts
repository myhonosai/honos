import {
  validateMoveCrmLeadStageInput, validateSaveCrmPipelineStagesInput, verifyCrmLeadStageMoveReceipt, verifyCrmPipelineBoard,
  verifyCrmPipelineStagesReceipt, type CrmBoardStatus, type CrmLeadStageMoveReceipt, type CrmPipelineBoard, type CrmPipelineStagesReceipt,
  type SaveCrmPipelineStagesInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * 0417 lead pipeline board calls. The school is the one the shell verified; ids are selectors only and the API re-derives
 * the human, school and permission from the signed session. The two commands are same-origin browser commands, each with
 * a key made on the press and reused only to retry that same uncertain press.
 */
export type BoardScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type BoardErrorKind = 'SESSION' | 'DENIED' | 'UNAVAILABLE';
export class BoardError extends Error { constructor(readonly kind: BoardErrorKind) { super(kind); } }
/** A command answer: refused (with the server's closed code), stale, denied, ended session, or unknown outcome. */
export type CommandErrorKind = 'REJECTED' | 'CONFLICT' | 'DENIED' | 'SESSION' | 'UNCERTAIN';
export class BoardCommandError extends Error { constructor(readonly kind: CommandErrorKind, readonly code: string | null = null) { super(kind); } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
function id(value: string): string { if (!UUID.test(value)) throw new BoardError('UNAVAILABLE'); return value.toLowerCase(); }
function base(scope: BoardScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/crm`; }

export function boardPath(scope: BoardScope, pipelineId: string | null, status: CrmBoardStatus): string {
  const query = new URLSearchParams({ status });
  if (pipelineId) query.set('pipelineId', id(pipelineId));
  return `${base(scope)}/pipeline-board?${query}`;
}

export async function readBoard(scope: BoardScope, pipelineId: string | null, status: CrmBoardStatus, signal: AbortSignal, owned: Owned): Promise<CrmPipelineBoard> {
  const path = boardPath(scope, pipelineId, status);
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal });
  } catch (error) { if (signal.aborted) throw error; throw new BoardError('UNAVAILABLE'); }
  // A retired read never ends a newer session.
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new BoardError('SESSION'); }
  if (response.status === 403) throw new BoardError('DENIED');
  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new BoardError('UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { throw new BoardError('UNAVAILABLE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') throw new BoardError('UNAVAILABLE');
  try {
    const board = verifyCrmPipelineBoard((body as { data: unknown }).data, { status });
    if (pipelineId && board.pipeline && board.pipeline.id !== pipelineId.toLowerCase()) throw new Error('pipeline drift');
    return board;
  } catch { throw new BoardError('UNAVAILABLE'); }
}

export type PreparedCommand = Readonly<{ path: string; key: string; body: string; command: 'crm.lead.stage.move' | 'crm.pipeline.stages.save'; target: string; stageId?: string }>;

export function prepareMove(scope: BoardScope, leadId: string, stageId: string, expectedVersion: number, key: string): PreparedCommand {
  if (!UUID.test(key)) throw new BoardCommandError('REJECTED');
  const input = validateMoveCrmLeadStageInput({ stageId: stageId.toLowerCase(), expectedVersion });
  return Object.freeze({ path: `${base(scope)}/leads/${id(leadId)}/stage`, key, body: JSON.stringify(input), command: 'crm.lead.stage.move', target: id(leadId), stageId: input.stageId });
}

export function prepareSave(scope: BoardScope, pipelineId: string, input: SaveCrmPipelineStagesInput, key: string): PreparedCommand {
  if (!UUID.test(key)) throw new BoardCommandError('REJECTED');
  const checked = validateSaveCrmPipelineStagesInput(input);
  return Object.freeze({ path: `${base(scope)}/pipelines/${id(pipelineId)}/stages`, key, body: JSON.stringify(checked), command: 'crm.pipeline.stages.save', target: id(pipelineId) });
}

async function send(request: PreparedCommand): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(request.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-HON-Human-Command': request.command }, body: request.body });
  } catch { throw new BoardCommandError('UNCERTAIN'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new BoardCommandError('SESSION'); }
  if (response.status === 403) throw new BoardCommandError('DENIED');
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    let code: string | null = null;
    try { const raw: unknown = await response.json(); const value = raw && typeof raw === 'object' ? (raw as { code?: unknown }).code : undefined; if (typeof value === 'string' && CODE.test(value)) code = value; } catch { /* closed answer */ }
    if (code === 'IDEMPOTENCY_IN_PROGRESS') throw new BoardCommandError('UNCERTAIN', code);
    throw new BoardCommandError(response.status === 409 || response.status === 404 ? 'CONFLICT' : 'REJECTED', code);
  }
  try {
    if (response.status !== 200 || response.redirected || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new Error('shape');
    const raw = await response.text(); if (raw.length > 200000) throw new Error('size');
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') throw new Error('shape');
    return (body as { data: unknown }).data;
  } catch { throw new BoardCommandError('UNCERTAIN'); }
}

export async function submitMove(request: PreparedCommand): Promise<CrmLeadStageMoveReceipt> {
  const data = await send(request);
  try { return verifyCrmLeadStageMoveReceipt(data, { leadId: request.target, ...(request.stageId ? { stageId: request.stageId } : {}) }); }
  catch { throw new BoardCommandError('UNCERTAIN'); }
}

export async function submitSave(request: PreparedCommand): Promise<CrmPipelineStagesReceipt> {
  const data = await send(request);
  try { return verifyCrmPipelineStagesReceipt(data, { pipelineId: request.target }); }
  catch { throw new BoardCommandError('UNCERTAIN'); }
}

export interface BoardApi {
  read: typeof readBoard; submitMove: typeof submitMove; submitSave: typeof submitSave;
}
export const boardApi: BoardApi = { read: readBoard, submitMove, submitSave };
