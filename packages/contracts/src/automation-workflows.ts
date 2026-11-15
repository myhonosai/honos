// Automation Builder workflow definitions (AU-1, migration 0416). One definition model for the visual editor and for
// workflows that HON or an AI agent proposes: one trigger, entry rules, exit rules and a step graph, all from closed
// catalogues. validateAutomationDefinition mirrors hon.validate_automation_definition exactly; the database proof runs a
// shared corpus through both. No expressions, code, SQL, URLs or tool calls; text is plain with closed {{merge_fields}}.
// Saving a definition runs nothing: the engine (AU-2) turns workflows on.

export const AUTOMATION_SCHEMA_VERSION = 1;
export const AUTOMATION_CREATE_COMMAND = 'automation.workflow.create';
export const AUTOMATION_SAVE_COMMAND = 'automation.workflow.save';
export const AUTOMATION_RESTORE_COMMAND = 'automation.workflow.restore';
export const AUTOMATION_ARCHIVE_COMMAND = 'automation.workflow.archive';
export const CONTACT_TAG_ADD_COMMAND = 'contact.tag.add';
export const CONTACT_TAG_REMOVE_COMMAND = 'contact.tag.remove';
export const CONTACT_TAG_LOOKUP_COMMAND = 'contact.tag.lookup';
export const AUTOMATION_LIMITS = { workflows: 100, versions: 500, steps: 50, conditions: 10, definitionBytes: 65536 } as const;
export const CONTACT_TAG_LIMITS = { perPerson: 20, perSchool: 200, tagMax: 40, lookupMax: 200 } as const;

export const AUTOMATION_EVENT_TRIGGERS = ['LEAD_CREATED', 'META_LEAD_RECEIVED', 'TRIAL_BOOKED', 'TRIAL_CANCELLED', 'TRIAL_ATTENDED', 'TRIAL_NO_SHOW',
  'CLASS_BOOKING_CREATED', 'EVENT_BOOKING_CREATED', 'EVENT_BOOKING_CANCELLED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_CANCELLED', 'MISSED_CALL',
  'CONVERSATION_MESSAGE_RECEIVED', 'CONVERSATION_ESCALATED', 'TESTING_REGISTRATION_SUBMITTED', 'MEMBERSHIP_ANNIVERSARY', 'MANUAL'] as const;
export const AUTOMATION_TRIGGER_KINDS = [...AUTOMATION_EVENT_TRIGGERS, 'FORM_LEAD_RECEIVED', 'TAG_ADDED', 'CUSTOM_TOOL_RECORD', 'ABSENT_DAYS',
  'MEMBERSHIP_ENDS_IN_DAYS', 'BIRTHDAY', 'SCHEDULE'] as const;
export const AUTOMATION_CONDITION_KINDS = ['LEAD_IS_OPEN', 'IS_ACTIVE_STUDENT', 'TRIAL_BOOKED', 'REPLIED', 'LEAD_STAGE_IS', 'IN_PROGRAM', 'HAS_CONSENT',
  'MEMBERSHIP_ENDS_WITHIN', 'HAS_TAG', 'ATTENDED_AT_LEAST', 'CUSTOM_FIELD_EQUALS'] as const;
export const AUTOMATION_STEP_TYPES = ['SEND_SMS', 'SEND_EMAIL', 'CREATE_TASK', 'NOTIFY_STAFF', 'ASSIGN_LEAD', 'ADD_TAG', 'REMOVE_TAG', 'MOVE_STAGE',
  'START_WORKFLOW', 'WAIT', 'WAIT_FOR', 'IF', 'REQUEST_APPROVAL', 'STOP'] as const;
export const AUTOMATION_REENTRY = ['ONCE_EVER', 'ONCE_PER_PERIOD', 'EVERY_TIME'] as const;
export const AUTOMATION_EXITS = ['TRIAL_BOOKED', 'REPLIED', 'ENROLLED', 'LEAD_CLOSED', 'OPTED_OUT'] as const;
export const AUTOMATION_WAIT_EVENTS = ['TRIAL_BOOKED', 'REPLIED', 'ENROLLED'] as const;
export const AUTOMATION_AI_PURPOSES = ['INTRODUCTION', 'CHECK_IN', 'TRIAL_REMINDER', 'REENGAGEMENT', 'BIRTHDAY', 'RENEWAL', 'THANK_YOU', 'REVIEW_REQUEST', 'OTHER'] as const;
export const AUTOMATION_AUDIENCE_GROUPS = ['ACTIVE_STUDENTS', 'ALL_CONTACTS', 'PROSPECTS', 'TRIAL', 'FORMER_STUDENTS'] as const;
export const AUTOMATION_STAFF_TARGETS = ['SCHOOL_OWNERS', 'LEAD_ASSIGNEE'] as const;
export const AUTOMATION_TOOL_CHANGES = ['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'] as const;
export const AUTOMATION_MERGE_FIELDS = ['first_name', 'school_name', 'program_name', 'trial_time', 'booking_link', 'staff_name'] as const;
export const AUTOMATION_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export const AUTOMATION_SOURCES = ['HUMAN_UI', 'HON_ASSIST', 'AI_AGENT'] as const;

