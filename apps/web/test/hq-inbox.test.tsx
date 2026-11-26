import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HqMessage, HqMessageCreateInput, HqMessageReceipt } from '@hon/contracts';
import { CommsError } from '../src/components/hq-communications/http';
import { HqSendFlow, filterConversations, groupConversations, threadOrder, type SendApi } from '../src/components/hq-communications/inbox-model';
import { HqInboxView, type InboxViewProps } from '../src/components/hq-communications/inbox';
import { inboxCatalogs, inboxText, inboxWhyKey } from '../src/components/hq-communications/inbox-copy';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agent = { principalId: id(50), displayName: 'Synthetic Agent' };
const summary = { pending: 0, accepted: 0, delivered: 0, suppressed: 0, failed: 0, unknown: 0 };
const msg = (patch: Partial<HqMessage> = {}): HqMessage => ({ messageId: id(1), organizationId: id(2), organizationDisplayName: 'Synthetic Dojo LLC', schoolId: id(3),
  schoolDisplayName: 'Synthetic Academy', purpose: 'SUPPORT', channel: 'EMAIL', content: 'Your sign-in link was reset.', supportCaseId: null, status: 'QUEUED',
  recipientCount: 2, createdBy: agent, createdAt: '2026-11-01T00:00:00.000Z', queuedAt: '2026-11-01T00:00:01.000Z', cancelledAt: null, updatedAt: '2026-11-01T00:00:01.000Z',
  version: 2, deliverySummary: { ...summary, delivered: 2 }, ...patch });
const input: HqMessageCreateInput = { organizationId: id(2), schoolId: id(3), purpose: 'SUPPORT', channel: 'EMAIL', content: 'Hello owners', supportCaseId: null };
const receipt = (operation: 'CREATE' | 'QUEUE', patch: Partial<HqMessage>): HqMessageReceipt => ({ operation, message: msg(patch), replayed: false });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('conversations by school', () => {
  it('groups messages by school, newest conversation first, and keeps the newest names', () => {
    const list = groupConversations([
      msg({ messageId: id(10), schoolId: id(3), createdAt: '2026-11-01T00:00:00.000Z' }),
      msg({ messageId: id(11), schoolId: id(4), schoolDisplayName: 'Other Dojo', createdAt: '2026-11-03T00:00:00.000Z' }),
      msg({ messageId: id(12), schoolId: id(3).toUpperCase(), schoolDisplayName: 'Synthetic Academy Renamed', createdAt: '2026-11-02T00:00:00.000Z' }),
    ]);
    expect(list.map(c => [c.schoolDisplayName, c.count, c.latest.messageId])).toEqual([['Other Dojo', 1, id(11)], ['Synthetic Academy Renamed', 2, id(12)]]);
    expect(filterConversations(list, 'renamed').map(c => c.schoolDisplayName)).toEqual(['Synthetic Academy Renamed']);
    expect(filterConversations(list, 'dojo llc')).toHaveLength(2);
    expect(filterConversations(list, '  ')).toHaveLength(2);
  });
  it('shows a thread oldest to newest', () => {
    const t = threadOrder([msg({ messageId: id(2), createdAt: '2026-11-02T00:00:00.000Z' }), msg({ messageId: id(1), createdAt: '2026-11-01T00:00:00.000Z' })]);
    expect(t.map(m => m.messageId)).toEqual([id(1), id(2)]);
  });
});

