/**
 * Integration boundary for a future HON conversation. No conversational
 * orchestration contract exists today: the voice/text handoff stores private
 * human evidence only and never invokes an agent. Until Codex publishes the
 * contract below, the conversation surface must stay explicitly NOT_CONNECTED
 * and must not render a composer that appears to send anything.
 */
export const HON_CONVERSATION_BOUNDARY = Object.freeze({
  state: 'NOT_CONNECTED' as const,
  headline: 'HON conversation is not connected yet',
  detail: 'No AI conversation, transcript or agent response is available. Nothing you type here is sent, stored or answered.',
  handoff: {
    href: '/staff/voice',
    label: 'Record a private text handoff instead',
    detail: 'Stores a private note and reference IDs only. It does not invoke HON or any employee.',
  },
  history: 'No conversation history exists to show. A requester-scoped conversation list contract is required.',
});

/**
 * Shape the frontend will bind to once a governed contract exists. Documented in
 * docs/architecture/HON_COMMAND_EXPERIENCE.md; this is not an implemented API.
 */
export interface HonConversationContractNeeded {
  listThreads: 'GET /v1/organizations/:organizationId/schools/:schoolId/hon/conversations';
  readThread: 'GET /v1/organizations/:organizationId/schools/:schoolId/hon/conversations/:conversationId';
  readiness: 'GET /v1/organizations/:organizationId/schools/:schoolId/hon/readiness';
  startThread: 'POST /v1/organizations/:organizationId/schools/:schoolId/hon/conversations';
  sendTurn: 'POST /v1/organizations/:organizationId/schools/:schoolId/hon/conversations/:conversationId/turns';
}

/**
 * Closed turn states the frontend will accept from the future conversation
 * contract. Presentation only: nothing here creates, polls or advances a turn,
 * and a state is shown only when the server reports it.
 */
export const HON_TURN_STATUSES = ['PROPOSED', 'PROCESSING', 'DELEGATING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'UNKNOWN'] as const;
export type HonTurnStatus = typeof HON_TURN_STATUSES[number];

const TURN_PRESENTATION: Readonly<Record<HonTurnStatus, { label: string; tone: 'ready' | 'neutral' | 'waiting' | 'blocked' | 'planned'; detail: string }>> = {
  PROPOSED: { label: 'Proposed', tone: 'neutral', detail: 'HON proposed a next step. Nothing has run.' },
  PROCESSING: { label: 'Processing', tone: 'neutral', detail: 'The server reports this message is being handled.' },
  DELEGATING: { label: 'Delegating', tone: 'neutral', detail: 'The server reports a bounded task was handed to a named specialist.' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', tone: 'waiting', detail: 'A proposal needs a qualified human decision in Action Center. Nothing has run.' },
  COMPLETED: { label: 'Completed', tone: 'ready', detail: 'The server recorded a verified result.' },
  FAILED: { label: 'Failed', tone: 'blocked', detail: 'The server recorded a failure. Nothing is assumed to have happened.' },
  UNKNOWN: { label: 'Unknown', tone: 'planned', detail: 'The outcome could not be confirmed. Check the record before acting again.' },
};

/** Any value the server did not explicitly report as a known state is shown as UNKNOWN, never as success. */
export function honTurnStatusPresentation(value: unknown): { status: HonTurnStatus } & (typeof TURN_PRESENTATION)[HonTurnStatus] {
  const status = (HON_TURN_STATUSES as readonly unknown[]).includes(value) ? value as HonTurnStatus : 'UNKNOWN';
  return { status, ...TURN_PRESENTATION[status] };
}

/**
 * The composer may be enabled only when every prerequisite is confirmed by the
 * server for this requester and school. Today none exists, so this is false.
 */
export interface HonConversationReadiness {
  contract: boolean;
  providerRoute: boolean;
  entitlement: boolean;
  authorization: boolean;
}
export function honComposerEnabled(readiness: HonConversationReadiness | null): boolean {
  return readiness !== null && readiness.contract && readiness.providerRoute && readiness.entitlement && readiness.authorization;
}
