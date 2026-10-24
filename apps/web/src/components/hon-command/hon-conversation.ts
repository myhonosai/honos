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
  sendTurn: 'POST /v1/organizations/:organizationId/schools/:schoolId/hon/conversations/:conversationId/turns';
}
