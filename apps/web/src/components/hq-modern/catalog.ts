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
export const HQ_SCHOOLS = [
  { path: '/hq/schools', title: 'School Directory', icon: 'school' },
  { path: '/hq/schools/access', title: 'School Access', icon: 'check' },
  { path: '/hq/schools/access/policy', title: 'Exception Policy', icon: 'settings' },
  { path: '/hq/schools/owners', title: 'School Owners', icon: 'team' },
  { path: '/hq/schools/attention', title: 'Needs Attention', icon: 'flag' },
] as const;
export const HQ_REVENUE = [
  { path: '/hq/revenue', title: 'Subscriptions', icon: 'chart' },
  { path: '/hq/revenue/invoices', title: 'Invoices', icon: 'database' },
  { path: '/hq/pricing-offers', title: 'Pricing & Offers', icon: 'settings' },
] as const;
export const HQ_AI = [
  { path: '/hq/executives', title: 'Executive Team', icon: 'team' },
  { path: '/hq/ai-costs', title: 'AI Costs', icon: 'database' },
  { path: '/hq/ai-safety', title: 'AI Safety', icon: 'check' },
  { path: '/hq/ai-providers', title: 'AI Providers', icon: 'settings' },
] as const;
/** Top-level HQ entries. A grouped entry's path is a route inside that group; grouped children keep their existing URLs. */
export const HQ_NAV = [
  { path: '/hq', title: 'Overview', icon: 'home' },
  { path: '/hq/schools', title: 'Schools', icon: 'school' },
  { path: '/hq/revenue', title: 'Revenue', icon: 'chart' },
  { path: '/hq/executives', title: 'AI', icon: 'team' },
  { path: '/hq/growth', title: 'Growth & Referrals', icon: 'growth' },
  { path: '/hq/approvals', title: 'Approvals', icon: 'check' },
  { path: '/hq/support', title: 'Support', icon: 'support' },
] as const;
type HqNavLink = { readonly path: string; readonly title: string; readonly icon: string };
export type HqNavGroup = { readonly key: 'schools' | 'revenue' | 'ai' | 'growth'; readonly title: string; readonly icon: string; readonly overview?: HqNavLink; readonly children: readonly HqNavLink[] };
/** Desktop rail and mobile drawer share this one structure. */
export const HQ_NAV_GROUPS: Readonly<Record<string, HqNavGroup>> = {
  '/hq/schools': { key: 'schools', title: 'Schools', icon: 'school', children: HQ_SCHOOLS },
  '/hq/revenue': { key: 'revenue', title: 'Revenue', icon: 'chart', children: HQ_REVENUE },
  '/hq/executives': { key: 'ai', title: 'AI', icon: 'team', children: HQ_AI },
  '/hq/growth': { key: 'growth', title: 'Growth & Referrals', icon: 'growth', overview: { path: '/hq/growth', title: 'Growth overview', icon: 'growth' }, children: HQ_GROWTH },
};
/** True when a path belongs to a group, so the group opens for the current page. */
export function hqGroupContains(group: HqNavGroup, path: string): boolean {
  return [...(group.overview ? [group.overview] : []), ...group.children].some((item) => path === item.path || path.startsWith(`${item.path}/`));
}

export const HQ_PLANNED: Readonly<Record<string, { title: string; description: string; areas: readonly string[] }>> = {
  '/hq/revenue': { title: 'Revenue', description: 'Company revenue reporting requires an authoritative HQ financial projection.', areas: ['MRR & ARR', 'Cash & refunds', 'Gross margin'] },
  '/hq/approvals': { title: 'Approvals', description: 'An HQ approval queue is not available. School approval authority is separate and is not reused here.', areas: ['Pending decisions', 'Approval history', 'Policy evidence'] },
  '/hq/growth': { title: 'Growth & Referrals', description: 'HON company growth operations, governed by the owner. No campaign, contest or reward is active from this interface.', areas: ['Champions Club', 'Referral competitions', 'Founder campaigns'] },
  '/hq/growth/champions-club': { title: 'Champions Club', description: 'The permanent school referral program. Qualification, attribution and reward accounting require approved services before activation.', areas: ['Referral invitations', 'Qualified milestones', 'Member progress'] },
  '/hq/growth/contests': { title: 'Referral Contests', description: 'Owner-controlled competitions. Publishing, changing live rules and awarding prizes require independently authorized workflows.', areas: ['Draft & schedule', 'Launch & pause', 'End & review winners'] },
  '/hq/growth/rewards': { title: 'Reward Management', description: 'Review qualified rewards and liabilities before approved fulfillment. No credit, refund, gift or financial grant is issued here.', areas: ['Eligibility review', 'Reward liabilities', 'Approved fulfillment'] },
  '/hq/growth/founder-campaigns': { title: 'Founder Campaigns', description: 'Plan HON founder offers using owner-approved commercial policy. No checkout, published inventory or campaign delivery is active here.', areas: ['Founding 50', 'Campaign planning', 'Offer readiness'] },
};

/** Unknown paths never become assistant context. Query values are intentionally excluded. */
export function hqPageLabel(path: string): string {
  if (path === '/hq/revenue/invoices') return 'Invoices';
  if (/^\/hq\/revenue\/invoices\/[0-9a-f-]{36}$/i.test(path)) return 'Invoice detail';
  if (path === '/hq/growth/champions-club/schools') return 'School referrals';
  if (/^\/hq\/schools\/[0-9a-f-]{36}$/i.test(path)) return 'School detail';
  if (/^\/hq\/support\/[0-9a-f-]{36}$/i.test(path)) return 'Support case';
  if (path === '/hq/revenue') return 'Revenue';
  const fixed = [...HQ_REVENUE, ...HQ_AI, ...HQ_GROWTH, ...HQ_NAV, ...HQ_SCHOOLS].find((item) => item.path === path);
  if (fixed) return fixed.title;
  const executive = HQ_EXECUTIVES.find((entry) => path === `/hq/executives/${entry.executiveKey}`);
  return executive ? `${executive.displayName} workspace` : 'HQ workspace';
}
