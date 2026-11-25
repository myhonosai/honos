import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { validatePersonDetails, validatePersonRecord, type PersonDetails } from '@hon/contracts';
import { PersonRecordError } from '../src/components/people/http';
import { DetailsCard, badRows, detailsInput, detailsText, draftOf, type DetailsCardProps } from '../src/components/people/profile-details';
import { detailsApi, keepDetailsForRetry } from '../src/components/people/profile-details-http';
import { id, scope } from './account-status-fixtures';

// Owner, 2026-11-21: "it should handle more than just name and contact. needs rank, program, more than 1 contact both phone and email,
// date of birth, male or female and more." Synthetic people only.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(31);
const record = validatePersonRecord({ personId: person, schoolId: scope.schoolId, givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid',
  phoneE164: '+15555550100', version: 3, updatedAt: '2026-11-07T06:30:00.000Z', student: { birthDate: '2015-04-02', status: 'ACTIVE', version: 1 },
  consents: { EMAIL: 'NOT_RECORDED', SMS: 'NOT_RECORDED' }, canEdit: true });
const empty: PersonDetails = validatePersonDetails({ personId: person, version: 0, gender: null, guardianName: null, notes: null, primaryPhoneLabel: null,
  primaryEmailLabel: null, otherPhones: [], otherEmails: [], canEdit: true }, person);
const saved: PersonDetails = validatePersonDetails({ personId: person, version: 2, gender: 'FEMALE', guardianName: 'Sam Rivera', notes: 'Prefers evening classes',
  primaryPhoneLabel: 'MOBILE', primaryEmailLabel: 'PERSONAL', otherPhones: [{ phoneE164: '+15555550101', label: 'HOME' }],
  otherEmails: [{ email: 'sam@example.invalid', label: 'WORK' }], canEdit: true }, person);
const props = (over: Partial<DetailsCardProps> = {}): DetailsCardProps => ({ language: 'en', canEdit: true, read: { state: 'READY', details: saved },
  draft: draftOf(saved), primary: record, standing: { programName: 'Little Tigers', ranks: [{ curriculum: 'Kids', rank: 'Yellow belt', color: '#f4d03f' }] },
  outcome: null, locked: false, canRetry: false, ...over });
const html = (over: Partial<DetailsCardProps> = {}) => renderToStaticMarkup(<DetailsCard {...props(over)}/>);

it('shows gender, guardian, labels, other phones and emails, notes, and the program and rank with a link to rank setup', () => {
  const h = html();
  expect(h).toContain('More details');
  expect(h).toMatch(/<option value="FEMALE" selected="">Female<\/option>/);
  expect(h).toContain('value="Sam Rivera"'); expect(h).toContain('Prefers evening classes');
  expect(h).toContain('value="+15555550101"'); expect(h).toContain('value="sam@example.invalid"');
  expect(h).toContain('Little Tigers'); expect(h).toContain('Kids: Yellow belt'); expect(h).toContain('href="/staff/curriculum/ranks"');
  expect(h).toContain('data-testid="details-add-phone"'); expect(h).toContain('data-testid="details-save"');
  expect(h).toContain('Messages still go only to the main phone and email');
});

it('stops offering Add after five, and is read-only without edit access', () => {
  const five = { ...draftOf(saved), otherPhones: Array.from({ length: 5 }, (_, i) => ({ value: `+1555555011${i}`, label: 'HOME' as const })) };
  expect(html({ draft: five })).not.toContain('details-add-phone');
  const ro = html({ canEdit: false });
  expect(ro).toContain('your access does not include changing them'); expect(ro).not.toContain('details-save'); expect(ro).not.toContain('details-add-email');
  expect(ro).toMatch(/disabled="" data-testid="details-gender"/);
});

it('shows each read state and every outcome, with Try again only for a kept request', () => {
  expect(html({ read: { state: 'LOADING' }, draft: null })).toContain('Reading the details');
  expect(html({ read: { state: 'DENIED' }, draft: null })).not.toContain('details-save');
  expect(html({ outcome: { kind: 'UNKNOWN' }, canRetry: true, onTryAgain: () => {}, onStop: () => {} })).toContain('Try again');
  expect(html({ outcome: { kind: 'CONFLICT' } })).toContain('Someone else changed these details');
  expect(html({ outcome: { kind: 'SAVED' } })).toContain('Details saved.');
  for (const lang of ['ko', 'es']) expect(detailsText(lang, 'title')).not.toBe(detailsText('en', 'title'));
});

