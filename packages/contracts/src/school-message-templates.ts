/**
 * School message templates (0586, Texts and Email pages piece TE2; docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md §3).
 * The Templates tab of the Texts and Email pages: saved texts and emails staff pick to fill the composer. Reading needs
 * communication.template.read; adding, changing, archiving and restoring need communication.template.manage. A template is
 * text only: sending still goes through the 0047 queue and the 0243 worker.
 */
export const SCHOOL_TEMPLATE_CHANNELS = ['SMS', 'EMAIL'] as const;
export type SchoolTemplateChannel = (typeof SCHOOL_TEMPLATE_CHANNELS)[number];
export const SCHOOL_TEMPLATE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type SchoolTemplateStatus = (typeof SCHOOL_TEMPLATE_STATUSES)[number];
export const SCHOOL_TEMPLATE_LIMITS = { name: 80, subject: 150, smsBody: 1000, emailBody: 3500, list: 500 } as const;
/** The closed merge-tag list (the blasts list, BL1). */
export const SCHOOL_TEMPLATE_MERGE_TAGS = ['first_name', 'last_name', 'school_name', 'staff_name'] as const;

/** Same-origin browser command names (the X-HON-Human-Command header). */
export const SCHOOL_TEMPLATES_READ_COMMAND = 'school.messages.templates.read';
export const SCHOOL_TEMPLATE_SAVE_COMMAND = 'school.messages.template.save';
export const SCHOOL_TEMPLATE_STATUS_COMMAND = 'school.messages.template.status';

export interface SchoolTemplate {
  templateId: string; channel: SchoolTemplateChannel; name: string; subject: string | null; body: string;
  status: SchoolTemplateStatus; version: number; createdAt: string; updatedAt: string;
}
export interface SchoolTemplateList { templates: SchoolTemplate[] }
export interface SchoolTemplatesQuery { channel?: SchoolTemplateChannel; status?: SchoolTemplateStatus }
export interface SaveSchoolTemplateInput {
  templateId: string | null; expectedVersion: number; channel: SchoolTemplateChannel; name: string; subject: string | null; body: string;
}
export interface SetSchoolTemplateStatusInput { templateId: string; expectedVersion: number; status: SchoolTemplateStatus }
export interface SchoolTemplateReceipt { template: SchoolTemplate; replayed: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LINE_REFUSED = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/;
const BODY_REFUSED = /[\u0000-\u0009\u000b-\u001f\u007f‎‏‪-‮⁦-⁩﻿]/;
const TAG = /\{\{([^{}]*)\}\}/g;

/** Characters as the database counts them (code points, so an emoji is one). */
const size = (text: string): number => [...text].length;
function invalid(): never { throw new Error('Invalid school message template data.'); }
function record(value: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key)) || (!optional && keys.some(key => !(key in row)))) invalid();
  return row;
}
function oneOf<T extends string>(value: unknown, list: readonly T[]): T {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) invalid();
  return value as T;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function instant(value: unknown): string { if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) invalid(); return value; }
function version(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 999_999_999) invalid();
  return value;
}

/** The written tags outside the closed list, as written (the editor refuses to save while any are left). */
export function schoolTemplateUnknownTags(text: string): string[] {
  return [...text.matchAll(TAG)].filter(m => !(SCHOOL_TEMPLATE_MERGE_TAGS as readonly string[]).includes(m[1]!.replace(/^[ \t\n]+|[ \t\n]+$/g, ''))).map(m => m[0]);
}
export function schoolTemplateLineOk(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && size(value) <= max && value.trim() === value && !LINE_REFUSED.test(value)
    && schoolTemplateUnknownTags(value).length === 0;
}
export function schoolTemplateBodyMax(channel: SchoolTemplateChannel): number {
  return channel === 'SMS' ? SCHOOL_TEMPLATE_LIMITS.smsBody : SCHOOL_TEMPLATE_LIMITS.emailBody;
}
export function schoolTemplateBodyOk(value: unknown, channel: SchoolTemplateChannel): value is string {
  return typeof value === 'string' && value.length >= 1 && size(value) <= schoolTemplateBodyMax(channel) && value.replace(/[ \n]/g, '') !== ''
    && !BODY_REFUSED.test(value) && schoolTemplateUnknownTags(value).length === 0;
}

