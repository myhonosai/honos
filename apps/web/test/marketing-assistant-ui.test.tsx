import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MarketingAssistantWorkbench } from '../src/components/marketing-assistant-workbench';
import { marketingRequest, verifyMarketingView } from '../src/components/marketing-assistant-http';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const base = '/api/v1/marketing/assistant';
const blocked = { id, schoolId:id, campaignId:id, workItemId:id, status:'CONFIGURATION_REQUIRED', reason:'CONFIGURATION_REQUIRED', actionRequestId:null, draft:null, inputTokens:null, outputTokens:null, providerCostMicrounits:null, customerCredits:null };

describe('Marketing Assistant local-only surface', () => {
  it('starts empty without network, credentials, sample drafts, fabricated usage or external publishing', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<MarketingAssistantWorkbench />);
      expect(fetcher).not.toHaveBeenCalled();
      for (const text of ['AI Marketing Assistant', 'No external publishing or delivery', 'No sample draft or production fake', 'Never submit secrets', 'Load authorized campaign plans']) expect(html).toContain(text);
      for (const text of ['Recorded usage:', 'Verified saved', 'School UUID', 'Organization UUID', 'type="password"']) expect(html).not.toContain(text);
    } finally { fetcher.mockRestore(); }
  });

  it('uses only same-origin fixed transport with the human header and retained submit key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok:true, json:async () => ({data:blocked}) } as Response);
    try {
      expect(await marketingRequest(base, {campaignId:id, request:'A safe brief'}, 'retained-key')).toEqual(blocked);
      expect(fetcher).toHaveBeenCalledWith(base, expect.objectContaining({method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error', headers:expect.objectContaining({'X-HON-Human-Command':'marketing-assistant', 'Idempotency-Key':'retained-key'})}));
      for (const route of [`${base}/${id}`, `${base}/${id}/retry`, `${base}/${id}/save-approved`, `${base}/campaigns/${id}/content`]) await marketingRequest(route);
      for (const route of [`https://evil.test${base}`, `//evil.test${base}`, `${base}?schoolId=${id}`, `${base}/${id}/publish`, `${base}/${id}/retry?modelId=other`, `${base}/${id}#fragment`, '/api/v1/payments', '/api/v1/ai/providers']) {
        const before = fetcher.mock.calls.length;
        await expect(marketingRequest(route)).rejects.toThrow();
        expect(fetcher.mock.calls.length).toBe(before);
      }
    } finally { fetcher.mockRestore(); }
  });

  it('does not expose private error bodies or accept missing authoritative envelopes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok:false, status:403, json:async () => ({detail:'PRIVATE_CONTACT credential'})} as Response);
    try {
      await expect(marketingRequest(base)).rejects.toThrow('Current Complete school owner permission is unavailable');
      expect(fetcher.mock.calls).toHaveLength(1);
      fetcher.mockResolvedValue({ok:true, json:async () => ({private:'not a result'})} as Response);
      await expect(marketingRequest(base)).rejects.toThrow('Unverified marketing response');
    } finally { fetcher.mockRestore(); }
  });

  it('rejects authority/secret smuggling, wrong target bindings and unverified draft projections', () => {
    expect(verifyMarketingView(blocked, id, id)).toEqual(blocked);
    for (const field of ['apiKey','organizationId','rawResponse','requestText','providerSecret']) expect(() => verifyMarketingView({...blocked, [field]:'private'})).toThrow();
    expect(() => verifyMarketingView(blocked, other)).toThrow();
    expect(() => verifyMarketingView(blocked, id, other)).toThrow();
    expect(() => verifyMarketingView({...blocked, status:'SAVED'})).toThrow();
    expect(() => verifyMarketingView({...blocked, draft:{title:'Good', content:'Bearer confidential'}})).toThrow();
    expect(() => verifyMarketingView({...blocked, inputTokens:-1})).toThrow();
    expect(() => verifyMarketingView({...blocked, status:'PUBLISHED'})).toThrow();
  });

  it('declares a no-index route and explicit quarantined outcomes without production fake or provider calls', () => {
    const source = readFileSync('src/components/marketing-assistant-workbench.tsx','utf8');
    expect(source).toContain('retry.current');
    expect(source).toContain('No automatic or manual resend is permitted');
    expect(source).toContain('The requester cannot self-approve');
    expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|openrouter\.ai/);
    const page = readFileSync('src/app/staff/marketing/assistant/page.tsx','utf8');
    expect(page).toContain("force-dynamic");
    expect(page).toContain('index:false');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json','utf8'));
    expect(manifest.routes.filter((route:{path:string}) => route.path === '/staff/marketing/assistant')).toHaveLength(1);
  });
});
