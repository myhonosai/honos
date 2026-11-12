import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HON_CONVERSATION_COMMAND, HON_SCHOOL_TONE_API, HonConversationError, prepareSchoolTone } from '../src/components/hon-command/hon-conversation-http';
import { HonSchoolToneView, type HonSchoolToneViewProps } from '../src/components/hon-command/hon-school-tone';

// 0256 "How HON talks": the owner picks one closed tone; everyone else sees it read-only.

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/hon`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noop = () => {};
const view = (over: Partial<HonSchoolToneViewProps> = {}) => renderToStaticMarkup(<HonSchoolToneView {...{
  phase: 'READY', tone: 'STANDARD', canManage: true, choice: 'STANDARD', pending: null, onChoose: noop, onSave: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over,
} as HonSchoolToneViewProps} />);

afterEach(() => { vi.unstubAllGlobals(); });

describe('School tone transport (0256)', () => {
  it('freezes a closed tone with a fresh key and refuses anything else', () => {
    const a = prepareSchoolTone(SCHOOL, 'FORMAL'), b = prepareSchoolTone(SCHOOL, 'FORMAL');
    expect(Object.isFrozen(a)).toBe(true); expect(a.key).not.toBe(b.key);
    expect(a.path).toBe(`${BASE}/tone`); expect(JSON.parse(a.body)).toEqual({ tone: 'FORMAL' });
    for (const bad of ['formal', 'PIRATE', '']) expect(() => prepareSchoolTone(SCHOOL, bad)).toThrow(HonConversationError);
  });
  it('reads exactly the tone envelope and sends the human-command header and key', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: { tone: 'FORMAL', canManage: false, updatedAt: '2026-11-11T09:00:00.000Z' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(HON_SCHOOL_TONE_API.read(SCHOOL, new AbortController().signal)).resolves.toMatchObject({ tone: 'FORMAL', canManage: false });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/tone`);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { tone: 'LOUD', canManage: false, updatedAt: null } })));
    expect(((await HON_SCHOOL_TONE_API.read(SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
    const prepared = prepareSchoolTone(SCHOOL, 'FRIENDLY_COACH');
    const send = vi.fn(async () => json(200, { data: { tone: 'FRIENDLY_COACH', previousTone: 'STANDARD', replayed: false } }));
    vi.stubGlobal('fetch', send);
    await expect(HON_SCHOOL_TONE_API.send(prepared)).resolves.toMatchObject({ tone: 'FRIENDLY_COACH' });
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HON_CONVERSATION_COMMAND, 'Idempotency-Key': prepared.key });
  });
});

describe('How HON talks view (0256)', () => {
  it('offers the four tones to the owner, with the current one checked and the facts promise', () => {
    const html = view({ tone: 'FORMAL', choice: 'FORMAL' });
    for (const label of ['Standard', 'Friendly coach', 'Straight to the point', 'Formal']) expect(html).toContain(label);
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toMatch(/value="FORMAL"[^>]*checked=""|checked=""[^>]*value="FORMAL"/);
    expect(html).toMatch(/never changes the facts/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
  it('enables Save only for a changed choice, and is read-only without manage', () => {
    expect(view({ choice: 'FORMAL' })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    const ro = view({ canManage: false, tone: 'FRIENDLY_COACH' });
    expect(ro).not.toContain('type="radio"');
    expect(ro).toContain('Friendly coach');
    expect(ro).toMatch(/Only the school owner can change this/);
  });
  it('keeps the exact retry for an unknown outcome', () => {
    expect(view({ pending: { state: 'UNKNOWN', code: null } })).toContain('Retry the same request');
    expect(view({ phase: 'FORBIDDEN' })).not.toContain('type="radio"');
  });
});
