import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HON_AI_TEAM } from '@hon/design-system';
import { ClassicDashboard } from '../src/components/classic-dashboard/classic-dashboard';
import { PORTRAIT_STYLES, portraitSource } from '../src/components/classic-dashboard/portraits';
import { SAMPLE_METRICS, SAMPLE_RECOMMENDATIONS } from '../src/components/classic-dashboard/sample-data';

const markup = renderToStaticMarkup(<ClassicDashboard />);
const source = ['classic-dashboard.tsx', 'sample-data.ts', 'portraits.ts', 'icons.tsx']
  .map((file) => readFileSync(join('src/components/classic-dashboard', file), 'utf8'))
  .join('\n');

describe('Classic school dashboard reference', () => {
  it('is a no-index reference route that labels its data as sample-only', () => {
    expect(readFileSync('src/app/reference/classic-dashboard/page.tsx', 'utf8')).toContain('robots: { index: false, follow: false }');
    expect(markup).toContain('Reference preview · sample data only · not connected to a school');
    expect(markup).toContain('Sample entitlement');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    expect(manifest.routes.filter((route) => route.path === '/reference/classic-dashboard')).toHaveLength(1);
  });

  it('links only to its own route, the existing reference views, or real staff pages', () => {
    const hrefs = [...new Set([...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1] as string))];
    expect(hrefs.length).toBeGreaterThan(15);
    for (const href of hrefs) {
      if (href === '#dashboard-main' || href === '/reference/classic-dashboard') continue;
      expect(href, href).toMatch(/^\/staff\//);
      expect(existsSync(join('src/app', href, 'page.tsx')), href).toBe(true);
    }
  });

  it('shows contract-unavailable measures as unavailable instead of estimating them', () => {
    for (const fact of [SAMPLE_METRICS.revenue, SAMPLE_METRICS.trialConversion, SAMPLE_METRICS.attendanceDecline, SAMPLE_METRICS.unansweredInquiries]) {
      expect(fact.availability).not.toBe('AVAILABLE');
      expect(markup).toContain(fact.reason);
    }
    expect(markup).toContain('not cash revenue');
    expect(markup).toContain('Unknown payment outcomes are never treated as paid.');
    expect(markup).not.toMatch(/vs\.? last|↑|▲/);
  });

  it('keeps recommendations navigation-only and never automatic', () => {
    for (const recommendation of SAMPLE_RECOMMENDATIONS) {
      expect(recommendation.action).toBe('NAVIGATE');
      expect(recommendation.automaticExecution).toBe(false);
      expect(markup).toContain(`href="${recommendation.route}"`);
    }
  });

  it('shows the locked school AI roster with presentation-only portrait styles and no invented activity', () => {
    for (const member of HON_AI_TEAM) expect(markup).toContain(`>${member.name}<`);
    expect(markup).toContain('no work recorded in this sample');
    expect(markup).not.toMatch(/Running|Engaged|Optimizing|In progress|Working|Thinking/);
    for (const member of HON_AI_TEAM) expect(markup).toMatch(new RegExp(`aria-label="${member.name}, [^"]+\\. (Drafts · approval|Planned)\\. Open [^"]+"`));
    expect(markup).toContain('href="/staff/leads/assistant"');
    expect(markup).toContain('href="/staff/marketing/assistant"');
    expect(markup).not.toContain('/staff/teaching-assistant');
    expect(markup).toContain('aria-label="Claire, Business Performance Manager. Planned. Open AI draft inbox (dedicated workspace not yet available)"');
    expect(markup).toMatch(/<a [^>]*href="\/staff\/ai-work"[^>]*aria-label="Claire, /);
    expect(PORTRAIT_STYLES.map((style) => style.label)).toEqual(['Realistic', 'Anime', 'Chibi']);
    for (const member of HON_AI_TEAM) {
      expect(portraitSource(member.id, 'realistic')).toBe(member.portrait);
      expect(existsSync(join('public', member.portrait))).toBe(true);
      expect(portraitSource(member.id, 'anime')).toMatch(/^\/manus-storage\/async-images\//);
      expect(portraitSource(member.id, 'chibi')).toMatch(/^\/manus-storage\/async-images\//);
    }
    expect(markup).toContain('Presentation only. Never changes data, permissions, or AI authority.');
  });

  it('puts HON and all seven employees above the key figures and labels real versus planned capability', () => {
    const team = markup.indexOf('id="team-heading"');
    expect(team).toBeGreaterThan(-1);
    expect(team).toBeLessThan(markup.indexOf('aria-label="Key figures"'));
    expect(markup).toContain('HON &amp; your AI team');
    expect(markup.match(/data-availability="DRAFTS"/g)).toHaveLength(2);
    expect(markup.match(/data-availability="PLANNED"/g)).toHaveLength(5);
    for (const name of ['Chad', 'Marcus']) expect(markup).toMatch(new RegExp(`aria-label="${name}, [^"]+\\. Drafts · approval\\.`));
    for (const name of ['Alex', 'Maya', 'Jordan', 'Claire', 'Lena']) expect(markup).toMatch(new RegExp(`aria-label="${name}, [^"]+\\. Planned\\.`));
    expect(markup).toContain('plan, provider and credit setup are not checked in this preview');
    expect(markup.match(/data-hon-trigger/g)).toHaveLength(3);
    expect(markup.indexOf('data-hon-trigger')).toBeLessThan(markup.indexOf('aria-label="Key figures"'));
  });

  it('shows the three-mode view selector as an inert visual reference, with the appearance control inline under the school selector', () => {
    expect(markup).toContain('<span aria-current="page">Classic</span>');
    for (const label of ['Big-Button', 'Modern']) expect(markup).toMatch(new RegExp(`<button type="button" aria-disabled="true" title="Visual reference only: switching views is not implemented in this proof">${label}</button>`));
    expect(markup).toContain('Visual reference · switching not wired in this proof');
    expect(markup).not.toMatch(/<a [^>]*href="(\/|\/complete-mobile)"/);
    expect(markup).toMatch(/<details[^>]*>/);
    const school = markup.indexOf('aria-controls="school-menu"');
    const appearance = markup.indexOf('<details');
    const primaryNav = markup.indexOf('aria-label="Primary"');
    expect(school).toBeGreaterThan(-1);
    expect(school).toBeLessThan(appearance);
    expect(appearance).toBeLessThan(primaryNav);
    expect(markup).not.toMatch(/role="dialog"|aria-modal/);
  });

  it('offers a persistent, clearly labeled, navigation-only HON assistant entry point', () => {
    expect(markup.match(/aria-label="Open HON assistant"/g)).toHaveLength(2);
    expect(markup).toContain('data-hon-trigger');
    expect(markup).not.toContain('id="hon-panel"');
    const component = readFileSync('src/components/classic-dashboard/classic-dashboard.tsx', 'utf8');
    expect(component).toContain('Preview · not connected');
    expect(component).toContain('chat and voice are not connected: nothing is sent and HON takes no action');
    expect(component).toMatch(/<input id="hon-message" type="text" disabled/);
    expect(component).toMatch(/<button type="button" disabled aria-label="Voice is off in this preview">/);
    expect(component).toContain('href="/staff/voice"');
    expect(component).not.toMatch(/onSubmit|getUserMedia|SpeechRecognition|WebSocket|EventSource/);
  });

  it('collapses detailed sections on phones behind accessible toggles while keeping priorities visible', () => {
    const toggles = [...markup.matchAll(/aria-expanded="false" aria-controls="(panel-[a-z0-9-]+-body)"/g)].map((match) => match[1]);
    expect(toggles).toHaveLength(8);
    for (const id of toggles) expect(markup).toContain(`id="${id}"`);
    expect(markup).not.toContain('aria-controls="panel-today-at-a-glance-body"');
    expect(markup).not.toContain('aria-controls="panel-needs-attention-body"');
    expect(markup).toContain('View all 5 in Command Center');
    expect(markup.match(/data-beyond-phone-limit="true"/g)).toHaveLength(2);
  });

  it('reads no API, storage, or AI path and never touches protected visual files', () => {
    expect(source).not.toMatch(/fetch\(|localStorage|sessionStorage|XMLHttpRequest|executeAction|invokeLLM|hon-reference-suite|hon-control-shell|interface-theme/);
  });
});
