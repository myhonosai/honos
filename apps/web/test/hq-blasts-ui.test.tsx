import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HqBlast, HqBlastAudiencePreview, HqBlastDetail, HqBlastSummary } from '@hon/contracts';
import { CommsError } from '../src/components/hq-communications/http';
import { HQ_BLAST_REFUSALS, hqBlastApi } from '../src/components/hq-blasts/http';
import { NO_HQ_BLAST_FILTERS, citiesOf, hqBlastAudienceOf, hqBlastDraftOf, hqBlastMayCancel, hqBlastProblems, hqBlastSameAsSaved, hqBlastSaveInput, hqBlastSendAt,
  insertHqBlastTag, newHqBlastDraft, togglePick, type HqBlastDraft } from '../src/components/hq-blasts/format';
import { HqBlastsView, type HqBlastsViewProps } from '../src/components/hq-blasts/view';
import { hqBlastText } from '../src/components/hq-blasts/copy';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-28T08:00:00.000Z';
const results = () => ({ schools: { queued: 2, noOwners: 1, notReachable: 0, recentlySent: 0 },
  deliveries: { waiting: 3, pending: 0, sending: 0, accepted: 0, delivered: 0, bounced: 0, failed: 0, suppressed: 1, unknown: 0 } });
const blast = (patch: Partial<HqBlast> = {}): HqBlast => ({ blastId: id(1), name: 'December news', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', subject: 'New in HON OS',
  body: 'Hi {{first_name}}, news for {{school_name}}.', audience: { statuses: ['ACTIVE'], trial: 'ON_TRIAL', schools: [id(7)] }, status: 'DRAFT', sendAt: null, queuedAt: null,
  cancelledAt: null, schoolCount: null, recipientCount: null, createdBy: { principalId: id(9), displayName: 'Synthetic Owner' }, createdAt: T, updatedAt: T, version: 1, ...patch });
const draft = (patch: Partial<HqBlastDraft> = {}): HqBlastDraft => ({ ...newHqBlastDraft(), name: 'News', subject: 'Hello', body: 'Hi {{first_name}}', ...patch });

