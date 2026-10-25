import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { HonInterfaceTheme } from '@hon/design-system';
import { honMessageProblem, verifyHonReadiness, verifyHonThread, verifyHonThreadPage, verifyHonTurnReceipt, HON_DELEGATE_KEYS } from '../src/components/hon-command/hon-conversation-contract';
import { HonConversationAccessError, HonConversationController, HonConversationRejected, notConnectedConversationSnapshot, type HonConversationSnapshot, type HonConversationSource } from '../src/components/hon-command/hon-conversation-data';
import { HonConversationView } from '../src/components/hon-command/hon-conversation-view';
import { HonWorkspaceView } from '../src/components/hon-command/hon-workspace-view';
import { initialHonCommandSnapshot, type HonCommandSnapshot } from '../src/components/hon-command/hon-command-data';
import { SYNTHETIC_SCOPE, syntheticConversationSource, syntheticThreads } from '../src/components/hon-command/preview/hon-conversation-fixtures';

const MODES: HonInterfaceTheme[] = ['modern', 'big-button', 'classic'];
const scope = SYNTHETIC_SCOPE;
const otherSchool = '00000000-0000-4000-8000-00000000b999';
const READY = { contract: true, providerRoute: true, entitlement: true, authorization: true };
const thread = (index: number) => syntheticThreads()[index]!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function source(overrides: Partial<HonConversationSource> = {}): HonConversationSource & Record<keyof HonConversationSource, ReturnType<typeof vi.fn>> {
  const threads = syntheticThreads();
  return {
    readiness: vi.fn(async () => READY),
    listThreads: vi.fn(async () => ({ items: threads.map((item) => ({ id: item.id, title: item.title, status: 'COMPLETED', updatedAt: '2026-10-20T15:30:00.000Z' })), more: false })),
    readThread: vi.fn(async (_scope: unknown, threadId: string) => threads.find((item) => item.id === threadId)),
    sendTurn: vi.fn(async () => ({ turnId: thread(0).turns[1] && (thread(0).turns[1] as { id: string }).id, threadId: thread(0).id, status: 'PROCESSING', delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [] })),
    ...overrides,
  } as never;
}
function render(snapshot: HonConversationSnapshot, presentation: 'panel' | 'full' = 'full'): string {
  return renderToStaticMarkup(<HonConversationView snapshot={snapshot} presentation={presentation} />);
}
async function opened(src: HonConversationSource | null): Promise<HonConversationController> {
  const controller = new HonConversationController(src, () => 'key-1');
  await controller.open(scope);
  return controller;
}

