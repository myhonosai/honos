// AI-R1 AI team readiness for the requesting human at one school. Read only: nothing is planned, reserved, recorded or
// sent. Each live agent says whether a request would be allowed now and, if not, the first gate that refuses.
import { championsDrift as drift, championsExactKeys as exactKeys, championsIsTimestamp as isTimestamp, championsIsUuid as isUuid,
  championsRecord as record } from './champions-club.js';

export const AI_TEAM_READY_AGENTS = [['marcus', 'MARKETING', 6], ['kai', 'TEACHING', 6], ['chad', 'CHAD_FOLLOW_UP', 3], ['hon', 'HON_REPLY', 10], ['claire', 'BUSINESS_PERFORMANCE', 15]] as const;
export type AiTeamReadyAgentKey = typeof AI_TEAM_READY_AGENTS[number][0];
/** S4-c decisions plus ALLOWED. */
export const AI_TEAM_SPEND_DECISIONS = ['ALLOWED', 'AI_PAUSED_BY_HQ', 'AI_EXCEPTION_NO_AI', 'AI_ACCESS_UNKNOWN_STATE', 'AI_TRIAL_FUNDING_NOT_APPROVED',
  'AI_ACCESS_NOT_PAID', 'AI_ACCESS_PAST_DUE', 'AI_ACCESS_REVIEW_HOLD', 'AI_ACCESS_LAPSED', 'AI_ACCESS_SUSPENDED', 'AI_ACCESS_ENDED'] as const;
export const AI_TEAM_BLOCKERS = ['NOT_AUTHORIZED', 'NO_ELIGIBLE_ROUTE', 'ORGANIZATION_AI_BUDGET_REACHED', 'PROVIDER_RUNTIME_NOT_CONFIGURED'] as const;
export type AiTeamProviderRuntime = 'READY' | 'CONFIGURATION_REQUIRED';

export interface AiTeamAgentReadiness {
  agentKey: AiTeamReadyAgentKey; agent: string; authorized: boolean; spendDecision: string; route: 'CONFIGURED' | 'NO_ELIGIBLE_ROUTE';
  requestCredits: number; providerRuntime: AiTeamProviderRuntime; available: boolean; blockedBy: string | null;
}
export interface AiTeamReadiness {
  organizationId: string; schoolId: string; completeEntitlement: boolean;
  /**
   * Organization-wide agent budget (all schools of the organization). Null unless the requester independently holds
   * organization-wide authority (HON HQ reader, or ai.usage.read at every school of the organization).
   */
  agentBudget: { committedCredits: number; ceilingCredits: number } | null; agents: AiTeamAgentReadiness[]; asOf: string;
  /** The C1 HON conversation contract exists; GET /hon/readiness gives the composer prerequisites. */
  honConversation: { contract: true };
}

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const SPEND = new Set<unknown>(AI_TEAM_SPEND_DECISIONS);
const BLOCK = new Set<unknown>([...AI_TEAM_SPEND_DECISIONS.slice(1), ...AI_TEAM_BLOCKERS]);

/** Database shape (before the API adds the runtime). */
export function validateAiTeamReadinessRow(value: unknown): Omit<AiTeamReadiness, 'honConversation' | 'agents'> & { agents: Omit<AiTeamAgentReadiness, 'providerRuntime'>[] } {
  const r = record(value, drift);
  exactKeys(r, ['organizationId', 'schoolId', 'completeEntitlement', 'agentBudget', 'agents', 'asOf'], drift);
  if (r.agentBudget !== null) {
    const b = record(r.agentBudget, drift); exactKeys(b, ['committedCredits', 'ceilingCredits'], drift);
    if (!isCount(b.committedCredits) || !isCount(b.ceilingCredits)) drift();
  }
  if (!isUuid(r.organizationId) || !isUuid(r.schoolId) || typeof r.completeEntitlement !== 'boolean'
    || !isTimestamp(r.asOf) || !Array.isArray(r.agents) || r.agents.length !== AI_TEAM_READY_AGENTS.length) drift();
  (r.agents as unknown[]).forEach((x, i) => {
    const a = record(x, drift);
    exactKeys(a, ['agentKey', 'agent', 'authorized', 'spendDecision', 'route', 'requestCredits', 'available', 'blockedBy'], drift);
    const [key, agent, credits] = AI_TEAM_READY_AGENTS[i]!;
    if (a.agentKey !== key || a.agent !== agent || a.requestCredits !== credits || typeof a.authorized !== 'boolean' || !SPEND.has(a.spendDecision)
      || (a.route !== 'CONFIGURED' && a.route !== 'NO_ELIGIBLE_ROUTE') || typeof a.available !== 'boolean'
      || (a.available ? a.blockedBy !== null : !BLOCK.has(a.blockedBy))
      || (a.available && (!a.authorized || a.spendDecision !== 'ALLOWED' || a.route !== 'CONFIGURED'))) drift();
  });
  return r as never;
}

/** API shape: the database result plus the server runtime state. A runtime refusal applies only where the database allowed. */
export function validateAiTeamReadiness(value: unknown): AiTeamReadiness {
  const r = record(value, drift);
  exactKeys(r, ['organizationId', 'schoolId', 'completeEntitlement', 'agentBudget', 'agents', 'asOf', 'honConversation'], drift);
  const h = record(r.honConversation, drift); exactKeys(h, ['contract'], drift);
  if (h.contract !== true || !Array.isArray(r.agents)) drift();
  const dbAgents = (r.agents as unknown[]).map((x) => {
    const { providerRuntime, ...rest } = record(x, drift);
    if (providerRuntime !== 'READY' && providerRuntime !== 'CONFIGURATION_REQUIRED') drift();
    if (rest.available === true && providerRuntime !== 'READY') drift();
    if (rest.blockedBy === 'PROVIDER_RUNTIME_NOT_CONFIGURED') {
      if (providerRuntime === 'READY' || rest.available !== false) drift();
      return { ...rest, available: true, blockedBy: null };
    }
    return rest;
  });
  const { honConversation: _h, ...row } = r;
  validateAiTeamReadinessRow({ ...row, agents: dbAgents });
  return r as unknown as AiTeamReadiness;
}

/** Composes the API shape from a validated database row and the server runtime state (no provider call). */
export function composeAiTeamReadiness(row: ReturnType<typeof validateAiTeamReadinessRow>, runtime: (key: AiTeamReadyAgentKey) => AiTeamProviderRuntime): AiTeamReadiness {
  return { ...row, honConversation: { contract: true }, agents: row.agents.map((a) => {
    const providerRuntime = runtime(a.agentKey);
    return a.available && providerRuntime !== 'READY' ? { ...a, providerRuntime, available: false, blockedBy: 'PROVIDER_RUNTIME_NOT_CONFIGURED' } : { ...a, providerRuntime };
  }) };
}
