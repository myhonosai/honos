import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HON_CONVERSATION_COMMAND, HON_SCHOOL_BRIEFING_API, HonConversationError, prepareBriefingSettings, prepareMyBriefing,
} from '../src/components/hon-command/hon-conversation-http';
import { HonWeeklyBriefingView, type HonWeeklyBriefingViewProps } from '../src/components/hon-command/hon-weekly-briefing';

// 0257 weekly briefing, part 1: the owner's switch and hour, "Email me" for oneself, and a preview. Nothing is sent.

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/hon`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noop = () => {};
const BRIEFING = { enabled: false, sendHour: 8, canManage: true, me: { email: false, canSubscribe: true } };
const view = (over: Partial<HonWeeklyBriefingViewProps> = {}) => renderToStaticMarkup(<HonWeeklyBriefingView {...{
  phase: 'READY', briefing: BRIEFING, draft: { enabled: false, sendHour: 8 }, preview: { state: 'IDLE' }, pending: null,
  onDraft: noop, onSaveSettings: noop, onEmail: noop, onPreview: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over,
} as HonWeeklyBriefingViewProps} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('Weekly briefing transport (0257)', () => {
  it('freezes closed inputs with a fresh key and refuses anything else', () => {
    const a = prepareBriefingSettings(SCHOOL, true, 7), b = prepareBriefingSettings(SCHOOL, true, 7);
    expect(Object.isFrozen(a)).toBe(true); expect(a.key).not.toBe(b.key);
    expect(a.path).toBe(`${BASE}/briefing/settings`); expect(JSON.parse(a.body)).toEqual({ enabled: true, sendHour: 7 });
    for (const hour of [5, 12, 8.5]) expect(() => prepareBriefingSettings(SCHOOL, true, hour)).toThrow(HonConversationError);
    const me = prepareMyBriefing(SCHOOL, true);
    expect(me.path).toBe(`${BASE}/briefing/me`); expect(JSON.parse(me.body)).toEqual({ email: true });
  });
  it('reads exact envelopes and sends the human-command header and key', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: BRIEFING }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(HON_SCHOOL_BRIEFING_API.read(SCHOOL, new AbortController().signal)).resolves.toEqual(BRIEFING);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/briefing`);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { ...BRIEFING, me: { email: false } } })));
    expect(((await HON_SCHOOL_BRIEFING_API.read(SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
    const pv = vi.fn(async () => json(200, { data: { subject: 'HON weekly briefing: Demo', text: 'New leads in the last 24 hours: 2' } }));
    vi.stubGlobal('fetch', pv);
    await expect(HON_SCHOOL_BRIEFING_API.preview(SCHOOL, new AbortController().signal)).resolves.toMatchObject({ subject: 'HON weekly briefing: Demo' });
    expect((pv.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/briefing/preview`);
    const prepared = prepareMyBriefing(SCHOOL, true);
    const send = vi.fn(async () => json(200, { data: { record: { ...BRIEFING, me: { email: true, canSubscribe: true } }, replayed: false } }));
    vi.stubGlobal('fetch', send);
    await expect(HON_SCHOOL_BRIEFING_API.send(prepared)).resolves.toMatchObject({ replayed: false });
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HON_CONVERSATION_COMMAND, 'Idempotency-Key': prepared.key });
  });
});

describe('Weekly briefing view (0257)', () => {
  it('gives the owner the switch and the six hours, says honestly that nothing is sent yet', () => {
    const html = view();
    expect(html).toContain('Weekly briefing');
    expect(html.match(/<option/g)).toHaveLength(6);
    expect(html).toMatch(/Nothing is sent yet/);
    expect(html).toMatch(/never names/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(view({ draft: { enabled: true, sendHour: 8 } })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
  it('is read-only without manage, and Email me needs the Command Center permission to turn on', () => {
    const ro = view({ briefing: { ...BRIEFING, enabled: true, sendHour: 7, canManage: false } });
    expect(ro).not.toContain('<select');
    expect(ro).toMatch(/On, Mondays at 7:00 AM/);
    expect(ro).toMatch(/Only the school owner can change this/);
    const blocked = view({ briefing: { ...BRIEFING, me: { email: false, canSubscribe: false } } });
    expect(blocked).toMatch(/name="hon-briefing-email"[^>]*disabled=""|disabled=""[^>]*name="hon-briefing-email"/);
    expect(blocked).toMatch(/needs the Command Center permission/);
    const canStop = view({ briefing: { ...BRIEFING, me: { email: true, canSubscribe: false } } });
    expect(canStop).not.toMatch(/name="hon-briefing-email"[^>]*disabled=""|disabled=""[^>]*name="hon-briefing-email"/);
  });
  it('shows the preview text as plain text and keeps the exact retry for an unknown outcome', () => {
    const html = view({ preview: { state: 'READY', subject: 'HON weekly briefing: Demo <b>', text: 'New leads in the last 24 hours: 2' } });
    expect(html).toContain('HON weekly briefing: Demo &lt;b&gt;');
    expect(html).toContain('New leads in the last 24 hours: 2');
    expect(view({ pending: { state: 'UNKNOWN', code: null } })).toContain('Retry the same request');
    expect(view({ phase: 'FORBIDDEN' })).not.toContain('<select');
  });
});
