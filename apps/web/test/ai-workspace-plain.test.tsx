import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));
import { canTryAgain, draftStatus, plainReason, purposeLabel, type DraftStatus } from '../src/components/ai-workspace/plain';
import { AgentIntroView } from '../src/components/ai-workspace/agent-intro';
import { homeText } from '../src/components/home/copy';
import { FOLLOW_UP_DRAFT_PURPOSES } from '@hon/contracts';

const ALL: DraftStatus[] = ['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED', 'SENDING', 'UNKNOWN', 'FAILED', 'RESULT_RECORDED', 'RESULT_HELD', 'AWAITING_APPROVAL', 'APPROVED', 'SAVED', 'REJECTED'];
const CODE = /\b[A-Z]{2,}_[A-Z_]+\b/;

describe('plain words for AI drafts', () => {
  it('gives every draft status a plain title and detail, never the raw code', () => {
    for (const status of ALL) {
      const { title, detail } = draftStatus(status);
      expect(title, status).not.toMatch(CODE); expect(detail, status).not.toMatch(CODE); expect(title).not.toBe(status);
    }
    expect(draftStatus('SOMETHING_NEW').title).toBe('Status unknown');
  });
  it('offers Try again only before anything was sent', () => {
    expect(ALL.filter(canTryAgain)).toEqual(['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED']);
    for (const never of ['SENDING', 'UNKNOWN', 'FAILED']) expect(canTryAgain(never)).toBe(false);
  });
  it('explains refusals plainly, never shows an unknown code, and never implies a charge', () => {
    for (const reason of ['CUSTOMER_BUDGET_EXCEEDED', 'ORGANIZATION_AI_BUDGET_REACHED', 'CONFIGURATION_REQUIRED', 'AI_PAUSED_BY_HQ', 'NOT_AUTHORIZED', 'NO_ELIGIBLE_ROUTE', 'AI_ACCESS_PAST_DUE', 'AI_TRIAL_FUNDING_NOT_APPROVED', 'PROVIDER_LEAKED_SECRET_X'])
      expect(plainReason(reason), reason).not.toMatch(CODE);
    expect(plainReason('CUSTOMER_BUDGET_EXCEEDED')).toContain('Nothing is charged');
    expect(plainReason(null)).toBeNull();
  });
  it('labels every follow-up purpose in plain words', () => {
    for (const purpose of FOLLOW_UP_DRAFT_PURPOSES) expect(purposeLabel(purpose), purpose).not.toMatch(CODE);
  });
});

describe('agent intro', () => {
  const props = { agent: 'kai' as const, name: 'Kai', role: 'Teaching & Curriculum', lead: 'Drafts lessons.', portrait: '/ai/kai.webp', links: [{ href: '/staff/teaching-studio', label: 'Teaching studio' }] };
  it('shows who the agent is and the readiness status as one heading and one status line', () => {
    const html = renderToStaticMarkup(<AgentIntroView {...props} status="PROVIDER_OFF" />);
    expect(html.match(/<h1/g)).toHaveLength(1); expect(html).toContain('>Kai</h1>');
    expect(html).toContain(homeText('en', 'statusPROVIDER_OFF')); expect(html).toContain('data-agent-status="PROVIDER_OFF"');
    expect(html).toContain('href="/staff/teaching-studio"');
  });
  it('uses the viewer language for the status line', () => {
    expect(renderToStaticMarkup(<AgentIntroView {...props} language="ko" status="READY" />)).toContain(homeText('ko', 'statusREADY'));
  });
});