describe('HQ blast form model', () => {
  it('turns the form into the closed audience, leaving unset filters out', () => {
    expect(hqBlastAudienceOf(newHqBlastDraft())).toEqual({});
    const d = draft({ filters: { ...NO_HQ_BLAST_FILTERS, statuses: ['ACTIVE'], planNames: ['Core'], founder: 'no', freePlan: 'yes', trial: 'ON_TRIAL', trialEndsWithinDays: '7',
      joined: '30', countries: ['US'], regions: ['CA'], cities: ' San Gabriel, Pasadena ,san gabriel ', featuresIncluded: ['crm.families_students_prospects'], canGetTexts: true },
      picked: [{ schoolId: id(7), name: 'Main' }], leftOut: [{ schoolId: id(8), name: null }] });
    expect(hqBlastAudienceOf(d)).toEqual({ statuses: ['ACTIVE'], planNames: ['Core'], founder: false, freePlan: true, trial: 'ON_TRIAL', trialEndsWithinDays: 7, joinedWithinDays: 30,
      countries: ['US'], regions: ['CA'], cities: ['San Gabriel', 'Pasadena'], featuresIncluded: ['crm.families_students_prospects'], canGetTexts: true, schools: [id(7)], excludeSchools: [id(8)] });
    expect(hqBlastAudienceOf(draft({ filters: { ...NO_HQ_BLAST_FILTERS, trial: 'NEVER', trialEndsWithinDays: '7', joined: 'RANGE', joinedFrom: '2026-01-01' } })))
      .toEqual({ trial: 'NEVER', joinedFrom: '2026-01-01' });
    expect(citiesOf(',,')).toEqual([]);
  });
  it('round-trips a saved blast and tells saved from changed', () => {
    const d = hqBlastDraftOf(blast(), new Map([[id(7), 'Main']]));
    expect(d.picked).toEqual([{ schoolId: id(7), name: 'Main' }]);
    expect(hqBlastAudienceOf(d)).toEqual(blast().audience);
    expect(hqBlastSameAsSaved(d, d)).toBe(true);
    expect(hqBlastSameAsSaved({ ...d, body: 'Changed' }, d)).toBe(false);
    expect(hqBlastSameAsSaved(d, null)).toBe(false);
  });
  it('names each problem and saves only a closed request', () => {
    expect(hqBlastProblems(newHqBlastDraft())).toEqual(['name', 'subject', 'body']);
    expect(hqBlastProblems(draft({ body: 'Hi {{last_name}}' }))).toEqual(['mergeTag']);
    expect(hqBlastProblems(draft({ channel: 'SMS', subject: '', body: 'x'.repeat(1401) }))).toEqual(['bodyLength']);
    expect(hqBlastProblems(draft({ filters: { ...NO_HQ_BLAST_FILTERS, joined: 'RANGE', joinedFrom: '2026-05-01', joinedTo: '2026-01-01' } }))).toEqual(['joined']);
    expect(hqBlastSaveInput(draft({ body: '' }))).toBeNull();
    expect(hqBlastSaveInput(draft({ name: '  News  ', channel: 'SMS', subject: 'ignored' }))).toEqual({ blastId: null, expectedVersion: 0, name: 'News', channel: 'SMS',
      purpose: 'ANNOUNCEMENT', subject: null, body: 'Hi {{first_name}}', audience: {} });
  });
  it('puts merge tags at the cursor, picks schools once, and keeps send times in range', () => {
    expect(insertHqBlastTag('Hi !', 'first_name', 3)).toEqual({ text: 'Hi {{first_name}}!', cursor: 17 });
    const one = togglePick([], { schoolId: id(7).toUpperCase(), name: 'Main' });
    expect(one).toEqual([{ schoolId: id(7), name: 'Main' }]);
    expect(togglePick(one, { schoolId: id(7), name: 'Main' })).toEqual([]);
    const now = Date.parse('2026-11-28T08:00:00Z');
    expect(hqBlastSendAt('', now)).toBeNull();
    expect(hqBlastSendAt('2026-11-28T08:00', now)).toBeNull();
    const later = hqBlastSendAt('2026-12-01T09:30', now);
    expect(later && Date.parse(later) > now).toBe(true);
    expect(hqBlastSendAt('2027-03-01T09:30', now)).toBeNull();
  });
  it('offers call-off only before any message reached the sender', () => {
    const q = blast({ status: 'QUEUED', sendAt: T, queuedAt: T, schoolCount: 2, recipientCount: 3, version: 2 });
    expect(hqBlastMayCancel(q, results().deliveries)).toBe(true);
    expect(hqBlastMayCancel(q, { ...results().deliveries, accepted: 1 })).toBe(false);
    expect(hqBlastMayCancel(blast(), results().deliveries)).toBe(false);
  });
});

