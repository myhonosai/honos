import React from 'react';
import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { verifySchoolContactCard } from '@hon/contracts/school-contact-card';
import { verifyConversationDetail, verifyConversationList, verifyConversationReplyReceipt } from '@hon/contracts/school-conversations';
import { StaffApp } from '../src/StaffApp';
import { createStaffApi, type StaffApi } from '../src/api/client';
import { ORG, SCHOOL_A } from './fixtures';

// S4 People and Texts (docs/architecture/STAFF_MOBILE_PEOPLE_TEXTS.md).
const P = '44444444-4444-4444-8444-444444444444', P2 = '44444444-4444-4444-8444-444444444445';
const C = '33333333-3333-4333-8333-333333333333', M = '77777777-7777-4777-8777-777777777777', M2 = '77777777-7777-4777-8777-777777777778';
const T = '2026-11-20T17:00:00.000Z';
const school = { organizationId: ORG, schoolId: SCHOOL_A, schoolName: 'North Test School' };
const counts = { ALL: 2, STUDENT: 1, TRIAL: 1, PROSPECT: 0, INACTIVE: 0, ARCHIVED: 0 };
const contact = (over: Record<string, unknown> = {}) => ({ personId: P, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: '+15125550100', segment: 'STUDENT',
  planName: 'Kids monthly', planCode: 'KIDS', programName: 'Little Tigers', membershipEndsAt: null, membershipState: null, age: null, ranks: [{ rank: 'White', color: '#ffffff' }], ...over });
const page = (over: Record<string, unknown> = {}) => ({ data: { generatedAt: T, segment: 'ALL', counts, rows: [contact()], hasMore: false, options: null, nextCursor: null, ...over }, meta: {} });
const card = (over: Record<string, unknown> = {}) => ({ generatedAt: T,
  person: { personId: P, version: 1, givenName: 'Avery', familyName: 'Able', email: 'avery@example.test', phoneE164: '+15125550100', createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: 'Kids monthly', programName: 'Little Tigers', membershipEndsAt: null, ranks: [{ curriculum: 'Karate', rank: 'White', color: '#ffffff' }], openLead: false },
  family: { allowed: true, families: [{ familyId: P2, name: 'Able family', members: [{ personId: P2, givenName: 'Gale', familyName: 'Able', role: 'GUARDIAN', billingContact: true }] }] },
  appointments: { allowed: false }, tasks: { allowed: false }, membership: { allowed: false }, billing: { allowed: false }, messages: { allowed: false },
  timeline: [{ kind: 'ATTENDANCE', at: '2026-11-18T01:00:00.000Z', detail: null }], ...over });
const row = (over: Record<string, unknown> = {}) => ({ conversationId: C, channel: 'SMS', contactAddress: '+15125550100', contactName: 'Ada Lee', personId: P, leadId: null, leadStatus: null,
  leadStage: null, status: 'OPEN', unread: 1, tags: [], assignedTo: null, lastMessage: { direction: 'INBOUND', preview: 'Is class on tonight?', mediaCount: 0, at: T }, lastMessageAt: T,
  lastInboundAt: T, version: 3, ...over });
const msg = (over: Record<string, unknown> = {}) => ({ messageId: M, direction: 'INBOUND', author: 'CONTACT', staffName: null, body: 'Is class on tonight?', mediaCount: 0, at: T, delivery: null, ...over });
const inbox = (over: Record<string, unknown> = {}) => ({ conversations: [row()], nextCursor: null, unreadConversations: 1, canManage: true, ...over });
const detail = (over: Record<string, unknown> = {}) => ({ conversation: row(), messages: [msg()], hasOlder: false, canManage: true,
  contact: { person: { personId: P, givenName: 'Ada', familyName: 'Lee', phone: '+15125550100', email: null, smsConsent: 'OPTED_IN' }, lead: null, nextAppointment: null, peopleWithNumber: 1, schoolCanText: true },
  ...over });
const sent = () => ({ conversation: row({ version: 4, unread: 0 }), message: msg({ messageId: M2, direction: 'OUTBOUND', author: 'STAFF', staffName: 'Sam', body: 'Yes, 6pm.', delivery: 'QUEUED' }) });

