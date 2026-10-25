import { HON_TURN_STATUSES, type HonConversationReadiness, type HonTurnStatus } from './hon-conversation';

/**
 * Typed shapes and strict verifiers for the PROPOSED HON conversation contract
 * (docs/architecture/HON_COMMAND_EXPERIENCE.md, contract 1). No such endpoint
 * exists yet: nothing here performs a request. A future client must pass every
 * server body through these verifiers before anything is shown.
 */

/** Management specialists HON may delegate to. Kai is a separate Teaching AI with its own future contract. */
export const HON_DELEGATE_KEYS = ['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena'] as const;
export type HonDelegateKey = typeof HON_DELEGATE_KEYS[number];
export const HON_TURN_ROLES = ['HUMAN', 'HON', 'AGENT'] as const;
export type HonTurnRole = typeof HON_TURN_ROLES[number];
export const HON_REFERENCE_KINDS = ['WORK_ITEM', 'ACTION_REQUEST'] as const;
export type HonReferenceKind = typeof HON_REFERENCE_KINDS[number];

export interface HonConversationScope { organizationId: string; schoolId: string }
export interface HonDelegation { agentKey: HonDelegateKey; status: HonTurnStatus; summary: string }
export interface HonReference { kind: HonReferenceKind; id: string }
export interface HonTurn {
  id: string;
  role: HonTurnRole;
  agentKey: HonDelegateKey | null;
  text: string;
  status: HonTurnStatus;
  createdAt: string;
  delegations: HonDelegation[];
  references: HonReference[];
}
export interface HonThreadSummary { id: string; title: string; status: HonTurnStatus; updatedAt: string }
export interface HonThreadPage { items: HonThreadSummary[]; more: boolean }
export interface HonThread { id: string; schoolId: string; title: string; turns: HonTurn[] }
export interface HonTurnReceipt { turnId: string; threadId: string; status: HonTurnStatus; delegatedAgentKeys: HonDelegateKey[]; actionRequestIds: string[]; workItemIds: string[] }

export const HON_MESSAGE_MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/;

function fail(): never { throw new Error('Unverified HON conversation response.'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) fail();
  return record;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value; }
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || [...value].length > max || (!empty && !value.trim()) || CONTROL.test(value)) fail();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail();
  return value as T;
}
/** An unrecognized status string is shown as UNKNOWN, never as success; a non-string is rejected. */
function status(value: unknown): HonTurnStatus {
  if (typeof value !== 'string') fail();
  return (HON_TURN_STATUSES as readonly string[]).includes(value) ? value as HonTurnStatus : 'UNKNOWN';
}
function list<T>(value: unknown, max: number, verify: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(verify);
}

export function verifyHonReadiness(value: unknown): HonConversationReadiness {
  const r = closed(value, ['contract', 'providerRoute', 'entitlement', 'authorization']);
  if ([r.contract, r.providerRoute, r.entitlement, r.authorization].some((flag) => typeof flag !== 'boolean')) fail();
  return { contract: r.contract as boolean, providerRoute: r.providerRoute as boolean, entitlement: r.entitlement as boolean, authorization: r.authorization as boolean };
}

export function verifyHonThreadPage(value: unknown): HonThreadPage {
  const r = closed(value, ['items', 'more']);
  if (typeof r.more !== 'boolean') fail();
  const items = list(r.items, 50, (item) => {
    const t = closed(item, ['id', 'title', 'status', 'updatedAt']);
    return { id: uuid(t.id), title: text(t.title, 120), status: status(t.status), updatedAt: timestamp(t.updatedAt) };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail();
  return { items, more: r.more };
}

function verifyTurn(value: unknown): HonTurn {
  const t = closed(value, ['id', 'role', 'agentKey', 'text', 'status', 'createdAt', 'delegations', 'references']);
  const role = oneOf(t.role, HON_TURN_ROLES);
  const agentKey = t.agentKey === null ? null : oneOf(t.agentKey, HON_DELEGATE_KEYS);
  // Only a specialist turn names a specialist; a human or HON turn never carries one.
  if ((role === 'AGENT') !== (agentKey !== null)) fail();
  const delegations = list(t.delegations, 7, (item) => {
    const d = closed(item, ['agentKey', 'status', 'summary']);
    return { agentKey: oneOf(d.agentKey, HON_DELEGATE_KEYS), status: status(d.status), summary: text(d.summary, 280) };
  });
  if (role === 'HUMAN' && delegations.length) fail();
  const references = list(t.references, 10, (item) => {
    const ref = closed(item, ['kind', 'id']);
    return { kind: oneOf(ref.kind, HON_REFERENCE_KINDS), id: uuid(ref.id) };
  });
  return { id: uuid(t.id), role, agentKey, text: text(t.text, HON_MESSAGE_MAX, role !== 'HUMAN'), status: status(t.status), createdAt: timestamp(t.createdAt), delegations, references };
}

/** The thread must belong to the verified school; anything else is rejected, never shown. */
export function verifyHonThread(value: unknown, expectedSchoolId: string): HonThread {
  const r = closed(value, ['id', 'schoolId', 'title', 'turns']);
  if (uuid(r.schoolId) !== expectedSchoolId) fail();
  const turns = list(r.turns, 200, verifyTurn);
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) fail();
  for (let index = 1; index < turns.length; index += 1) if (Date.parse(turns[index]!.createdAt) < Date.parse(turns[index - 1]!.createdAt)) fail();
  return { id: uuid(r.id), schoolId: expectedSchoolId, title: text(r.title, 120), turns };
}

export function verifyHonTurnReceipt(value: unknown): HonTurnReceipt {
  const r = closed(value, ['turnId', 'threadId', 'status', 'delegatedAgentKeys', 'actionRequestIds', 'workItemIds']);
  return {
    turnId: uuid(r.turnId), threadId: uuid(r.threadId), status: status(r.status),
    delegatedAgentKeys: list(r.delegatedAgentKeys, 7, (key) => oneOf(key, HON_DELEGATE_KEYS)),
    actionRequestIds: list(r.actionRequestIds, 10, uuid), workItemIds: list(r.workItemIds, 10, uuid),
  };
}

/** Typed references open existing authorized workflows only; the id is never trusted as authority. */
export const HON_REFERENCE_DESTINATIONS: Readonly<Record<HonReferenceKind, { label: string; href: string }>> = {
  ACTION_REQUEST: { label: 'Review in Action Center', href: '/staff/action-center/approvals' },
  WORK_ITEM: { label: 'Open the work queue', href: '/staff/work' },
};

/** Human message validation before a send is even offered. */
export function honMessageProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Type a message first.';
  if ([...trimmed].length > HON_MESSAGE_MAX) return `Messages are limited to ${HON_MESSAGE_MAX} characters.`;
  if (CONTROL.test(trimmed)) return 'Remove hidden control characters before sending.';
  return null;
}
