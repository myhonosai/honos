import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ParentJourney, JourneyChildDetails } from '../src/components/parent-journey';
import { loadParentJourney, ParentJourneyAccessError } from '../src/components/parent-journey-http';
import { verifyParentJourneyView, type ParentJourneyView } from '@hon/contracts';
const id = '11111111-1111-4111-8111-111111111111';
const from = '2026-01-01T00:00:00.000Z', to = '2026-01-31T00:00:00.000Z';
const unavailable = { status: 'UNAVAILABLE' as const, reason: 'READ_API_UNAVAILABLE' as const };
const view = (): ParentJourneyView => ({ generatedAt: from, from, to, accessLevel: 'PRIMARY_GUARDIAN', children: [{ name: 'Authorized child', profileAvailable: true, programs: [{ name: 'Actual curriculum', rank: 'Actual rank', requirements: { status: 'AVAILABLE', limited: false, items: [{ label: 'Actual requirement', kind: 'TECHNIQUE', required: true, status: null, recordedAt: null }] } }], schedule: { status: 'AVAILABLE', items: [], limited: false }, achievements: { status: 'AVAILABLE', items: [], limited: false } }], documents: { status: 'AVAILABLE', items: [], limited: false }, documentReceipts: unavailable, plannedAbsences: unavailable });
const response = (data: unknown) => Response.json({ data, meta: { requestId: id, correlationId: id } });
describe('family-safe Parent Journey', () => {
  it('has one fixed same-origin credentialed GET, no authority or redirect follow, and strict DTO verification', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view()));
    try {
      await expect(loadParentJourney()).resolves.toEqual(view());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/parent/journey', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const secret of ['familyId', 'studentProfileId', 'schoolId', 'principalId', 'staffNote', 'invoice', 'paymentMethod', 'coParentEvidence', 'history', 'aiAction']) expect(() => verifyParentJourneyView({ ...view(), [secret]: 'PRIVATE' })).toThrow();
      expect(() => verifyParentJourneyView({ ...view(), children: [{ ...view().children[0], reason: 'PRIVATE_REASON' }] })).toThrow();
      expect(() => verifyParentJourneyView({ ...view(), children: [{ ...view().children[0], programs: [{ ...view().children[0]!.programs[0], instructor: 'PRIVATE' }] }] })).toThrow();
    } finally { fetcher.mockRestore(); }
  });
  it('rejects malicious nested DTOs, fabricated observation defaults, invalid bounds and unsafe envelopes', async () => {
    const data = view();
    const requirement = data.children[0]!.programs[0]!.requirements;
    if (requirement.status !== 'AVAILABLE') throw new Error();
    for (const patch of [{ notes: 'PRIVATE_NOTE' }, { status: 'NOT_A_REAL_STATUS' }, { status: 'MET', recordedAt: null }, { status: null, recordedAt: from }]) {
      const candidate = view(); const req = candidate.children[0]!.programs[0]!.requirements;
      if (req.status === 'AVAILABLE') req.items[0] = { ...req.items[0]!, ...patch } as never;
      expect(() => verifyParentJourneyView(candidate)).toThrow();
    }
    expect(() => verifyParentJourneyView({ ...view(), to: '2027-01-31T00:00:00.000Z' })).toThrow();
    expect(() => verifyParentJourneyView({ ...view(), generatedAt: '2026-02-30T00:00:00.000Z' })).toThrow();
    const emptyDescription = view(); emptyDescription.children[0]!.achievements = { status: 'AVAILABLE', limited: false, items: [{ name: 'Shared award', description: '', awardedOn: '2026-01-01' }] };
    expect(verifyParentJourneyView(emptyDescription)).toEqual(emptyDescription);
    expect(() => verifyParentJourneyView({ ...view(), children: [{ ...view().children[0], profileAvailable: false }] })).toThrow();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: view(), meta: { requestId: id, correlationId: id, familyId: id } }));
    try { await expect(loadParentJourney()).rejects.toThrow('could not be verified'); fetcher.mockResolvedValue(new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })); await expect(loadParentJourney()).rejects.toThrow('could not be verified'); } finally { fetcher.mockRestore(); }
  });
  it.each([401, 403])('sanitizes %s permission loss without consuming private upstream details', async status => {
    const json = vi.fn(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json } as unknown as Response);
    try { await expect(loadParentJourney()).rejects.toBeInstanceOf(ParentJourneyAccessError); expect(json).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); }
  });
  it('starts in real loading state without fetching during SSR or fabricating a child or progress', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try { const html = renderToStaticMarkup(<ParentJourney/>); expect(fetcher).not.toHaveBeenCalled(); expect(html).toContain('Loading Student Journey'); expect(html).toContain('Big-Button / Phone'); expect(html).not.toMatch(/Avery|Ideal Martial Arts|Green Belt|75%|Eian/); } finally { fetcher.mockRestore(); }
  });
  it('renders only supplied current requirements, empty schedule/recognition and explicit unavailable states', () => {
    const html = renderToStaticMarkup(<JourneyChildDetails child={view().children[0]!} from={from} to={to}/>);
    for (const text of ['Authorized child', 'Actual curriculum', 'Actual rank', 'Actual requirement', 'Not recorded', 'No bookings for this child', 'No currently visible achievements', 'MET or PASSED is not testing approval']) expect(html).toContain(text);
    const unavailableChild = { ...view().children[0]!, profileAvailable: false, programs: [], schedule: unavailable, achievements: unavailable };
    const noProfile = renderToStaticMarkup(<JourneyChildDetails child={unavailableChild} from={from} to={to}/>);
    expect(noProfile).toContain('No current active student profile'); expect(noProfile).toContain('No sibling schedule is substituted');
  });
  it('protects/no-indexes dynamic route, manifests/navigation, local selections and clear-on-access-loss state', () => {
    const route = readFileSync('src/app/parent/journey/page.tsx', 'utf8'); const parent = readFileSync('src/app/parent/page.tsx', 'utf8');
    for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false']) expect(route).toContain(token);
    expect(route).not.toMatch(/searchParams|familyId|studentProfileId/); for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false', 'ParentHome']) expect(parent).toContain(token);
    const component = readFileSync('src/components/parent-journey.tsx', 'utf8'); const http = readFileSync('src/components/parent-journey-http.ts', 'utf8');
    expect(component).toContain('setView(null)'); expect(component).toContain('pending.current?.abort()'); expect(component).toContain("'visibilitychange'"); expect(component).toContain('generation.current === token'); expect(component).toContain('onClick={() => setSelected(i)}');
    expect(component).not.toMatch(/<input|useSearchParams|localStorage|sessionStorage/);
    expect(component).toContain('receipt listing is not available'); expect(component).toContain('no planned-absence read endpoint');
    expect(http + component).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|from\s+['"][^'"]*(?:voice|action|ai|provider|billing)/i);
    const css = readFileSync('src/components/parent-journey.module.css', 'utf8'); expect(css).toContain('var(--surface)'); expect(css).toContain('min-height: 60px'); expect(css).toContain('max-width: 420px');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((r: { path: string }) => r.path === '/parent/journey')).toHaveLength(1);
  });
});