it('builds the closed body: trims, drops blank rows, lower-cases emails, and refuses repeats or the main address', () => {
  const input = detailsInput(scope.schoolId, record, empty, { ...draftOf(empty), gender: 'MALE', guardianName: '  Jo  ', notes: ' ',
    otherPhones: [{ value: '+1 (555) 555-0102', label: 'WORK' }, { value: '', label: 'HOME' }], otherEmails: [{ value: ' Jo@Example.Invalid ', label: 'SCHOOL' }] });
  expect(input).toEqual({ schoolId: scope.schoolId, personId: person, expectedVersion: 0, gender: 'MALE', guardianName: 'Jo', notes: null,
    primaryPhoneLabel: null, primaryEmailLabel: null, otherPhones: [{ phoneE164: '+15555550102', label: 'WORK' }], otherEmails: [{ email: 'jo@example.invalid', label: 'SCHOOL' }] });
  expect(detailsInput(scope.schoolId, record, saved, draftOf(saved))).toBe('UNCHANGED');
  const dupes = { ...draftOf(empty), otherPhones: [{ value: '+15555550100', label: 'HOME' as const }], otherEmails: [{ value: 'a@b.co', label: 'WORK' as const }, { value: 'A@b.co', label: 'WORK' as const }] };
  expect(detailsInput(scope.schoolId, record, empty, dupes)).toBe('INVALID');
  const bad = badRows(dupes, record); expect([...bad.phones]).toEqual([0]); expect([...bad.emails]).toEqual([1]);
  expect(badRows({ ...draftOf(empty), otherEmails: [{ value: 'nope', label: 'WORK' }] }, record).emails.has(0)).toBe(true);
});

it('reads and saves through the exact human command, and refuses an answer that does not match what was sent', async () => {
  vi.stubGlobal('location', { origin: 'https://hon.example.invalid' });
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let reply: Response = answer({ data: { ...saved, personId: person } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return reply; }));
  const read = await detailsApi.read(scope.schoolId, person, new AbortController().signal);
  expect(read.version).toBe(2);
  expect(calls[0]!.url).toBe(`/api/v1/school/schools/${scope.schoolId.toLowerCase()}/people/${person.toLowerCase()}/details`);
  const input = detailsInput(scope.schoolId, record, empty, draftOf(saved));
  if (typeof input === 'string') throw new Error('input');
  const key = id(77);
  reply = answer({ data: { details: { ...saved, version: 1 }, changedFields: ['gender'] } });
  await expect(detailsApi.update(input, record, key, new AbortController().signal, () => true)).resolves.toBeTruthy();
  const sent = calls[1]!;
  expect(sent.url).toBe('/api/v1/school/people/details'); expect(sent.init.method).toBe('POST');
  expect((sent.init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('school-person-record');
  expect((sent.init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
  reply = answer({ data: { details: { ...saved, version: 1, guardianName: 'Someone else' }, changedFields: ['gender'] } });
  await expect(detailsApi.update(input, record, key, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  reply = answer({ code: 'PERSON_VERSION_CONFLICT' }, 409);
  const conflict = await detailsApi.update(input, record, key, new AbortController().signal, () => true).catch(e => e);
  expect(conflict).toBeInstanceOf(PersonRecordError); expect(conflict.kind).toBe('CONFLICT'); expect(keepDetailsForRetry(conflict)).toBe(false);
  expect(keepDetailsForRetry(new PersonRecordError('UNKNOWN'))).toBe(true);
  await expect(detailsApi.update({ ...input, otherPhones: [{ phoneE164: '+15555550100', label: 'HOME' }] }, record, key, new AbortController().signal, () => true))
    .rejects.toMatchObject({ kind: 'INVALID' });
  expect(calls).toHaveLength(4);
});
