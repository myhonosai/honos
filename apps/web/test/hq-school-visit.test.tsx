import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HqSchoolDirectory } from '@hon/contracts';
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: 'modern' }) }));
import { DirectoryTable } from '../src/components/hq-school-directory';
import { HqVisitBannerView } from '../src/components/hq-school-visit/banner';
import { HqSchoolVisitError, enterSchoolAsHq, leaveSchoolAsHq, readMyHqSchoolVisits } from '../src/components/hq-school-visit/http';
import { SchoolSwitcherView } from '../src/components/school-switcher/switcher';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const org = '44444444-4444-4444-8444-444444444444', visitId = '55555555-5555-4555-8555-555555555555';
const directory: HqSchoolDirectory = { schools: [
  { schoolId: ids[0]!, organizationDisplayName: 'Ideal Org', schoolDisplayName: 'Ideal Martial Arts', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: '2026-11-14T05:46:53.188Z' },
  { schoolId: ids[1]!, organizationDisplayName: 'Paused Org', schoolDisplayName: 'Paused Dojo', organizationOperationalStatus: 'SUSPENDED', schoolOperationalStatus: 'SUSPENDED', entitlementTier: null, createdAt: '2026-11-15T05:46:53.188Z' },
] };
const visit = { visitId, organizationId: org, schoolId: ids[0]!, schoolName: 'Ideal Martial Arts', startedAt: '2026-11-25T16:00:00.000Z', endsAt: '2026-11-25T20:00:00.000Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ goes inside a school', () => {
  it('the HQ Schools ⋯ menu offers Go inside for active schools only', () => {
    const html = renderToStaticMarkup(<DirectoryTable directory={directory} />);
    expect(html.match(/data-action="ENTER"/g)?.length).toBe(1);
    expect(html).toContain('Go inside');
    const row = html.slice(html.indexOf('Paused Dojo'));
    expect(row.slice(0, row.indexOf('</tr>'))).not.toContain('data-action="ENTER"');
  });

  it('the banner says HQ is inside, that it is logged, that money settings stay with the owner, and offers Leave', () => {
    expect(renderToStaticMarkup(<HqVisitBannerView language="en" visit={null} />)).toBe('');
    const html = renderToStaticMarkup(<HqVisitBannerView language="en" visit={visit} timeLabel="8:00 PM" />);
    expect(html).toContain('HON HQ is inside this school'); expect(html).toContain('Until 8:00 PM');
    expect(html).toContain('logged under your name'); expect(html).toContain('Card charges, saved payment methods, refunds (including Point of Sale) and payout settings stay with the owner');
    expect(html).toContain('data-hq-visit-leave'); expect(html).toContain('>Leave<');
    expect(renderToStaticMarkup(<HqVisitBannerView language="ko" visit={visit} busy />)).toContain('나가는 중');
  });

  it('the account switcher links HQ people to the schools list to go inside any school; others never see it', () => {
    const hq = renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'hq' }} isHq schools={[]} />);
    expect(hq).toContain('href="/hq/schools" data-switch-to="hq-schools"'); expect(hq).toContain('Go inside another school');
    const staff = renderToStaticMarkup(<SchoolSwitcherView language="en" current={{ kind: 'school', schoolId: ids[0]!, schoolName: null }} isHq={false}
      schools={[{ organizationId: org, schoolId: ids[0]!, organizationName: 'Ideal Org', schoolName: 'A' }, { organizationId: org, schoolId: ids[1]!, organizationName: 'Ideal Org', schoolName: 'B' }]} />);
    expect(staff).not.toContain('hq-schools');
  });

  it('the school shell shows the banner, which reads only with the HQ display hint', () => {
    const shell = readFileSync('src/components/school-shell/shell.tsx', 'utf8');
    expect(shell).toContain('<HqVisitBanner language={preferences.language}');
    const banner = readFileSync('src/components/hq-school-visit/banner.tsx', 'utf8');
    expect(banner).toMatch(/if \(!schoolId \|\| !readHqHint\(\)\) return;/);
  });

  it('enter and leave send one same-origin human command with the key; failures map to plain reasons', async () => {
    const seen: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { seen.push([url, init]);
      return url.endsWith('/enter') ? json({ data: { visitId, organizationId: org, schoolId: ids[0], action: 'ENTER', startedAt: visit.startedAt, endsAt: visit.endsAt, replayed: false } })
        : json({ data: { visitId, schoolId: ids[0], left: true, leftAt: visit.startedAt, replayed: false } }); }));
    const key = '66666666-6666-4666-8666-666666666666';
    expect((await enterSchoolAsHq(ids[0]!, key, ' Setup ')).organizationId).toBe(org);
    expect(seen[0]![0]).toBe(`/api/v1/hq/schools/${ids[0]}/enter`);
    const headers = seen[0]![1].headers as Record<string, string>;
    expect(headers['X-HON-Human-Command']).toBe('hq-school-visit'); expect(headers['Idempotency-Key']).toBe(key);
    expect(seen[0]![1].body).toBe('{"reason":"Setup"}'); expect(seen[0]![1].credentials).toBe('same-origin');
    expect((await leaveSchoolAsHq(ids[0]!, key)).left).toBe(true);
    expect(seen[1]![0]).toBe(`/api/v1/hq/schools/${ids[0]}/leave`); expect(seen[1]![1].body).toBe('{}');
    for (const [status, code, reason] of [[403, 'HQ_SCHOOL_VISIT_FORBIDDEN', 'forbidden'], [404, 'HQ_SCHOOL_VISIT_UNAVAILABLE', 'unavailable'], [409, 'HQ_SCHOOL_VISIT_OUTCOME_UNKNOWN', 'unknown'], [503, 'X', 'unknown']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ code }, status)));
      await expect(enterSchoolAsHq(ids[0]!, key)).rejects.toMatchObject({ reason });
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { visitId, organizationId: org, schoolId: ids[1], action: 'ENTER', startedAt: visit.startedAt, endsAt: visit.endsAt, replayed: false } })));
    await expect(enterSchoolAsHq(ids[0]!, key)).rejects.toBeInstanceOf(HqSchoolVisitError);
    await expect(enterSchoolAsHq('not-a-uuid', key)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('own visits read validates the closed shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { visits: [visit] } })));
    expect((await readMyHqSchoolVisits(new AbortController().signal)).visits[0]!.schoolName).toBe('Ideal Martial Arts');
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { visits: [{ ...visit, email: 'x' }] } })));
    await expect(readMyHqSchoolVisits(new AbortController().signal)).rejects.toThrow();
  });
});
