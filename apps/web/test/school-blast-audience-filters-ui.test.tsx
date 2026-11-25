import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateSaveSchoolBlast, type SchoolBlast } from '@hon/contracts';
import { BLAST_COPY } from '../src/components/school-blasts/copy';
import { NO_BLAST_FILTERS, NO_BELT, blastDraftOf, blastFilters, blastInput, blastProblems, filterCount, newBlastDraft, pickPerson, unpickPerson, type BlastDraft } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { id } from './account-status-fixtures';

// BL4 (0695): the Contacts list filters narrow the groups and tags; hand-picked people are reached as well.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const RANK = id(61), PROGRAM = id(62), PLAN = id(63), P1 = id(64), P2 = id(65), BLAST = id(66);
const base = (): BlastDraft => ({ ...newBlastDraft('EMAIL'), name: 'Renewals', subject: 'Hi', body: 'Hello {{first_name}}' });
const options = { ranks: [{ rankId: RANK, curriculum: 'Taekwondo', rank: 'Yellow' }], programs: [{ programId: PROGRAM, name: 'Little Tigers' }], plans: [{ planId: PLAN, name: 'Kids monthly' }], tags: [] };
function props(over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', blasts: [] }, selected: null, draft: base(),
    dirty: true, problems: [], preview: null, scheduleLocal: '', scheduleValid: false, ask: null, outcome: null, locked: false, canRetry: false,
    pictures: { state: 'READY', assets: [] }, filterOptions: { state: 'READY', options }, ...over };
}

it('sends only the filters that are set, with no belt and day windows in the server shape, and the contract accepts them', () => {
  expect(blastFilters(NO_BLAST_FILTERS)).toBeUndefined();
  expect(blastInput(base()).audience).toEqual({ groups: ['ACTIVE_STUDENTS'], tags: [] });
  const d = { ...base(), filters: { ...NO_BLAST_FILTERS, rankId: NO_BELT, programId: PROGRAM, planId: PLAN, membership: 'ACTIVE' as const, endsWithinDays: '30' as const, ageMin: '5', ageMax: '12' } };
  const audience = blastInput(d).audience;
  expect(audience.filters).toEqual({ noBelt: true, programId: PROGRAM, planId: PLAN, membership: 'ACTIVE', endsWithinDays: 30, ageMin: 5, ageMax: 12 });
  expect(filterCount(d.filters)).toBe(7);
  expect(validateSaveSchoolBlast(blastInput(d)).audience).toEqual(audience);
  expect(blastProblems(d)).toEqual([]);
  expect(blastInput({ ...base(), filters: { ...NO_BLAST_FILTERS, rankId: RANK, endsFrom: '2026-12-01', endsTo: '2026-12-31' } }).audience.filters).toEqual({ rankId: RANK, endsFrom: '2026-12-01', endsTo: '2026-12-31' });
});

it('refuses filters the server would refuse: bad or reversed ages, reversed dates', () => {
  for (const f of [{ ageMin: '12', ageMax: '5' }, { ageMin: '5.5' }, { ageMax: '121' }, { ageMin: '-1' }, { endsFrom: '2026-12-31', endsTo: '2026-12-01' }]) {
    expect(blastProblems({ ...base(), filters: { ...NO_BLAST_FILTERS, ...f } })).toEqual(['filters']);
  }
});

it('picked people are reached as well: no group is fine with someone picked, never more than 200, each person once', () => {
  const none = { ...base(), groups: [] as const };
  expect(blastProblems(none)).toEqual(['groups']);
  let people = pickPerson([], { personId: P1.toUpperCase(), name: 'Avery Kim' });
  people = pickPerson(people, { personId: P1, name: null });
  people = pickPerson(people, { personId: P2, name: 'Blake Lee' });
  expect(people).toEqual([{ personId: P1, name: 'Avery Kim' }, { personId: P2, name: 'Blake Lee' }]);
  expect(unpickPerson(people, P1)).toEqual([{ personId: P2, name: 'Blake Lee' }]);
  const picked = { ...none, people };
  expect(blastProblems(picked)).toEqual([]);
  expect(blastInput(picked).audience).toEqual({ groups: [], tags: [], people: [P1, P2] });
  expect(validateSaveSchoolBlast(blastInput(picked)).audience.people).toEqual([P1, P2]);
  const many = Array.from({ length: 201 }, (_, i) => ({ personId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: null }));
  expect(blastProblems({ ...picked, people: many })).toContain('people');
});