describe('Send saves then sends, never twice', () => {
  const api = () => ({ create: vi.fn<SendApi['create']>(), queue: vi.fn<SendApi['queue']>() });
  it('saves the message, then queues the exact saved version with its own key', async () => {
    const a = api(), sent = vi.fn();
    a.create.mockResolvedValue(receipt('CREATE', { messageId: id(7), status: 'DRAFT', version: 1, recipientCount: 0 }));
    a.queue.mockResolvedValue(receipt('QUEUE', { messageId: id(7), status: 'QUEUED', version: 2, recipientCount: 3 }));
    const flow = new HqSendFlow(a, sent);
    expect(flow.send(input)).toBe(true); expect(flow.send(input)).toBe(false);
    await settle();
    expect(a.create).toHaveBeenCalledWith(input, expect.any(String), expect.any(AbortSignal), expect.any(Function));
    expect(a.queue.mock.calls[0]![0]).toBe(id(7)); expect(a.queue.mock.calls[0]![1]).toEqual({ expectedVersion: 1 });
    expect(a.queue.mock.calls[0]![2]).not.toBe(a.create.mock.calls[0]![1]);
    expect(flow.snapshot()).toMatchObject({ phase: 'SENT', message: { recipientCount: 3 } }); expect(sent).toHaveBeenCalledTimes(1);
    expect(flow.locked).toBe(false);
  });
  it('an unknown save is retried with the same key, then sent', async () => {
    const a = api();
    a.create.mockRejectedValueOnce(new CommsError('UNKNOWN')).mockResolvedValueOnce(receipt('CREATE', { messageId: id(7), status: 'DRAFT', version: 1 }));
    a.queue.mockResolvedValue(receipt('QUEUE', { messageId: id(7) }));
    const flow = new HqSendFlow(a);
    flow.send(input); await settle();
    expect(flow.snapshot()).toEqual({ phase: 'UNKNOWN', step: 'SAVE', messageId: null }); expect(flow.locked).toBe(true); expect(flow.canRetry).toBe(true);
    expect(flow.send(input)).toBe(false);
    flow.tryAgain(); await settle();
    expect(a.create.mock.calls[1]![1]).toBe(a.create.mock.calls[0]![1]); expect(a.create.mock.calls[1]![0]).toBe(a.create.mock.calls[0]![0]);
    expect(flow.snapshot().phase).toBe('SENT');
  });
  it('an unknown send is retried with the same send key and never saves again', async () => {
    const a = api();
    a.create.mockResolvedValue(receipt('CREATE', { messageId: id(7), status: 'DRAFT', version: 1 }));
    a.queue.mockRejectedValueOnce(new CommsError('UNKNOWN')).mockResolvedValueOnce(receipt('QUEUE', { messageId: id(7) }));
    const flow = new HqSendFlow(a);
    flow.send(input); await settle();
    expect(flow.snapshot()).toEqual({ phase: 'UNKNOWN', step: 'SEND', messageId: id(7) });
    flow.tryAgain(); await settle();
    expect(a.create).toHaveBeenCalledTimes(1); expect(a.queue.mock.calls[1]![2]).toBe(a.queue.mock.calls[0]![2]);
    expect(flow.snapshot().phase).toBe('SENT');
  });
  it('a refused send keeps the saved message and says why; a refused save sends nothing', async () => {
    const a = api();
    a.create.mockResolvedValueOnce(receipt('CREATE', { messageId: id(7), status: 'DRAFT', version: 1 }));
    a.queue.mockRejectedValueOnce(new CommsError('REFUSED', 'HQ_MESSAGE_NO_RECIPIENTS'));
    const flow = new HqSendFlow(a);
    flow.send(input); await settle();
    expect(flow.snapshot()).toEqual({ phase: 'SAVED', messageId: id(7), code: 'HQ_MESSAGE_NO_RECIPIENTS', kind: 'REFUSED' }); expect(flow.locked).toBe(false);
    a.create.mockRejectedValueOnce(new CommsError('DENIED'));
    flow.send(input); await settle();
    expect(flow.snapshot()).toEqual({ phase: 'FAILED', kind: 'DENIED', code: null }); expect(a.queue).toHaveBeenCalledTimes(1);
  });
  it('a session end drops a kept send; a late answer changes nothing', async () => {
    const a = api(); let finish!: (r: HqMessageReceipt) => void;
    a.create.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const flow = new HqSendFlow(a);
    flow.send(input); await settle(); flow.drop();
    finish(receipt('CREATE', { status: 'DRAFT', version: 1 })); await settle();
    expect(a.queue).not.toHaveBeenCalled(); expect(flow.snapshot()).toEqual({ phase: 'IDLE' }); expect(flow.locked).toBe(false);
  });
});

const base = (patch: Partial<InboxViewProps> = {}): InboxViewProps => ({ language: 'en', formattingLocale: 'en-US', timeZone: 'UTC', concealed: false,
  list: { state: 'READY', messages: [msg(), msg({ messageId: id(9), schoolId: id(4), schoolDisplayName: 'Second Dojo', content: 'Billing update', channel: 'SMS', createdAt: '2026-11-04T00:00:00.000Z' })],
    purposes: ['SUPPORT', 'BILLING'], next: false, loadingMore: false, moreFailed: false },
  open: null, thread: { state: 'LOADING' }, picker: null, opening: null, search: '', send: { phase: 'IDLE' }, locked: false, canRetry: false,
  onSearch() {}, onRefresh() {}, onReveal() {}, onMore() {}, onOlder() {}, onOpen() {}, onBack() {}, onNew() {}, onPickCancel() {}, onPick() {}, onRetryOpen() {},
  onSend: () => true, onTryAgain() {}, onDismiss() {}, ...patch });
const html = (p: InboxViewProps) => renderToStaticMarkup(<HqInboxView {...p}/>);