export type AutomationTriggerKind = typeof AUTOMATION_TRIGGER_KINDS[number];
export type AutomationConditionKind = typeof AUTOMATION_CONDITION_KINDS[number];
export type AutomationStepType = typeof AUTOMATION_STEP_TYPES[number];
export type AutomationWorkflowStatus = typeof AUTOMATION_STATUSES[number];
export type AutomationWorkflowSource = typeof AUTOMATION_SOURCES[number];

export interface AutomationWorkflowTrigger { kind: AutomationTriggerKind; config: Record<string, unknown> }
export interface AutomationWorkflowCondition { kind: AutomationConditionKind; negate: boolean; [param: string]: unknown }
export interface AutomationWorkflowStep { id: string; type: AutomationStepType; [field: string]: unknown }
export interface AutomationDefinition {
  schemaVersion: 1;
  trigger: AutomationWorkflowTrigger;
  entry: { reentry: typeof AUTOMATION_REENTRY[number]; reentryDays: number | null; conditions: AutomationWorkflowCondition[] };
  exitWhen: Array<typeof AUTOMATION_EXITS[number]>;
  steps: AutomationWorkflowStep[];
}

export class AutomationDefinitionError extends Error {
  constructor(readonly where: string) { super(`Invalid automation ${where}.`); this.name = 'AutomationDefinitionError'; }
}
function bad(where: string): never { throw new AutomationDefinitionError(where); }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: unknown, ks: readonly string[]): v is Obj => isObj(v) && Object.keys(v).sort().join('\u0000') === [...ks].sort().join('\u0000');
const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const oneOf = (v: unknown, allowed: readonly string[]): v is string => typeof v === 'string' && allowed.includes(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MERGE = new RegExp(`\\{\\{(${AUTOMATION_MERGE_FIELDS.join('|')})\\}\\}`, 'g');
const length = (s: string): number => [...s].length;
/** Plain text the server accepts: trimmed, min..max characters, no control characters except tab and line breaks, and every {{...}} a merge field. */
export function automationTextOk(v: unknown, min: number, max: number, merge = true): v is string {
  if (typeof v !== 'string' || v !== v.trim() || length(v) < min || length(v) > max || CONTROL.test(v)) return false;
  return !/(\{\{|\}\})/.test(merge ? v.replace(MERGE, '') : v);
}
const TAG = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$/;
export const contactTagOk = (v: unknown): v is string => typeof v === 'string' && TAG.test(v);
const TOOL_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const toolKey = (v: unknown): v is string => typeof v === 'string' && TOOL_KEY.test(v);
const localTime = (v: unknown): v is string => typeof v === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function list(v: unknown, min: number, max: number, ok: (e: unknown) => boolean): boolean {
  if (!Array.isArray(v) || v.length < min || v.length > max) return false;
  const seen = new Set(v.map(e => (typeof e === 'string' ? e.toLowerCase() : JSON.stringify(e))));
  return seen.size === v.length && v.every(ok);
}
const optionalText = (v: unknown, max: number, merge: boolean): boolean => v === '' || automationTextOk(v, 1, max, merge);
/** UTF-8 byte length without relying on DOM/Node globals. */
function utf8Bytes(s: string): number { let n = 0; for (const ch of s) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; }
const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;

function conditionOk(c: unknown): boolean {
  if (!isObj(c) || typeof c.kind !== 'string' || typeof c.negate !== 'boolean') return false;
  switch (c.kind) {
    case 'LEAD_IS_OPEN': case 'IS_ACTIVE_STUDENT': case 'TRIAL_BOOKED': case 'REPLIED': return keys(c, ['kind', 'negate']);
    case 'LEAD_STAGE_IS': return keys(c, ['kind', 'negate', 'stageId']) && uuid(c.stageId);
    case 'IN_PROGRAM': return keys(c, ['kind', 'negate', 'programId']) && uuid(c.programId);
    case 'HAS_CONSENT': return keys(c, ['kind', 'negate', 'channel']) && oneOf(c.channel, ['SMS', 'EMAIL']);
    case 'MEMBERSHIP_ENDS_WITHIN': return keys(c, ['kind', 'negate', 'days']) && int(c.days, 1, 365);
    case 'HAS_TAG': return keys(c, ['kind', 'negate', 'tag']) && contactTagOk(c.tag);
    case 'ATTENDED_AT_LEAST': return keys(c, ['kind', 'negate', 'count', 'days']) && int(c.count, 1, 100) && int(c.days, 1, 365);
    case 'CUSTOM_FIELD_EQUALS': return keys(c, ['kind', 'negate', 'toolKey', 'field', 'value']) && toolKey(c.toolKey) && toolKey(c.field) && automationTextOk(c.value, 1, 200, false);
    default: return false;
  }
}

function triggerOk(t: unknown): boolean {
  if (!keys(t, ['kind', 'config']) || typeof t.kind !== 'string' || !isObj(t.config)) return false;
  const c = t.config;
  if ((AUTOMATION_EVENT_TRIGGERS as readonly string[]).includes(t.kind)) return Object.keys(c).length === 0;
  switch (t.kind) {
    case 'FORM_LEAD_RECEIVED': return keys(c, ['formId']) && (c.formId === null || uuid(c.formId));
    case 'TAG_ADDED': return keys(c, ['tag']) && contactTagOk(c.tag);
    case 'CUSTOM_TOOL_RECORD': return keys(c, ['toolKey', 'change']) && toolKey(c.toolKey) && oneOf(c.change, AUTOMATION_TOOL_CHANGES);
    case 'ABSENT_DAYS': return keys(c, ['days']) && int(c.days, 3, 365);
    case 'MEMBERSHIP_ENDS_IN_DAYS': return keys(c, ['days']) && int(c.days, 1, 180);
    case 'BIRTHDAY': return keys(c, ['daysBefore']) && int(c.daysBefore, 0, 30);
    case 'SCHEDULE': {
      if (!keys(c, ['mode', 'date', 'weekdays', 'localTime', 'audience']) || !localTime(c.localTime)) return false;
      const modeOk = c.mode === 'ONCE' ? date(c.date) && c.weekdays === null
        : c.mode === 'WEEKLY' ? c.date === null && list(c.weekdays, 1, 7, e => int(e, 1, 7)) : false;
      const a = c.audience;
      return modeOk && keys(a, ['groups', 'tags', 'rankIds']) && list(a.groups, 1, 5, e => oneOf(e, AUTOMATION_AUDIENCE_GROUPS))
        && list(a.tags, 0, 10, contactTagOk) && list(a.rankIds, 0, 20, uuid);
    }
    default: return false;
  }
}

function contentOk(c: unknown, email: boolean): boolean {
  if (!isObj(c)) return false;
  const bodyMax = email ? 4000 : 1000;
  if (c.mode === 'FIXED') {
    return (email ? keys(c, ['mode', 'subject', 'text']) && automationTextOk(c.subject, 1, 150) : keys(c, ['mode', 'text'])) && automationTextOk(c.text, 1, bodyMax);
  }
  if (c.mode === 'AI') {
    return (email ? keys(c, ['mode', 'purpose', 'guidance', 'fallbackSubject', 'fallbackText']) && automationTextOk(c.fallbackSubject, 1, 150)
      : keys(c, ['mode', 'purpose', 'guidance', 'fallbackText']))
      && oneOf(c.purpose, AUTOMATION_AI_PURPOSES) && optionalText(c.guidance, 500, false) && automationTextOk(c.fallbackText, 1, bodyMax);
  }
  return false;
}

/** The outgoing links of one step, or null when its shape is wrong. */
function stepEdges(s: unknown): string[] | null {
  if (!isObj(s) || typeof s.type !== 'string') return null;
  let ok: boolean;
  switch (s.type) {
    case 'SEND_SMS': ok = keys(s, ['id', 'type', 'content', 'next']) && contentOk(s.content, false); break;
    case 'SEND_EMAIL': ok = keys(s, ['id', 'type', 'content', 'next']) && contentOk(s.content, true); break;
    case 'CREATE_TASK': ok = keys(s, ['id', 'type', 'title', 'details', 'dueInHours', 'assignTo', 'next']) && automationTextOk(s.title, 1, 120)
      && optionalText(s.details, 1000, true) && int(s.dueInHours, 0, 720) && oneOf(s.assignTo, AUTOMATION_STAFF_TARGETS); break;
    case 'NOTIFY_STAFF': ok = keys(s, ['id', 'type', 'to', 'text', 'next']) && oneOf(s.to, AUTOMATION_STAFF_TARGETS) && automationTextOk(s.text, 1, 500); break;
    case 'ASSIGN_LEAD': ok = keys(s, ['id', 'type', 'staffPrincipalId', 'next']) && uuid(s.staffPrincipalId); break;
    case 'ADD_TAG': case 'REMOVE_TAG': ok = keys(s, ['id', 'type', 'tag', 'next']) && contactTagOk(s.tag); break;
    case 'MOVE_STAGE': ok = keys(s, ['id', 'type', 'stageId', 'next']) && uuid(s.stageId); break;
    case 'START_WORKFLOW': ok = keys(s, ['id', 'type', 'workflowId', 'next']) && uuid(s.workflowId); break;
    case 'WAIT': ok = keys(s, ['id', 'type', 'minutes', 'localTime', 'next'])
      && ((int(s.minutes, 1, 525600) && s.localTime === null) || (s.minutes === null && localTime(s.localTime))); break;
    case 'WAIT_FOR': ok = keys(s, ['id', 'type', 'event', 'timeoutMinutes', 'yes', 'no']) && oneOf(s.event, AUTOMATION_WAIT_EVENTS) && int(s.timeoutMinutes, 1, 43200); break;
    case 'IF': ok = keys(s, ['id', 'type', 'condition', 'yes', 'no']) && conditionOk(s.condition); break;
    case 'REQUEST_APPROVAL': ok = keys(s, ['id', 'type', 'question', 'yes', 'no']) && automationTextOk(s.question, 1, 300); break;
    case 'STOP': ok = keys(s, ['id', 'type']); break;
    default: return null;
  }
  if (!ok) return null;
  const edges = s.type === 'STOP' ? [] : ['WAIT_FOR', 'IF', 'REQUEST_APPROVAL'].includes(s.type) ? [s.yes, s.no] : [s.next];
  if (edges.some(e => e !== null && (typeof e !== 'string' || !STEP_ID.test(e)))) return null;
  return edges.filter((e): e is string => e !== null);
}

/** Throws AutomationDefinitionError unless v is a complete schema-version-1 definition (same rules as the database). */
export function validateAutomationDefinition(v: unknown): AutomationDefinition {
  if (!keys(v, ['schemaVersion', 'trigger', 'entry', 'exitWhen', 'steps']) || v.schemaVersion !== 1
    || utf8Bytes(JSON.stringify(v)) > AUTOMATION_LIMITS.definitionBytes) bad('definition');
  if (!triggerOk(v.trigger)) bad('trigger');
  const e = v.entry;
  if (!keys(e, ['reentry', 'reentryDays', 'conditions'])
    || !(e.reentry === 'ONCE_PER_PERIOD' ? int(e.reentryDays, 1, 365) : (e.reentry === 'ONCE_EVER' || e.reentry === 'EVERY_TIME') && e.reentryDays === null)
    || !Array.isArray(e.conditions) || e.conditions.length > AUTOMATION_LIMITS.conditions || !e.conditions.every(conditionOk)) bad('entry');
  if (!list(v.exitWhen, 0, 5, x => oneOf(x, AUTOMATION_EXITS))) bad('exitWhen');
  const steps = v.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > AUTOMATION_LIMITS.steps) bad('steps');
  const ids: string[] = [];
  for (const s of steps) {
    const id = isObj(s) ? s.id : undefined;
    if (typeof id !== 'string' || !STEP_ID.test(id) || ids.includes(id)) bad('step id');
    ids.push(id);
  }
  const indeg = new Map<string, number>(), adj = new Map<string, string[]>();
  for (const s of steps as Obj[]) {
    const id = s.id as string, edges = stepEdges(s);
    if (!edges) bad('step ' + id);
    for (const t of edges) {
      if (!ids.includes(t) || t === id) bad('step ' + id + ' link');
      indeg.set(t, (indeg.get(t) ?? 0) + 1);
    }
    adj.set(id, edges);
  }
  if ((indeg.get(ids[0]!) ?? 0) !== 0) bad('first step is linked to');
  for (const id of ids.slice(1)) if ((indeg.get(id) ?? 0) === 0) bad('step ' + id + ' is never reached');
  const queue = [ids[0]!]; let seen = 0;
  while (queue.length) {
    const cur = queue.shift()!; seen += 1;
    for (const t of adj.get(cur)!) { indeg.set(t, indeg.get(t)! - 1); if (indeg.get(t) === 0) queue.push(t); }
  }
  if (seen !== ids.length) bad('steps loop');
  return v as unknown as AutomationDefinition;
}

