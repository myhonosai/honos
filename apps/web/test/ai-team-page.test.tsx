import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiTeamView } from '../src/components/ai-team/ai-team-page';
import { aiTeamText } from '../src/components/ai-team/copy';
import { homeAiTeam, type Panel } from '../src/components/home/model';
import type { AiTeamReadiness } from '@hon/contracts';
import { readiness, readinessAgent } from './school-home-fixtures';

const KEYS = [['marcus', 'MARKETING', 6], ['kai', 'TEACHING', 6], ['chad', 'CHAD_FOLLOW_UP', 3], ['hon', 'HON_REPLY', 10], ['claire', 'BUSINESS_PERFORMANCE', 15],
  ['alex', 'GENERAL_MANAGEMENT', 15], ['jordan', 'OPERATIONS', 15], ['lena', 'CREATIVE_COMMERCE', 15], ['maya', 'RETENTION', 15]] as const;
const allReady = () => readiness(KEYS.map(([key, agent, credits]) => readinessAgent(key, agent, credits, { providerRuntime: 'READY', available: true, blockedBy: null })));
const view = (panel: Panel<AiTeamReadiness>, language = 'en', hasSchool = true) =>
  renderToStaticMarkup(<AiTeamView language={language} hasSchool={hasSchool} readiness={panel} team={homeAiTeam(panel, 'realistic')} />);

describe('AI team page', () => {
  it('shows all eight launch specialists with a plain description of each', () => {
    const html = view({ state: 'READY', value: allReady() });
    for (const name of ['Kai', 'Chad', 'Marcus', 'Alex', 'Maya', 'Jordan', 'Claire', 'Lena']) expect(html).toContain(`>${name}<small>`);
    expect(html).toContain(aiTeamText('en', 'maya'));
  });

  it('opens a workspace for Chad, Marcus, Kai and Maya, and Ask HON with the specialist picked for the rest', () => {
    const html = view({ state: 'READY', value: allReady() });
    for (const href of ['/staff/leads/assistant', '/staff/marketing/assistant', '/staff/teaching-assistant', '/staff/retention/at-risk']) expect(html).toContain(`href="${href}">Open workspace</a>`);
    for (const id of ['alex', 'jordan', 'claire', 'lena']) expect(html).toMatch(new RegExp(`href="/staff/hon\\?ask=${id}">Ask [A-Z][a-z]+</a>`));
  });

  it('offers no action for anyone readiness does not clear, and says why in plain words', () => {
    const paused = readiness(KEYS.map(([key, agent, credits]) => readinessAgent(key, agent, credits, key === 'chad'
      ? { spendDecision: 'AI_PAUSED_BY_HQ', available: false, blockedBy: 'AI_PAUSED_BY_HQ' } : { providerRuntime: 'READY', available: true, blockedBy: null })));
    const html = view({ state: 'READY', value: paused });
    expect(html).not.toContain('href="/staff/leads/assistant"');
    expect(html).toContain('AI access is off for this school');
  });

  it('never shows anyone as available while checking, when refused, unverifiable, or without a school', () => {
    for (const panel of [{ state: 'LOADING' }, { state: 'DENIED' }, { state: 'UNAVAILABLE' }] as Panel<AiTeamReadiness>[]) {
      const html = view(panel);
      expect(html).not.toContain('Open workspace'); expect(html).not.toContain('?ask=');
      expect(html).toContain('role="status"');
    }
    expect(view({ state: 'READY', value: allReady() }, 'en', false)).not.toContain('Open workspace');
  });

  it('speaks Korean and Spanish', () => {
    expect(view({ state: 'READY', value: allReady() }, 'ko')).toContain(aiTeamText('ko', 'title'));
    expect(view({ state: 'READY', value: allReady() }, 'es')).toContain('Preguntar a Alex');
  });

  it('contains no developer jargon', () => {
    const html = view({ state: 'READY', value: allReady() });
    for (const word of ['UUID', 'OPENROUTER', 'provider', 'inference', 'legacy', 'NOT_CREATED']) expect(html).not.toContain(word);
  });
});
