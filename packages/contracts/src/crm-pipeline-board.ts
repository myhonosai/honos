/**
 * 0417: the lead pipeline board. One pipeline's stages, totals and up to 500 leads of one status; moving an open lead to
 * another stage; saving the ordered list of non-terminal stages. The database validates every rule here again.
 */
export const CRM_STAGE_COLORS = ['BLUE', 'SKY', 'CYAN', 'VIOLET', 'GREEN', 'RED', 'AMBER', 'SLATE'] as const;
export type CrmStageColor = typeof CRM_STAGE_COLORS[number];
export const CRM_BOARD_STATUSES = ['OPEN', 'WON', 'LOST', 'CLOSED'] as const;
export type CrmBoardStatus = typeof CRM_BOARD_STATUSES[number];
export const CRM_BOARD_LIMIT = 500;
export const CRM_STAGE_MAX = 20;
export const CRM_STAGE_NAME_MAX = 60;

export interface CrmBoardStage {
  id: string; name: string; position: number; color: CrmStageColor; hidden: boolean;
  terminalStatus: 'WON' | 'LOST' | 'ARCHIVED' | null; openCount: number;
}
export interface CrmBoardLead {
  id: string; version: number; status: 'OPEN' | 'WON' | 'LOST' | 'ARCHIVED'; stageId: string; personId: string;
  givenName: string; familyName: string; email: string | null; phoneE164: string | null;
  programInterestCode: string | null; sourceCode: string | null;
  createdAt: string; closedAt: string | null; nextTrialAt: string | null; lastTrialAt: string | null;
}
export interface CrmPipelineRef { id: string; name: string; version: number }
export interface CrmPipelineBoard {
  pipelines: CrmPipelineRef[]; pipeline: CrmPipelineRef | null; stages: CrmBoardStage[];
  totals: { open: number; won: number; lost: number }; status: CrmBoardStatus;
  leads: CrmBoardLead[]; truncated: boolean; limit: number;
}
export interface MoveCrmLeadStageInput { stageId: string; expectedVersion: number }
export interface CrmLeadStageMoveReceipt {
  organizationId: string; schoolId: string; leadId: string; pipelineId: string; fromStageId: string; stageId: string;
  priorVersion: number; version: number; movedAt: string;
}
export interface SaveCrmStageItem { id: string | null; name: string; color: CrmStageColor; hidden: boolean }
export interface SaveCrmPipelineStagesInput {
  expectedVersion: number; stages: SaveCrmStageItem[]; moves: Array<{ fromStageId: string; toStageId: string }>;
}
export interface CrmPipelineStagesReceipt {
  organizationId: string; schoolId: string; pipelineId: string; priorVersion: number; version: number;
  stages: CrmBoardStage[]; moves: Array<{ fromStageId: string; toStageId: string; count: number }>; savedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/;

function invalid(): never { throw new Error('Invalid lead pipeline board data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
const uuid = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value : invalid());
const version = (value: unknown, min = 1): number => (Number.isInteger(value) && (value as number) >= min && (value as number) <= 999999999 ? value as number : invalid());
const count = (value: unknown): number => (Number.isInteger(value) && (value as number) >= 0 ? value as number : invalid());
const instant = (value: unknown): string => (typeof value === 'string' && INSTANT.test(value) ? value : invalid());
const maybe = <T>(value: unknown, check: (v: unknown) => T): T | null => (value === null ? null : check(value));
const text = (max: number) => (value: unknown): string => (typeof value === 'string' && value.length <= max ? value : invalid());
const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid());
const color = (value: unknown): CrmStageColor => ((CRM_STAGE_COLORS as readonly unknown[]).includes(value) ? value as CrmStageColor : invalid());
function list<T>(value: unknown, item: (v: unknown) => T, max: number): T[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value.map(item);
}

export function crmStageNameOk(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CRM_STAGE_NAME_MAX && value.trim() === value && !UNSAFE_NAME.test(value);
}

function stage(value: unknown): CrmBoardStage {
  const row = record(value, ['color', 'hidden', 'id', 'name', 'openCount', 'position', 'terminalStatus']);
  const terminal = row.terminalStatus;
  if (terminal !== null && terminal !== 'WON' && terminal !== 'LOST' && terminal !== 'ARCHIVED') invalid();
  if (typeof row.name !== 'string' || !row.name.length || row.name.length > 200) invalid();
  if (!Number.isInteger(row.position)) invalid();
  const hidden = bool(row.hidden);
  if (hidden && terminal !== null) invalid();
  return { id: uuid(row.id), name: row.name, position: row.position as number, color: color(row.color), hidden, terminalStatus: terminal, openCount: count(row.openCount) };
}
function pipelineRef(value: unknown): CrmPipelineRef {
  const row = record(value, ['id', 'name', 'version']);
  return { id: uuid(row.id), name: text(200)(row.name), version: version(row.version) };
}
function lead(value: unknown): CrmBoardLead {
  const row = record(value, ['closedAt', 'createdAt', 'email', 'familyName', 'givenName', 'id', 'lastTrialAt', 'nextTrialAt', 'personId',
    'phoneE164', 'programInterestCode', 'sourceCode', 'stageId', 'status', 'version']);
  if (!['OPEN', 'WON', 'LOST', 'ARCHIVED'].includes(row.status as string)) invalid();
  return {
    id: uuid(row.id), version: version(row.version), status: row.status as CrmBoardLead['status'], stageId: uuid(row.stageId), personId: uuid(row.personId),
    givenName: text(200)(row.givenName), familyName: text(200)(row.familyName), email: maybe(row.email, text(320)), phoneE164: maybe(row.phoneE164, text(32)),
    programInterestCode: maybe(row.programInterestCode, text(200)), sourceCode: maybe(row.sourceCode, text(80)),
    createdAt: instant(row.createdAt), closedAt: maybe(row.closedAt, instant), nextTrialAt: maybe(row.nextTrialAt, instant), lastTrialAt: maybe(row.lastTrialAt, instant),
  };
}

export function verifyCrmPipelineBoard(value: unknown, expected?: { status?: CrmBoardStatus }): CrmPipelineBoard {
  const row = record(value, ['leads', 'limit', 'pipeline', 'pipelines', 'stages', 'status', 'totals', 'truncated']);
  if (!(CRM_BOARD_STATUSES as readonly unknown[]).includes(row.status) || (expected?.status && row.status !== expected.status)) invalid();
  const status = row.status as CrmBoardStatus;
  const totals = record(row.totals, ['lost', 'open', 'won']);
  const board: CrmPipelineBoard = {
    pipelines: list(row.pipelines, pipelineRef, 50), pipeline: maybe(row.pipeline, pipelineRef), stages: list(row.stages, stage, 100),
    totals: { open: count(totals.open), won: count(totals.won), lost: count(totals.lost) }, status,
    leads: list(row.leads, lead, CRM_BOARD_LIMIT), truncated: bool(row.truncated), limit: row.limit === CRM_BOARD_LIMIT ? CRM_BOARD_LIMIT : invalid(),
  };
  const allowed = status === 'CLOSED' ? ['WON', 'LOST'] : [status];
  const stageIds = new Set(board.stages.map(s => s.id));
  if (board.leads.some(l => !allowed.includes(l.status) || !stageIds.has(l.stageId))) invalid();
  if (board.pipeline === null && (board.stages.length || board.leads.length)) invalid();
  if (board.pipeline && !board.pipelines.some(p => p.id === board.pipeline!.id)) invalid();
  return board;
}

export function validateMoveCrmLeadStageInput(value: unknown): MoveCrmLeadStageInput {
  const row = record(value, ['expectedVersion', 'stageId']);
  return { stageId: uuid(row.stageId), expectedVersion: version(row.expectedVersion) };
}
export function verifyCrmLeadStageMoveReceipt(value: unknown, expected?: { leadId?: string; stageId?: string }): CrmLeadStageMoveReceipt {
  const row = record(value, ['fromStageId', 'leadId', 'movedAt', 'organizationId', 'pipelineId', 'priorVersion', 'schoolId', 'stageId', 'version']);
  const receipt: CrmLeadStageMoveReceipt = {
    organizationId: uuid(row.organizationId), schoolId: uuid(row.schoolId), leadId: uuid(row.leadId), pipelineId: uuid(row.pipelineId),
    fromStageId: uuid(row.fromStageId), stageId: uuid(row.stageId), priorVersion: version(row.priorVersion), version: version(row.version), movedAt: instant(row.movedAt),
  };
  if (receipt.version !== receipt.priorVersion + 1 || receipt.fromStageId === receipt.stageId) invalid();
  if (expected?.leadId && receipt.leadId !== expected.leadId) invalid();
  if (expected?.stageId && receipt.stageId !== expected.stageId) invalid();
  return receipt;
}

export function validateSaveCrmPipelineStagesInput(value: unknown): SaveCrmPipelineStagesInput {
  const row = record(value, ['expectedVersion', 'moves', 'stages']);
  const stages = list(row.stages, (v): SaveCrmStageItem => {
    const item = record(v, ['color', 'hidden', 'id', 'name']);
    const id = item.id === null ? null : uuid(item.id);
    if (!crmStageNameOk(item.name)) invalid();
    const hidden = bool(item.hidden);
    if (hidden && id === null) invalid();
    return { id, name: item.name, color: color(item.color), hidden };
  }, CRM_STAGE_MAX);
  if (!stages.length || stages.every(s => s.hidden)) invalid();
  const names = stages.map(s => s.name.toLowerCase());
  if (new Set(names).size !== names.length) invalid();
  const ids = stages.flatMap(s => (s.id ? [s.id] : []));
  if (new Set(ids).size !== ids.length) invalid();
  const moves = list(row.moves, (v) => {
    const item = record(v, ['fromStageId', 'toStageId']);
    return { fromStageId: uuid(item.fromStageId), toStageId: uuid(item.toStageId) };
  }, CRM_STAGE_MAX);
  if (new Set(moves.map(m => m.fromStageId)).size !== moves.length) invalid();
  return { expectedVersion: version(row.expectedVersion), stages, moves };
}
export function verifyCrmPipelineStagesReceipt(value: unknown, expected?: { pipelineId?: string }): CrmPipelineStagesReceipt {
  const row = record(value, ['moves', 'organizationId', 'pipelineId', 'priorVersion', 'savedAt', 'schoolId', 'stages', 'version']);
  const receipt: CrmPipelineStagesReceipt = {
    organizationId: uuid(row.organizationId), schoolId: uuid(row.schoolId), pipelineId: uuid(row.pipelineId),
    priorVersion: version(row.priorVersion), version: version(row.version), stages: list(row.stages, stage, 100),
    moves: list(row.moves, (v) => {
      const item = record(v, ['count', 'fromStageId', 'toStageId']);
      return { fromStageId: uuid(item.fromStageId), toStageId: uuid(item.toStageId), count: count(item.count) };
    }, CRM_STAGE_MAX),
    savedAt: instant(row.savedAt),
  };
  if (receipt.version !== receipt.priorVersion + 1) invalid();
  if (expected?.pipelineId && receipt.pipelineId !== expected.pipelineId) invalid();
  return receipt;
}

/**
 * Ready-made martial-arts lead funnels a school adds as extra pipelines with one press. The server owns the stage list;
 * owners rename or recolour afterwards in the stage editor. Each ends with one Won and one Lost stage.
 */
export const CRM_PIPELINE_TEMPLATE_CODES = ['KIDS_PROGRAM', 'ADULT_PROGRAM', 'EVENTS'] as const;
export type CrmPipelineTemplateCode = typeof CRM_PIPELINE_TEMPLATE_CODES[number];
export interface CrmPipelineTemplateStage { readonly name: string; readonly color: CrmStageColor; readonly terminalStatus?: 'WON' | 'LOST' }
export interface CrmPipelineTemplate { readonly code: CrmPipelineTemplateCode; readonly name: string; readonly stages: readonly CrmPipelineTemplateStage[] }
/** The most pipelines one school keeps; past it a template press is refused. */
export const CRM_PIPELINE_MAX = 10;
const stageOf = (name: string, color: CrmStageColor, terminalStatus?: 'WON' | 'LOST'): CrmPipelineTemplateStage =>
  Object.freeze(terminalStatus ? { name, color, terminalStatus } : { name, color });
export const CRM_PIPELINE_TEMPLATES: readonly CrmPipelineTemplate[] = Object.freeze([
  Object.freeze({ code: 'KIDS_PROGRAM' as const, name: 'Kids program', stages: Object.freeze([
    stageOf('New inquiry', 'BLUE'), stageOf('Contacted', 'SKY'), stageOf('Trial booked', 'AMBER'), stageOf('Trial done', 'VIOLET'),
    stageOf('Enrolled', 'GREEN', 'WON'), stageOf('Not now', 'RED', 'LOST')]) }),
  Object.freeze({ code: 'ADULT_PROGRAM' as const, name: 'Adult program', stages: Object.freeze([
    stageOf('New inquiry', 'BLUE'), stageOf('Contacted', 'SKY'), stageOf('Intro class booked', 'AMBER'), stageOf('Intro class done', 'VIOLET'),
    stageOf('Joined', 'GREEN', 'WON'), stageOf('Not now', 'RED', 'LOST')]) }),
  Object.freeze({ code: 'EVENTS' as const, name: 'Birthday parties and events', stages: Object.freeze([
    stageOf('New request', 'BLUE'), stageOf('Date offered', 'SKY'), stageOf('Deposit pending', 'AMBER'),
    stageOf('Booked', 'GREEN', 'WON'), stageOf('Not now', 'RED', 'LOST')]) }),
]);
export function crmPipelineTemplate(code: string): CrmPipelineTemplate | undefined { return CRM_PIPELINE_TEMPLATES.find((t) => t.code === code); }
/** The template command's whole body: exactly one known template code. */
export function validateCrmPipelineTemplateInput(value: unknown): { template: CrmPipelineTemplateCode } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'template') invalid();
  const template = (value as { template: unknown }).template;
  if (typeof template !== 'string' || !crmPipelineTemplate(template)) invalid();
  return { template: template as CrmPipelineTemplateCode };
}
