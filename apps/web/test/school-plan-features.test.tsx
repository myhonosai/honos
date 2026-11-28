import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HON_OS_PLAN_CAPABILITIES, type SaasSchoolPlanFeatures } from '@hon/contracts';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { PLAN_FEATURE_FOR_PAGE, PLAN_UPGRADE_HREF, lockedPages, planLockCopy, readSchoolPlanFeatures } from '../src/components/school-shell/plan-features';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const AI_ONLY = ['marketing.campaigns_ai_managed', 'attribution.ai_insight', 'ai.workforce', 'ai.delegated_jobs', 'ai.orchestration'];
const features = (locked: string[], planName: string | null = 'HON OS Core'): SaasSchoolPlanFeatures => ({ schoolId: B, source: locked.length ? 'OFFER' : 'NONE',
  planName: locked.length ? planName : null, included: HON_OS_PLAN_CAPABILITIES.filter(c => !locked.includes(c)), locked, asOf: '2026-11-27T10:00:00.000Z' });
const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: { organizationId: A, schoolId: B }, schoolName: null,
  choices: [], mode: 'classic', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};
const render = (props: Partial<SchoolShellFrameProps> = {}) => renderToStaticMarkup(
  <SchoolShellFrame {...base} {...props}><p data-testid="page">private page</p></SchoolShellFrame>);

describe('school plan features (0699): locked pages with an Upgrade button', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps every locked capability to its menu pages, and never locks Settings or the Dashboard', () => {
    for (const capability of Object.values(PLAN_FEATURE_FOR_PAGE)) expect(HON_OS_PLAN_CAPABILITIES).toContain(capability);
    for (const key of Object.keys(PLAN_FEATURE_FOR_PAGE)) expect(SCHOOL_SHELL_NAV.some(item => item.key === key)).toBe(true);
    expect([...lockedPages(features(AI_ONLY))].sort()).toEqual(['aiTeam', 'conversationAi']);
    expect(lockedPages(features([])).size).toBe(0);
    expect(lockedPages(null).size).toBe(0);
    const everything = lockedPages(features(HON_OS_PLAN_CAPABILITIES.slice(1)));
    for (const key of ['settings', 'home', 'staff', 'messages'] as const) expect(everything.has(key)).toBe(false);
  });

  it('marks locked menu pages and shows the Upgrade card instead of a locked page', () => {
    const locks = lockedPages(features(AI_ONLY));
    const home = render({ lockedPages: locks, planName: 'HON OS Core' });
    expect(home).toMatch(/data-nav="aiTeam"[^>]*data-plan-locked="true"/);
    expect(home).not.toMatch(/data-nav="students"[^>]*data-plan-locked/);
    expect(home).toContain('Locked: not in your plan');
    expect(home).toContain('private page');
    const locked = render({ path: '/staff/ai-team', lockedPages: locks, planName: 'HON OS Core' });
    expect(locked).toContain('data-plan-locked=""');
    expect(locked).not.toContain('private page');
    expect(locked).toContain('AI Team is not in your plan');
    expect(locked).toContain('Your plan, HON OS Core,');
    expect(locked).toContain(`href="${PLAN_UPGRADE_HREF}"`);
    expect(locked).toMatch(/data-plan-upgrade="">Upgrade</);
    // A hidden page owned by a locked area is locked too.
    expect(render({ path: '/staff/ai-team/alex', lockedPages: locks })).not.toContain('private page');
  });

  it('locks nothing until the school is verified', () => {
    const html = render({ phase: 'LOADING', path: '/staff/ai-team', lockedPages: lockedPages(features(AI_ONLY)) });
    expect(html).toContain('private page');
    expect(html).not.toContain('data-plan-lock');
  });

  it('has Korean and Spanish copy', () => {
    expect(planLockCopy('ko-KR').upgrade).toBe('업그레이드');
    expect(planLockCopy('es').upgrade).toBe('Mejorar plan');
    expect(planLockCopy('fr').upgrade).toBe('Upgrade');
  });

  it('reads the exact school and rejects refusals, drift and another school', async () => {
    const answer = (status: number, data: unknown) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer(200, features(AI_ONLY)));
    const signal = new AbortController().signal;
    expect((await readSchoolPlanFeatures(B, signal, () => true)).locked).toEqual(AI_ONLY);
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/schools/${B}/plan-features`);
    expect((fetcher.mock.calls[0]![1] as RequestInit).method).toBe('GET');
    fetcher.mockResolvedValueOnce(answer(403, { code: 'SAAS_FORBIDDEN' }));
    await expect(readSchoolPlanFeatures(B, signal, () => true)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(answer(200, { ...features(AI_ONLY), schoolId: A }));
    await expect(readSchoolPlanFeatures(B, signal, () => true)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(answer(200, { ...features(AI_ONLY), locked: ['ai.workforce'] }));
    await expect(readSchoolPlanFeatures(B, signal, () => true)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(answer(200, { ...features([]), source: 'CUSTOM', planName: 'Deal', locked: ['ai.workforce'], included: HON_OS_PLAN_CAPABILITIES.filter(c => c !== 'ai.workforce') }));
    await expect(readSchoolPlanFeatures(B, signal, () => true)).rejects.toThrow();
    await expect(readSchoolPlanFeatures('not-a-uuid', signal, () => true)).rejects.toThrow();
  });
});
