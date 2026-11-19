import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_SECTIONS, SCHOOL_SHELL_UNLISTED_ROUTES, schoolShellActiveItem, schoolShellHref, schoolShellListed, schoolShellSectionItems } from '../src/components/school-shell/catalog';
import { shellText, SHELL_LANGUAGES } from '../src/components/school-shell/copy';

const APP = join(__dirname, '../src/app');
function staffPages(dir = join(APP, 'staff')): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return staffPages(path);
    return name === 'page.tsx' ? ['/' + relative(APP, dir).replaceAll('\\', '/')] : [];
  });
}
const pageExists = (href: string) => existsSync(join(APP, href.split('?')[0]!, 'page.tsx'));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

describe('school shell navigation catalog', () => {
  it('follows the owner\'s menu (2026-11-16): eleven headings with their pages, Settings at the bottom, no duplicated route', () => {
    expect(SCHOOL_SHELL_SECTIONS.map(section => shellText('en', section.titleKey))).toEqual(['Dashboard', 'AI', 'Calendar', 'Contacts', 'Lead', 'Communication', 'Finance', 'Marketing', 'Ranks', 'Business', 'Community']);
    const menu = Object.fromEntries(SCHOOL_SHELL_SECTIONS.map(section => [section.key, schoolShellSectionItems(section.key).map(item => shellText('en', item.titleKey))]));
    expect(menu).toEqual({
      dashboard: ['Dashboard', 'Ask HON'], ai: ['AI Team', 'Conversation AI'], calendar: ['Calendar', 'Attendance'], contacts: ['Contact list', 'Staff'],
      leads: ['Lead pipeline', 'Automations'], communication: ['Texts', 'Parent app', 'Facebook & Instagram'], finance: ['Checkout Pages', 'Shopify', 'Invoices'],
      marketing: ['Website', 'Marketing', 'Ads', 'Creative Studio'], ranks: ['Rank setup', 'Tests', 'Mass rank promotion'], business: ['Membership', 'Reports'], community: ['Community'],
    });
    expect(SCHOOL_SHELL_NAV.filter(item => !item.section).map(item => item.key)).toEqual(['settings']);
    expect(SCHOOL_SHELL_NAV.at(-1)?.key).toBe('settings');
    expect(new Set(SCHOOL_SHELL_NAV.map(item => item.key)).size).toBe(SCHOOL_SHELL_NAV.length);
    const hrefs = SCHOOL_SHELL_NAV.flatMap(item => item.routes.map(route => route.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('only links to routes that exist', () => {
    for (const item of SCHOOL_SHELL_NAV) for (const route of item.routes) expect(pageExists(route.href), route.href).toBe(true);
  });

  it('covers every /staff page as a nav route or an explicitly listed detail route', () => {
    const covered = new Set<string>([...SCHOOL_SHELL_NAV.flatMap(item => item.routes.map(route => route.href)), ...SCHOOL_SHELL_UNLISTED_ROUTES]);
    const missing = staffPages().filter(page => !covered.has(page));
    expect(missing).toEqual([]);
  });

  it('every item and route title has en/ko/es copy', () => {
    for (const language of SHELL_LANGUAGES) for (const item of SCHOOL_SHELL_NAV) {
      expect(shellText(language, item.titleKey)).toBeTruthy();
      for (const route of item.routes) expect(shellText(language, route.titleKey)).toBeTruthy();
    }
  });

  it('appends only the closed verified school prefill, and only for scoped routes', () => {
    const scoped = SCHOOL_SHELL_NAV.flatMap(item => item.routes).find(route => route.scoped)!;
    const unscoped = SCHOOL_SHELL_NAV.flatMap(item => item.routes).find(route => !route.scoped)!;
    expect(schoolShellHref(scoped, { organizationId: A, schoolId: B })).toBe(`${scoped.href}?organizationId=${A}&schoolId=${B}`);
    expect(schoolShellHref(scoped, null)).toBe(scoped.href);
    expect(schoolShellHref(unscoped, { organizationId: A, schoolId: B })).toBe(unscoped.href);
  });

  it('never appends malformed or partial selectors', () => {
    const scoped = SCHOOL_SHELL_NAV.flatMap(item => item.routes).find(route => route.scoped)!;
    expect(schoolShellHref(scoped, { organizationId: 'x', schoolId: B })).toBe(scoped.href);
    expect(schoolShellHref(scoped, { organizationId: A, schoolId: `${B}&role=owner` })).toBe(scoped.href);
  });

  it('opens AI Team on the whole team, with each specialist\'s workspace reached from its card, and keeps the human-only Teaching studio under Ranks', () => {
    const ai = SCHOOL_SHELL_NAV.find(item => item.key === 'aiTeam')!;
    expect(schoolShellListed(ai).map(route => route.href)).toEqual(['/staff/ai-team', '/staff/action-center/approvals', '/staff/ai-work', '/staff/voice']);
    for (const href of ['/staff/leads/assistant', '/staff/marketing/assistant', '/staff/teaching-assistant', '/staff/retention/at-risk']) expect(schoolShellActiveItem(href)?.key).toBe('aiTeam');
    expect(schoolShellActiveItem('/staff/teaching-studio')?.key).toBe('ranks');
  });

  it('puts every former page where the owner\'s menu says', () => {
    const where: Record<string, string> = {
      '/staff/team/invitations': 'staff', '/staff/roles': 'staff', '/staff/texts': 'messages', '/staff/texts/send': 'messages', '/staff/conversations/train-ai': 'conversationAi', '/staff/family-messages': 'parentApp',
      '/staff/marketing/social': 'social', '/staff/marketing/campaigns': 'marketing', '/staff/champions-club': 'marketing', '/staff/creative-studio': 'creative', '/staff/marketing/ads': 'ads',
      '/staff/automations': 'automation', '/staff/automation/rules': 'automation', '/staff/operations': 'analytics', '/staff/retention/review': 'analytics', '/community/marketplace': 'community',
      '/staff/testing/promotion-decisions': 'promotions', '/staff/billing/payment-processors': 'settings', '/staff/attendance/planned-absences': 'attendance',
    };
    for (const [href, key] of Object.entries(where)) expect(schoolShellActiveItem(href)?.key, href).toBe(key);
  });

  it('keeps every page short (at most seven tabs, Settings aside), and hidden routes are still linked from the app', () => {
    const SOURCE = join(__dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !path.endsWith('school-shell/catalog.ts') ? [path] : []; });
    const text = files(SOURCE).map(file => readFileSync(file, 'utf8')).join('\n');
    for (const item of SCHOOL_SHELL_NAV) {
      // Settings is one page with a wrapped row of tabs, like the owner's CRM.
      if (item.key !== 'settings') expect(schoolShellListed(item).length, item.key).toBeLessThanOrEqual(7);
      expect(item.routes[0]!.hidden, item.key).toBeFalsy();
      for (const route of item.routes.filter(candidate => candidate.hidden)) expect(text.includes(`'${route.href}'`) || text.includes(`"${route.href}"`), route.href).toBe(true);
    }
  });

  it('makes Tests one page of six ordered steps that opens at "Who is ready" (L3)', () => {
    const testing = SCHOOL_SHELL_NAV.find(item => item.key === 'testing')!;
    expect(testing.steps).toBe(true);
    expect(schoolShellListed(testing).map(route => route.href)).toEqual(['/staff/testing/readiness', '/staff/testing/registrations',
      '/staff/testing/candidates/register', '/staff/testing/candidates/grade', '/staff/testing/scorecards', '/staff/testing/certificates']);
    expect(SCHOOL_SHELL_UNLISTED_ROUTES).not.toContain('/staff/testing/candidates/register');
    expect(SCHOOL_SHELL_UNLISTED_ROUTES).not.toContain('/staff/testing/candidates/grade');
    expect(schoolShellActiveItem('/staff/testing/candidates/grade')?.key).toBe('testing');
    expect(SCHOOL_SHELL_NAV.filter(item => item.steps).map(item => item.key)).toEqual(['testing']);
  });

  it('resolves the active primary item from the path, including sub-routes and dynamic detail pages', () => {
    expect(schoolShellActiveItem('/staff/dashboard')?.key).toBe('home');
    expect(schoolShellActiveItem('/staff/crm/follow-ups')?.key).toBe('crm');
    expect(schoolShellActiveItem('/staff/billing/invoices')?.key).toBe('invoices');
    expect(schoolShellActiveItem('/staff/teaching-assistant')?.key).toBe('aiTeam');
    expect(schoolShellActiveItem('/staff/schedule/timetable')?.key).toBe('classes');
    expect(schoolShellActiveItem('/staff/search/a/b/c/d')?.key).toBe('students');
    expect(schoolShellActiveItem('/staff/unknown')).toBeNull();
  });
});
