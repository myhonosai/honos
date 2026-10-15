import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ParentMessageHistory } from '../src/components/parent-message-history';
import { loadParentMessageHistory, ParentMessageHistoryAccessError } from '../src/components/parent-message-history-http';
import { verifyParentMessageHistoryView, type ParentMessageHistoryView } from '@hon/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const view = (): ParentMessageHistoryView => ({ generatedAt: '2026-06-01T00:00:00.000Z', accessLevel: 'PRIMARY_GUARDIAN', messages: { status: 'UNAVAILABLE', reason: 'RECEIPT_EVIDENCE_UNAVAILABLE', items: [], limited: false } });
const response = (data: unknown) => Response.json({ data, meta: { requestId: id, correlationId: id } });

describe('privacy-safe family message history', () => {
  it('has one fixed same-origin credentialed no-store GET and accepts only unavailable receipt-evidence responses', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view()));
    try {
      await expect(loadParentMessageHistory()).resolves.toEqual(view());
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/v1/parent/messages', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      for (const secret of ['familyId', 'studentProfileId', 'schoolId', 'recipientPersonId', 'senderId', 'content', 'channel', 'delivery', 'provider', 'consent', 'campaign', 'messageId']) expect(() => verifyParentMessageHistoryView({ ...view(), [secret]: 'PRIVATE' })).toThrow();
      expect(() => verifyParentMessageHistoryView({ ...view(), accessLevel: 'VIEWER' })).toThrow();
      expect(() => verifyParentMessageHistoryView({ ...view(), messages: { ...view().messages, items: [{ content: 'PRIVATE' }] } })).toThrow();
    } finally { fetcher.mockRestore(); }
  });

  it.each([401, 403])('clears content for %s permission loss without consuming upstream details', async status => {
    const json = vi.fn(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status, json } as unknown as Response);
    try { await expect(loadParentMessageHistory()).rejects.toBeInstanceOf(ParentMessageHistoryAccessError); expect(json).not.toHaveBeenCalled(); } finally { fetcher.mockRestore(); }
  });

  it('starts without SSR data reads or fabricated messages and is explicit about receipt-evidence unavailability', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try { const html = renderToStaticMarkup(<ParentMessageHistory/>); expect(fetcher).not.toHaveBeenCalled(); expect(html).toContain('Loading school message history'); expect(html).toContain('Receipt evidence unavailable'); expect(html).toContain('History only. Nothing changes here.'); expect(html).not.toMatch(/Avery|Ideal Martial Arts|PRIVATE_|Eian/); } finally { fetcher.mockRestore(); }
  });

  it('protects/no-indexes the dynamic no-store route and keeps UI read-only with access-loss concealment', () => {
    const route = readFileSync('src/app/parent/messages/page.tsx', 'utf8'); const component = readFileSync('src/components/parent-message-history.tsx', 'utf8'); const http = readFileSync('src/components/parent-message-history-http.ts', 'utf8');
    for (const token of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'revalidate = 0', "fetchCache = 'force-no-store'", 'index: false', 'follow: false']) expect(route).toContain(token);
    expect(route).not.toMatch(/searchParams|familyId|studentProfileId|recipientPersonId|messageId/);
    for (const token of ['Receipt evidence unavailable', 'Guardian family access unavailable', 'No verified message history shown', 'setView(null)', 'pending.current?.abort()', "'visibilitychange'"]) expect(component).toContain(token);
    expect(component).not.toMatch(/<input|useSearchParams|localStorage|sessionStorage|method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|sendMessage|reply|queueMessage|invokeLLM|executeAction|payment provider/i);
    expect(http + component).not.toMatch(/method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|invokeLLM|executeAction|sendMessage|queueMessage|from\s+['"][^'"]*(?:voice|action|ai|provider|billing)/i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')); expect(manifest.routes.filter((route: { path: string }) => route.path === '/parent/messages')).toEqual([{ path: '/parent/messages', title: 'HON | School message history' }]);
  });
});