describe('HON conversation contract verifiers', () => {
  it('accepts only the four closed readiness booleans', () => {
    expect(verifyHonReadiness(READY)).toEqual(READY);
    expect(() => verifyHonReadiness({ ...READY, extra: true })).toThrow('Unverified');
    expect(() => verifyHonReadiness({ ...READY, contract: 'true' })).toThrow('Unverified');
  });

  it('rejects a thread from another school, so nothing from it can be shown', () => {
    expect(verifyHonThread(thread(0), scope.schoolId).id).toBe(thread(0).id);
    expect(() => verifyHonThread({ ...thread(0), schoolId: otherSchool }, scope.schoolId)).toThrow('Unverified');
  });

  it('keeps Kai and unknown names out of management delegation', () => {
    expect(HON_DELEGATE_KEYS).toEqual(['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena']);
    const base = thread(1);
    const turns = base.turns as Record<string, unknown>[];
    expect(() => verifyHonThread({ ...base, turns: [turns[0], { ...turns[2], agentKey: 'kai' }] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThread({ ...base, turns: [turns[0], { ...turns[1], delegations: [{ agentKey: 'Chad', status: 'DELEGATING', summary: 'x' }] }] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThread({ ...base, turns: [{ ...turns[2], agentKey: null }] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThread({ ...base, turns: [{ ...turns[0], delegations: [{ agentKey: 'chad', status: 'DELEGATING', summary: 'x' }] }] }, scope.schoolId)).toThrow('Unverified');
  });

  it('shows an unrecognized status as Unknown, never success, and rejects malformed values', () => {
    const turns = thread(0).turns as Record<string, unknown>[];
    const verified = verifyHonThread({ ...thread(0), turns: [turns[0], { ...turns[1], status: 'DONE' }] }, scope.schoolId);
    expect(verified.turns[1]!.status).toBe('UNKNOWN');
    expect(() => verifyHonThread({ ...thread(0), turns: [turns[0], { ...turns[1], status: 1 }] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThread({ ...thread(0), turns: [turns[1], turns[0]] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThread({ ...thread(0), turns: [turns[0], turns[0]] }, scope.schoolId)).toThrow('Unverified');
    expect(() => verifyHonThreadPage({ items: [], more: false, total: 0 })).toThrow('Unverified');
    expect(() => verifyHonTurnReceipt({ turnId: 'x', threadId: thread(0).id, status: 'PROCESSING', delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [] })).toThrow('Unverified');
  });

  it('validates a message before a send is offered', () => {
    expect(honMessageProblem('   ')).toBe('Type a message first.');
    expect(honMessageProblem('x'.repeat(2001))).toMatch(/limited to 2000/);
    expect(honMessageProblem('hi\u0007')).toMatch(/control characters/);
    expect(honMessageProblem('How is my school doing this month?')).toBeNull();
  });
});

describe('HON conversation controller', () => {
  it('stays Not connected and makes no request without a server source (production today)', async () => {
    const controller = await opened(null);
    expect(controller.snapshot()).toEqual(notConnectedConversationSnapshot());
    controller.draft('hello');
    await controller.send();
    controller.newConversation();
    expect(controller.snapshot().connection.state).toBe('NOT_CONNECTED');
    expect(controller.snapshot().send.text).toBe('');
  });

  it('maps readiness denial, failure and partial readiness without loading any history', async () => {
    for (const [readiness, state] of [
      [vi.fn(async () => { throw new HonConversationAccessError('no'); }), 'DENIED'],
      [vi.fn(async () => { throw new Error('offline'); }), 'ERROR'],
      [vi.fn(async () => ({ ...READY, authorization: false })), 'DENIED'],
      [vi.fn(async () => ({ ...READY, providerRoute: false })), 'NOT_READY'],
      [vi.fn(async () => ({ ...READY, extra: 1 })), 'ERROR'],
    ] as const) {
      const src = source({ readiness });
      const controller = await opened(src);
      expect(controller.snapshot().connection.state).toBe(state);
      controller.draft('hello');
      await controller.send();
      expect(src.listThreads).not.toHaveBeenCalled();
      expect(src.sendTurn).not.toHaveBeenCalled();
    }
  });

  it('loads only verified threads for the verified school', async () => {
    const src = source({ readThread: vi.fn(async () => ({ ...thread(0), schoolId: otherSchool })) });
    const controller = await opened(src);
    expect(controller.snapshot().threads.state).toBe('READY');
    await controller.selectThread('00000000-0000-4000-8000-0000000000ff');
    expect(src.readThread).not.toHaveBeenCalled();
    await controller.selectThread(thread(0).id);
    expect(controller.snapshot().active).toMatchObject({ state: 'ERROR', thread: null });
    expect(src.readThread).toHaveBeenCalledWith(scope, thread(0).id);
  });

  it('shows only the server record after a send, never the receipt or a local echo as a result', async () => {
    const src = source();
    const controller = await opened(src);
    controller.draft(' How is my school doing this month? ');
    await controller.send();
    expect(src.sendTurn).toHaveBeenCalledWith(scope, { threadId: null, text: 'How is my school doing this month?', requestKey: 'key-1' });
    expect(src.readThread).toHaveBeenCalledWith(scope, thread(0).id);
    expect(controller.snapshot().active.state).toBe('READY');
    expect(controller.snapshot().send).toEqual({ state: 'IDLE', text: '', message: '' });
  });

  it('keeps the same request key for a safe retry after an unknown outcome and drops it once the text changes', async () => {
    let n = 0;
    const src = source({ sendTurn: vi.fn(async () => { throw new Error('timeout'); }) });
    const controller = new HonConversationController(src, () => `key-${++n}`);
    await controller.open(scope);
    controller.draft('Show me what needs approval.');
    await controller.send();
    expect(controller.snapshot().send.state).toBe('UNKNOWN');
    expect(controller.snapshot().send.text).toBe('Show me what needs approval.');
    await controller.send();
    expect(src.sendTurn.mock.calls.map((call) => (call[1] as { requestKey: string }).requestKey)).toEqual(['key-1', 'key-1']);
    controller.draft('Show me what needs approval today.');
    await controller.send();
    expect((src.sendTurn.mock.calls[2]![1] as { requestKey: string }).requestKey).toBe('key-2');
    await controller.check();
    expect(src.listThreads).toHaveBeenCalledTimes(2);
  });

  it('reports a definitive rejection as Failed and keeps the text', async () => {
    const src = source({ sendTurn: vi.fn(async () => { throw new HonConversationRejected('Message refused.', 422); }) });
    const controller = await opened(src);
    controller.draft('Have Marcus prepare a campaign for next week.');
    await controller.send();
    expect(controller.snapshot().send).toMatchObject({ state: 'FAILED', text: 'Have Marcus prepare a campaign for next week.' });
    expect(controller.snapshot().send.message).toContain('Nothing was sent to any employee.');
  });

  it('treats a receipt for a different thread as an unknown outcome', async () => {
    const src = source({ sendTurn: vi.fn(async () => ({ turnId: thread(0).id, threadId: thread(2).id, status: 'COMPLETED', delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [] })) });
    const controller = await opened(src);
    await controller.selectThread(thread(0).id);
    controller.draft('Summarize attendance problems.');
    await controller.send();
    expect(controller.snapshot().send.state).toBe('UNKNOWN');
  });

  it('discards every thread and draft on reset', async () => {
    const controller = await opened(source());
    await controller.selectThread(thread(0).id);
    controller.draft('draft');
    controller.reset();
    expect(controller.snapshot()).toEqual(notConnectedConversationSnapshot());
  });
});

describe('HON conversation presentation', () => {
  it('renders Not connected with a disabled composer in every mode and presentation', () => {
    for (const presentation of ['panel', 'full'] as const) {
      const html = render(notConnectedConversationSnapshot(), presentation);
      expect(html).toContain('Not connected');
      expect(html).toContain('HON conversation is not connected yet');
      expect(html).toContain('Message HON (not connected)');
      expect(html).toMatch(/<textarea[^>]*disabled/);
      expect(html).toMatch(/<button type="button" disabled="">Send<\/button>/);
      expect(html).toMatch(/<button type="button" disabled="">New conversation<\/button>/);
      expect(html).toContain('Governed provider route: not confirmed');
      expect(html).not.toMatch(/Processing|Delegating|Completed|Awaiting approval|Connected</);
      expect(html).not.toContain('How is my school doing');
    }
  });

  it('production HON passes no conversation source, so the workspace shows Not connected in all modes', () => {
    const tsx = readFileSync('src/components/hon-command/hon-command.tsx', 'utf8');
    expect(tsx).not.toMatch(/conversation=|HonConversationController/);
    const verified: HonCommandSnapshot = { ...initialHonCommandSnapshot(), scope: { state: 'VERIFIED', ...scope, source: 'DASHBOARD', message: 'ok' } };
    for (const variant of MODES) {
      const html = renderToStaticMarkup(<HonWorkspaceView snapshot={verified} variant={variant} presentation="panel" tab="team" selectedAgentId={null} headingId="h" />);
      expect(html).toContain('data-connection="NOT_CONNECTED"');
      expect(html).toMatch(/<button type="button" disabled="">Send<\/button>/);
    }
  });

  it('renders checking, denied and error states without history or an enabled composer', async () => {
    const checking = new HonConversationController(syntheticConversationSource('checking'));
    void checking.open(scope);
    expect(render(checking.snapshot())).toContain('Checking whether HON conversation is available');
    const denied = render((await opened(syntheticConversationSource('denied'))).snapshot());
    expect(denied).toContain('Not available');
    expect(denied).not.toMatch(/<textarea|New conversation/);
    const error = render((await opened(syntheticConversationSource('error'))).snapshot());
    expect(error).toContain('could not be checked');
    expect(error).toMatch(/<textarea[^>]*disabled/);
    const notReady = render((await opened(syntheticConversationSource('not-ready'))).snapshot());
    expect(notReady).toContain('Governed provider route: not ready');
    expect(notReady).toContain('Your authorization for this school: confirmed by the server');
    expect(notReady).toMatch(/<textarea[^>]*disabled/);
  });

  it('renders the empty connected state with starters that only fill the composer', async () => {
    const html = render((await opened(syntheticConversationSource('empty'))).snapshot());
    expect(html).toContain('Connected');
    expect(html).toContain('You have no conversations at this school yet.');
    expect(html).toContain('A starter only fills the message box.');
    expect(html).toContain('How is my school doing this month?');
    expect(html).toMatch(/<textarea(?![^>]*disabled)[^>]*>/);
  });

  it('labels approval-required work as not done and links to Action Center, never as completed', async () => {
    const controller = await opened(syntheticConversationSource('history'));
    await controller.selectThread(thread(2).id);
    const html = render(controller.snapshot()).split('role="log"')[1]!;
    expect(html).toContain('Awaiting approval');
    expect(html).toContain('Approval required. Nothing has run.');
    expect(html).toContain('href="/staff/action-center/approvals"');
    expect(html).toContain('HON → Marcus');
    expect(html).toContain('/ai/marcus.webp');
    expect(html).not.toContain('>Completed<');
    expect(html).not.toMatch(/Kai|kai\.webp/);
  });

  it('shows every server status distinctly across the sample threads', async () => {
    const controller = await opened(syntheticConversationSource('history'));
    const labels = new Set<string>();
    for (const item of syntheticThreads()) {
      await controller.selectThread(item.id);
      const html = render(controller.snapshot());
      for (const match of html.matchAll(/data-turn-status="([A-Z_]+)"/g)) labels.add(match[1]!);
    }
    expect([...labels].sort()).toEqual(['AWAITING_APPROVAL', 'COMPLETED', 'DELEGATING', 'FAILED', 'PROCESSING', 'PROPOSED', 'UNKNOWN']);
  });

  it('offers a safe check after an unknown outcome and explains a rejection', async () => {
    const unknown = await opened(syntheticConversationSource('send-unknown'));
    unknown.draft('Summarize attendance problems.');
    await unknown.send();
    const html = render(unknown.snapshot());
    expect(html).toContain('Outcome unknown.');
    expect(html).toContain('Check the conversation');
    expect(html).toContain('>Retry</button>');
    const failed = await opened(syntheticConversationSource('send-failed'));
    failed.draft('Summarize attendance problems.');
    await failed.send();
    expect(render(failed.snapshot())).toContain('Not sent.');
    const sending = await opened(syntheticConversationSource('sending'));
    sending.draft('Summarize attendance problems.');
    void sending.send();
    await flush();
    expect(render(sending.snapshot())).toContain('waiting for the server to confirm');
    expect(render(sending.snapshot())).toMatch(/<textarea[^>]*disabled/);
  });
});

describe('HON conversation preview isolation', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  it('keeps synthetic fixtures out of every production module', () => {
    const allowed = new Set([
      join('src/components/hon-command/preview/hon-conversation-fixtures.ts'),
      join('src/components/hon-command/preview/hon-conversation-preview.tsx'),
      join('src/app/reference/hon-conversation/page.tsx'),
    ]);
    for (const file of files('src').filter((path) => /\.(ts|tsx)$/.test(path) && !allowed.has(path))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/hon-conversation-fixtures|hon-conversation-preview|syntheticConversationSource/);
    }
  });

  it('serves the preview only when HON_REFERENCE_PREVIEW=1, without indexing, and labels it synthetic', () => {
    const page = readFileSync('src/app/reference/hon-conversation/page.tsx', 'utf8');
    expect(page).toContain("process.env.HON_REFERENCE_PREVIEW === '1'");
    expect(page).toContain('if (!honPreviewEnabled()) notFound();');
    expect(page).toContain('robots: { index: false, follow: false }');
    expect(readFileSync('src/components/hon-command/preview/hon-conversation-fixtures.ts', 'utf8')).toContain('synthetic fixtures · no school data, no AI, nothing is sent');
    const preview = files('src/components/hon-command/preview').map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(preview).not.toMatch(/fetch\(|localStorage|sessionStorage|openrouter|invokeLLM|XMLHttpRequest|WebSocket/i);
  });
});
