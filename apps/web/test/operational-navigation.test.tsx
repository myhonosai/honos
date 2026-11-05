import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { parseOperationalSchoolSelectors, schoolWorkflowLinks } from '../src/components/operational-navigation';
import { SchoolOperationsNavigation } from '../src/components/school-operations-navigation';
import { entryText } from '../src/components/school-entry/copy';
const h = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = { organizationId: id(1), schoolId: id(2) }, b = { organizationId: id(3), schoolId: id(4) };
type El = ReactElement<Record<string, any>>;
const nodes = (value: unknown): El[] => Array.isArray(value) ? value.flatMap(nodes) : React.isValidElement(value) ? [value as El, ...nodes((value as El).props.children)] : [];
afterEach(() => vi.restoreAllMocks());

it('normalizes only a complete inert pair and performs no reads or commands', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  expect(parseOperationalSchoolSelectors({ organizationId: 'ABCDEF12-0000-4000-8000-000000000001', schoolId: a.schoolId })).toEqual({ initialOrganizationId: 'abcdef12-0000-4000-8000-000000000001', initialSchoolId: a.schoolId });
  for (const query of [null, [], '', {}, { organizationId: a.organizationId }, { schoolId: a.schoolId }, { ...a, organizationId: [a.organizationId] }, { ...a, schoolId: [a.schoolId, b.schoolId] }, { ...a, schoolId: 'bad' }, { ...a, organizationId: ` ${a.organizationId}` }, ...['role', 'familyId', 'studentId', 'membershipId', 'token', 'retryId'].map(key => ({ ...a, [key]: id(90) }))]) expect(parseOperationalSchoolSelectors(query)).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
});
it.each([a, b])('preserves both selectors for school $schoolId through a closed route set', scope => {
  const links = schoolWorkflowLinks({ ...scope, extraReportFact: 'not serialized' } as typeof scope);
  expect(links.map(link => link.key)).toEqual(['crm', 'registration', 'membership', 'booking', 'attendance', 'dashboard', 'team', 'family']);
  for (const link of links) {
    const url = new URL(link.href, 'https://hon.invalid');
    expect(url.origin).toBe('https://hon.invalid');
    expect([...url.searchParams.entries()]).toEqual(Object.entries(scope));
    expect(['/staff/crm/journey', '/staff/dashboard', '/staff/team/invitations', '/staff/family-access']).toContain(url.pathname);
  }
  expect(schoolWorkflowLinks({ ...scope, schoolId: 'invalid' })).toEqual([]);
});
it.each(['en', 'ko', 'es'])('%s exposes ordinary keyboard-native links, localized help and an identifier-free school entry return', language => {
  h.language = language; const fetch = vi.spyOn(globalThis, 'fetch');
  const tree = SchoolOperationsNavigation({ scope: a, current: 'dashboard', blocked: false, canNavigate: () => true });
  const html = renderToStaticMarkup(tree);
  expect(html).toContain(`aria-label="${entryText(language, 'operations')}"`);
  for (const key of ['team', 'family', 'navigationHelp', 'backToEntry'] as const) expect(html).toContain(entryText(language, key));
  const links = nodes(tree).filter(node => node.type === 'a');
  expect(links.every(link => typeof link.props.href === 'string' && !('tabIndex' in link.props) && !link.props['aria-disabled'])).toBe(true);
  expect(links[0]!.props.href).toBe('/staff/entry');
  expect(fetch).not.toHaveBeenCalled();
});
it('disables pending navigation and rejects a retained callback after authority or revision changes', () => {
  let current = true;
  const tree = SchoolOperationsNavigation({ scope: a, current: 'crm', blocked: false, canNavigate: () => current });
  const anchor = nodes(tree).find(node => node.props['data-testid'] === 'operations-team')!;
  const allowed = { preventDefault: vi.fn() }; anchor.props.onClick(allowed); expect(allowed.preventDefault).not.toHaveBeenCalled();
  current = false; const stale = { preventDefault: vi.fn() }; anchor.props.onClick(stale); expect(stale.preventDefault).toHaveBeenCalledOnce();
  for (const blocked of [false, true]) {
    const anchors = nodes(SchoolOperationsNavigation({ scope: b, current: 'crm', blocked, canNavigate: () => false })).filter(node => node.type === 'a');
    expect(anchors.every(link => !link.props.href && link.props['aria-disabled'])).toBe(true);
  }
  // CRM membership/booking/attendance remain inside the existing student-bound journey.
  expect(nodes(tree).some(node => ['operations-membership', 'operations-booking', 'operations-attendance'].includes(node.props['data-testid']))).toBe(false);
});
