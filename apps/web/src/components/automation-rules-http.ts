import { validateAutomationRule, validateAutomationDryRun, type AutomationRuleInput, type AutomationRule, type AutomationRuleList, type AutomationDryRunInput, type AutomationEvaluationPlan } from '@hon/contracts';
const base = '/api/v1/staff/automation/rules';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const automationFingerprint = (v: unknown): string => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
function invalid(): never { throw new Error('Unverified result. No save or plan assumed; retain the key for unchanged uncertain saves.'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid(); }
export function automationRuleInput(r: AutomationRule): AutomationRuleInput { const { expectedVersion, name, enabled, triggerKind, conditions, proposal, posture, schedule } = r; return { expectedVersion, name, enabled, triggerKind, conditions, proposal, posture, schedule }; }
function rule(v: unknown): AutomationRule {
  closed(v, ['ruleId','schoolId','version','recordedAt','configurationOnly','expectedVersion','name','enabled','triggerKind','conditions','proposal','posture','schedule']);
  if (typeof v.ruleId !== 'string' || !uuid.test(v.ruleId) || typeof v.schoolId !== 'string' || !uuid.test(v.schoolId) || v.configurationOnly !== true || !Number.isSafeInteger(v.version) || Number(v.version) < 1 || v.version !== Number(v.expectedVersion) + 1 || typeof v.recordedAt !== 'string' || !Number.isFinite(Date.parse(v.recordedAt))) invalid();
  validateAutomationRule(automationRuleInput(v as unknown as AutomationRule)); return v as unknown as AutomationRule;
}
async function request(path: string, body?: AutomationRuleInput | AutomationDryRunInput, key?: string): Promise<unknown> {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'automation-rules', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission is unavailable.' : response.status === 409 ? 'Version or retry conflict. Reload current rules before changing input.' : 'No verified result. Check bounded configuration and simulation values.');
  const envelope: unknown = await response.json(); const data = (envelope as { data?: unknown })?.data; if (!data) invalid(); return data;
}
export async function loadAutomationRules(): Promise<AutomationRuleList> {
  const v = await request(''); closed(v, ['schoolId','configurationOnly','canManage','canDryRun','rules']);
  if (typeof v.schoolId !== 'string' || !uuid.test(v.schoolId) || v.configurationOnly !== true || typeof v.canManage !== 'boolean' || typeof v.canDryRun !== 'boolean' || !Array.isArray(v.rules) || v.rules.length > 100) invalid();
  const ids = new Set<string>(); for (const r of v.rules) { const saved = rule(r); if (saved.schoolId !== v.schoolId || ids.has(saved.ruleId)) invalid(); ids.add(saved.ruleId); }
  return v as unknown as AutomationRuleList;
}
export async function saveAutomationRule(id: string | null, input: AutomationRuleInput, key: string): Promise<AutomationRule> {
  if ((id !== null && !uuid.test(id)) || typeof key !== 'string' || !key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  validateAutomationRule(input); const r = rule(await request(id ? `/${id}/versions` : '', input, key));
  if ((id && r.ruleId.toLowerCase() !== id.toLowerCase()) || automationFingerprint(automationRuleInput(r)) !== automationFingerprint(input)) invalid(); return r;
}
export async function readAutomationRuleVersion(id: string, version: number): Promise<AutomationRule> {
  if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 1 || version > 999999999) invalid();
  const r = rule(await request(`/${id}/versions/${version}`)); if (r.ruleId.toLowerCase() !== id.toLowerCase() || r.version !== version) invalid(); return r;
}
export async function dryRunAutomationRule(id: string, input: AutomationDryRunInput): Promise<AutomationEvaluationPlan> {
  if (!uuid.test(id)) invalid(); validateAutomationDryRun(input);
  const v = await request(`/${id}/dry-run`, input); closed(v, ['ruleId','version','configurationOnly','executionAllowed','status','reason','plan']);
  if (v.ruleId !== id || v.version !== input.expectedVersion || v.configurationOnly !== true || v.executionAllowed !== false || !['MATCH','DISABLED','TRIGGER_MISMATCH','CONDITION_MISMATCH','OUTSIDE_SCHEDULE','COOLDOWN'].includes(String(v.reason)) || v.status !== (v.reason === 'MATCH' ? 'PLANNED' : 'NOT_PLANNED')) invalid();
  if (v.reason !== 'MATCH') { if (v.plan !== null) invalid(); }
  else { closed(v.plan, ['kind','category','priority','authority','approval','requiredPermissions','policyRequirements','scheduleMetadataOnly']);
    if (v.plan.kind !== 'MANUAL_REVIEW_TEMPLATE_DESCRIPTION' || !['LEAD_TRIAGE','TRIAL_ATTENDANCE_REVIEW'].includes(String(v.plan.category)) || !['NORMAL','HIGH'].includes(String(v.plan.priority)) || v.plan.authority !== 'NONE' || v.plan.approval !== 'HUMAN_REVIEW_REQUIRED' || v.plan.scheduleMetadataOnly !== true || automationFingerprint(v.plan.requiredPermissions) !== '["work_item.create"]' || automationFingerprint(v.plan.policyRequirements) !== '["CURRENT_SCHOOL_PERMISSION","SEPARATE_HUMAN_COMMAND","CURRENT_DOMAIN_POLICY"]') invalid(); }
  return v as unknown as AutomationEvaluationPlan;
}
