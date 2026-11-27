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

/**
 * HQ menu (owner, 2026-11-24): seven sections like an agency view. Home, Schools, Plans & Billing, Grow,
 * Messages & Support, AI Team, Settings. Every page keeps its URL; only where it sits in the menu changed.
 */
export const HQ_GROWTH = [
  { path: '/hq/growth/champions-club', title: 'Champions Club', icon: 'trophy' },
  { path: '/hq/growth/leaderboard', title: 'Referral Leaderboard', icon: 'chart' },
  { path: '/hq/growth/contests', title: 'Referral Contests', icon: 'flag' },
  { path: '/hq/growth/rewards', title: 'Reward Management', icon: 'gift' },
  { path: '/hq/growth/founder-campaigns', title: 'Founder Campaigns', icon: 'target' },
  { path: '/hq/growth/prospects', title: 'Prospects', icon: 'team' },
  { path: '/hq/marketing', title: 'Marketing & Creative', icon: 'target' },
  { path: '/hq/marketing/creative/designs', title: 'Flyers & posters', icon: 'gift' },
] as const;
export const HQ_SCHOOLS = [
  { path: '/hq/schools', title: 'All schools', icon: 'school' },
  { path: '/hq/schools/attention', title: 'Needs Attention', icon: 'flag' },
  { path: '/hq/schools/owners', title: 'School Owners', icon: 'team' },
  { path: '/hq/school-owner-invitations', title: 'Owner invitations', icon: 'support' },
  { path: '/hq/schools/access', title: 'School Access', icon: 'check' },
  { path: '/hq/schools/access/policy', title: 'Exception Policy', icon: 'settings' },
] as const;
export const HQ_REVENUE = [
  { path: '/hq/pricing-offers', title: 'Pricing & Offers', icon: 'settings' },
  { path: '/hq/marketing/promotions', title: 'Plan promotions', icon: 'gift' },
  { path: '/hq/revenue', title: 'Subscriptions', icon: 'chart' },
  { path: '/hq/revenue/business-numbers', title: 'Business Numbers', icon: 'chart' },
  { path: '/hq/revenue/invoices', title: 'Invoices', icon: 'database' },
  { path: '/hq/revenue/trials', title: 'Free Trials', icon: 'flag' },
  { path: '/hq/revenue/founder-billing', title: 'Founder Billing', icon: 'flag' },
  { path: '/hq/creative-credits', title: 'Creative Credits', icon: 'chart' },
  { path: '/hq/revenue/sign-up-limits', title: 'Sign-up Limits', icon: 'settings' },
] as const;
export const HQ_AI = [
  { path: '/hq/executives', title: 'Executive Team', icon: 'team' },
  { path: '/hq/ai-costs', title: 'AI Costs', icon: 'database' },
  { path: '/hq/creative-limits', title: 'Creative Spend Limits', icon: 'settings' },
  { path: '/hq/conversation-ai', title: 'Conversation AI', icon: 'settings' },
  { path: '/hq/ai-safety', title: 'AI Safety', icon: 'check' },
] as const;
export const HQ_INBOX = [
  { path: '/hq/approvals', title: 'Approvals', icon: 'check' },
  { path: '/hq/support', title: 'Support', icon: 'support' },
  { path: '/hq/communications', title: 'Texts & Email', icon: 'support' },
  { path: '/hq/communications/numbers', title: 'School texting numbers', icon: 'settings' },
] as const;
export const HQ_SETTINGS = [
  { path: '/hq/founder-setup', title: 'Setup guide', icon: 'flag' },
  { path: '/hq/ai-providers', title: 'AI Providers', icon: 'settings' },
  { path: '/hq/integrations/zernio', title: 'Zernio connection', icon: 'settings' },
] as const;
/** Top-level HQ entries. A grouped entry's path is a route inside that group; grouped children keep their existing URLs. */
export const HQ_NAV = [
  { path: '/hq', title: 'Home', icon: 'home' },
  { path: '/hq/schools', title: 'Schools', icon: 'school' },
  { path: '/hq/revenue', title: 'Plans & Billing', icon: 'chart' },
  { path: '/hq/growth', title: 'Grow', icon: 'growth' },
  { path: '/hq/support', title: 'Messages & Support', icon: 'support' },
  { path: '/hq/executives', title: 'AI Team', icon: 'team' },
  { path: '/hq/ai-providers', title: 'Settings', icon: 'settings' },
] as const;
type HqNavLink = { readonly path: string; readonly title: string; readonly icon: string };
export type HqNavGroup = { readonly key: 'schools' | 'billing' | 'growth' | 'inbox' | 'ai' | 'settings'; readonly title: string; readonly icon: string; readonly overview?: HqNavLink; readonly children: readonly HqNavLink[] };
/** Desktop rail and mobile drawer share this one structure. */
export const HQ_NAV_GROUPS: Readonly<Record<string, HqNavGroup>> = {
  '/hq/schools': { key: 'schools', title: 'Schools', icon: 'school', children: HQ_SCHOOLS },
  '/hq/revenue': { key: 'billing', title: 'Plans & Billing', icon: 'chart', children: HQ_REVENUE },
  '/hq/growth': { key: 'growth', title: 'Grow', icon: 'growth', overview: { path: '/hq/growth', title: 'Growth overview', icon: 'growth' }, children: HQ_GROWTH },
  '/hq/support': { key: 'inbox', title: 'Messages & Support', icon: 'support', children: HQ_INBOX },
  '/hq/executives': { key: 'ai', title: 'AI Team', icon: 'team', children: HQ_AI },
  '/hq/ai-providers': { key: 'settings', title: 'Settings', icon: 'settings', children: HQ_SETTINGS },
};
/** Every menu link once, in menu order. */
export function hqNavLinks(): readonly HqNavLink[] {
  return HQ_NAV.flatMap((item) => {
    const group = HQ_NAV_GROUPS[item.path];
    return group ? [...(group.overview ? [group.overview] : []), ...group.children] : [item];
  });
}
/** The one menu link for a page: an exact match, else the longest link whose path the page sits under ("/hq" only matches itself). */
export function hqNavMatch(path: string): string | null {
  let best: string | null = null;
  for (const { path: link } of hqNavLinks()) {
    const hit = path === link || (link !== '/hq' && path.startsWith(`${link}/`));
    if (hit && (best === null || link.length > best.length)) best = link;
  }
  return best;
}
/** True when a path belongs to a group, so the group opens for the current page. */
export function hqGroupContains(group: HqNavGroup, path: string): boolean {
  const match = hqNavMatch(path);
  return match !== null && [...(group.overview ? [group.overview] : []), ...group.children].some((item) => item.path === match);
}

