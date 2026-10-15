import { validateAutomationRule, validateAutomationDryRun, type AutomationRule, type AutomationDryRunInput, type AutomationEvaluationPlan, type AutomationPlanReason } from '@hon/contracts';
/** Pure reference planner. Caller must establish live staff authorization separately. */
export function planAutomationRule(rule: AutomationRule, input: AutomationDryRunInput): AutomationEvaluationPlan {
  const { ruleId, schoolId: _schoolId, version, recordedAt: _recordedAt, configurationOnly, ...descriptor } = rule;
  validateAutomationRule(descriptor); validateAutomationDryRun(input);
  if (configurationOnly !== true || version !== descriptor.expectedVersion + 1 || input.expectedVersion !== version) throw new Error('VERSION_CONFLICT');
  let reason: AutomationPlanReason = 'MATCH';
  if (!rule.enabled) reason = 'DISABLED';
  else if (rule.triggerKind !== input.event.triggerKind) reason = 'TRIGGER_MISMATCH';
  else if ((rule.conditions.source !== 'ANY' && rule.conditions.source !== input.event.source) || input.event.aggregateVersion < rule.conditions.minimumAggregateVersion) reason = 'CONDITION_MISMATCH';
  else if (input.simulation.localDate < rule.schedule.effectiveFrom || (rule.schedule.endsOn !== null && input.simulation.localDate >= rule.schedule.endsOn)) reason = 'OUTSIDE_SCHEDULE';
  else if (input.simulation.minutesSincePriorPlan !== null && input.simulation.minutesSincePriorPlan < rule.schedule.cooldownMinutes) reason = 'COOLDOWN';
  return { ruleId, version, configurationOnly: true, executionAllowed: false, status: reason === 'MATCH' ? 'PLANNED' : 'NOT_PLANNED', reason,
    plan: reason !== 'MATCH' ? null : { kind: 'MANUAL_REVIEW_TEMPLATE_DESCRIPTION', category: rule.proposal.category, priority: rule.proposal.priority, authority: 'NONE', approval: 'HUMAN_REVIEW_REQUIRED', requiredPermissions: ['work_item.create'], policyRequirements: ['CURRENT_SCHOOL_PERMISSION', 'SEPARATE_HUMAN_COMMAND', 'CURRENT_DOMAIN_POLICY'], scheduleMetadataOnly: true } };
}