describe('People and Texts client', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = (status: number, body: unknown) => createStaffApi({ baseUrl: 'https://api.example.test/api', getToken: async () => 't',
    fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status, json: async () => body } as Response; }) as unknown as typeof fetch });
  const base = `https://api.example.test/api/v1/organizations/${ORG}/schools/${SCHOOL_A}`;
  beforeEach(() => { calls.length = 0; });

  it('searches contacts with only the query, as a native GET, and checks the page', async () => {
    const r = await client(200, page()).findContacts(school, '  ave ');
    expect(r).toMatchObject({ ok: true, data: { hasMore: false, rows: [{ personId: P }] } });
    expect(calls[0]!.url).toBe(`${base}/contacts?query=ave`);
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer t' });
    expect(calls[0]!.init.headers).not.toHaveProperty('Idempotency-Key');
    expect(calls[0]!.init.headers).not.toHaveProperty('Origin');
    for (const bad of [page({ hasMore: true }), page({ segment: 'TRIAL' }), page({ rows: [contact({ segment: 'BOSS' })] }), { data: page().data }]) {
      expect(await client(200, bad).findContacts(school, 'ave')).toEqual({ ok: false, state: 'unavailable' });
    }
    expect(await client(403, { code: 'SCHOOL_CONTACTS_FORBIDDEN' }).findContacts(school, 'ave')).toEqual({ ok: false, state: 'no-staff-access' });
  });
  it('reads one card for that person only', async () => {
    expect((await client(200, { data: card(), meta: {} }).contactCard(school, P)).ok).toBe(true);
    expect(calls[0]!.url).toBe(`${base}/contacts/${P}`);
    expect(await client(200, { data: card(), meta: {} }).contactCard(school, P2)).toEqual({ ok: false, state: 'unavailable' });
    expect(await client(200, { data: card(), meta: {} }).contactCard(school, '../x')).toEqual({ ok: false, state: 'unavailable' });
  });
  it('reads the inbox and one conversation, and marks read with no key', async () => {
    expect((await client(200, { data: inbox(), meta: {} }).inbox(school)).ok).toBe(true);
    expect(calls[0]!.url).toBe(`${base}/conversations`);
    expect((await client(200, { data: detail(), meta: {} }).conversation(school, C)).ok).toBe(true);
    expect(calls[1]!.url).toBe(`${base}/conversations/${C}`);
    expect((await client(200, { data: { conversationId: C, unread: 0, version: 4 }, meta: {} }).markRead(school, C, M)).ok).toBe(true);
    expect(calls[2]!.url).toBe(`${base}/conversations/${C}/read`);
    expect(calls[2]!.init.headers).toMatchObject({ 'X-HON-Human-Command': 'conversation.mark_read', 'Content-Type': 'application/json' });
    expect(calls[2]!.init.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ throughMessageId: M });
  });
  it('replies with the key, the version and only the text; maps refusals', async () => {
    const r = await client(201, { data: sent(), meta: { replayed: false } }).reply(school, C, 3, ' Yes, 6pm. ', 'k-1');
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${base}/conversations/${C}/replies`);
    expect(calls[0]!.init.headers).toMatchObject({ 'X-HON-Human-Command': 'conversation.reply', 'Idempotency-Key': 'k-1' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedVersion: 3, body: 'Yes, 6pm.' });
    expect(await client(422, { code: 'CONVERSATION_CONSENT_REQUIRED' }).reply(school, C, 3, 'x', 'k')).toEqual({ ok: false, state: 'blocked', reason: 'CONVERSATION_CONSENT_REQUIRED' });
    expect(await client(409, { code: 'CONVERSATION_VERSION_CONFLICT' }).reply(school, C, 3, 'x', 'k')).toEqual({ ok: false, state: 'changed' });
    expect(await client(409, { code: 'IDEMPOTENCY_KEY_REUSED' }).reply(school, C, 3, 'x', 'k')).toEqual({ ok: false, state: 'rejected' });
    expect(await client(503, {}).reply(school, C, 3, 'x', 'k')).toEqual({ ok: false, state: 'unknown' });
    expect(await client(403, { code: 'CONVERSATION_FORBIDDEN' }).reply(school, C, 3, 'x', 'k')).toEqual({ ok: false, state: 'no-staff-access' });
    // A receipt for other text is not this reply.
    expect(await client(201, { data: sent(), meta: { replayed: false } }).reply(school, C, 3, 'Different', 'k')).toEqual({ ok: false, state: 'unknown' });
    calls.length = 0;
    expect(await client(201, {}).reply(school, C, 3, '   ', 'k')).toEqual({ ok: false, state: 'rejected' });
    expect(calls).toHaveLength(0);
  });
});

describe('People and Texts screens', () => {
  const session = { token: async () => 't', save: async () => {}, clear: jest.fn(async () => {}), subscribe: () => () => {} };
  let n = 0;
  const newKey = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const fakeApi = (patch: Partial<StaffApi> = {}): StaffApi => ({
    whereIWork: async () => ({ ok: true, data: { kind: 'one', school } }),
    todayClasses: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), roster: jest.fn(), mark: jest.fn(), findStudents: jest.fn(),
    clock: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), punch: jest.fn(),
    myAgents: jest.fn(async () => ({ ok: false as const, state: 'no-staff-access' as const })), startConversation: jest.fn(), ask: jest.fn(),
    findContacts: jest.fn(async () => ({ ok: true as const, data: { rows: [contact() as never], hasMore: false } })),
    contactCard: jest.fn(async () => ({ ok: true as const, data: verifySchoolContactCard(card(), P) })),
    inbox: jest.fn(async () => ({ ok: true as const, data: verifyConversationList(inbox()) })),
    conversation: jest.fn(async () => ({ ok: true as const, data: verifyConversationDetail(detail(), C) })),
    markRead: jest.fn(async () => ({ ok: true as const, data: { conversationId: C, unread: 0, version: 4 } })),
    reply: jest.fn(async () => ({ ok: true as const, data: verifyConversationReplyReceipt(sent(), { conversationId: C, body: 'Yes, 6pm.' }) })),
    ...patch,
  });
  const open = async (api: StaffApi, tab: 'People' | 'Texts') => {
    await render(<StaffApp api={api} session={session} version="0.1.0" newKey={newKey} />);
    await fireEvent.press(await screen.findByRole('tab', { name: tab }));
  };

  it('People: search, open a card with only the sections the role allows, call through the phone', async () => {
    const api = fakeApi();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    await open(api, 'People');
    await fireEvent.changeText(screen.getByLabelText('Search contacts'), 'ave');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(api.findContacts).toHaveBeenCalledWith(school, 'ave');
    await fireEvent.press(await screen.findByRole('button', { name: 'Open Avery Able' }));
    expect(await screen.findByText('avery@example.test')).toBeTruthy();
    expect(screen.getByText('Gale Able')).toBeTruthy();
    expect(screen.queryByText('Memberships')).toBeNull();
    expect(screen.queryByText('Balance due')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Call Avery' }));
    expect(openURL).toHaveBeenCalledWith('tel:+15125550100');
    await fireEvent.press(screen.getByRole('button', { name: 'Back to search' }));
    expect(await screen.findByRole('button', { name: 'Open Avery Able' })).toBeTruthy();
  });
  it('People: a role without contacts says so; nothing matches says so', async () => {
    await open(fakeApi({ findContacts: async () => ({ ok: false, state: 'no-staff-access' }) }), 'People');
    await fireEvent.changeText(screen.getByLabelText('Search contacts'), 'ave');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Your role does not include contacts at this school.')).toBeTruthy();
    await open(fakeApi({ findContacts: async () => ({ ok: true, data: { rows: [], hasMore: false } }) }), 'People');
    await fireEvent.changeText(screen.getByLabelText('Search contacts'), 'zed');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/No contacts match/)).toBeTruthy();
  });
  it('Texts: open marks read up to the newest message, then a reply shows as sent', async () => {
    const api = fakeApi();
    await open(api, 'Texts');
    expect(await screen.findByText('1 unread')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open conversation with Ada Lee, 1 unread' }));
    expect(await screen.findByText('Is class on tonight?')).toBeTruthy();
    expect(api.markRead).toHaveBeenCalledWith(school, C, M);
    await fireEvent.changeText(screen.getByLabelText('Reply to Ada Lee'), 'Yes, 6pm.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(api.reply).toHaveBeenCalledWith(school, C, 3, 'Yes, 6pm.', expect.any(String));
    expect(await screen.findByText('Yes, 6pm.')).toBeTruthy();
  });
  it('Texts: an unknown outcome keeps the key for a safe retry; a blocked reply says why', async () => {
    const reply = jest.fn().mockResolvedValueOnce({ ok: false, state: 'unknown' })
      .mockResolvedValueOnce({ ok: false, state: 'blocked', reason: 'CONVERSATION_CONSENT_REQUIRED' });
    await open(fakeApi({ reply }), 'Texts');
    await fireEvent.press(await screen.findByRole('button', { name: 'Open conversation with Ada Lee, 1 unread' }));
    await fireEvent.changeText(await screen.findByLabelText('Reply to Ada Lee'), 'Yes, 6pm.');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not sure it went through. Tap Send again to retry safely.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(reply.mock.calls[1]![4]).toBe(reply.mock.calls[0]![4]);
    expect(await screen.findByText('This person has not agreed to texts from the school. Nothing was sent.')).toBeTruthy();
  });
  it('Texts: read-only roles see no reply box; no inbox access says so', async () => {
    await open(fakeApi({ conversation: async () => ({ ok: true, data: verifyConversationDetail(detail({ canManage: false }), C) }) }), 'Texts');
    await fireEvent.press(await screen.findByRole('button', { name: 'Open conversation with Ada Lee, 1 unread' }));
    expect(await screen.findByText('Your role can read texts here but not reply.')).toBeTruthy();
    expect(screen.queryByLabelText('Reply to Ada Lee')).toBeNull();
    await open(fakeApi({ inbox: async () => ({ ok: false, state: 'no-staff-access' }) }), 'Texts');
    expect(await screen.findByText('Your role does not include the texts inbox at this school.')).toBeTruthy();
  });
});