export const HQ_PLANNED: Readonly<Record<string, { title: string; description: string; areas: readonly string[] }>> = {
  '/hq/revenue': { title: 'Revenue', description: 'Revenue totals will show here once billing is live.', areas: ['MRR & ARR', 'Cash & refunds', 'Gross margin'] },
  '/hq/approvals': { title: 'Approvals', description: 'A list of things waiting for your OK will show here. It isn’t built yet.', areas: ['Pending decisions', 'Approval history', 'Policy evidence'] },
  '/hq/growth': { title: 'Growth & Referrals', description: 'Everything that helps HON get more schools: referrals, contests, rewards, founder offers and prospects.', areas: ['Champions Club', 'Referral competitions', 'Founder campaigns'] },
  '/hq/growth/champions-club': { title: 'Champions Club', description: 'HON’s referral program for schools: who referred whom and what they earned.', areas: ['Referral invitations', 'Qualified milestones', 'Member progress'] },
  '/hq/growth/rewards': { title: 'Reward Management', description: 'Rewards schools have earned and whether they’ve been given out. Nothing is paid from here.', areas: ['Eligibility review', 'Reward liabilities', 'Approved fulfillment'] },
  '/hq/growth/founder-campaigns': { title: 'Founder Campaigns', description: 'Plan founder offers. Checkout and sending aren’t switched on yet.', areas: ['Founding 50', 'Campaign planning', 'Offer readiness'] },
};

/** Unknown paths never become assistant context. Query values are intentionally excluded. */
export function hqPageLabel(path: string): string {
  if (path === '/hq/revenue/invoices') return 'Invoices';
  if (/^\/hq\/revenue\/invoices\/[0-9a-f-]{36}$/i.test(path)) return 'Invoice detail';
  if (path === '/hq/growth/champions-club/schools') return 'School referrals';
  if (/^\/hq\/schools\/[0-9a-f-]{36}$/i.test(path)) return 'School detail';
  if (/^\/hq\/support\/[0-9a-f-]{36}$/i.test(path)) return 'Support case';
  if (/^\/hq\/communications\/[0-9a-f-]{36}$/i.test(path)) return 'HQ message';
  if (/^\/hq\/growth\/prospects\/[0-9a-f-]{36}$/i.test(path)) return 'Prospect';
  if (/^\/hq\/growth\/contests\/[0-9a-f-]{36}$/i.test(path)) return 'Contest detail';
  if (path === '/hq/schools') return 'Schools';
  if (path === '/hq/marketing/creative') return 'Creative Studio';
  if (path === '/hq/marketing/creative/designs') return 'Flyers & posters';
  const fixed = [...HQ_REVENUE, ...HQ_AI, ...HQ_GROWTH, ...HQ_INBOX, ...HQ_SETTINGS, ...HQ_SCHOOLS, ...HQ_NAV].find((item) => item.path === path);
  if (fixed) return fixed.title;
  const executive = HQ_EXECUTIVES.find((entry) => path === `/hq/executives/${entry.executiveKey}`);
  return executive ? `${executive.displayName} workspace` : 'HQ workspace';
}
