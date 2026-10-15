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