export function validateSchoolTemplatesQuery(value: unknown): SchoolTemplatesQuery {
  const row = record(value, ['channel', 'status'], true);
  const out: SchoolTemplatesQuery = {};
  if ('channel' in row) out.channel = oneOf(row.channel, SCHOOL_TEMPLATE_CHANNELS);
  if ('status' in row) out.status = oneOf(row.status, SCHOOL_TEMPLATE_STATUSES);
  return out;
}
export function validateSaveSchoolTemplateInput(value: unknown): SaveSchoolTemplateInput {
  const row = record(value, ['templateId', 'expectedVersion', 'channel', 'name', 'subject', 'body']);
  const templateId = row.templateId === null ? null : uuid(row.templateId);
  const expectedVersion = version(row.expectedVersion, 0);
  if ((templateId === null) !== (expectedVersion === 0)) invalid();
  const channel = oneOf(row.channel, SCHOOL_TEMPLATE_CHANNELS);
  if (!schoolTemplateLineOk(row.name, SCHOOL_TEMPLATE_LIMITS.name) || !schoolTemplateBodyOk(row.body, channel)) invalid();
  if (channel === 'SMS' ? row.subject !== null : !schoolTemplateLineOk(row.subject, SCHOOL_TEMPLATE_LIMITS.subject)) invalid();
  return { templateId, expectedVersion, channel, name: row.name, subject: row.subject as string | null, body: row.body };
}
export function validateSetSchoolTemplateStatusInput(value: unknown): SetSchoolTemplateStatusInput {
  const row = record(value, ['templateId', 'expectedVersion', 'status']);
  return { templateId: uuid(row.templateId), expectedVersion: version(row.expectedVersion, 1), status: oneOf(row.status, SCHOOL_TEMPLATE_STATUSES) };
}

export function verifySchoolTemplate(value: unknown): SchoolTemplate {
  const row = record(value, ['templateId', 'channel', 'name', 'subject', 'body', 'status', 'version', 'createdAt', 'updatedAt']);
  const channel = oneOf(row.channel, SCHOOL_TEMPLATE_CHANNELS);
  if (!schoolTemplateLineOk(row.name, SCHOOL_TEMPLATE_LIMITS.name) || !schoolTemplateBodyOk(row.body, channel)) invalid();
  if (channel === 'SMS' ? row.subject !== null : !schoolTemplateLineOk(row.subject, SCHOOL_TEMPLATE_LIMITS.subject)) invalid();
  const createdAt = instant(row.createdAt), updatedAt = instant(row.updatedAt);
  if (updatedAt < createdAt) invalid();
  return { templateId: uuid(row.templateId), channel, name: row.name, subject: row.subject as string | null, body: row.body,
    status: oneOf(row.status, SCHOOL_TEMPLATE_STATUSES), version: version(row.version, 1), createdAt, updatedAt };
}
/** A list answer: no duplicates, sorted by name (case-insensitive), every row matching the asked channel and status. */
export function verifySchoolTemplateList(value: unknown, query: SchoolTemplatesQuery = {}): SchoolTemplateList {
  const row = record(value, ['templates']);
  if (!Array.isArray(row.templates) || row.templates.length > SCHOOL_TEMPLATE_LIMITS.list) invalid();
  const templates = row.templates.map(verifySchoolTemplate);
  if (new Set(templates.map(t => t.templateId)).size !== templates.length) invalid();
  const status = query.status ?? 'ACTIVE';
  if (templates.some(t => t.status !== status || (query.channel && t.channel !== query.channel))) invalid();
  return { templates };
}
/** A command answer for the exact asked template: the next version, the asked channel or status. */
export function verifySchoolTemplateReceipt(value: unknown, expect: { version: number; templateId?: string | null; channel?: SchoolTemplateChannel; status?: SchoolTemplateStatus }): SchoolTemplateReceipt {
  const row = record(value, ['template', 'replayed']);
  if (typeof row.replayed !== 'boolean') invalid();
  const template = verifySchoolTemplate(row.template);
  if (template.version !== expect.version || (expect.templateId && template.templateId !== expect.templateId)
    || (expect.channel && template.channel !== expect.channel) || (expect.status && template.status !== expect.status)) invalid();
  return { template, replayed: row.replayed };
}
