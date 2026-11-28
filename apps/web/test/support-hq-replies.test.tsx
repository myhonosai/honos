import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqSupportCaseDetail, type SupportRequest, type SupportRequestList } from '@hon/contracts';
import { SupportError, supportApi } from '../src/components/hq-support/http';
import { HqSupportCaseView, type SupportCaseViewProps } from '../src/components/hq-support/case-view';
import { supportText } from '../src/components/hq-support/copy';
import { HqSupportAlertBar, HqSupportBadge, notifyIfNew, readSupportAlertsNow, resetSupportAlertsForTest } from '../src/components/hq-support/alerts';
import { EMPTY_DRAFT, SupportView, type SupportViewProps } from '../src/components/school-support/view';
import { supportText as schoolText } from '../src/components/school-support/copy';

// 0713: HQ answers a school's request inside it, HQ sees which requests wait for a reply, and the school sees the
// answer as "HON support". All data here is synthetic.
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetSupportAlertsForTest(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const agent = { principalId: id(50), displayName: 'Synthetic Agent' };
const kase = (patch: Record<string, unknown> = {}) => ({ caseId: id(1), organizationId: id(2), organizationDisplayName: 'Synthetic Dojo', schoolId: id(3),
  schoolDisplayName: 'Synthetic Academy', subject: 'How do I change my plan?', category: 'OTHER', priority: 'NORMAL', status: 'OPEN', assignee: null,
  openedBy: agent, openedAt: T, updatedAt: T, closedAt: null, version: 1, noteCount: 1,
  fromSchool: true, needsReply: true, lastSchoolMessageAt: T, lastReplyAt: null, ...patch });
const event = (patch: Record<string, unknown> = {}) => ({ seq: 1, kind: 'OPENED', actor: agent, note: 'From the school.', statusFrom: null, statusTo: null,
  priorityFrom: null, priorityTo: null, assigneeChanged: false, assigneeTo: null, occurredAt: T, ...patch });
const detailRaw = (patch: Record<string, unknown> = {}) => ({ case: kase(), events: [event()], assignees: [agent], viewer: agent, asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const alert = (n: number, at = T2) => ({ caseId: id(n), subject: `Synthetic question ${n}`, priority: 'NORMAL' as const, schoolDisplayName: `School ${n}`, organizationDisplayName: 'Synthetic Dojo', lastSchoolMessageAt: at });
const alerts = (...latest: ReturnType<typeof alert>[]) => ({ needsReply: latest.length, latest, asOf: T2 });

it('replies with its own command name and key, and accepts only this case one version on and waiting on the school', async () => {
  const f = stub(json({ data: { operation: 'REPLY', case: kase({ version: 3, status: 'WAITING_ON_SCHOOL', needsReply: false, lastReplyAt: T2, noteCount: 2 }), replayed: false } }));
  await supportApi.reply(id(1), { expectedVersion: 2, message: 'Change it in Settings.', waitForSchool: true }, id(80), new AbortController().signal, yes);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/hq/support/cases/${id(1)}/replies`);
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-support-case-reply', 'Idempotency-Key': id(80) });
  expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 2, message: 'Change it in Settings.', waitForSchool: true });
  // Asked to wait for the school, but the answer did not move the case: the outcome is unknown, not success.
  stub(json({ data: { operation: 'REPLY', case: kase({ version: 3, needsReply: false, lastReplyAt: T2 }), replayed: false } }));
  await expect(supportApi.reply(id(1), { expectedVersion: 2, message: 'x', waitForSchool: true }, id(80), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const none = stub();
  await expect(supportApi.reply('nope', { expectedVersion: 2, message: 'x', waitForSchool: false }, id(81), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(supportApi.reply(id(1), { expectedVersion: 2, message: '', waitForSchool: false }, id(81), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(none).not.toHaveBeenCalled();
});

it('reads alerts from one fixed path and refuses an answer whose count and list disagree', async () => {
  const f = stub(json({ data: alerts(alert(4)) }), json({ data: { needsReply: 3, latest: [alert(4)], asOf: T2 } }));
  expect((await supportApi.alerts(new AbortController().signal, yes)).needsReply).toBe(1);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/hq/support/cases/alerts');
  await expect(supportApi.alerts(new AbortController().signal, yes)).rejects.toBeInstanceOf(SupportError);
});

const noop = () => {};
const caseProps = (patch: Partial<SupportCaseViewProps> = {}): SupportCaseViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', view: validateHqSupportCaseDetail(detailRaw()) }, busy: false, outcome: null, locked: false, canRetry: false, formKey: 0,
  onRefresh: noop, onReveal: noop, onNote: noop, onReply: noop, onChange: noop, onTryAgain: noop, ...patch });

it('shows Reply to school, the From school and Needs reply marks, and the reply in the history', () => {
  const view = validateHqSupportCaseDetail(detailRaw({ case: kase({ version: 2, needsReply: false, lastReplyAt: T2, noteCount: 2 }),
    events: [event(), event({ seq: 2, kind: 'REPLY', note: 'Change it in Settings.', occurredAt: T2 })] }));
  const html = renderToStaticMarkup(<HqSupportCaseView {...caseProps({ state: { state: 'READY', view } })}/>);
  for (const s of ['data-support-form="reply"', supportText('en', 'replyTitle'), supportText('en', 'waitForSchool'), supportText('en', 'eventREPLY'), 'Change it in Settings.', 'data-from-school=""'])
    expect(html).toContain(s);
  expect(html).toMatch(/name="wait"[^>]*checked=""|checked=""[^>]*name="wait"/);
  expect(html).not.toContain('data-needs-reply');
  expect(renderToStaticMarkup(<HqSupportCaseView {...caseProps()}/>)).toContain('data-needs-reply=""');
  // A case HQ opened itself has no school to answer.
  const own = renderToStaticMarkup(<HqSupportCaseView {...caseProps({ state: { state: 'READY', view: validateHqSupportCaseDetail(detailRaw({ case: kase({ fromSchool: false, needsReply: false, lastSchoolMessageAt: null }) })) } })}/>);
  expect(own).not.toContain('data-support-form="reply"');
  expect(own).toContain(supportText('en', 'notFromSchool'));
});

type Shown = { title: string; options: Record<string, unknown>; onclick: (() => void) | null };
function fakeNotification(permission: string) {
  const shown: Shown[] = [];
  class N { static permission = permission; onclick: (() => void) | null = null; constructor(title: string, options: Record<string, unknown>) { shown.push(Object.assign(this, { title, options }) as unknown as Shown); } }
  vi.stubGlobal('Notification', N);
  return shown;
}

it('shows one desktop notice only when the count rose and this browser allows it, naming the school and subject only', () => {
  const shown = fakeNotification('granted');
  const before = alerts(alert(4, T)), after = alerts(alert(5), alert(4, T));
  expect(notifyIfNew(null, after)).toBe(false);
  expect(notifyIfNew(after, before)).toBe(false);
  expect(notifyIfNew(before, before)).toBe(false);
  expect(notifyIfNew(before, after)).toBe(true);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe(supportText('en', 'alertTitle'));
  expect(shown[0]!.options).toEqual({ body: supportText('en', 'alertBody', { school: 'School 5', subject: 'Synthetic question 5' }), tag: `hq-support-${id(5)}` });
  for (const p of ['default', 'denied']) { const none = fakeNotification(p); expect(notifyIfNew(before, after)).toBe(false); expect(none).toHaveLength(0); }
});

it('shares one read for every badge, and stops for good once support access is refused', async () => {
  const read = vi.fn().mockResolvedValueOnce(alerts(alert(4), alert(5))).mockRejectedValueOnce(new SupportError('DENIED'));
  resetSupportAlertsForTest({ alerts: read } as never);
  await readSupportAlertsNow();
  let badge = renderToStaticMarkup(<HqSupportBadge/>);
  expect(badge).toContain('data-hq-support-badge="2"');
  expect(badge).toContain('>2</span>');
  expect(renderToStaticMarkup(<HqSupportAlertBar/>)).toContain('School 5: Synthetic question 5');
  await readSupportAlertsNow();
  badge = renderToStaticMarkup(<HqSupportBadge/>);
  expect(badge).toBe('');
  await readSupportAlertsNow();
  expect(read).toHaveBeenCalledTimes(2);
  // Zero shows nothing.
  resetSupportAlertsForTest({ alerts: vi.fn().mockResolvedValue({ needsReply: 0, latest: [], asOf: T2 }) } as never);
  await readSupportAlertsNow();
  expect(renderToStaticMarkup(<HqSupportBadge/>)).toBe('');
});

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (over: Partial<SupportRequest> = {}): SupportRequest => ({ requestId: sid(40), topic: 'OTHER', subject: 'How do I change my plan?', status: 'WAITING_ON_SCHOOL', pageHint: null,
  openedAt: T, updatedAt: T2, closedAt: null, messages: [{ seq: 1, note: 'Where is billing?', at: T, author: 'Synthetic Owner', from: 'SCHOOL' },
    { seq: 2, note: 'Change it in Settings.', at: T2, author: 'HON support', from: 'HON' }], awaitingSchool: true, ...over });
const list = (requests: SupportRequest[]): SupportRequestList => ({ requests, limits: { requestsPerDay: 10, messagesPerDay: 30, subjectMax: 200, messageMax: 4000 },
  checkedAt: T2, awaitingSchoolCount: requests.filter((r) => r.awaitingSchool).length });
const base = (over: Partial<SupportViewProps> = {}): SupportViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true, pageHint: null,
  list: { state: 'READY', list: list([request()]) }, draft: EMPTY_DRAFT, replyTo: null, replyText: '', outcome: null, locked: false, canRetry: false, ...over });

it('shows the school HQ\'s answer as HON support and says when HON support waits on them', () => {
  const html = renderToStaticMarkup(<SupportView {...base()}/>);
  for (const s of ['data-from="HON"', schoolText('en', 'fromHon'), 'Change it in Settings.', 'data-awaiting-school=""', 'data-awaiting-count="1"'])
    expect(html).toContain(s);
  expect(html).not.toContain('Synthetic Agent');
  const quiet = renderToStaticMarkup(<SupportView {...base({ list: { state: 'READY', list: list([request({ status: 'OPEN', awaitingSchool: false,
    messages: [{ seq: 1, note: 'Where is billing?', at: T, author: 'Synthetic Owner', from: 'SCHOOL' }] })]) } })}/>);
  expect(quiet).not.toContain('data-awaiting');
});
