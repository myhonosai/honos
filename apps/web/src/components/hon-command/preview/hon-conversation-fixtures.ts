import { HonConversationAccessError, HonConversationRejected, type HonConversationSource } from '../hon-conversation-data';
import type { HonInterfaceTheme } from '@hon/design-system';
import type { HonScope } from '../hon-command-data';

/**
 * SYNTHETIC design fixtures for tests and the env-gated preview route only.
 * No production module imports this file (tested). Nothing here is school data,
 * an AI response or a provider call: every value is hand-written sample text,
 * and the "server" is an in-memory function that never leaves the browser.
 */

export const SYNTHETIC_SCOPE: HonScope = Object.freeze({
  organizationId: '00000000-0000-4000-8000-00000000a001',
  schoolId: '00000000-0000-4000-8000-00000000b001',
});

export const HON_PREVIEW_SCENARIOS = ['not-connected', 'checking', 'not-ready', 'denied', 'error', 'empty', 'history', 'sending', 'send-failed', 'send-unknown'] as const;
export type HonPreviewScenario = typeof HON_PREVIEW_SCENARIOS[number];
export const HON_PREVIEW_SCENARIO_LABELS: Readonly<Record<HonPreviewScenario, string>> = {
  'not-connected': 'Not connected (production today)',
  checking: 'Checking readiness',
  'not-ready': 'Provider route not ready',
  denied: 'Access denied',
  error: 'Readiness check failed',
  empty: 'Connected, no history',
  history: 'History with every status',
  sending: 'Sending (waiting for server)',
  'send-failed': 'Send rejected',
  'send-unknown': 'Send outcome unknown',
};

/** Plain (non-client) constants so the server page can validate query values against them. */
export const HON_PREVIEW_MODES: readonly HonInterfaceTheme[] = ['modern', 'big-button', 'classic'];
export const HON_PREVIEW_VIEWS = ['panel', 'full'] as const;
export type HonPreviewView = typeof HON_PREVIEW_VIEWS[number];
export const HON_PREVIEW_BANNER = 'Design preview · synthetic fixtures · no school data, no AI, nothing is sent';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 15, minute)).toISOString();
const human = (n: number, text: string, minute: number) => ({ id: id(n), role: 'HUMAN', agentKey: null, text, status: 'COMPLETED', createdAt: at(minute), delegations: [], references: [] });
const hon = (n: number, text: string, status: string, minute: number, extra: { delegations?: unknown[]; references?: unknown[] } = {}) => ({ id: id(n), role: 'HON', agentKey: null, text, status, createdAt: at(minute), delegations: extra.delegations ?? [], references: extra.references ?? [] });
const agent = (n: number, agentKey: string, text: string, status: string, minute: number, references: unknown[] = []) => ({ id: id(n), role: 'AGENT', agentKey, text, status, createdAt: at(minute), delegations: [], references });

/** One sample thread per owner example; together they cover all seven statuses. */
export function syntheticThreads(): { id: string; schoolId: string; title: string; turns: unknown[] }[] {
  const school = SYNTHETIC_SCOPE.schoolId;
  return [
    { id: id(0x101), schoolId: school, title: 'Sample: How is my school doing this month?', turns: [
      human(1, 'How is my school doing this month?', 1),
      hon(2, 'Sample summary from synthetic figures: 3 trial classes booked, 2 members with overdue follow-ups and one class with lower attendance. Open the work queue to see the real records.', 'COMPLETED', 2, { references: [{ kind: 'WORK_ITEM', id: id(0x901) }] }),
    ] },
    { id: id(0x102), schoolId: school, title: 'Sample: Enrollment follow-ups', turns: [
      human(3, 'Ask Chad to review enrollment follow-ups.', 5),
      hon(4, 'I handed this to Chad.', 'DELEGATING', 6, { delegations: [{ agentKey: 'chad', status: 'DELEGATING', summary: 'Review the sample enrollment follow-ups and draft next steps.' }] }),
      agent(5, 'chad', 'Reviewing the sample follow-ups now.', 'PROCESSING', 7),
    ] },
    { id: id(0x103), schoolId: school, title: 'Sample: Campaign for next week', turns: [
      human(6, 'Have Marcus prepare a campaign for next week.', 10),
      hon(7, 'Marcus drafted a sample campaign. It needs your approval before anything is scheduled or sent.', 'AWAITING_APPROVAL', 11, { delegations: [{ agentKey: 'marcus', status: 'AWAITING_APPROVAL', summary: 'Draft a sample campaign for next week.' }], references: [{ kind: 'ACTION_REQUEST', id: id(0x902) }] }),
    ] },
    { id: id(0x104), schoolId: school, title: 'Sample: What needs approval', turns: [
      human(8, 'Show me what needs approval.', 14),
      hon(9, 'Proposal: review the two sample items waiting in Action Center.', 'PROPOSED', 15, { references: [{ kind: 'ACTION_REQUEST', id: id(0x903) }] }),
    ] },
    { id: id(0x105), schoolId: school, title: 'Sample: Attendance problems', turns: [
      human(10, 'Summarize attendance problems.', 18),
      hon(11, 'I asked Maya for an attendance summary.', 'FAILED', 19, { delegations: [{ agentKey: 'maya', status: 'FAILED', summary: 'Summarize sample attendance changes.' }] }),
      agent(12, 'maya', 'The sample attendance summary could not be confirmed.', 'UNKNOWN', 20),
    ] },
  ];
}

function summaries(threads: ReturnType<typeof syntheticThreads>) {
  return threads.map((thread) => {
    const last = thread.turns.at(-1) as { status: string; createdAt: string };
    return { id: thread.id, title: thread.title, status: last.status, updatedAt: last.createdAt };
  }).reverse();
}

const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
const READY = { contract: true, providerRoute: true, entitlement: true, authorization: true };

/** In-memory synthetic transport. Returns `null` for "not connected", exactly like production. */
export function syntheticConversationSource(scenario: HonPreviewScenario): HonConversationSource | null {
  if (scenario === 'not-connected') return null;
  const threads = scenario === 'empty' ? [] : syntheticThreads();
  let next = 0x200;
  return {
    readiness: async () => {
      if (scenario === 'checking') return never();
      if (scenario === 'denied') throw new HonConversationAccessError('denied');
      if (scenario === 'error') throw new Error('synthetic network failure');
      if (scenario === 'not-ready') return { ...READY, providerRoute: false };
      return READY;
    },
    listThreads: async () => ({ items: summaries(threads), more: false }),
    readThread: async (_scope, threadId) => {
      const thread = threads.find((item) => item.id === threadId);
      if (!thread) throw new Error('not found');
      return thread;
    },
    sendTurn: async (_scope, input) => {
      if (scenario === 'sending') return never();
      if (scenario === 'send-failed') throw new HonConversationRejected('The sample server rejected this message.', 422);
      if (scenario === 'send-unknown') throw new Error('synthetic timeout');
      next += 2;
      let thread = input.threadId ? threads.find((item) => item.id === input.threadId) : undefined;
      if (!thread) {
        thread = { id: id(next + 0x1000), schoolId: SYNTHETIC_SCOPE.schoolId, title: `Sample: ${input.text.slice(0, 60)}`, turns: [] };
        threads.push(thread);
      }
      thread.turns.push(human(next, input.text, 40 + thread.turns.length), hon(next + 1, '', 'PROCESSING', 41 + thread.turns.length));
      return { turnId: id(next + 1), threadId: thread.id, status: 'PROCESSING', delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [] };
    },
  };
}
