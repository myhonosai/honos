import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HQ_OVERVIEW_UNAVAILABLE_REASONS, type HqPlatformOverview } from '@hon/contracts';
import { HQ_EXECUTIVES } from '../src/components/hq-modern/catalog';

const overview: HqPlatformOverview = {
  asOf: '2026-10-18T00:00:00.000Z', callerHqRole: 'OWNER', organizationCount: 2, schoolCount: 3,
  onboarding: { availability: 'AVAILABLE', requestCount: 4, inProgressRequestCount: 1, completedRequestCount: 3 },
  configuredProviderStates: { disabled: 1, configured: 2, healthy: 0, degraded: 0, unavailable: 1 }, taskProfileCount: 5,
  financialMetrics: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics },
  aiUsage: { availability: 'UNAVAILABLE', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage },
  durableHqWork: { availability: 'UNAVAILABLE', state: 'NO_RECORDED_WORK', reason: HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork },
};
const state = vi.hoisted(() => ({ art: 'chibi' as 'chibi' | 'realistic' | 'anime' }));

vi.mock('../src/components/hq-modern/shell', () => ({
  useHqModern: () => ({ overview, art: state.art, view: 'modern', draft: '', setDraft: vi.fn(), openAssistant: vi.fn() }),
  HonCore: () => <span aria-label="HON Core"/>,
}));
import { ExecutivePortrait, HqModernDashboard } from '../src/components/hq-modern/dashboard';

const css = readFileSync(new URL('../src/components/hq-modern/hq-modern.module.css', import.meta.url), 'utf8');

describe('HQ command stage: chibi portraits', () => {
  it('gives every executive their own whole, centred chibi portrait from the approved set', () => {
    state.art = 'chibi';
    HQ_EXECUTIVES.forEach((executive, index) => {
      const html = renderToStaticMarkup(<ExecutivePortrait index={index} executiveKey={executive.executiveKey} name={executive.displayName}/>);
      expect(html).toContain(`/hq-assets/chibi/${executive.executiveKey}.webp`);
      expect(html).toContain(`${executive.displayName}, Chibi portrait`);
      expect(html).not.toContain('--portrait-x');
      expect(existsSync(new URL(`../public/hq-assets/chibi/${executive.executiveKey}.webp`, import.meta.url))).toBe(true);
    });
  });

  it('uses the chibi portrait for each card on the dashboard stage', () => {
    state.art = 'chibi';
    const html = renderToStaticMarkup(<HqModernDashboard/>);
    for (const executive of HQ_EXECUTIVES) expect(html).toContain(`/hq-assets/chibi/${executive.executiveKey}.webp`);
  });

  it('gives every executive their own anime portrait instead of a pending placeholder', () => {
    state.art = 'anime';
    HQ_EXECUTIVES.forEach((executive, index) => {
      const html = renderToStaticMarkup(<ExecutivePortrait index={index} executiveKey={executive.executiveKey} name={executive.displayName}/>);
      expect(html).toContain(`/hq-assets/anime/${executive.executiveKey}.webp`);
      expect(html).toContain(`${executive.displayName}, Anime portrait`);
      expect(html).not.toMatch(/artwork pending/i);
      expect(existsSync(new URL(`../public/hq-assets/anime/${executive.executiveKey}.webp`, import.meta.url))).toBe(true);
    });
    const dashboard = renderToStaticMarkup(<HqModernDashboard/>);
    for (const executive of HQ_EXECUTIVES) expect(dashboard).toContain(`/hq-assets/anime/${executive.executiveKey}.webp`);
  });

  it('leaves the realistic portraits on the approved sprite', () => {
    state.art = 'realistic';
    const html = renderToStaticMarkup(<ExecutivePortrait index={0} executiveKey="chase" name="Chase"/>);
    expect(html).toContain('--portrait-x');
    expect(html).not.toContain('/hq-assets/chibi/');
  });
});

describe('HQ command stage: card alignment', () => {
  it('has no per-card vertical lift or turn, so all six cards share one baseline', () => {
    expect(css).not.toMatch(/\.stageExecutive:nth-child\(\d\)\{[^}]*--card-(lift|turn)/);
    expect(css).not.toMatch(/--card-lift:\s*[1-9]/);
    expect(css).not.toMatch(/--card-turn:\s*-?[1-9]/);
  });

  it('keeps every card the same height with the Workspace button pinned to the bottom', () => {
    expect(css).toMatch(/\.stageExecutive>\.workspaceEntry\{[^}]*margin-top:auto/);
    expect(css).toMatch(/\.stageIdentity p\{[^}]*-webkit-line-clamp:2/);
    expect(css).toMatch(/\.stageIdentity small\{[^}]*-webkit-line-clamp:2/);
    expect(css).toMatch(/\.stageIdentity p\{[^}]*height:2\.8em/);
    expect(css).toMatch(/\.stageIdentity small\{[^}]*height:2\.8em/);
    expect(css).toMatch(/\.stageIdentity h3\{[^}]*white-space:nowrap/);
  });
});
