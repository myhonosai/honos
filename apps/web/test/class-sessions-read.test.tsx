import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ClassSessionsReadAccessError, classSessionsReadPath, loadCurrentSchoolClassSessions, parseClassSessionsRead } from '../src/components/class-sessions-read-http';
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual, useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; }, useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; }, useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } } }; });
import { ClassSessionsRead } from '../src/components/class-sessions-read';
import Page, { dynamic, metadata } from '../src/app/staff/schedule/sessions/page';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const session = { sessionId: id('3'), name: 'Morning fundamentals', startsAt: '2026-10-16T12:00:00.000Z', endsAt: '2026-10-16T13:00:00.000Z', roomName: null, capacity: 12, bookingPolicy: 'REQUIRED_BOOKING', status: 'SCHEDULED', createdAt: '2026-10-10T12:00:00.000Z' };
const envelope = (data: unknown = [session]) => ({ data, meta: { requestId: id('4'), correlationId: id('4') } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const element = node as Element; return [element, ...elements(element.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; const tree = ClassSessionsRead() as Element; hooks.effects.splice(0).forEach((run) => run()); return tree; }
function field(name: string): Element { return elements(render()).find((element) => element.props.name === name)!; }
function edit(name: string, value: string): void { field(name).props.onChange({ target: { value } }); }
function submit(): void { elements(render()).find((element) => element.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
const settle = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; }); afterEach(() => vi.restoreAllMocks());

describe('bounded current-school Class Sessions browser read', () => {
  it('uses exactly one relative same-origin no-store GET with no body and verifies the closed minimum projection', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(envelope()));
    expect(await loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId)).toEqual([session]);
    expect(fetcher.mock.calls).toEqual([[classSessionsReadPath(scope.organizationId, scope.schoolId), { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'X-HON-Human-Read': 'class-sessions' } }]]);
  });
  it('rejects selector/path substitutions, malformed/broader output, invalid ordering, access loss and unverified responses', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const value of ['', 'org', `${id('1')}?search=x`, `https://evil.test/${id('1')}`]) expect(() => classSessionsReadPath(value, scope.schoolId)).toThrow();
    for (const value of [{ ...envelope(), data: [{ ...session, bookingId: id('5') }] }, { ...envelope(), data: [{ ...session, sessionId: id('5') }, session] }, { ...envelope(), data: [{ ...session, startsAt: 'bad' }] }, { data: [session] }]) expect(() => parseClassSessionsRead(value)).toThrow();
    for (const status of [401, 403]) { fetcher.mockResolvedValueOnce(Response.json({}, { status })); await expect(loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId)).rejects.toBeInstanceOf(ClassSessionsReadAccessError); }
    for (const response of [new Response('bad', { status: 200, headers: { 'Content-Type': 'application/json' } }), Response.json(envelope(), { status: 201 }), Response.json({ data: [{ ...session, bookingId: id('6') }], meta: envelope().meta }, { status: 200 }), new Response('x'.repeat(64_001), { status: 200, headers: { 'Content-Type': 'application/json' } })]) { fetcher.mockResolvedValueOnce(response); await expect(loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId)).rejects.toThrow(); }
  });
  it('starts blank and idle, lists only after an explicit valid scope load, and selection is local-only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(envelope()));
    expect([field('organizationId').props.value, field('schoolId').props.value]).toEqual(['', '']); expect(text(render())).toContain('No session list is shown'); expect(fetcher).not.toHaveBeenCalled(); submit(); await settle(); expect(fetcher).not.toHaveBeenCalled();
    edit('organizationId', scope.organizationId); edit('schoolId', scope.schoolId); submit(); await settle(); expect(fetcher).toHaveBeenCalledTimes(1); expect(text(render())).toContain('Morning fundamentals');
    const select = elements(render()).find((element) => element.type === 'button' && text(element) === 'Select session')!; select.props.onClick(); expect(text(render())).toContain('Selected session'); expect(text(render())).toContain('technical ID is intentionally not needed'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('is protected dynamic/noindex, listed once, and declares no search, booking, mutation, roster, availability or downstream executor', () => {
    const page = Page(); expect(page.type).toBe(ClassSessionsRead); expect(dynamic).toBe('force-dynamic'); expect(metadata.robots).toEqual({ index: false, follow: false });
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/schedule/sessions')).toEqual([{ path: '/staff/schedule/sessions', title: 'HON | Bounded Class Sessions' }]);
    const ui = readFileSync('src/components/class-sessions-read.tsx', 'utf8'); const http = readFileSync('src/components/class-sessions-read-http.ts', 'utf8'); const source = `${ui}\n${http}`;
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|setInterval|setTimeout|dangerouslySetInnerHTML|@Post|method: 'POST'|invokeLLM|searchParams|\/search/); expect(ui).not.toMatch(/fetch\(/); expect(http.match(/fetch\(/g)).toHaveLength(1);
  });
});
