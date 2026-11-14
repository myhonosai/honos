import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_UNLISTED_ROUTES, schoolShellActiveItem, schoolShellHref } from '../src/components/school-shell/catalog';
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
  it('follows the owner blueprint areas, in order, with unique keys and no duplicated route', () => {
    expect(SCHOOL_SHELL_NAV.map(item => item.key)).toEqual(['home', 'hon', 'aiTeam', 'crm', 'students', 'billing', 'classes', 'attendance',
      'marketing', 'referrals', 'community', 'analytics', 'staff', 'settings']);
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

  it('lists the whole AI team page first under AI Team, and keeps the human-only Teaching studio out of it', () => {
    const ai = SCHOOL_SHELL_NAV.find(item => item.key === 'aiTeam')!;
    expect(ai.routes.map(route => route.href)).toEqual(['/staff/ai-team', '/staff/leads/assistant', '/staff/marketing/assistant', '/staff/teaching-assistant', '/staff/retention/at-risk']);
    expect(schoolShellActiveItem('/staff/teaching-studio')?.key).toBe('attendance');
  });

  it('resolves the active primary item from the path, including sub-routes and dynamic detail pages', () => {
    expect(schoolShellActiveItem('/staff/dashboard')?.key).toBe('home');
    expect(schoolShellActiveItem('/staff/crm/follow-ups')?.key).toBe('crm');
    expect(schoolShellActiveItem('/staff/billing/invoices')?.key).toBe('billing');
    expect(schoolShellActiveItem('/staff/teaching-assistant')?.key).toBe('aiTeam');
    expect(schoolShellActiveItem('/staff/search/a/b/c/d')?.key).toBe('students');
    expect(schoolShellActiveItem('/staff/unknown')).toBeNull();
  });
});
