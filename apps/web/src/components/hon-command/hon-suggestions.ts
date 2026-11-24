import {
  CAMPAIGN_STATUSES, FOLLOW_UP_DRAFT_PURPOSES, HON_REPLY_LIMITS, HON_TURN_TEXT_LIMITS, validateHonOrchestrationList, validateTeachingCurriculumOptions,
  type FollowUpDraftPurpose, type HonDelegation, type HonOrchestration, type HonOrchestrationList,
  type HonOrchestrationStatus, type HonSuggestedAgentKey,
} from '@hon/contracts';
import { verifyCrmLeadList } from '../crm-leads-http';

/**
 * C3a "Ask HON" suggestion cards. HON may suggest up to three specialists for one completed answer; a suggestion does nothing
 * until the human picks the specialist's own target here and confirms it, which sends one ordinary delegation turn naming
 * the answer it came from. The target lists are read from each specialist's existing list API for this signed-in human;
 * the ids are selectors only and the server re-checks the human, the school and the target before anything is drafted.
 */
export type HonDelegateTarget = Readonly<{ id: string; label: string; detail: string | null; version: number | null }>;

export const SUGGESTION_AGENT: Readonly<Record<HonSuggestedAgentKey, { name: string; role: string; does: string; target: string; empty: string }>> = {
  marcus: { name: 'Marcus', role: 'Marketing', does: 'Drafts content for one of your campaigns. The draft waits for approval in Action Center; nothing is published.',
    target: 'Campaign', empty: 'No open campaigns at this school yet. Create one in Campaigns first.' },
  kai: { name: 'Kai', role: 'Teaching & Curriculum', does: 'Drafts teaching material for one published curriculum. The draft waits for approval; no student record changes.',
    target: 'Curriculum', empty: 'No published curricula at this school yet.' },
  chad: { name: 'Chad', role: 'Lead follow-up', does: 'Drafts a follow-up message for one open lead. Nothing is sent to the family; the draft waits for approval in Action Center.',
    target: 'Lead', empty: 'No open leads at this school right now.' },
  // K2c: Claire takes a question, not a target. Her answer is text: the recorded facts, then her view.
  claire: { name: 'Claire', role: 'Business Performance', does: 'Reads this school’s performance numbers and answers with the recorded facts, then her view. She never drafts, sends or changes anything.',
    target: '', empty: '' },
};

export const PURPOSE_LABEL: Readonly<Record<FollowUpDraftPurpose, string>> = {
  INTRODUCTION: 'Introduction', CHECK_IN: 'Check-in', TRIAL_REMINDER: 'Trial reminder', REENGAGEMENT: 'Re-engagement',
};
export const SUGGESTION_PURPOSES = FOLLOW_UP_DRAFT_PURPOSES;

export const ORCHESTRATION_PRESENTATION: Readonly<Record<HonOrchestrationStatus, { label: string; tone: 'ready' | 'neutral' | 'waiting' | 'blocked' | 'planned'; detail: string }>> = {
  PENDING: { label: 'Working', tone: 'neutral', detail: 'At least one specialist you asked is still working.' },
  NEEDS_REVIEW: { label: 'Needs your review', tone: 'waiting', detail: 'A draft is waiting for a human decision in Action Center. Nothing has run.' },
  COMPLETED: { label: 'Done', tone: 'ready', detail: 'Every specialist you asked recorded a result.' },
  PARTIAL: { label: 'Partly done', tone: 'waiting', detail: 'Some specialists recorded a result and some did not. Nothing is assumed for the others.' },
  FAILED: { label: 'Did not complete', tone: 'blocked', detail: 'No specialist you asked recorded a result. Nothing is assumed to have happened.' },
  UNKNOWN: { label: 'Not confirmed', tone: 'planned', detail: 'At least one outcome could not be confirmed. HON HQ reviews it; nothing is sent twice.' },
};

export const textLimit = (agent: HonSuggestedAgentKey) => agent === 'claire' ? HON_REPLY_LIMITS.questionCharacters : HON_TURN_TEXT_LIMITS[agent];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class HonTargetDrift extends Error { constructor() { super('The specialist target list could not be verified. Nothing is shown in its place.'); } }
const drift = (): never => { throw new HonTargetDrift(); };
function root(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drift();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return drift();
  return value as Record<string, unknown>;
}
const unique = (items: HonDelegateTarget[]) => { if (new Set(items.map((item) => item.id.toLowerCase())).size !== items.length) drift(); return items; };

/** Marcus: the school's campaigns from GET /v1/marketing/campaigns. Archived campaigns cannot be drafted for, so they are left out. */
export function verifyCampaignTargets(envelope: unknown): HonDelegateTarget[] {
  const data = root(envelope, ['data', 'meta']).data;
  if (!Array.isArray(data) || data.length > 500) return drift();
  return unique(data.flatMap((item: unknown): HonDelegateTarget[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return drift();
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !UUID.test(c.id) || typeof c.name !== 'string' || c.name.trim().length === 0 || c.name.length > 120
      || !(CAMPAIGN_STATUSES as readonly unknown[]).includes(c.status) || !Number.isSafeInteger(c.version) || (c.version as number) < 1 || c.planningOnly !== true) return drift();
    return c.status === 'ARCHIVED' ? [] : [{ id: c.id, label: c.name, detail: (c.status as string).toLowerCase(), version: null }];
  }));
}

/** Kai: the published curricula from GET /v1/staff/teaching-assistant/curricula (exactly the set Kai accepts). */
export function verifyCurriculumTargets(envelope: unknown): HonDelegateTarget[] {
  let options;
  try { options = validateTeachingCurriculumOptions(root(envelope, ['data']).data); } catch { return drift(); }
  return unique(options.items.map((item) => ({ id: item.id, label: item.name, detail: `version ${item.version}`, version: null })));
}

/** Chad: open leads from the CRM lead list, with the version the follow-up request must name. */
export function verifyLeadTargets(envelope: unknown): HonDelegateTarget[] {
  let leads;
  try { leads = verifyCrmLeadList(root(envelope, ['data', 'meta']).data); } catch { return drift(); }
  return leads.filter((lead) => lead.status === 'OPEN').map((lead) => ({ id: lead.id, label: `${lead.givenName} ${lead.familyName}`, detail: null, version: lead.version }));
}

export function verifyOrchestrations(envelope: unknown): HonOrchestrationList {
  try { return validateHonOrchestrationList(root(envelope, ['data']).data); } catch { return drift(); }
}

/** The delegation for one confirmed suggestion; Claire takes none, a lead target must carry its version and a follow-up purpose. */
export function suggestionDelegation(agent: HonSuggestedAgentKey, target: HonDelegateTarget | null, purpose: FollowUpDraftPurpose | null): HonDelegation {
  if (agent === 'claire') return { agentKey: 'claire' };
  if (target === null) throw new HonTargetDrift();
  if (agent === 'marcus') return { agentKey: 'marcus', campaignId: target.id };
  if (agent === 'kai') return { agentKey: 'kai', curriculumId: target.id };
  if (target.version === null || purpose === null) throw new HonTargetDrift();
  return { agentKey: 'chad', leadId: target.id, expectedLeadVersion: target.version, purpose };
}

/** Index of grouped confirmations by the HON answer they came from. */
export const orchestrationsBySource = (list: HonOrchestrationList): ReadonlyMap<string, HonOrchestration> =>
  new Map(list.items.map((item) => [item.sourceTurnId.toLowerCase(), item]));
