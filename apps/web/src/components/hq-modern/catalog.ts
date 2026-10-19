import { HON_HQ_EXECUTIVE_CATALOG } from '@hon/contracts';

export type HqView = 'big-button' | 'modern' | 'classic';
export type HqArt = 'realistic' | 'anime' | 'chibi';

export const HQ_VIEWS: readonly { key: HqView; label: string }[] = [
  { key: 'big-button', label: 'Big Button' }, { key: 'modern', label: 'Modern' }, { key: 'classic', label: 'Classic' },
];
export const HQ_ART: readonly { key: HqArt; label: string }[] = [
  { key: 'realistic', label: 'Realistic' }, { key: 'anime', label: 'Anime' }, { key: 'chibi', label: 'Chibi' },
];

/** Static HQ presentation only. No domain selectors, authority or customer facts. */
export const HQ_EXECUTIVES = HON_HQ_EXECUTIVE_CATALOG.filter((entry) => entry.executiveKey !== 'hon');
export const HQ_RESPONSIBILITIES: Readonly<Record<string, string>> = {
  chase: 'Acquisition & campaigns', mia: 'Onboarding & retention', ethan: 'Roadmap & product quality',
  olivia: 'Revenue reporting & margins', ryan: 'Pipeline & conversion', sophia: 'Support & company operations',
};

export const HQ_GROWTH = [
  { path: '/hq/growth/champions-club', title: 'Champions Club', icon: 'trophy' },
  { path: '/hq/growth/leaderboard', title: 'Referral Leaderboard', icon: 'chart' },
  { path: '/hq/growth/contests', title: 'Referral Contests', icon: 'flag' },
  { path: '/hq/growth/rewards', title: 'Reward Management', icon: 'gift' },
  { path: '/hq/growth/founder-campaigns', title: 'Founder Campaigns', icon: 'target' },
] as const;
export const HQ_NAV = [
  { path: '/hq', title: 'Overview', icon: 'home' },
  { path: '/hq/executives', title: 'Executive Team', icon: 'team' },
  { path: '/hq/schools', title: 'Schools', icon: 'school' },
  { path: '/hq/revenue', title: 'Revenue', icon: 'chart' },
  { path: '/hq/ai-costs', title: 'AI Costs', icon: 'database' },
  { path: '/hq/growth', title: 'Growth & Referrals', icon: 'growth' },
  { path: '/hq/approvals', title: 'Approvals', icon: 'check' },
  { path: '/hq/support', title: 'Support', icon: 'support' },
  { path: '/hq/ai-providers', title: 'AI Providers', icon: 'settings' },
] as const;

export const HQ_PLANNED: Readonly<Record<string, { title: string; description: string; areas: readonly string[] }>> = {
  '/hq/revenue': { title: 'Revenue', description: 'Company revenue reporting requires an authoritative HQ financial projection.', areas: ['MRR & ARR', 'Cash & refunds', 'Gross margin'] },
  '/hq/ai-costs': { title: 'AI Costs', description: 'Verified provider costs, usage and allowance accounting are not available in HQ-1.', areas: ['Usage & spend', 'Provider reconciliation', 'School contribution'] },
  '/hq/approvals': { title: 'Approvals', description: 'An HQ approval queue is not available. School approval authority is separate and is not reused here.', areas: ['Pending decisions', 'Approval history', 'Policy evidence'] },
  '/hq/support': { title: 'Support', description: 'HQ support cases and escalations are not available. This interface does not grant school access or impersonation.', areas: ['Cases & escalations', 'Failed operations', 'Owner decisions'] },
  '/hq/growth': { title: 'Growth & Referrals', description: 'HON company growth operations, governed by the owner. No campaign, contest or reward is active from this interface.', areas: ['Champions Club', 'Referral competitions', 'Founder campaigns'] },
  '/hq/growth/champions-club': { title: 'Champions Club', description: 'The permanent school referral program. Qualification, attribution and reward accounting require approved services before activation.', areas: ['Referral invitations', 'Qualified milestones', 'Member progress'] },
  '/hq/growth/contests': { title: 'Referral Contests', description: 'Owner-controlled competitions. Publishing, changing live rules and awarding prizes require independently authorized workflows.', areas: ['Draft & schedule', 'Launch & pause', 'End & review winners'] },
  '/hq/growth/rewards': { title: 'Reward Management', description: 'Review qualified rewards and liabilities before approved fulfillment. No credit, refund, gift or financial grant is issued here.', areas: ['Eligibility review', 'Reward liabilities', 'Approved fulfillment'] },
  '/hq/growth/founder-campaigns': { title: 'Founder Campaigns', description: 'Plan HON founder offers using owner-approved commercial policy. No checkout, published inventory or campaign delivery is active here.', areas: ['Founding 50', 'Campaign planning', 'Offer readiness'] },
};

/** Unknown paths never become assistant context. Query values are intentionally excluded. */
export function hqPageLabel(path: string): string {
  if (path === '/hq/growth/champions-club/schools') return 'School referrals';
  const fixed = [...HQ_NAV, ...HQ_GROWTH].find((item) => item.path === path);
  if (fixed) return fixed.title;
  const executive = HQ_EXECUTIVES.find((entry) => path === `/hq/executives/${entry.executiveKey}`);
  return executive ? `${executive.displayName} workspace` : 'HQ workspace';
}
