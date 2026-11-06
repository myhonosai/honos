import { FOLLOW_UP_DRAFT_PURPOSES, HON_TURN_TEXT_LIMITS, type FollowUpDraftPurpose, type HonDelegateAgentKey, type HonDelegation } from '@hon/contracts';
import { campaignRequest } from '../campaign-workbench';
import { loadCrmLeads } from '../crm-leads-http';
import type { HonSchool } from './hon-conversation-http';

/**
 * Targets a HON delegation can name. Every list is an existing server read that applies its own permission for the signed-in
 * person; a target here is only a selector and the HON delegation command re-checks it. Nothing is typed by hand.
 */
export type HonDelegationTarget = Readonly<{ id: string; label: string; version: number | null }>;
export type HonDelegateChoice = 'hon' | HonDelegateAgentKey;
export const HON_DELEGATE_PRESENTATION: Readonly<Record<HonDelegateAgentKey, { name: string; task: string; pick: string; empty: string }>> = {
  marcus: { name: 'Marcus', task: 'Marketing draft for a campaign', pick: 'Campaign', empty: 'No active campaign plans yet. Create one in Marketing first.' },
  chad: { name: 'Chad', task: 'Follow-up draft for a lead', pick: 'Lead', empty: 'No open leads right now.' },
  claire: { name: 'Kai', task: 'Teaching notes for a curriculum', pick: 'Curriculum', empty: 'No curriculum is available to pick yet.' },
};
export const FOLLOW_UP_PURPOSE_LABEL: Readonly<Record<FollowUpDraftPurpose, string>> = {
  INTRODUCTION: 'Introduction', CHECK_IN: 'Check-in', TRIAL_REMINDER: 'Trial reminder', REENGAGEMENT: 'Re-engagement',
};
export const HON_FOLLOW_UP_PURPOSES = FOLLOW_UP_DRAFT_PURPOSES;
export const delegateTextLimit = (choice: HonDelegateChoice, questionLimit: number) => choice === 'hon' ? questionLimit : HON_TURN_TEXT_LIMITS[choice];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Builds the exact delegation the contract accepts, or null when the selection is incomplete. */
export function honDelegation(choice: HonDelegateChoice, target: HonDelegationTarget | null, purpose: FollowUpDraftPurpose): HonDelegation | null {
  if (choice === 'hon' || !target || !UUID.test(target.id)) return null;
  if (choice === 'marcus') return { agentKey: 'marcus', campaignId: target.id.toLowerCase() };
  if (choice === 'claire') return { agentKey: 'claire', curriculumId: target.id.toLowerCase() };
  if (target.version === null || !Number.isSafeInteger(target.version) || target.version < 1) return null;
  return { agentKey: 'chad', leadId: target.id.toLowerCase(), expectedLeadVersion: target.version, purpose };
}

export interface HonDelegationTargetsApi {
  /** null: no server read exists for this specialist yet, so nothing can be picked. */
  load(school: HonSchool, agent: HonDelegateAgentKey, signal: AbortSignal): Promise<HonDelegationTarget[] | null>;
}

type CampaignRow = { id?: unknown; name?: unknown; status?: unknown; version?: unknown };
export function campaignTargets(value: unknown): HonDelegationTarget[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Campaign list could not be verified.');
  return (value as CampaignRow[]).filter((row) => row && row.status !== 'ARCHIVED').map((row) => {
    if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 200
      || !Number.isSafeInteger(row.version)) throw new Error('Campaign list could not be verified.');
    return { id: row.id, label: row.name, version: null };
  });
}

export const HON_DELEGATION_TARGETS: HonDelegationTargetsApi = {
  async load(school, agent, signal) {
    if (agent === 'marcus') return campaignTargets(await campaignRequest<unknown>('/api/v1/marketing/campaigns'));
    if (agent === 'chad') return (await loadCrmLeads(school.organizationId, school.schoolId, 'OPEN', signal))
      .map((lead) => ({ id: lead.id, label: `${lead.givenName} ${lead.familyName}`.trim(), version: lead.version }));
    return kaiCurricula(signal);
  },
};

/** Published curricula of the caller's school (the only ones Kai accepts). 403 or a read that does not exist yet: nothing to pick. */
export const KAI_CURRICULA_PATH = '/api/v1/staff/teaching-assistant/curricula';
export function curriculumTargets(value: unknown): HonDelegationTarget[] {
  const bad = (): never => { throw new Error('Curriculum list could not be verified.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'data') bad();
  const data = (value as { data: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join() !== 'items') bad();
  const items = (data as { items: unknown }).items;
  if (!Array.isArray(items) || items.length > 200) bad();
  return (items as unknown[]).map((item) => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join() !== 'id,name,version' || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.name !== 'string' || row.name.length < 1 || row.name.length > 200 || !Number.isSafeInteger(row.version)) bad();
    return { id: row.id as string, label: row.name as string, version: null };
  });
}
async function kaiCurricula(signal: AbortSignal): Promise<HonDelegationTarget[] | null> {
  const response = await fetch(KAI_CURRICULA_PATH, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', 'X-HON-Human-Command': 'teaching-assistant' } });
  if (response.status === 403 || response.status === 404) return null;
  if (response.status !== 200) throw new Error('Curriculum list is unavailable.');
  return curriculumTargets(await response.json());
}
