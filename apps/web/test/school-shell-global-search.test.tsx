import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StaffSearchResult } from '@hon/contracts';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { GlobalSearch } from '../src/components/school-shell/global-search';
import { SCHOOL_SHELL_NAV, schoolShellListed } from '../src/components/school-shell/catalog';
import { shellText } from '../src/components/school-shell/copy';
import { GlobalSearchRunner, SEARCH_DEBOUNCE_MS, contactHref, isSearchShortcut, moveActive, orderedHits, searchPages, searchQuery,
  type SearchReads, type SearchView } from '../src/components/school-shell/global-search-model';

const ORG = '11111111-1111-4111-8111-111111111111', SCHOOL = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333', L1 = '44444444-4444-4444-8444-444444444444';
const scope = { organizationId: ORG, schoolId: SCHOOL };
const lead: StaffSearchResult = { kind: 'LEAD', entityId: L1, title: 'Sam Rivera', subtitle: 'New lead', route: `/staff/search/${ORG}/${SCHOOL}/LEAD/${L1}` };
const contact = { personId: P1, givenName: 'Sam', familyName: 'Lee', email: 'sam@example.test', phoneE164: null };

afterEach(() => { vi.useRealTimers(); });

describe('page search', () => {
  it('lists the menu pages for an empty query, in menu order, never hidden workflow routes', () => {
    const hits = searchPages('en', '', null);
    expect(hits.map(hit => hit.title)).toEqual(SCHOOL_SHELL_NAV.map(item => shellText('en', item.titleKey)));
    const hidden = SCHOOL_SHELL_NAV.flatMap(item => item.routes.filter(route => route.hidden).map(route => route.href));
    expect(hidden.length).toBeGreaterThan(0);
    for (const query of ['', 'enroll', 'journey', 'rules']) for (const hit of searchPages('en', query, null)) expect(hidden).not.toContain(hit.href.split('?')[0]);
  });

  it('matches page, tab and heading names, every word, best title matches first', () => {
    const invoices = searchPages('en', 'invoi', null);
    expect(invoices[0]).toMatchObject({ group: 'PAGES', title: 'Invoices', href: '/staff/billing/invoices' });
    // A tab is found by its own name and says where it lives.
    expect(searchPages('en', 'planned abs', null)[0]).toMatchObject({ title: 'Planned absences', subtitle: 'Calendar · Attendance', href: '/staff/attendance/planned-absences' });
    // The heading matches too: "finance" finds the Finance pages.
    expect(searchPages('en', 'finance', null).map(hit => hit.title)).toEqual(expect.arrayContaining(['Checkout Pages', 'Point of Sale', 'Invoices']));
    expect(searchPages('en', 'zzzz nothing', null)).toEqual([]);
  });

  it('searches in the viewer language and adds the verified prefill only to scoped routes', () => {
    expect(searchPages('ko', '출석', null).some(hit => hit.href === '/staff/attendance')).toBe(true);
    expect(searchPages('es', 'factur', null).length).toBeGreaterThan(0);
    const scoped = searchPages('en', 'attendance', scope).find(hit => hit.title === 'Attendance')!;
    expect(scoped.href).toBe(`/staff/attendance?organizationId=${ORG}&schoolId=${SCHOOL}`);
    expect(searchPages('en', 'invoices', scope)[0]!.href).toBe('/staff/billing/invoices');
  });

  it('covers every listed menu tab', () => {
    for (const item of SCHOOL_SHELL_NAV) for (const route of schoolShellListed(item))
      expect(searchPages('en', shellText('en', route.titleKey), null).some(hit => hit.href === route.href), route.href).toBe(true);
  });
});

describe('links and keys', () => {
  it('opens a contact on the contact list by person id only', () => {
    expect(contactHref(P1.toUpperCase())).toBe(`/staff/people?person=${P1}`);
    expect(() => contactHref('../x')).toThrow();
  });
  it('bounds the query and moves through results with wrap-around', () => {
    expect(Array.from(searchQuery(`  ${'a'.repeat(300)}  `))).toHaveLength(120);
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0); expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2); expect(moveActive(-1, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(1, 3, 'End')).toBe(2); expect(moveActive(1, 0, 'ArrowDown')).toBe(-1);
  });
  it('opens on Ctrl+K and Cmd+K only', () => {
    const key = (k: Partial<KeyboardEvent>) => isSearchShortcut({ key: 'k', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...k });
    expect(key({ ctrlKey: true })).toBe(true); expect(key({ metaKey: true, key: 'K' })).toBe(true);
    expect(key({})).toBe(false); expect(key({ ctrlKey: true, shiftKey: true })).toBe(false); expect(key({ ctrlKey: true, key: 'j' })).toBe(false);
  });
});

function runner(reads: Partial<SearchReads> = {}) {
  const views: SearchView[] = [];
  const calls = { contacts: vi.fn(reads.contacts ?? (async () => [contact])), records: vi.fn(reads.records ?? (async () => [lead])) };
  const r = new GlobalSearchRunner(calls, 'en', view => views.push(view));
  return { r, calls, views, last: () => views[views.length - 1]! };
}
const flush = async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS); await Promise.resolve(); await Promise.resolve(); };

