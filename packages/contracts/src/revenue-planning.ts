export const REVENUE_PLANNING_VERSION = 'school-revenue-v1' as const;
export const REVENUE_PLAN_PERMISSION = 'planning.revenue.manage' as const;
export const REVENUE_BASELINE_METHODS = ['CURRENT_MONTHLY_SCHEDULES', 'ZERO_BASELINE'] as const;
export const REVENUE_MAX_MINOR = 1_000_000_000_000;
export const REVENUE_MAX_QUANTITY = 1_000_000_000;
export const REVENUE_VALIDATION = Object.freeze({ priceMinimumSample: 5, rateMinimumSample: 20, maxMinor: REVENUE_MAX_MINOR, maxQuantity: REVENUE_MAX_QUANTITY, maxActivitiesPerLead: 1000, rateDecimalPlaces: 6, maxTargetDays: 366, maxHistoryDays: 92, evidenceConsistency: 'SINGLE_STATEMENT' as const });
export interface RevenuePlanAssumptions {
  newMembershipMonthlyMinor?: number;
  trialToMembership?: number;
  appointmentToTrial?: number;
  leadToAppointment?: number;
  activitiesPerLead?: number;
}
export interface RevenuePlanInput {
  targetMonthlyMinor: number;
  currency: string;
  targetFrom: string;
  targetTo: string;
  historyFrom: string;
  historyTo: string;
  baselineMethod: typeof REVENUE_BASELINE_METHODS[number];
  assumptions: RevenuePlanAssumptions;
}
export interface SaveRevenuePlanInput extends RevenuePlanInput { expectedVersion: number }
export interface RevenuePlanningContext {
  organizationId: string; schoolId: string; principalId: string; externalSubject: string;
  principalType: string; source: string; requestId: string; correlationId: string;
  idempotencyKey: string; actionRequestId?: string; delegatedByPrincipalId?: string;
}
export interface RevenuePlanRecord {
  id: string; version: number; algorithmVersion: typeof REVENUE_PLANNING_VERSION;
  input: RevenuePlanInput;
}
export interface RevenueEvidence {
  currency: string; asOf: string; from: string; to: string;
  eligibleMonthlyMinor: number; eligibleMemberships: number; activeMemberships: number;
  excludedMemberships: number; leads: number; bookedTrialLeads: number;
  completedTrialLeads: number; ambiguousTrialLeads: number;
}
export interface RevenuePlanSnapshot {
  plan: RevenuePlanRecord; evidence: RevenueEvidence; snapshotHash: string;
}
export interface RevenuePlanSummary { id: string; version: number; currency: string; targetMonthlyMinor: number }
export interface RevenueSignal {
  source: 'HUMAN_ASSUMPTION' | 'SCOPED_HISTORY' | 'CURRENT_ELIGIBLE_AVERAGE' | 'UNAVAILABLE';
  value: number | null; numerator: number | null; denominator: number | null;
  sampleSize: number; minimumSampleSize: number; reason: string;
}
export interface RevenueQuantity {
  required: number | null;
  status: 'READY' | 'NOT_REQUIRED' | 'ASSUMPTION_REQUIRED' | 'ZERO_DENOMINATOR' | 'OUTPUT_LIMIT' | 'UPSTREAM_BLOCKED';
  formula: string;
}
export interface RevenueProjection extends RevenuePlanSnapshot {
  evidenceState: 'LIVE' | 'SAVED';
  validation: typeof REVENUE_VALIDATION;
  baseline: { monthlyMinor: number; source: 'CURRENT_ELIGIBLE_SCHEDULES' | 'HUMAN_ZERO_ASSUMPTION' };
  gapMinor: number; planningDays: number;
  signals: { newMembershipMonthlyMinor: RevenueSignal; trialToMembership: RevenueSignal; appointmentToTrial: RevenueSignal; leadToAppointment: RevenueSignal; activitiesPerLead: RevenueSignal };
  funnel: { memberships: RevenueQuantity; trials: RevenueQuantity; appointments: RevenueQuantity; leads: RevenueQuantity; activity: RevenueQuantity };
  assumptions: { field: string; value: number; source: 'HUMAN_ASSUMPTION' }[];
}
const DAY = 86_400_000;
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('VALIDATION_FAILED');
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  closed(value, keys);
  if (keys.some(k => !Object.hasOwn(value, k))) throw new Error('INVALID_REVENUE_EVIDENCE');
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error('VALIDATION_FAILED');
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) throw new Error('VALIDATION_FAILED');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('VALIDATION_FAILED');
  return time;
}
export function validateRevenuePlanInput(value: unknown): asserts value is SaveRevenuePlanInput {
  exact(value, ['expectedVersion','targetMonthlyMinor','currency','targetFrom','targetTo','historyFrom','historyTo','baselineMethod','assumptions']);
  integer(value.expectedVersion, 999_999_998); integer(value.targetMonthlyMinor, REVENUE_MAX_MINOR);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || !REVENUE_BASELINE_METHODS.includes(value.baselineMethod as never)) throw new Error('VALIDATION_FAILED');
  const duration = instant(value.targetTo) - instant(value.targetFrom);
  const history = instant(value.historyTo) - instant(value.historyFrom);
  if (duration < DAY || duration > 366 * DAY || history < DAY || history > 92 * DAY) throw new Error('VALIDATION_FAILED');
  closed(value.assumptions, ['newMembershipMonthlyMinor','trialToMembership','appointmentToTrial','leadToAppointment','activitiesPerLead']);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value.assumptions))) throw new Error('VALIDATION_FAILED');
  for (const [key, number] of Object.entries(value.assumptions)) {
    if (key === 'newMembershipMonthlyMinor') integer(number, REVENUE_MAX_MINOR);
    else if (key === 'activitiesPerLead') integer(number, 1000);
    else if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1 || !/^(0|1)(\.[0-9]{1,6})?$/.test(String(number))) throw new Error('VALIDATION_FAILED');
  }
}
// Derive the millionth rational from the validated decimal literal, never a
// floating-point multiplication/tolerance. Displayed ratios drive every ceiling.
function rateMillionths(value: number): number {
  const [whole, fraction = ''] = String(value).split('.');
  return Number(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')));
}
function signal(source: RevenueSignal['source'], numerator: number | null, denominator: number | null, sampleSize: number, minimumSampleSize: number, reason: string): RevenueSignal {
  return { source, numerator, denominator, value: numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null, sampleSize, minimumSampleSize, reason };
}
function rate(assumed: number | undefined, numerator: number, denominator: number, ambiguous: number): RevenueSignal {
  if (assumed !== undefined) return signal('HUMAN_ASSUMPTION', rateMillionths(assumed), 1_000_000, 0, 0, 'Explicit human rate; not an observed membership or booking guarantee.');
  if (denominator >= REVENUE_VALIDATION.rateMinimumSample && ambiguous === 0) return signal('SCOPED_HISTORY', numerator, denominator, denominator, REVENUE_VALIDATION.rateMinimumSample, 'Distinct lead cohort with one terminal TRIAL appointment; current outcomes within [from,to).');
  return signal('UNAVAILABLE', null, null, denominator, REVENUE_VALIDATION.rateMinimumSample, ambiguous > 0 ? 'Repeated or unresolved TRIAL appointments make this cohort ambiguous; supply a human assumption.' : 'Insufficient cohort (minimum 20); supply a human assumption.');
}
function quantity(numerator: bigint, denominator: bigint, formula: string): RevenueQuantity {
  if (denominator === 0n) return { required: null, status: 'ZERO_DENOMINATOR', formula };
  const result = (numerator + denominator - 1n) / denominator;
  return result > BigInt(REVENUE_MAX_QUANTITY) ? { required: null, status: 'OUTPUT_LIMIT', formula } : { required: Number(result), status: 'READY', formula };
}
function divide(upstream: RevenueQuantity, divisor: RevenueSignal, formula: string): RevenueQuantity {
  if (upstream.required === 0) return { required: 0, status: 'NOT_REQUIRED', formula };
  if (upstream.required === null) return { required: null, status: 'UPSTREAM_BLOCKED', formula };
  if (divisor.numerator === null || divisor.denominator === null) return { required: null, status: 'ASSUMPTION_REQUIRED', formula };
  return quantity(BigInt(upstream.required) * BigInt(divisor.denominator), BigInt(divisor.numerator), formula);
}
/** Pure deterministic calculator. No time, random values, network, provider or domain mutations. */
export function projectRevenuePlan(snapshot: RevenuePlanSnapshot, evidenceState: 'LIVE' | 'SAVED' = 'SAVED'): RevenueProjection {
  exact(snapshot, ['plan','evidence','snapshotHash']);
  const { plan, evidence: e } = snapshot;
  exact(plan, ['id','version','algorithmVersion','input']);
  exact(plan.input, ['targetMonthlyMinor','currency','targetFrom','targetTo','historyFrom','historyTo','baselineMethod','assumptions']);
  exact(e, ['currency','asOf','from','to','eligibleMonthlyMinor','eligibleMemberships','activeMemberships','excludedMemberships','leads','bookedTrialLeads','completedTrialLeads','ambiguousTrialLeads']);
  integer(plan.version, 999_999_999);
  if (plan.version < 1 || typeof plan.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.id)
    || typeof snapshot.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.snapshotHash)
    || !['LIVE','SAVED'].includes(evidenceState)) throw new Error('INVALID_REVENUE_EVIDENCE');
  if (instant(e.to) > instant(e.asOf)) throw new Error('INVALID_REVENUE_EVIDENCE');
  validateRevenuePlanInput({ ...plan.input, expectedVersion: plan.version - 1 });
  if (plan.algorithmVersion !== REVENUE_PLANNING_VERSION || e.currency !== plan.input.currency || e.from !== plan.input.historyFrom || e.to !== plan.input.historyTo) throw new Error('INVALID_REVENUE_EVIDENCE');
  for (const k of ['eligibleMonthlyMinor','eligibleMemberships','activeMemberships','excludedMemberships','leads','bookedTrialLeads','completedTrialLeads','ambiguousTrialLeads'] as const) integer(e[k], Number.MAX_SAFE_INTEGER);
  if (e.completedTrialLeads > e.bookedTrialLeads || e.bookedTrialLeads + e.ambiguousTrialLeads > e.leads || e.eligibleMemberships + e.excludedMemberships !== e.activeMemberships || (e.eligibleMemberships === 0 && e.eligibleMonthlyMinor !== 0)) throw new Error('INVALID_REVENUE_EVIDENCE');
  const a = plan.input.assumptions;
  const price = a.newMembershipMonthlyMinor !== undefined
    ? signal('HUMAN_ASSUMPTION', a.newMembershipMonthlyMinor, 1, 0, 0, 'Explicit monthly new-membership price assumption in plan currency.')
    : e.eligibleMemberships >= REVENUE_VALIDATION.priceMinimumSample
      ? signal('CURRENT_ELIGIBLE_AVERAGE', e.eligibleMonthlyMinor, e.eligibleMemberships, e.eligibleMemberships, REVENUE_VALIDATION.priceMinimumSample, 'Conventional new-member price proxy: exact eligible schedule average at capture, assuming the same price for new memberships; not observed new-member pricing, a historical price or realized receipts.')
      : signal('UNAVAILABLE', null, null, e.eligibleMemberships, REVENUE_VALIDATION.priceMinimumSample, 'Fewer than 5 eligible monthly schedules; supply a human new-membership monthly price.');
  const signals = {
    newMembershipMonthlyMinor: price,
    trialToMembership: a.trialToMembership !== undefined ? signal('HUMAN_ASSUMPTION', rateMillionths(a.trialToMembership), 1_000_000, 0, 0, 'Explicit human assumption. Membership schema has no trial/lead linkage; WON is not membership evidence.') : signal('UNAVAILABLE', null, null, 0, 0, 'No unambiguous trial-to-membership lineage in the schema; human assumption required.'),
    appointmentToTrial: rate(a.appointmentToTrial, e.completedTrialLeads, e.bookedTrialLeads, e.ambiguousTrialLeads),
    leadToAppointment: rate(a.leadToAppointment, e.bookedTrialLeads, e.leads, e.ambiguousTrialLeads),
    activitiesPerLead: a.activitiesPerLead !== undefined ? signal('HUMAN_ASSUMPTION', a.activitiesPerLead, 1, 0, 0, 'Explicit manual activity units per lead; no work/task/message is created.') : signal('UNAVAILABLE', null, null, 0, 0, 'CRM activities do not define an unambiguous acquisition unit; human quantity assumption required.'),
  };
  const baseline = { monthlyMinor: plan.input.baselineMethod === 'ZERO_BASELINE' ? 0 : e.eligibleMonthlyMinor, source: plan.input.baselineMethod === 'ZERO_BASELINE' ? 'HUMAN_ZERO_ASSUMPTION' as const : 'CURRENT_ELIGIBLE_SCHEDULES' as const };
  const gapMinor = Math.max(0, plan.input.targetMonthlyMinor - baseline.monthlyMinor);
  const memberships = divide({required: gapMinor, status: 'READY', formula: 'max(0,target-baseline)'}, price, 'ceil(gapMinor / newMembershipMonthlyMinor)');
  const trials = divide(memberships, signals.trialToMembership, 'ceil(memberships / trialToMembership)');
  const appointments = divide(trials, signals.appointmentToTrial, 'ceil(trials / appointmentToTrial)');
  const leads = divide(appointments, signals.leadToAppointment, 'ceil(appointments / leadToAppointment)');
  const activity: RevenueQuantity = leads.required === 0 ? {required: 0, status: 'NOT_REQUIRED', formula: 'leads * activitiesPerLead'} : leads.required === null ? {required: null, status: 'UPSTREAM_BLOCKED', formula: 'leads * activitiesPerLead'} : a.activitiesPerLead === undefined ? {required: null, status: 'ASSUMPTION_REQUIRED', formula: 'leads * activitiesPerLead'} : quantity(BigInt(leads.required) * BigInt(a.activitiesPerLead), 1n, 'leads * activitiesPerLead');
  return {plan: {id: plan.id, version: plan.version, algorithmVersion: plan.algorithmVersion, input: {...plan.input, assumptions: {...a}}}, evidence: {currency:e.currency,asOf:e.asOf,from:e.from,to:e.to,eligibleMonthlyMinor:e.eligibleMonthlyMinor,eligibleMemberships:e.eligibleMemberships,activeMemberships:e.activeMemberships,excludedMemberships:e.excludedMemberships,leads:e.leads,bookedTrialLeads:e.bookedTrialLeads,completedTrialLeads:e.completedTrialLeads,ambiguousTrialLeads:e.ambiguousTrialLeads}, snapshotHash:snapshot.snapshotHash, evidenceState, validation: {...REVENUE_VALIDATION}, baseline, gapMinor, planningDays: Math.ceil((Date.parse(plan.input.targetTo)-Date.parse(plan.input.targetFrom))/DAY), signals, funnel: {memberships,trials,appointments,leads,activity}, assumptions: Object.entries(a).sort(([x],[y]) => x < y ? -1 : x > y ? 1 : 0).map(([field,value]) => ({field,value,source:'HUMAN_ASSUMPTION'}))};
}