export function automationNameOk(v: unknown): v is string {
  return automationTextOk(v, 1, 100, false) && !/[\t\n\r​-‏‪-‮⁠-⁯﻿]/.test(v);
}
function name(v: unknown): string { if (!automationNameOk(v)) bad('name'); return v; }

export interface AutomationCreateInput { name: string; definition: AutomationDefinition }
export interface AutomationSaveInput { expectedRevision: number; name: string; definition: AutomationDefinition }
export interface AutomationRestoreInput { expectedRevision: number; fromVersion: number }
export interface AutomationArchiveInput { expectedRevision: number }
const revision = (v: unknown): number => { if (!int(v, 1, 999999999)) bad('expectedRevision'); return v; };
export function validateAutomationCreateInput(v: unknown): AutomationCreateInput {
  if (!keys(v, ['name', 'definition'])) bad('input');
  return { name: name(v.name), definition: validateAutomationDefinition(v.definition) };
}
export function validateAutomationSaveInput(v: unknown): AutomationSaveInput {
  if (!keys(v, ['expectedRevision', 'name', 'definition'])) bad('input');
  return { expectedRevision: revision(v.expectedRevision), name: name(v.name), definition: validateAutomationDefinition(v.definition) };
}
export function validateAutomationRestoreInput(v: unknown): AutomationRestoreInput {
  if (!keys(v, ['expectedRevision', 'fromVersion']) || !int(v.fromVersion, 1, 500)) bad('input');
  return { expectedRevision: revision(v.expectedRevision), fromVersion: v.fromVersion };
}
export function validateAutomationArchiveInput(v: unknown): AutomationArchiveInput {
  if (!keys(v, ['expectedRevision'])) bad('input');
  return { expectedRevision: revision(v.expectedRevision) };
}

