import type { HonTier, RegisteredAction } from '@hon/contracts';

export const TIER_FEATURES: Record<HonTier, readonly string[]> = {
  ESSENTIAL: [
    'school-os.foundation',
    'crm.foundation',
    'students.families',
    'scheduling.attendance',
    'billing.foundation',
    'community.read-write',
    'ai.assist.basic',
  ],
  CORE: [
    'school-os.foundation',
    'crm.foundation',
    'students.families',
    'scheduling.attendance',
    'billing.foundation',
    'community.read-write',
    'ai.assist.basic',
    'automation.advanced',
    'reporting.advanced',
    'marketing.growth',
    'multilocation.management',
    'workforce.management',
  ],
  COMPLETE: [
    'school-os.foundation',
    'crm.foundation',
    'students.families',
    'scheduling.attendance',
    'billing.foundation',
    'community.read-write',
    'ai.assist.basic',
    'automation.advanced',
    'reporting.advanced',
    'marketing.growth',
    'multilocation.management',
    'workforce.management',
    'ai.employees',
    'ai.durable-work',
    'ai.voice',
    'ai.customizer',
  ],
};

export const INCLUDED_AI_CREDITS: Record<HonTier, number> = {
  ESSENTIAL: 2_000,
  CORE: 5_000,
  COMPLETE: 12_000,
};

export const ACTION_CATALOG: readonly RegisteredAction[] = [
  { code: 'ai.invocation.plan', requiredPermission: 'ai.invocation.plan', minimumTier: 'COMPLETE', platformAuthorityFloor: 'RESTRICTED', riskClass: 'MODERATE' },
  { code: 'program.create', requiredPermission: 'program.manage', minimumTier: 'ESSENTIAL', platformAuthorityFloor: 'CONFIRM', riskClass: 'MODERATE' },
  { code: 'schedule.session.create', requiredPermission: 'schedule.session.manage', minimumTier: 'ESSENTIAL', platformAuthorityFloor: 'CONFIRM', riskClass: 'MODERATE' },
  { code: 'attendance.record', requiredPermission: 'attendance.record', minimumTier: 'ESSENTIAL', platformAuthorityFloor: 'AUTO', riskClass: 'SENSITIVE' },
  {
    code: 'curriculum.create',
    requiredPermission: 'curriculum.manage',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'MODERATE',
  },
  {
    code: 'testing.promotion.decide',
    requiredPermission: 'testing.promotion.decide',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'RESTRICTED',
    riskClass: 'SENSITIVE',
  },
  {
    code: 'family.create',
    requiredPermission: 'family.create',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'LOW',
  },
  {
    code: 'family.member.add',
    requiredPermission: 'family.member.manage',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'SENSITIVE',
  },
  {
    code: 'people.person.create',
    requiredPermission: 'people.create',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'LOW',
  },
  {
    code: 'crm.lead.create',
    requiredPermission: 'crm.lead.create',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'LOW',
  },
  {
    code: 'crm.trial.schedule',
    requiredPermission: 'crm.trial.schedule',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'LOW',
  },
  {
    code: 'crm.lead.follow_up.send',
    requiredPermission: 'crm.lead.follow_up.send',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'MODERATE',
  },
  {
    code: 'billing.membership.activate',
    requiredPermission: 'billing.membership.activate',
    minimumTier: 'CORE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'FINANCIAL',
  },
  {
    code: 'billing.membership.create',
    requiredPermission: 'billing.membership.create',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'MODERATE',
  },
  {
    code: 'billing.account.create',
    requiredPermission: 'billing.account.create',
    minimumTier: 'ESSENTIAL',
    platformAuthorityFloor: 'AUTO',
    riskClass: 'LOW',
  },
  {
    code: 'billing.invoice.issue',
    requiredPermission: 'billing.invoice.issue',
    minimumTier: 'CORE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'FINANCIAL',
  },
  {
    code: 'billing.payment.initiate',
    requiredPermission: 'billing.payment.initiate',
    minimumTier: 'CORE',
    platformAuthorityFloor: 'RESTRICTED',
    riskClass: 'FINANCIAL',
  },
  {
    code: 'billing.refund.create',
    requiredPermission: 'billing.refund.create',
    minimumTier: 'CORE',
    platformAuthorityFloor: 'RESTRICTED',
    riskClass: 'FINANCIAL',
  },
  {
    code: 'marketing.draft.save',
    requiredPermission: 'marketing.assistant.use',
    minimumTier: 'COMPLETE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'MODERATE',
  },
  {
    code: 'teaching.draft.save',
    requiredPermission: 'teaching.assistant.use',
    minimumTier: 'COMPLETE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'MODERATE',
  },
  {
    code: 'crm.follow_up_draft.propose',
    requiredPermission: 'crm.assistant.follow_up_draft',
    minimumTier: 'COMPLETE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'MODERATE',
  },
  {
    code: 'marketing.social.publish',
    requiredPermission: 'marketing.social.publish',
    minimumTier: 'CORE',
    platformAuthorityFloor: 'CONFIRM',
    riskClass: 'PUBLICATION',
  },
] as const;

export function tierIncludesFeature(tier: HonTier, feature: string): boolean {
  return TIER_FEATURES[tier].includes(feature);
}

export { AI_TEAM_CATALOG, aiTeamAgentDefinition } from './ai-team-catalog.js';

export { AI_INVOCATION_PLANNING_LIMITS, AI_INVOCATION_PLANNING_TASKS } from './ai-invocation-planning.js';
export { DOCUMENT_COMMAND_REGISTRY } from './documents.js';
export { STAFF_SEARCH_READ_REGISTRY } from './search.js';
export { LEAD_IMPORT_COMMAND_REGISTRY } from './lead-import.js';
export { CURRICULUM_PROGRESS_COMMAND_REGISTRY } from './curriculum-progress.js';
export { REVENUE_PLANNING_COMMAND_REGISTRY } from './revenue-planning.js';
export { CAMPAIGN_COMMAND_REGISTRY } from './marketing-campaigns.js';

export { STAFF_AVAILABILITY_COMMAND_REGISTRY } from './staff-availability.js';

export { TEACHING_STUDIO_COMMAND_REGISTRY } from './teaching-studio.js';

export * from './automation-rules.js';

export * from './crm-follow-ups.js';

export * from './billing-renewals.js';

export * from './community.js';

/** Inert human handoff only; deliberately absent from the Action/Tool catalog. */
export const VOICE_SESSION_POLICY = { permission: 'ai.voice.interact', tier: 'COMPLETE', lifetimeSeconds: 1800, maxDraftCharacters: 500, providerExecutionEnabled: false } as const;

export * from './marketplace.js';