describe('HQ inbox screen', () => {
  it('lists one conversation per school with New message, settings and numbers links', () => {
    const h = html(base());
    expect(h).toContain('data-hq-inbox="ready"'); expect(h).toContain('New message');
    expect(h).toContain('href="/hq/communications/settings"'); expect(h).toContain('href="/hq/communications/numbers"');
    expect(h.indexOf('Second Dojo')).toBeLessThan(h.indexOf('Synthetic Academy')); expect(h).toContain('Text: Billing update');
    expect(h).not.toMatch(/@|\+1\d{10}/);
  });
  it('opens a thread with the owners and a Text or Email composer limited to the purposes the reader holds', () => {
    const h = html(base({ open: { organizationId: id(2), schoolId: id(3), schoolDisplayName: 'Synthetic Academy', supportCaseId: id(70) },
      thread: { state: 'READY', messages: [msg()], next: true, loadingMore: false } }));
    expect(h).toContain('data-open="true"'); expect(h).toContain('Owners of Synthetic Academy'); expect(h).toContain('Linked to a support case.');
    expect(h).toContain('Your sign-in link was reset.'); expect(h).toContain('2 delivered'); expect(h).toContain(`href="/hq/communications/${id(1)}"`);
    expect(h).toContain('data-hq-composer'); expect(h).toContain('>Text<'); expect(h).toContain('>Email<');
    expect(h).toContain('<option value="SUPPORT" selected="">Support</option>'); expect(h).toContain('>Billing</option>'); expect(h).not.toContain('>Account</option>');
    expect(h).toContain('Show earlier messages');
  });
  it('New message is not offered while a send is kept for Try again', () => {
    expect(html(base({ locked: true }))).toMatch(/<button type="button" class="[^"]*" disabled="">New message<\/button>/);
    expect(html(base())).not.toMatch(/disabled="">New message/);
  });
  it('is read only without a sending purpose', () => {
    const p = base({ open: { organizationId: id(2), schoolId: id(3), schoolDisplayName: 'Synthetic Academy', supportCaseId: null }, thread: { state: 'READY', messages: [], next: false, loadingMore: false } });
    const h = html({ ...p, list: { ...(p.list as Extract<InboxViewProps['list'], { state: 'READY' }>), purposes: [] } });
    expect(h).not.toContain('data-hq-composer'); expect(h).toContain('cannot send texts or email'); expect(h).toContain('No messages to this school yet');
  });
  it('says what happened to a send, with Try again only for an unknown answer', () => {
    const open = { organizationId: id(2), schoolId: id(3), schoolDisplayName: 'Synthetic Academy', supportCaseId: null };
    const thread = { state: 'READY' as const, messages: [], next: false, loadingMore: false };
    expect(html(base({ open, thread, send: { phase: 'SENT', message: msg({ recipientCount: 3 }) } }))).toContain('Sent to 3 owners');
    const unknown = html(base({ open, thread, send: { phase: 'UNKNOWN', step: 'SEND', messageId: id(7) }, locked: true, canRetry: true }));
    expect(unknown).toContain('it will not go twice'); expect(unknown).toContain('>Try again<');
    expect(html(base({ open, thread, send: { phase: 'SAVED', messageId: id(7), code: 'HQ_MESSAGE_NO_RECIPIENTS', kind: 'REFUSED' } }))).toContain('this school has no owners to write to');
    expect(html(base({ open, thread, send: { phase: 'FAILED', kind: 'DENIED', code: null } }))).toContain('Nothing was sent: your HQ access does not allow this purpose.');
  });
  it('New message lists schools to pick from (archived ones are filtered by the container)', () => {
    const h = html(base({ picker: { state: 'READY', schools: [{ schoolId: id(5), organizationDisplayName: 'Pick Org', schoolDisplayName: 'Pick School',
      organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: null, createdAt: '2026-11-01T00:00:00.000Z' }] } }));
    expect(h).toContain('data-hq-inbox-picker="ready"'); expect(h).toContain(`data-hq-pick="${id(5)}"`); expect(h).toContain('Pick School');
  });
  it('shows nothing but a notice when the session ended, loading or denied', () => {
    expect(html(base({ concealed: true }))).not.toContain('Synthetic Academy');
    expect(html(base({ concealed: true }))).toContain('Hidden because your session ended');
    expect(html(base({ list: { state: 'DENIED' } }))).toContain('does not include texting or email');
    expect(html(base({ list: { state: 'LOADING' } }))).toContain('aria-busy="true"');
  });
});

describe('wording and routes', () => {
  it('has every key in English, Korean and Spanish, and a reason for every outcome', () => {
    const keys = Object.keys(inboxCatalogs.en!);
    for (const lang of ['ko', 'es']) expect(Object.keys(inboxCatalogs[lang]!).sort()).toEqual([...keys].sort());
    expect(inboxText('ko', 'send')).toBe('보내기'); expect(inboxText('xx', 'send')).toBe('Send');
    expect(inboxWhyKey('REFUSED', 'HQ_MESSAGE_NOT_DRAFT')).toBe('w_HQ_MESSAGE_NOT_DRAFT'); expect(inboxWhyKey('REFUSED', 'SOMETHING_NEW')).toBe('w_REFUSED');
    expect(inboxWhyKey('UNKNOWN', null)).toBe('w_REFUSED');
  });
  it('Texts and email opens the inbox; senders move to Settings; HQ never hides on blur here', () => {
    expect(readFileSync('src/app/hq/communications/page.tsx', 'utf8')).toContain('<HqInbox ');
    expect(readFileSync('src/app/hq/communications/settings/page.tsx', 'utf8')).toContain('<HqCommunications target={null}/>');
    const source = readFileSync('src/components/hq-communications/inbox.tsx', 'utf8');
    expect(source).not.toMatch(/'blur'|'pagehide'|visibilitychange/); expect(source).toContain('useConcealment');
  });
});