it('a saved draft reopens with its filters and picks; names come from this session, otherwise a plain label', () => {
  const blast = { blastId: BLAST, version: 3, name: 'Renewals', channel: 'SMS', subject: null, body: 'Hi',
    audience: { groups: ['ACTIVE_STUDENTS'], tags: ['vip'], filters: { noBelt: true, endsWithinDays: 60, ageMin: 7 }, people: [P1, P2] } } as unknown as SchoolBlast;
  const d = blastDraftOf(blast, new Map([[P1, 'Avery Kim']]));
  expect(d.filters).toEqual({ ...NO_BLAST_FILTERS, rankId: NO_BELT, endsWithinDays: '60', ageMin: '7' });
  expect(d.people).toEqual([{ personId: P1, name: 'Avery Kim' }, { personId: P2, name: null }]);
  expect(blastInput(d).audience).toEqual(blast.audience);
  const html = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: d })} />);
  expect(html).toContain('Avery Kim'); expect(html).toContain('Contact picked earlier'); expect(html).toContain('2 people picked');
  expect(html).toContain(`data-unpick="${P2}"`); expect(html).toContain('3 filters set');
});

it('the composer offers the Contacts list choices, keeps a saved choice no longer listed, and shows search results', () => {
  const html = renderToStaticMarkup(<SchoolBlastsView {...props()} />);
  expect(html).toContain('data-testid="blast-filters"'); expect(html).toContain('Taekwondo: Yellow'); expect(html).toContain('Little Tigers'); expect(html).toContain('Kids monthly');
  expect(html).toContain('No belt yet'); expect(html).toContain('In the next 90 days'); expect(html).not.toContain('data-filter="endsFrom"');
  expect(html).not.toContain('filters set');
  const gone = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: { ...base(), filters: { ...NO_BLAST_FILTERS, planId: id(69), endsFrom: '2026-12-01' } } })} />);
  expect(gone).toContain('Saved choice'); expect(gone).toContain('data-filter="endsFrom"');
  const found = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: { ...base(), people: [{ personId: P1, name: 'Avery Kim' }] }, peopleQuery: 'av',
    peopleSearch: { state: 'READY', matches: [{ personId: P1, name: 'Avery Kim', detail: 'a@example.test' }, { personId: P2, name: 'Avery Park', detail: null }] } })} />);
  expect(found).toMatch(new RegExp(`data-pick-person="${P1}"[^>]*disabled|disabled[^>]*data-pick-person="${P1}"`));
  expect(found).toContain('Avery Park'); expect(found).toContain('Added');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ peopleSearch: { state: 'READY', matches: [] } })} />)).toContain('No contacts match.');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ peopleSearch: { state: 'DENIED' }, filterOptions: { state: 'DENIED' } })} />)).toContain('needs permission to see contacts');
});

it('every language has the new words', () => {
  for (const c of Object.values(BLAST_COPY)) {
    for (const key of ['filtersTitle', 'filtersHint', 'clearFilters', 'any', 'savedChoice', 'fieldBelt', 'noBelt', 'fieldProgram', 'fieldPlan', 'fieldMembership', 'fieldEnds',
      'endsBetween', 'fieldAgeMin', 'fieldAgeMax', 'optionsDenied', 'peopleTitle', 'peopleHint', 'searchPeople', 'noMatches', 'pickedEarlier'] as const) expect(c[key]).toBeTruthy();
    expect(c.problems.filters).toBeTruthy(); expect(c.problems.people).toBeTruthy(); expect(Object.keys(c.membership)).toHaveLength(5);
  }
});