// ---- Responses ----------------------------------------------------------------------------------------------------
export interface AutomationWorkflowSummary {
  workflowId: string; name: string; status: AutomationWorkflowStatus; revision: number; latestVersion: number; activeVersion: number | null;
  triggerKind: AutomationTriggerKind; pausedReason: string | null; stepCount: number; activatedAt: string | null; createdAt: string; updatedAt: string;
}
export interface AutomationVersion {
  workflowId: string; version: number; name: string; source: AutomationWorkflowSource; restoredFromVersion: number | null;
  definition: AutomationDefinition; recordedAt: string; author: string;
}
export interface AutomationVersionEntry { version: number; name: string; source: AutomationWorkflowSource; restoredFromVersion: number | null; recordedAt: string }
export interface AutomationWorkflowDetail { workflow: AutomationWorkflowSummary; latest: AutomationVersion; versions: AutomationVersionEntry[] }
export interface AutomationWorkflowList { workflows: AutomationWorkflowSummary[]; limits: { workflows: number; versions: number; steps: number }; checkedAt: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
function unverified(what: string): never { throw new Error(`Unverified automation ${what}.`); }
function rec(v: unknown, ks: readonly string[], what: string): Obj { if (!keys(v, ks)) unverified(what); return v; }
function iso(v: unknown, what: string, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v))) unverified(what);
  return v;
}
function vuuid(v: unknown, what: string): string { if (typeof v !== 'string' || !UUID.test(v.toLowerCase())) unverified(what); return v; }
function vint(v: unknown, min: number, max: number, what: string, nullable = false): number | null {
  if (v === null && nullable) return null;
  if (!int(v, min, max)) unverified(what);
  return v;
}

