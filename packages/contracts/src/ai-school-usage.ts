// S4-e HQ per-school AI usage and actual provider cost. Read only. Each school's charged provider results come from the
// append-only AI usage ledger, split by spend class (agent inference and creative media are different credit units and
// are never summed together) and, for agent inference, by the agent that wrote the row. Provider cost is micro-USD.
// Cost basis is explicit: providerReportedCostMicrounits is only cost the provider itself reported (or provider evidence
// an HQ owner recorded); estimatedWriteOffCostMicrounits is an HQ write-off ESTIMATE and is never a provider charge;
// unreconciledInvocations are calls whose outcome is still unknown, so they carry no amount at all.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const AI_USAGE_SPEND_CLASSES = ['AGENT_INFERENCE', 'CREATIVE_MEDIA', 'HQ_INTERNAL'] as const;
export type AiUsageSpendClass = typeof AI_USAGE_SPEND_CLASSES[number];
export const AI_USAGE_AGENTS = ['MARKETING', 'TEACHING', 'CHAD_FOLLOW_UP', 'UNATTRIBUTED'] as const;
export type AiUsageAgent = typeof AI_USAGE_AGENTS[number];

export interface AiUsageAmount {
  credits: number;
  /** Provider-reported charges only. */
  providerReportedCostMicrounits: number;
  /** HQ WRITE_OFF estimates; never present these as provider charges. */
  estimatedWriteOffCostMicrounits: number;
  entries: number;
  writeOffEntries: number;
}
export interface AiUsageClassTotals extends AiUsageAmount { byAgent: Partial<Record<AiUsageAgent, AiUsageAmount>> | null }
export interface AiSchoolUsage {
  organizationId: string; schoolId: string; providerReportedCostMicrounits: number; estimatedWriteOffCostMicrounits: number;
  entries: number; writeOffEntries: number;
  /** Open lost outcomes at this school (UNKNOWN or stale SENDING with a hold): no ledger row, cost unknown. */
  unreconciledInvocations: number;
  byClass: Partial<Record<AiUsageSpendClass, AiUsageClassTotals>>;
}
export interface AiOrganizationAgentBudget {
  organizationId: string; agentWindowStart: string; agentWindowEnd: string; agentCommittedCredits: number; agentCeilingCredits: number;
  openUnknownHolds: number; aiPaused: boolean;
}
/** At most 500 schools (highest provider-reported cost, then estimate, first); truncated says more existed. */
export interface AiSchoolUsageReport {
  from: string; to: string; asOf: string; truncated: boolean; schools: AiSchoolUsage[]; organizations: AiOrganizationAgentBudget[];
  providerCostUnit: 'MICROUNITS_USD';
}

const MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isClass = (v: string): v is AiUsageSpendClass => (AI_USAGE_SPEND_CLASSES as readonly string[]).includes(v);
const isAgent = (v: string): v is AiUsageAgent => (AI_USAGE_AGENTS as readonly string[]).includes(v);

/** HQ query range: ISO instants, from < to, at most 92 days. */
export function validateAiSchoolUsageRange(from: unknown, to: unknown): { from: string; to: string } {
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO_INSTANT.test(from) || !ISO_INSTANT.test(to)) invalid();
  const a = Date.parse(from as string), b = Date.parse(to as string);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a) || b - a > MAX_RANGE_MS) invalid();
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

const AMOUNT = ['providerReportedCostMicrounits', 'estimatedWriteOffCostMicrounits', 'entries', 'writeOffEntries'];
function amount(value: unknown, keys: string[]): Record<string, unknown> {
  const r = record(value, drift); exactKeys(r, keys, drift);
  if (!isCount(r.providerReportedCostMicrounits) || !isCount(r.estimatedWriteOffCostMicrounits) || !isCount(r.entries) || (r.entries as number) < 1
    || !isCount(r.writeOffEntries) || (r.writeOffEntries as number) > (r.entries as number)
    // An estimate exists only on write-off rows.
    || ((r.writeOffEntries as number) === 0 && (r.estimatedWriteOffCostMicrounits as number) !== 0)
    || (keys.includes('credits') && !isCount(r.credits))) drift();
  return r;
}
const sums = () => ({ entries: 0, cost: 0, estimate: 0, writeOffs: 0 });
function add(t: ReturnType<typeof sums>, r: Record<string, unknown>): void {
  t.entries += r.entries as number; t.cost += r.providerReportedCostMicrounits as number;
  t.estimate += r.estimatedWriteOffCostMicrounits as number; t.writeOffs += r.writeOffEntries as number;
}
function same(t: ReturnType<typeof sums>, r: Record<string, unknown>): boolean {
  return t.entries === r.entries && t.cost === r.providerReportedCostMicrounits && t.estimate === r.estimatedWriteOffCostMicrounits && t.writeOffs === r.writeOffEntries;
}

function validateSchool(value: unknown): AiSchoolUsage {
  const r = amount(value, ['organizationId', 'schoolId', ...AMOUNT, 'unreconciledInvocations', 'byClass']);
  if (!isUuid(r.organizationId) || !isUuid(r.schoolId) || !isCount(r.unreconciledInvocations)) drift();
  const byClass = record(r.byClass, drift);
  const classes = Object.keys(byClass);
  if (classes.length === 0) drift();
  const school = sums();
  for (const k of classes) {
    if (!isClass(k)) drift();
    const c = amount(byClass[k], ['credits', ...AMOUNT, 'byAgent']);
    add(school, c);
    if (k === 'AGENT_INFERENCE') {
      const byAgent = record(c.byAgent, drift);
      const agents = sums();
      for (const a of Object.keys(byAgent)) {
        if (!isAgent(a)) drift();
        add(agents, amount(byAgent[a], ['credits', ...AMOUNT]));
      }
      if (!same(agents, c)) drift();
    } else if (c.byAgent !== null) drift();
  }
  if (!same(school, r)) drift();
  return r as unknown as AiSchoolUsage;
}

function validateOrganization(value: unknown): AiOrganizationAgentBudget {
  const r = record(value, drift);
  exactKeys(r, ['organizationId', 'agentWindowStart', 'agentWindowEnd', 'agentCommittedCredits', 'agentCeilingCredits', 'openUnknownHolds', 'aiPaused'], drift);
  if (!isUuid(r.organizationId) || !isTimestamp(r.agentWindowStart) || !isTimestamp(r.agentWindowEnd) || !isCount(r.agentCommittedCredits)
    || !isCount(r.agentCeilingCredits) || !isCount(r.openUnknownHolds) || typeof r.aiPaused !== 'boolean') drift();
  return r as unknown as AiOrganizationAgentBudget;
}

export function validateAiSchoolUsageReport(value: unknown): AiSchoolUsageReport {
  const r = record(value, drift);
  exactKeys(r, ['from', 'to', 'asOf', 'truncated', 'schools', 'organizations', 'providerCostUnit'], drift);
  if (!isTimestamp(r.from) || !isTimestamp(r.to) || !isTimestamp(r.asOf) || typeof r.truncated !== 'boolean' || r.providerCostUnit !== 'MICROUNITS_USD'
    || !Array.isArray(r.schools) || r.schools.length > 500 || !Array.isArray(r.organizations) || r.organizations.length > 500) drift();
  const schools = (r.schools as unknown[]).map(validateSchool);
  const organizations = (r.organizations as unknown[]).map(validateOrganization);
  const orgIds = new Set(organizations.map((o) => o.organizationId));
  if (orgIds.size !== organizations.length || schools.some((s) => !orgIds.has(s.organizationId))) drift();
  return { ...(r as unknown as AiSchoolUsageReport), schools, organizations };
}