describe('HQ blast requests', () => {
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  it('sends the save with the blast marker and refuses a receipt for something else', async () => {
    const fetchMock = vi.fn(async () => answer(200, { data: { operation: 'SAVE', blast: blast({ name: 'News', subject: 'Hello', body: 'Hi {{first_name}}', audience: {} }), replayed: false } }));
    vi.stubGlobal('fetch', fetchMock);
    const input = hqBlastSaveInput(draft())!;
    const r = await hqBlastApi.save(input, id(50), AbortSignal.timeout(1000), () => true);
    expect(r.blast.name).toBe('News');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/hq/communications/blasts');
    expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('hq-blast-save');
    expect(JSON.parse(String(init.body))).toEqual(input);
    fetchMock.mockImplementationOnce(async () => answer(200, { data: { operation: 'SAVE', blast: blast({ name: 'Other' }), replayed: false } }));
    await expect(hqBlastApi.save(input, id(51), AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  });
  it('maps each blast refusal and keeps the id in the path only', async () => {
    for (const code of HQ_BLAST_REFUSALS) {
      vi.stubGlobal('fetch', vi.fn(async () => answer(422, { code })));
      await expect(hqBlastApi.send({ blastId: id(1), expectedVersion: 1, sendAt: null }, id(52), AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'REFUSED', code });
    }
    const fetchMock = vi.fn(async () => answer(409, { code: 'SAAS_VERSION_CONFLICT' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(hqBlastApi.cancel({ blastId: id(1), expectedVersion: 2 }, id(53), AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'CHANGED' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/hq/communications/blasts/${id(1)}/cancel`);
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2 });
    await expect(hqBlastApi.options('x', AbortSignal.timeout(1000), () => true)).rejects.toBeInstanceOf(CommsError);
  });
});

const summary = (patch: Partial<HqBlast> = {}): HqBlastSummary => ({ ...blast(patch), results: results() });
const preview: HqBlastAudiencePreview = { blastId: id(1), channel: 'EMAIL', schoolsMatched: 3, schoolsReached: 2, ownersTotal: 4, ownersReached: 3,
  skipped: { noOwners: 1, notReachable: 0, recentlySent: 0, ownersNotReachable: 1 }, tooLarge: false,
  schools: [{ schoolId: id(7), schoolDisplayName: 'Synthetic Main', outcome: 'QUEUED', ownerCount: 2, reachableCount: 1 }],
  sample: { schoolDisplayName: 'Synthetic Main', subject: 'New in HON OS', body: 'Hi Alex, news for Synthetic Main.' }, asOf: T };
const noop = () => undefined;
const base = (patch: Partial<HqBlastsViewProps> = {}): HqBlastsViewProps => ({
  language: 'en', formatTime: iso => iso, featureLabel: f => f, concealed: false, list: { state: 'READY', list: { blasts: [summary()], sentToday: 1, dailyLimit: 10, asOf: T } },
  screen: { mode: 'LIST' }, draft: null, dirty: false, preview: null, options: null, search: '', searchRead: null, detail: null, when: 'NOW', local: '', sendAt: null, ask: null,
  outcome: null, locked: false, canRetry: false, onRefresh: noop, onReveal: noop, onNew: noop, onOpen: noop, onBack: noop, onDraft: noop, onFilters: noop, onTag: noop,
  onSearch: noop, onPick: noop, onSave: noop, onPreviewRetry: noop, onWhen: noop, onLocal: noop, onAsk: noop, onConfirm: noop, onTryAgain: noop, onDismiss: noop, onDetailRetry: noop, ...patch });
const html = (p: HqBlastsViewProps) => renderToStaticMarkup(<HqBlastsView {...p}/>);

describe('HQ blasts page', () => {
  it('lists blasts with today\'s count and links back to the inbox', () => {
    const out = html(base());
    expect(out).toContain('data-hq-blasts="list"');
    expect(out).toContain('1 of 10 blasts handed over in the last 24 hours.');
    expect(out).toContain('December news');
    expect(out).toContain('href="/hq/communications"');
    expect(html(base({ list: { state: 'DENIED' } }))).toContain('Only the HQ owner can use blasts.');
    expect(html(base({ concealed: true }))).toContain('data-hq-blasts="concealed"');
  });
  it('shows every filter, the merge tags, the counter and problems in the composer', () => {
    const d = hqBlastDraftOf(blast(), new Map([[id(7), 'Synthetic Main']]));
    const out = html(base({ screen: { mode: 'EDIT' }, draft: { ...d, body: '' }, dirty: true,
      options: { state: 'READY', value: { planNames: ['Core', 'Complete'], features: ['crm.families_students_prospects'], countries: ['US'], regions: [{ country: 'US', region: 'CA' }], schools: [], asOf: T } } }));
    for (const text of ['School status', 'Core', 'No plan yet', 'Founder schools', 'Free plan', 'Billing', 'Trial', 'Signed up', 'Country', 'CA', 'Cities (separate with commas)',
      'Plan includes', 'Plan does not include', 'Only schools where an owner can get texts', 'Pick or leave out schools', 'Synthetic Main', 'Owner first name', 'Write the message.',
      'Save your changes to check who gets it and send.'])
      expect(out).toContain(text);
    expect(out).toContain('data-hq-blast-tag="body:first_name"');
    expect(out).toContain('data-hq-blast-problems="body"');
  });
  it('shows the count and sample for a saved draft, and asks before sending', () => {
    const d = hqBlastDraftOf(blast());
    const ready = html(base({ screen: { mode: 'EDIT' }, draft: d, preview: { state: 'READY', value: preview } }));
    expect(ready).toContain('data-hq-blast-preview="ready"');
    expect(ready).toContain('Hi Alex, news for Synthetic Main.');
    expect(ready).toContain('data-hq-blast-send="true"');
    const asking = html(base({ screen: { mode: 'EDIT' }, draft: d, preview: { state: 'READY', value: preview }, ask: { kind: 'SEND', sendAt: null } }));
    expect(asking).toContain('Send &quot;December news&quot; to 3 owners at 2 schools?');
    const none = html(base({ screen: { mode: 'EDIT' }, draft: d, preview: { state: 'READY', value: { ...preview, schoolsReached: 0, ownersReached: 0, schools: [], sample: null } } }));
    expect(none).toMatch(/data-hq-blast-send="true" disabled=""/);
  });
  it('shows results per school with a link to each message, and the call-off ask', () => {
    const q = blast({ status: 'QUEUED', sendAt: T, queuedAt: T, schoolCount: 2, recipientCount: 3, version: 2 });
    const detail: HqBlastDetail = { blast: q, results: results(), schools: [{ schoolId: id(7), schoolDisplayName: 'Synthetic Main', outcome: 'QUEUED', ownerCount: 2, reachableCount: 1, messageId: id(30) },
      { schoolId: id(8), schoolDisplayName: 'Synthetic East', outcome: 'NO_OWNERS', ownerCount: 0, reachableCount: 0, messageId: null }], asOf: T };
    const out = html(base({ screen: { mode: 'DETAIL', blastId: id(1) }, detail: { state: 'READY', value: detail } }));
    expect(out).toContain(`href="/hq/communications/${id(30)}"`);
    expect(out).toContain('Held back (unsubscribed or STOP)');
    expect(out).toContain('data-hq-blast-cancel="true"');
    const gone = html(base({ screen: { mode: 'DETAIL', blastId: id(1) }, detail: { state: 'READY', value: { ...detail, results: { ...results(), deliveries: { ...results().deliveries, accepted: 1 } } } } }));
    expect(gone).toContain('Some messages already went out');
  });
  it('explains every refusal in the person\'s words', () => {
    for (const code of HQ_BLAST_REFUSALS) {
      const out = html(base({ outcome: { kind: 'REFUSED', code } }));
      expect(out).toContain(hqBlastText('en', code as never).replace(/'/g, '&#x27;'));
    }
  });
  it('carries the same copy in English, Korean and Spanish', () => {
    expect(hqBlastText('ko', 'title')).not.toBe(hqBlastText('en', 'title'));
    expect(hqBlastText('es', 'title')).not.toBe(hqBlastText('en', 'title'));
  });
  it('the inbox links to Blasts, and the page never hides when the person looks away', () => {
    expect(readFileSync('src/components/hq-communications/inbox.tsx', 'utf8')).toContain('href="/hq/communications/blasts"');
    for (const f of ['src/components/hq-blasts/hq-blasts.tsx', 'src/components/hq-blasts/view.tsx'])
      expect(readFileSync(f, 'utf8')).not.toMatch(/addEventListener\(\s*'(blur|pagehide|visibilitychange)'/);
  });
});