export function verifyAutomationWorkflowSummary(v: unknown): AutomationWorkflowSummary {
  const o = rec(v, ['workflowId', 'name', 'status', 'revision', 'latestVersion', 'activeVersion', 'triggerKind', 'pausedReason', 'stepCount', 'activatedAt', 'createdAt', 'updatedAt'], 'workflow');
  if (!automationNameOk(o.name) || !oneOf(o.status, AUTOMATION_STATUSES) || !oneOf(o.triggerKind, AUTOMATION_TRIGGER_KINDS)
    || !(o.pausedReason === null || (typeof o.pausedReason === 'string' && /^[A-Z_]{1,40}$/.test(o.pausedReason)))) unverified('workflow');
  const latest = vint(o.latestVersion, 1, 500, 'workflow')!, active = vint(o.activeVersion, 1, 500, 'workflow', true);
  if (active !== null && active > latest) unverified('workflow');
  return { workflowId: vuuid(o.workflowId, 'workflow'), name: o.name, status: o.status as AutomationWorkflowStatus, revision: vint(o.revision, 1, 999999999, 'workflow')!,
    latestVersion: latest, activeVersion: active, triggerKind: o.triggerKind as AutomationTriggerKind, pausedReason: o.pausedReason as string | null,
    stepCount: vint(o.stepCount, 1, AUTOMATION_LIMITS.steps, 'workflow')!, activatedAt: iso(o.activatedAt, 'workflow', true),
    createdAt: iso(o.createdAt, 'workflow')!, updatedAt: iso(o.updatedAt, 'workflow')! };
}
function versionEntry(v: unknown): AutomationVersionEntry {
  const o = rec(v, ['version', 'name', 'source', 'restoredFromVersion', 'recordedAt'], 'version');
  if (!automationNameOk(o.name) || !oneOf(o.source, AUTOMATION_SOURCES)) unverified('version');
  return { version: vint(o.version, 1, 500, 'version')!, name: o.name, source: o.source as AutomationWorkflowSource,
    restoredFromVersion: vint(o.restoredFromVersion, 1, 499, 'version', true), recordedAt: iso(o.recordedAt, 'version')! };
}
export function verifyAutomationVersion(v: unknown): AutomationVersion {
  const o = rec(v, ['workflowId', 'version', 'name', 'source', 'restoredFromVersion', 'definition', 'recordedAt', 'author'], 'version');
  const entry = versionEntry({ version: o.version, name: o.name, source: o.source, restoredFromVersion: o.restoredFromVersion, recordedAt: o.recordedAt });
  if (typeof o.author !== 'string' || o.author.length < 1 || o.author.length > 120) unverified('version');
  let definition: AutomationDefinition;
  try { definition = validateAutomationDefinition(o.definition); } catch { unverified('version'); }
  return { workflowId: vuuid(o.workflowId, 'version'), ...entry, definition, author: o.author };
}
export function verifyAutomationWorkflowDetail(v: unknown): AutomationWorkflowDetail {
  const o = rec(v, ['workflow', 'latest', 'versions'], 'detail');
  const workflow = verifyAutomationWorkflowSummary(o.workflow), latest = verifyAutomationVersion(o.latest);
  if (!Array.isArray(o.versions) || o.versions.length < 1 || o.versions.length > AUTOMATION_LIMITS.versions) unverified('detail');
  const versions = o.versions.map(versionEntry);
  if (latest.workflowId !== workflow.workflowId || latest.version !== workflow.latestVersion || versions[0]!.version !== workflow.latestVersion
    || versions.some((x, i) => i > 0 && x.version >= versions[i - 1]!.version) || latest.definition.trigger.kind !== workflow.triggerKind
    || latest.definition.steps.length !== workflow.stepCount || latest.name !== workflow.name) unverified('detail');
  return { workflow, latest, versions };
}
export function verifyAutomationWorkflowList(v: unknown): AutomationWorkflowList {
  const o = rec(v, ['workflows', 'limits', 'checkedAt'], 'list');
  const l = rec(o.limits, ['workflows', 'versions', 'steps'], 'list');
  if (l.workflows !== AUTOMATION_LIMITS.workflows || l.versions !== AUTOMATION_LIMITS.versions || l.steps !== AUTOMATION_LIMITS.steps
    || !Array.isArray(o.workflows) || o.workflows.length > 200) unverified('list');
  return { workflows: o.workflows.map(verifyAutomationWorkflowSummary), limits: { workflows: 100, versions: 500, steps: 50 }, checkedAt: iso(o.checkedAt, 'list')! };
}

