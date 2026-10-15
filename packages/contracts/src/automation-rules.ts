import type { CommandContext } from './index.js';

export const AUTOMATION_RULE_PERMISSIONS = ['automation.rule.read', 'automation.rule.manage', 'automation.rule.dry_run'] as const;
export type AutomationRulePermission = (typeof AUTOMATION_RULE_PERMISSIONS)[number];
export const AUTOMATION_TRIGGERS = ['LEAD_CREATED', 'TRIAL_NO_SHOW'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export type AutomationEventSource = 'HUMAN_UI' | 'PUBLIC_API';
export interface AutomationRuleContext extends CommandContext { externalSubject: string }
export interface AutomationRuleInput {
  expectedVersion: number; name: string; enabled: boolean; triggerKind: AutomationTrigger;
  conditions: { source: 'ANY' | AutomationEventSource; minimumAggregateVersion: number };
  proposal: { kind: 'MANUAL_REVIEW_TEMPLATE'; category: 'LEAD_TRIAGE' | 'TRIAL_ATTENDANCE_REVIEW'; priority: 'NORMAL' | 'HIGH' };
  posture: { authority: 'NONE'; approval: 'HUMAN_REVIEW_REQUIRED' };
  schedule: { mode: 'MANUAL_ONLY'; effectiveFrom: string; endsOn: string | null; cooldownMinutes: number };
}
export interface AutomationRule extends AutomationRuleInput {
  ruleId: string; schoolId: string; version: number; recordedAt: string; configurationOnly: true;
}
export interface AutomationRuleList {
  schoolId: string; configurationOnly: true; canManage: boolean; canDryRun: boolean; rules: AutomationRule[];
}
/** Simulation values only. No real event ID, payload, PII or client-selected scope. */
export interface AutomationDryRunInput {
  expectedVersion: number;
  event: { synthetic: true; triggerKind: AutomationTrigger; schemaVersion: 1; aggregateVersion: number; source: AutomationEventSource };
  simulation: { localDate: string; minutesSincePriorPlan: number | null };
}
export type AutomationPlanReason = 'MATCH' | 'DISABLED' | 'TRIGGER_MISMATCH' | 'CONDITION_MISMATCH' | 'OUTSIDE_SCHEDULE' | 'COOLDOWN';
export interface AutomationEvaluationPlan {
  ruleId: string; version: number; configurationOnly: true; executionAllowed: false;
  status: 'PLANNED' | 'NOT_PLANNED'; reason: AutomationPlanReason;
  plan: null | {
    kind: 'MANUAL_REVIEW_TEMPLATE_DESCRIPTION'; category: AutomationRuleInput['proposal']['category']; priority: 'NORMAL' | 'HIGH';
    authority: 'NONE'; approval: 'HUMAN_REVIEW_REQUIRED'; requiredPermissions: ['work_item.create'];
    policyRequirements: ['CURRENT_SCHOOL_PERMISSION', 'SEPARATE_HUMAN_COMMAND', 'CURRENT_DOMAIN_POLICY'];
    scheduleMetadataOnly: true;
  };
}
export const AUTOMATION_RULE_HELP = 'Configuration only; no execution. Enabled means eligible for an explicit synthetic dry-run, not subscribed or scheduled. Output is an inert manual review template description, not a work item, Action Engine command or approval. No messages, payments, publishing, provider or AI calls. Schedule and cooldown are human-defined simulation metadata only.';
const UNSAFE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function invalid(): never { throw new Error('INVALID_AUTOMATION_DESCRIPTOR'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
}
function integer(v: unknown, min: number, max: number): void { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid(); }
export function validateAutomationDate(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) invalid();
}
export function validateAutomationRule(v: unknown): asserts v is AutomationRuleInput {
  closed(v, ['expectedVersion', 'name', 'enabled', 'triggerKind', 'conditions', 'proposal', 'posture', 'schedule']);
  integer(v.expectedVersion, 0, 999999998);
  if (typeof v.name !== 'string' || v.name.length < 1 || v.name.length > 100 || v.name.trim() !== v.name || UNSAFE.test(v.name) || typeof v.enabled !== 'boolean' || !AUTOMATION_TRIGGERS.includes(v.triggerKind as AutomationTrigger)) invalid();
  closed(v.conditions, ['source', 'minimumAggregateVersion']);
  if (!['ANY', 'HUMAN_UI', 'PUBLIC_API'].includes(String(v.conditions.source)) || (v.triggerKind === 'TRIAL_NO_SHOW' && v.conditions.source === 'PUBLIC_API')) invalid();
  integer(v.conditions.minimumAggregateVersion, 1, 999999999);
  closed(v.proposal, ['kind', 'category', 'priority']);
  if (v.proposal.kind !== 'MANUAL_REVIEW_TEMPLATE' || v.proposal.category !== (v.triggerKind === 'LEAD_CREATED' ? 'LEAD_TRIAGE' : 'TRIAL_ATTENDANCE_REVIEW') || !['NORMAL', 'HIGH'].includes(String(v.proposal.priority))) invalid();
  closed(v.posture, ['authority', 'approval']);
  if (v.posture.authority !== 'NONE' || v.posture.approval !== 'HUMAN_REVIEW_REQUIRED') invalid();
  closed(v.schedule, ['mode', 'effectiveFrom', 'endsOn', 'cooldownMinutes']);
  if (v.schedule.mode !== 'MANUAL_ONLY') invalid();
  validateAutomationDate(v.schedule.effectiveFrom);
  if (v.schedule.endsOn !== null) { validateAutomationDate(v.schedule.endsOn); const days = (Date.parse(v.schedule.endsOn) - Date.parse(v.schedule.effectiveFrom)) / 86400000; if (days < 1 || days > 3660) invalid(); }
  integer(v.schedule.cooldownMinutes, 0, 10080);
}
export function validateAutomationDryRun(v: unknown): asserts v is AutomationDryRunInput {
  closed(v, ['expectedVersion', 'event', 'simulation']); integer(v.expectedVersion, 1, 999999999);
  closed(v.event, ['synthetic', 'triggerKind', 'schemaVersion', 'aggregateVersion', 'source']);
  if (v.event.synthetic !== true || v.event.schemaVersion !== 1 || !AUTOMATION_TRIGGERS.includes(v.event.triggerKind as AutomationTrigger) || !['HUMAN_UI', 'PUBLIC_API'].includes(String(v.event.source)) || (v.event.triggerKind === 'TRIAL_NO_SHOW' && v.event.source !== 'HUMAN_UI')) invalid();
  integer(v.event.aggregateVersion, 1, 999999999);
  closed(v.simulation, ['localDate', 'minutesSincePriorPlan']); validateAutomationDate(v.simulation.localDate);
  if (v.simulation.minutesSincePriorPlan !== null) integer(v.simulation.minutesSincePriorPlan, 0, 5256000);
}