describe('remote search runner', () => {
  it('reads contacts and records for the verified school after 2 characters, grouped with pages last', async () => {
    vi.useFakeTimers();
    const { r, calls, last } = runner();
    r.search('s', scope);
    await flush();
    expect(calls.contacts).not.toHaveBeenCalled();
    r.search('sa', scope);
    expect(last()).toMatchObject({ contactState: 'LOADING', recordState: 'LOADING' });
    await flush();
    expect(calls.contacts).toHaveBeenCalledWith(scope, 'sa', expect.any(AbortSignal));
    expect(calls.records).toHaveBeenCalledWith(scope, 'sa', expect.any(AbortSignal));
    const view = last();
    expect(view).toMatchObject({ contactState: 'READY', recordState: 'READY' });
    const hits = orderedHits(view);
    expect(hits[0]).toMatchObject({ group: 'CONTACTS', title: 'Sam Lee', subtitle: 'sam@example.test', href: `/staff/people?person=${P1}` });
    expect(hits[1]).toMatchObject({ group: 'LEADS', title: 'Sam Rivera', href: lead.route });
    expect(hits.slice(2).every(hit => hit.group === 'PAGES')).toBe(true);
  });

  it('never reads without a verified school', async () => {
    vi.useFakeTimers();
    const { r, calls, last } = runner();
    r.search('invoices', null);
    await flush();
    expect(calls.contacts).not.toHaveBeenCalled(); expect(calls.records).not.toHaveBeenCalled();
    expect(last().pages[0]!.title).toBe('Invoices');
  });

  it('debounces typing and aborts the previous query, never showing a stale answer', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let release: (rows: typeof contact[]) => void = () => {};
    const { r, calls, last } = runner({ contacts: (_s, _q, signal) => { signals.push(signal); return new Promise(resolve => { release = resolve; }); } });
    r.search('sa', scope); r.search('sam', scope);
    await flush();
    expect(calls.contacts).toHaveBeenCalledTimes(1);
    r.search('samx', scope);
    expect(signals[0]!.aborted).toBe(true);
    release([contact]); await Promise.resolve(); await Promise.resolve();
    expect(last().contacts).toEqual([]);
    expect(last().query).toBe('samx');
  });

  it('a failed group does not hide the others', async () => {
    vi.useFakeTimers();
    const { r, last } = runner({ contacts: async () => { throw new Error('denied'); } });
    r.search('sam', scope);
    await flush();
    expect(last()).toMatchObject({ contactState: 'FAILED', recordState: 'READY', contacts: [] });
    expect(last().records).toHaveLength(1);
  });

  it('clear drops every result and aborts reads in flight', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { r, last } = runner({ records: (_s, _q, signal) => { signals.push(signal); return new Promise(() => {}); } });
    r.search('sam', scope); await flush();
    r.clear();
    expect(signals[0]!.aborted).toBe(true);
    expect(last()).toMatchObject({ query: '', contacts: [], records: [], contactState: 'IDLE', recordState: 'IDLE' });
  });
});

const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: scope, schoolName: null, choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};
describe('shell frame', () => {
  it('puts a backdrop behind the Menu pop-up at every width that closes it on click', () => {
    const onMenu = vi.fn();
    const frame = SchoolShellFrame({ ...base, menuOpen: true, onMenu });
    const html = renderToStaticMarkup(frame);
    expect(html).toMatch(/data-menu-scrim="panel"/);
    expect(renderToStaticMarkup(<SchoolShellFrame {...base} mode="classic" menuOpen />)).toMatch(/data-menu-scrim="drawer"/);
    expect(renderToStaticMarkup(<SchoolShellFrame {...base} />)).not.toContain('data-menu-scrim');
    const find = (node: unknown): React.ReactElement<{ onClick?: () => void }> | null => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const child of node) { const hit = find(child); if (hit) return hit; } return null; }
      const element = node as React.ReactElement<{ children?: unknown; 'data-menu-scrim'?: string }>;
      if (element.props?.['data-menu-scrim'] === 'panel') return element as React.ReactElement<{ onClick?: () => void }>;
      return find(element.props?.children);
    };
    find(frame)!.props.onClick!();
    expect(onMenu).toHaveBeenCalledWith(false);
  });

  it('shows the search field in the top bar on every page, replacing the old search link', () => {
    const html = renderToStaticMarkup(<SchoolShellFrame {...base} search={<GlobalSearch language="en" selection={scope} />} />);
    expect(html).toMatch(/<header[^>]*>.*data-global-search-open="".*<\/header>/s);
    expect(html).toContain('Search contacts, leads, pages…');
    expect(html).not.toContain('href="/staff/search"');
    // Closed until opened: no results and no reads on render.
    expect(html).not.toContain('data-global-search=""');
  });
});