// ---- Contact tags -------------------------------------------------------------------------------------------------
export interface ContactTagInput { tag: string }
export interface ContactTagLookupInput { personIds: string[] }
export interface PersonContactTag { tag: string; tagKey: string; addedSource: 'HUMAN_UI' | 'AUTOMATION'; addedAt: string }
export interface PersonContactTags { personId: string; tags: PersonContactTag[] }
export interface ContactTagChange extends PersonContactTags { changed: boolean }
export interface SchoolContactTags { tags: Array<{ tag: string; tagKey: string; count: number }>; limits: { perPerson: number; perSchool: number; tagMax: number }; checkedAt: string }
export interface ContactTagLookup { people: Array<{ personId: string; tags: string[] }> }

export function validateContactTagInput(v: unknown): ContactTagInput {
  if (!keys(v, ['tag']) || !contactTagOk(v.tag)) bad('tag');
  return { tag: v.tag };
}
export function validateContactTagLookupInput(v: unknown): ContactTagLookupInput {
  if (!keys(v, ['personIds']) || !list(v.personIds, 1, CONTACT_TAG_LIMITS.lookupMax, uuid)) bad('personIds');
  return { personIds: v.personIds as string[] };
}
function personTag(v: unknown): PersonContactTag {
  const o = rec(v, ['tag', 'tagKey', 'addedSource', 'addedAt'], 'tag');
  if (!contactTagOk(o.tag) || o.tagKey !== o.tag.toLowerCase() || !oneOf(o.addedSource, ['HUMAN_UI', 'AUTOMATION'])) unverified('tag');
  return { tag: o.tag, tagKey: o.tagKey, addedSource: o.addedSource as PersonContactTag['addedSource'], addedAt: iso(o.addedAt, 'tag')! };
}
export function verifyPersonContactTags(v: unknown): PersonContactTags {
  const o = rec(v, ['personId', 'tags'], 'person tags');
  if (!Array.isArray(o.tags) || o.tags.length > CONTACT_TAG_LIMITS.perPerson) unverified('person tags');
  return { personId: vuuid(o.personId, 'person tags'), tags: o.tags.map(personTag) };
}
export function verifyContactTagChange(v: unknown): ContactTagChange {
  const o = rec(v, ['personId', 'tags', 'changed'], 'tag change');
  if (typeof o.changed !== 'boolean') unverified('tag change');
  return { ...verifyPersonContactTags({ personId: o.personId, tags: o.tags }), changed: o.changed };
}
export function verifySchoolContactTags(v: unknown): SchoolContactTags {
  const o = rec(v, ['tags', 'limits', 'checkedAt'], 'school tags');
  const l = rec(o.limits, ['perPerson', 'perSchool', 'tagMax'], 'school tags');
  if (l.perPerson !== 20 || l.perSchool !== 200 || l.tagMax !== 40 || !Array.isArray(o.tags) || o.tags.length > CONTACT_TAG_LIMITS.perSchool) unverified('school tags');
  return { tags: o.tags.map(t => { const x = rec(t, ['tag', 'tagKey', 'count'], 'school tags');
    if (!contactTagOk(x.tag) || x.tagKey !== x.tag.toLowerCase()) unverified('school tags');
    return { tag: x.tag, tagKey: x.tagKey, count: vint(x.count, 1, 2147483647, 'school tags')! }; }),
    limits: { perPerson: 20, perSchool: 200, tagMax: 40 }, checkedAt: iso(o.checkedAt, 'school tags')! };
}
export function verifyContactTagLookup(v: unknown): ContactTagLookup {
  const o = rec(v, ['people'], 'tag lookup');
  if (!Array.isArray(o.people) || o.people.length > CONTACT_TAG_LIMITS.lookupMax) unverified('tag lookup');
  return { people: o.people.map(p => { const x = rec(p, ['personId', 'tags'], 'tag lookup');
    if (!Array.isArray(x.tags) || x.tags.length > 20 || !x.tags.every(contactTagOk)) unverified('tag lookup');
    return { personId: vuuid(x.personId, 'tag lookup'), tags: x.tags as string[] }; }) };
}

