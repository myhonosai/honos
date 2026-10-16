import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AiDraftWorkInbox } from '../src/components/ai-draft-work-inbox';
import { AI_DRAFT_WORK_ENDPOINTS, loadMyAiDraftWork, verifyAiDraftWorkItem } from '../src/components/ai-draft-work-http';

const id = '11111111-1111-4111-8111-111111111111';
const work = { id, agentKey:'marcus', schoolId:id, sourceRecordId:id, workItemId:id, status:'AWAITING_APPROVAL', reason:null, actionRequestId:null, updatedAt:'2026-10-16T00:00:00.000Z' } as const;

describe('AI Draft Work inbox', () => {
  it('renders a data-free durable-work surface without chat, provider, usage, or delivery claims', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<AiDraftWorkInbox />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('My AI Draft Work');
      expect(html).toContain('This is not a chat transcript, provider console, or delivery queue.');
      expect(html).toContain('No automatic resend, publishing, messaging, payment, staff decision, or approval occurs here.');
      for (const value of ['OpenRouter', 'token', 'credit', 'prompt', 'draft text', 'School UUID', 'Organization UUID']) expect(html).not.toContain(value);
    } finally { fetcher.mockRestore(); }
  });

  it('accepts only the closed redacted item envelope and fixed agent endpoint', async () => {
    expect(verifyAiDraftWorkItem(work, 'marcus')).toEqual(work);
    for (const extra of ['prompt','draft','providerId','modelId','inputTokens','customerCredits','organizationId','leadName']) expect(() => verifyAiDraftWorkItem({...work, [extra]:'private'}, 'marcus')).toThrow();
    expect(() => verifyAiDraftWorkItem({...work, agentKey:'chad'}, 'marcus')).toThrow();
    expect(() => verifyAiDraftWorkItem({...work, status:'DELIVERED'}, 'marcus')).toThrow();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ok:true,json:async()=>({data:[work]})} as Response);
    try {
      expect(await loadMyAiDraftWork('marcus')).toEqual([work]);
      expect(fetcher).toHaveBeenCalledWith(AI_DRAFT_WORK_ENDPOINTS.marcus, expect.objectContaining({method:'GET', credentials:'same-origin', cache:'no-store', redirect:'error', headers:expect.objectContaining({'X-HON-Human-Command':'ai-draft-work'})}));
      expect(Object.values(AI_DRAFT_WORK_ENDPOINTS)).toEqual(['/api/v1/marketing/assistant/mine','/api/v1/staff/teaching-assistant/mine','/api/v1/staff/leads/assistant/mine']);
    } finally { fetcher.mockRestore(); }
  });

  it('declares a no-index staff route and safe opaque resumption links only', () => {
    const page = readFileSync('src/app/staff/ai-work/page.tsx','utf8');
    const component = readFileSync('src/components/ai-draft-work-inbox.tsx','utf8');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json','utf8'));
    expect(page).toContain("force-dynamic");
    expect(page).toContain('index: false');
    expect(manifest.routes.filter((route:{path:string}) => route.path === '/staff/ai-work')).toHaveLength(1);
    expect(component).toContain('#invocation=${item.id}');
    expect(component).not.toMatch(/localStorage|sessionStorage|invokeLLM|openrouter\.ai|fetch\(/);
  });
});
