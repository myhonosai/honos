import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PUBLIC_PLAN_CATALOG } from '@hon/config';
import { SAAS_OWNER_APPROVED_DRAFT, SAAS_PLAN_CAPABILITIES } from '@hon/contracts';
import { HON_INTERFACE_THEMES } from '@hon/design-system';
import { INITIAL_SELECTION, OFFER_CHOICES, PLAN_COMPARISON, displayUsd, planDisplay, selectPlan } from '../src/components/school-subscription/catalog';
import { SchoolSubscription } from '../src/components/school-subscription/subscription';

const source = readFileSync('src/components/school-subscription/subscription.tsx', 'utf8');
const catalog = readFileSync('src/components/school-subscription/catalog.ts', 'utf8');
const page = readFileSync('src/app/staff/subscription/page.tsx', 'utf8');
const markup = () => renderToStaticMarkup(<SchoolSubscription/>);

describe('school HON subscription foundation — merged display contracts only', () => {
  it('shows the six approved prices and exact planning allowances without a billing calculation', () => {
    expect(PUBLIC_PLAN_CATALOG.map((p) => p.tier)).toEqual(['CORE', 'COMPLETE']);
    expect(OFFER_CHOICES.map((o) => o.kind)).toEqual(['REGULAR_MONTHLY', 'FOUNDER_MONTHLY', 'FOUNDER_LIFETIME']);
    for (const [tier, values, credits] of [['CORE', [14900, 7900, 189600], 5000], ['COMPLETE', [24900, 14900, 357600], 12000]] as const) {
      OFFER_CHOICES.forEach((o, index) => { const display = planDisplay(tier, o.kind); expect(display.priceMinor).toBe(values[index]); expect(display.premiumAiCreditPlanningAllowance).toBe(credits); });
      expect(planDisplay(tier, 'REGULAR_MONTHLY').priceMinor).toBe(PUBLIC_PLAN_CATALOG.find((p) => p.tier === tier)!.monthlyDisplayPriceUsd * 100);
    }
    expect(displayUsd(189600)).toBe('$1,896'); expect(displayUsd(357600)).toBe('$3,576');
  });
  it('refuses unknown or retired plans and annual/injected offer selections', () => {
    for (const tier of ['ESSENTIAL', 'core', '../hq', 'CORE?role=OWNER']) expect(() => planDisplay(tier as never, 'REGULAR_MONTHLY')).toThrow();
    for (const offer of ['REGULAR_ANNUAL', 'FOUNDER_ANNUAL', 'FREE', 'REGULAR_MONTHLY&schoolId=x']) expect(() => planDisplay('CORE', offer as never)).toThrow();
  });
  it('covers every canonical capability once with exact Core/Complete membership', () => {
    expect(PLAN_COMPARISON.map((r) => r.capability)).toEqual(SAAS_PLAN_CAPABILITIES.COMPLETE);
    for (const row of PLAN_COMPARISON) { expect(row.label.length).toBeGreaterThan(5); expect(row.core).toBe(SAAS_PLAN_CAPABILITIES.CORE.includes(row.capability)); expect(row.complete).toBe(true); }
    expect(PLAN_COMPARISON.filter((r) => !r.core)).toHaveLength(5);
    expect(markup()).toContain('Executable capabilities vary'); expect(markup()).toContain('not activated by plan selection');
  });
  it('renders program limits as limits and never as inventory or eligibility facts', () => {
    expect(SAAS_OWNER_APPROVED_DRAFT.founderProgram).toMatchObject({ totalLimit: 50, monthlyLimit: 30, lifetimeLimit: 20 });
    const html = markup(); expect(html).toContain('first 50 eligible organizations'); expect(html).toContain('30 monthly / 20 lifetime');
    expect(html).toContain('Remaining slots and your eligibility are unavailable.'); expect(html).not.toMatch(/50 (?:slots|offers) (?:left|remaining)|You are eligible/i);
  });
  it('resets review and acknowledgement whenever price terms or plan change', () => {
    let state = selectPlan(INITIAL_SELECTION, { type: 'REVIEW' });
    state = selectPlan(state, { type: 'ACKNOWLEDGE', checked: true }); expect(state.acknowledged).toBe(true);
    state = selectPlan(state, { type: 'OFFER', offer: 'FOUNDER_LIFETIME' }); expect(state).toMatchObject({ reviewing: false, acknowledged: false });
    state = selectPlan(state, { type: 'REVIEW' }); state = selectPlan(state, { type: 'ACKNOWLEDGE', checked: true });
    expect(selectPlan(state, { type: 'PLAN', tier: 'COMPLETE' })).toMatchObject({ reviewing: false, acknowledged: false });
    expect(selectPlan(state, { type: 'EDIT' })).toMatchObject({ reviewing: false, acknowledged: false });
    expect(selectPlan(INITIAL_SELECTION, { type: 'ACKNOWLEDGE', checked: true }).acknowledged).toBe(false);
  });
  it('retains all shared modes as presentation only without a new persistence model', () => {
    expect(HON_INTERFACE_THEMES.map((t) => t.id)).toEqual(['big-button', 'modern', 'classic']);
    expect(source).toContain('HON_INTERFACE_THEMES.map'); expect(source).toContain('data-view={view}');
    expect(source + catalog).not.toMatch(/localStorage|sessionStorage|saveInterfaceTheme|document\.cookie|organizationId|schoolId|principalId/);
    expect(markup()).toContain('Big Button'); expect(markup()).toContain('Modern'); expect(markup()).toContain('Classic');
  });
  it('keeps all account, subscription, credit and checkout facts unavailable rather than inventing a fixture', () => {
    const html = markup(); expect(html).toContain('Current subscription unavailable'); expect(html).toContain('Checkout not connected');
    expect(html).toContain('Not a granted allowance or live balance'); expect(html).toContain('A success URL never proves payment or access.');
    expect(source).toContain('disabled aria-describedby="checkout-reason"');
    expect(html).not.toMatch(/data-fixture|SYNTHETIC|\bPAID\b|Your balance|Subscription active|Checkout successful/);
  });
  it('has no school/HQ/provider transport, unmerged B5 imports, credential form, URL authority or auto action', () => {
    expect(source + catalog + page).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\/api\/|saas-payments|SchoolHonPlan|Idempotency-Key|X-HON-Human-Command|window\.location|searchParams|useSearchParams|<form|type="password"|cardNumber|stripe\.com|https?:\/\//);
    expect(page).toContain('SchoolSubscription');
    expect(readFileSync('src/app/staff/layout.tsx', 'utf8')).toContain('await requireVerifiedWebSession()');
  });
  it('provides honest deterministic HON guidance and accessible panel/confirmation controls', () => {
    expect(source).toContain('AI conversation and voice are unavailable'); expect(source).toContain('event.key === \'Escape\'');
    expect(source).toContain('guideButton.current?.focus()'); expect(source).toContain('reviewHeading.current?.focus()');
    expect(source).toContain('aria-expanded={guideOpen}'); expect(source).toContain('type="checkbox"'); expect(source).not.toMatch(/contentEditable|SpeechRecognition|getUserMedia|MediaRecorder/);
    const html = markup(); expect(html).toContain('Skip to plan selection'); expect(html).toContain('scope="col"'); expect(html).toContain('scope="row"');
  });
  it('links only to an existing school setup route and registers its own protected route once', () => {
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    expect(manifest.routes.filter((r) => r.path === '/staff/subscription')).toHaveLength(1);
    expect(readFileSync('src/app/staff/launch/page.tsx', 'utf8')).toContain('OwnerLaunch');
    expect(markup()).toContain('href="/staff/launch"'); expect(markup()).not.toContain('href="/hq');
  });
});