// ---- Engine (AU-2, 0368): turn on, pause, run history ---------------------------------------------------------------
export const AUTOMATION_ACTIVATE_COMMAND = 'automation.workflow.activate';
export const AUTOMATION_PAUSE_COMMAND = 'automation.workflow.pause';
export const AUTOMATION_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'EXITED', 'STOPPED', 'FAILED', 'CANCELLED'] as const;
export const AUTOMATION_STEP_STATUSES = ['PENDING', 'WAITING', 'DONE', 'SKIPPED', 'FAILED'] as const;
export const AUTOMATION_DELIVERY_STATUSES = ['PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'SUPPRESSED', 'FAILED', 'UNKNOWN', 'BOUNCED'] as const;
export type AutomationRunStatus = typeof AUTOMATION_RUN_STATUSES[number];
export type AutomationStepStatus = typeof AUTOMATION_STEP_STATUSES[number];

export interface AutomationActivateInput { expectedRevision: number; version: number }
export function validateAutomationActivateInput(v: unknown): AutomationActivateInput {
  if (!keys(v, ['expectedRevision', 'version']) || !int(v.version, 1, 500)) bad('input');
  return { expectedRevision: revision(v.expectedRevision), version: v.version };
}
export const validateAutomationPauseInput = validateAutomationArchiveInput;

export interface AutomationRun {
  runId: string; workflowId: string; workflowVersion: number; personId: string; contactFirstName: string | null; status: AutomationRunStatus;
  endCode: string | null; depth: number; parentRunId: string | null; startedAt: string; endedAt: string | null;
}
export interface AutomationRunStep {
  stepId: string; type: AutomationStepType; status: AutomationStepStatus; outcome: string | null; branch: 'YES' | 'NO' | null;
  messageId: string | null; deliveryStatus: string | null; workItemId: string | null; startedRunId: string | null;
  dueAt: string; createdAt: string; finishedAt: string | null;
}
export interface AutomationRunList { workflowId: string; runs: AutomationRun[]; counts: { running: number; completed: number; exited: number; failed: number }; checkedAt: string }
export interface AutomationRunDetail { run: AutomationRun; steps: AutomationRunStep[]; checkedAt: string }

const CODE = /^[A-Z_]{1,40}$/;
const code = (v: unknown, what: string): string | null => { if (v === null) return null; if (typeof v !== 'string' || !CODE.test(v)) unverified(what); return v; };
const nuuid = (v: unknown, what: string): string | null => (v === null ? null : vuuid(v, what));
export function verifyAutomationRun(v: unknown): AutomationRun {
  const o = rec(v, ['runId', 'workflowId', 'workflowVersion', 'personId', 'contactFirstName', 'status', 'endCode', 'depth', 'parentRunId', 'startedAt', 'endedAt'], 'run');
  if (!oneOf(o.status, AUTOMATION_RUN_STATUSES) || !(o.contactFirstName === null || (typeof o.contactFirstName === 'string' && o.contactFirstName.length <= 60))) unverified('run');
  const depth = vint(o.depth, 0, 3, 'run')!, parent = nuuid(o.parentRunId, 'run'), ended = iso(o.endedAt, 'run', true), endCode = code(o.endCode, 'run');
  if ((depth === 0) !== (parent === null) || (o.status === 'RUNNING') !== (ended === null) || (['RUNNING', 'COMPLETED'].includes(o.status as string)) !== (endCode === null)) unverified('run');
  return { runId: vuuid(o.runId, 'run'), workflowId: vuuid(o.workflowId, 'run'), workflowVersion: vint(o.workflowVersion, 1, 500, 'run')!, personId: vuuid(o.personId, 'run'),
    contactFirstName: o.contactFirstName as string | null, status: o.status as AutomationRunStatus, endCode, depth, parentRunId: parent,
    startedAt: iso(o.startedAt, 'run')!, endedAt: ended };
}
function runStep(v: unknown): AutomationRunStep {
  const o = rec(v, ['stepId', 'type', 'status', 'outcome', 'branch', 'messageId', 'deliveryStatus', 'workItemId', 'startedRunId', 'dueAt', 'createdAt', 'finishedAt'], 'run step');
  if (typeof o.stepId !== 'string' || !STEP_ID.test(o.stepId) || !oneOf(o.type, AUTOMATION_STEP_TYPES) || !oneOf(o.status, AUTOMATION_STEP_STATUSES)
    || !(o.branch === null || oneOf(o.branch, ['YES', 'NO'])) || !(o.deliveryStatus === null || oneOf(o.deliveryStatus, AUTOMATION_DELIVERY_STATUSES))) unverified('run step');
  const finished = iso(o.finishedAt, 'run step', true), outcome = code(o.outcome, 'run step');
  if ((['PENDING', 'WAITING'].includes(o.status as string)) !== (finished === null) || (finished === null) !== (outcome === null)) unverified('run step');
  return { stepId: o.stepId, type: o.type as AutomationStepType, status: o.status as AutomationStepStatus, outcome, branch: o.branch as 'YES' | 'NO' | null,
    messageId: nuuid(o.messageId, 'run step'), deliveryStatus: o.deliveryStatus as string | null, workItemId: nuuid(o.workItemId, 'run step'),
    startedRunId: nuuid(o.startedRunId, 'run step'), dueAt: iso(o.dueAt, 'run step')!, createdAt: iso(o.createdAt, 'run step')!, finishedAt: finished };
}
export function verifyAutomationRunList(v: unknown): AutomationRunList {
  const o = rec(v, ['workflowId', 'runs', 'counts', 'checkedAt'], 'runs');
  const c = rec(o.counts, ['running', 'completed', 'exited', 'failed'], 'runs');
  if (!Array.isArray(o.runs) || o.runs.length > 100) unverified('runs');
  const workflowId = vuuid(o.workflowId, 'runs'), runs = o.runs.map(verifyAutomationRun);
  if (runs.some(r => r.workflowId.toLowerCase() !== workflowId.toLowerCase())) unverified('runs');
  const n = (x: unknown) => vint(x, 0, 2147483647, 'runs')!;
  return { workflowId, runs, counts: { running: n(c.running), completed: n(c.completed), exited: n(c.exited), failed: n(c.failed) }, checkedAt: iso(o.checkedAt, 'runs')! };
}
export function verifyAutomationRunDetail(v: unknown): AutomationRunDetail {
  const o = rec(v, ['run', 'steps', 'checkedAt'], 'run detail');
  if (!Array.isArray(o.steps) || o.steps.length > AUTOMATION_LIMITS.steps) unverified('run detail');
  return { run: verifyAutomationRun(o.run), steps: o.steps.map(runStep), checkedAt: iso(o.checkedAt, 'run detail')! };
}
