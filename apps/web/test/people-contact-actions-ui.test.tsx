import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHOOL_CONTACT_ARCHIVE_BLOCKERS, SCHOOL_CONTACT_MERGE_BLOCKERS, SCHOOL_CONTACT_RESTORE_BLOCKERS, verifySchoolContactCard } from '@hon/contracts';
import { contactAdminApi } from '../src/components/people/contacts-http';
import { ContactActions } from '../src/components/people/contact-actions';
import { ACTION_COPY } from '../src/components/people/contact-actions-copy';
import { CONTACTS_COPY } from '../src/components/people/contacts-copy';
import { id, scope } from './account-status-fixtures';

// C3 (0523): delete (archive), restore and merge on the contact card.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const fetch = vi.fn(async () => answers.shift()!); vi.stubGlobal('fetch', fetch); return fetch; };
const signal = () => new AbortController().signal;
const keep = id(500), dup = id(501), hash = 'b'.repeat(64);
const base = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/contacts`;
const person = (personId: string, version = 3) => ({ personId, version, givenName: 'Kim', familyName: 'Lee', email: null, phoneE164: null });
const state = (over: Record<string, unknown> = {}) => ({ person: person(keep), archived: false, mergedIntoPersonId: null, archiveBlockers: [], restoreBlockers: ['NOT_ARCHIVED'], ...over });
const preview = (over: Record<string, unknown> = {}) => ({ keep: person(keep), merge: person(dup, 2), blockers: [],
  moves: { leads: 1, familyLinks: 0, billingAccounts: 1, consents: 1, conversations: 0 }, stays: { consents: 1, messages: 2 }, planHash: hash, ...over });
const sent = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('reads archive state with a plain GET and sends archive / restore with their own command header, a fresh key and the version read', async () => {
  const f = stub(json({ data: state(), meta: {} }), json({ data: { personId: keep, version: 4, archived: true }, meta: {} }, 201),
    json({ data: { personId: keep, version: 5, archived: false }, meta: {} }, 201));
  expect((await contactAdminApi.archiveState(scope, keep, signal())).person.version).toBe(3);
  const [path, init] = sent(f);
  expect(path).toBe(`${base}/${keep}/archive`);
  expect(init.method).toBe('GET');
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);

  expect(await contactAdminApi.archive(scope, keep, 3, false, signal())).toEqual({ personId: keep, version: 4, archived: true });
  const [p2, i2] = sent(f, 1), h2 = i2.headers as Record<string, string>;
  expect(p2).toBe(`${base}/${keep}/archive`);
  expect([i2.method, h2['X-HON-Human-Command'], JSON.parse(String(i2.body))]).toEqual(['POST', 'people.contact.archive', { version: 3 }]);
  expect(h2['Idempotency-Key']).toMatch(/^contact-[0-9a-f-]{36}$/);

  await contactAdminApi.archive(scope, keep, 4, true, signal());
  const [p3, i3] = sent(f, 2), h3 = i3.headers as Record<string, string>;
  expect([p3, h3['X-HON-Human-Command']]).toEqual([`${base}/${keep}/restore`, 'people.contact.restore']);
  expect(h3['Idempotency-Key']).not.toBe(h2['Idempotency-Key']);
});

it('refuses receipts that do not match what was asked', async () => {
  for (const data of [{ personId: dup, version: 4, archived: true }, { personId: keep, version: 3, archived: true }, { personId: keep, version: 4, archived: false },
    { personId: keep, version: 4, archived: true, extra: 1 }]) {
    stub(json({ data, meta: {} }, 201));
    await expect(contactAdminApi.archive(scope, keep, 3, false, signal())).rejects.toMatchObject({ failure: { kind: 'UNKNOWN' } });
  }
  stub(json({ data: state({ archived: true }), meta: {} }));
  await expect(contactAdminApi.archiveState(scope, keep, signal())).rejects.toMatchObject({ failure: { kind: 'UNKNOWN' } });
});

it('previews a merge and sends the exact versions and plan hash, never the kept id in the body', async () => {
  const f = stub(json({ data: preview(), meta: {} }), json({ data: { keepPersonId: keep, keepVersion: 4, mergedPersonId: dup, mergedVersion: 3,
    moved: { leads: 1, familyLinks: 0, billingAccounts: 1, consents: 1, conversations: 0 } }, meta: {} }, 201));
  const p = await contactAdminApi.mergePreview(scope, keep, dup, signal());
  expect(sent(f)[0]).toBe(`${base}/${keep}/merge?mergePersonId=${dup}`);
  const receipt = await contactAdminApi.merge(scope, p, signal());
  expect(receipt.moved.leads).toBe(1);
  const [path, init] = sent(f, 1);
  expect(path).toBe(`${base}/${keep}/merge`);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('people.contact.merge');
  expect(JSON.parse(String(init.body))).toEqual({ keepVersion: 3, mergePersonId: dup, mergeVersion: 2, planHash: hash });
  stub(json({ data: preview({ merge: person(keep) }), meta: {} }));
  await expect(contactAdminApi.mergePreview(scope, keep, dup, signal())).rejects.toMatchObject({ failure: { kind: 'UNKNOWN' } });
});

it('maps refusals to closed kinds and keeps only known blocker codes', async () => {
  const cases: [Response, string, string[]][] = [
    [json({ code: 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' }, 403), 'DENIED', []], [json({ code: 'SCHOOL_CONTACT_NOT_FOUND' }, 404), 'MISSING', []],
    [json({ code: 'SCHOOL_CONTACT_BLOCKED', blockers: ['HAS_OPEN_LEAD', '<img>', 7] }, 409), 'BLOCKED', ['HAS_OPEN_LEAD']],
    [json({ code: 'SCHOOL_CONTACT_VERSION_CONFLICT' }, 409), 'STALE', []], [json({ code: 'SCHOOL_CONTACT_PREVIEW_STALE' }, 409), 'STALE', []],
    [json({ code: 'SCHOOL_CONTACTS_UNAVAILABLE' }, 503), 'UNKNOWN', []]];
  for (const [answer, kind, blockers] of cases) {
    stub(answer);
    await expect(contactAdminApi.archive(scope, keep, 3, false, signal())).rejects.toMatchObject({ failure: { kind, blockers } });
  }
});

it('shows Merge and Delete for a contact, Restore for an archived one, and nothing is sent until a step is chosen', () => {
  const f = stub();
  const card = (segment: string) => verifySchoolContactCard({ generatedAt: '2026-11-15T10:00:00.000Z',
    person: { ...person(keep), createdAt: '2026-08-01T10:00:00.000Z' },
    overview: { segment, planName: null, programName: null, membershipEndsAt: null, ranks: [], openLead: false },
    family: { allowed: false }, appointments: { allowed: false }, tasks: { allowed: false }, membership: { allowed: false }, billing: { allowed: false },
    messages: { allowed: false }, timeline: [] }, keep);
  const live = renderToStaticMarkup(<ContactActions language="en" scope={scope} card={card('PROSPECT')} onChanged={() => {}}/>);
  expect(live).toContain('Delete contact'); expect(live).toContain('Merge with a duplicate'); expect(live).not.toContain('Restore contact');
  const gone = renderToStaticMarkup(<ContactActions language="ko" scope={scope} card={card('ARCHIVED')} onChanged={() => {}}/>);
  expect(gone).toContain('연락처 복원'); expect(gone).not.toContain('연락처 삭제');
  expect(f).not.toHaveBeenCalled();
});

it('has every blocker and the archived segment in words, in en, ko and es', () => {
  const keys = Object.keys(ACTION_COPY.en).sort();
  for (const lang of ['ko', 'es'] as const) expect(Object.keys(ACTION_COPY[lang]).sort()).toEqual(keys);
  for (const code of [...SCHOOL_CONTACT_ARCHIVE_BLOCKERS, ...SCHOOL_CONTACT_RESTORE_BLOCKERS, ...SCHOOL_CONTACT_MERGE_BLOCKERS]) {
    for (const lang of ['en', 'ko', 'es'] as const) expect((ACTION_COPY[lang] as Record<string, string>)[`b_${code}`], `${lang} ${code}`).toBeTruthy();
  }
  for (const lang of ['en', 'ko', 'es'] as const) { expect(CONTACTS_COPY[lang].ARCHIVED).toBeTruthy(); expect(CONTACTS_COPY[lang].rowARCHIVED).toBeTruthy(); }
});
