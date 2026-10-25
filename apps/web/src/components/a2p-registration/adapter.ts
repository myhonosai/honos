import type { A2pAnswerKey, A2pAvailability, A2pConfirmationKey, A2pReviewMark, A2pSource } from './contract';

/**
 * Isolated boundary between the A2P registration UI and whatever supplies its
 * data. Methods return raw values on purpose: the controller narrows every
 * result with ./contract parsers, including synthetic fixtures, so the preview
 * exercises the same safety checks a server response will.
 *
 * A future HTTP adapter must take organization/school scope only from the
 * verified current-school resolver, never from a URL, form or query value, and
 * must send an Idempotency-Key with every command.
 */
export interface A2pRegistrationAdapter {
  readonly source: A2pSource;
  availability(): Promise<A2pAvailability>;
  latestWebsiteCheck(): Promise<unknown>;
  startWebsiteCheck(websiteUrl: string, idempotencyKey: string): Promise<unknown>;
  readWebsiteCheck(checkId: string): Promise<unknown>;
  markFinding(findingId: string, review: A2pReviewMark, idempotencyKey: string): Promise<unknown>;
  draftAnswers(idempotencyKey: string): Promise<unknown>;
  saveAnswers(answers: ReadonlyArray<{ key: A2pAnswerKey; value: string }>, expectedRevision: number | null, idempotencyKey: string): Promise<unknown>;
  setConfirmation(key: A2pConfirmationKey, confirmed: boolean, idempotencyKey: string): Promise<unknown>;
  registrationStatus(): Promise<unknown>;
}

export class A2pNotConnectedError extends Error {
  constructor() { super('A2P registration is not connected. Nothing was checked, generated, saved or submitted.'); }
}

const refuse = async (): Promise<never> => { throw new A2pNotConnectedError(); };

/**
 * The only adapter production uses until Codex's A2P backend and a provider
 * integration exist. It performs no network request and returns no data.
 */
export const A2P_NOT_CONNECTED_ADAPTER: A2pRegistrationAdapter = Object.freeze({
  source: 'NOT_CONNECTED' as const,
  availability: async (): Promise<A2pAvailability> => ({ state: 'NOT_CONNECTED' }),
  latestWebsiteCheck: refuse,
  startWebsiteCheck: refuse,
  readWebsiteCheck: refuse,
  markFinding: refuse,
  draftAnswers: refuse,
  saveAnswers: refuse,
  setConfirmation: refuse,
  registrationStatus: refuse,
});
