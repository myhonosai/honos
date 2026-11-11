import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  HON_REPLY_LIMITS, HQ_HON_LIMITS, saasUuid, validateHqHonAskInput, validateHqHonAskRecords, validateHqHonBudgetInput, validateHqHonBudgetReceipt,
  validateHqHonConversation, validateHqHonConversationRecords, validateHqHonResolveInput, validateHqHonTurnReceipt,
  type HqHonConversation, type HqHonInvocation, type HqHonTurnReceipt,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import {
  HON_REPLY_PROVIDER_RUNTIME, HonReplyProviderRuntimeError, type HonReplyProviderRuntime, type HonReplyResult,
} from '../ai/hon-reply-provider-runtime.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/** What the database records for a provider outcome (0263 record_hq_hon_result). */
type Outcome = {
  outcome: 'ANSWERED' | 'FAILED' | 'NOT_SENT' | 'UNKNOWN'; reply: string | null; truncated: boolean | null; inputTokens: number | null;
  outputTokens: number | null; providerCostMicrounits: number | null; failureReason: string | null;
};
const nothing = { reply: null, truncated: null, inputTokens: null, outputTokens: null, providerCostMicrounits: null };
const unknown = (failureReason: 'PROVIDER_UNKNOWN' | 'UNVERIFIED_RESULT' | 'INTERRUPTED'): Outcome => ({ outcome: 'UNKNOWN', ...nothing, failureReason });
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const recorded = (v: unknown) => validateHqHonTurnReceipt({ ...(v as object), replayed: false });

/** A provider answer is trusted only if it is well formed; the database also holds it to the turn's budgets and cost ceiling. */
function verified(result: HonReplyResult, i: HqHonInvocation): Outcome {
  const reply = typeof result?.reply === 'string' ? result.reply.trim() : '';
  // HQ HON never suggests specialists: a suggestion is unverified output.
  if (!result || reply.length < 1 || reply.length > HON_REPLY_LIMITS.replyCharacters || (result.suggestions ?? []).length > 0
    || !int(result.inputTokens, 1, i.inputBudget) || !int(result.outputTokens, 1, i.outputBudget)
    || !int(result.providerCostMicrounits, 0, i.maxCostMicrounits) || typeof result.truncated !== 'boolean') return unknown('UNVERIFIED_RESULT');
  return { outcome: 'ANSWERED', reply, truncated: result.truncated, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    providerCostMicrounits: result.providerCostMicrounits, failureReason: null };
}

/**
 * B1 HQ Ask HON (0263). HQ authority, the HQ AI text budget, the platform AGENT_INFERENCE pause, the route, idempotency and
 * immutability live in the database; this service validates closed inputs and outputs, makes at most one provider call
 * through the injected HON reply runtime (inactive unless OPENROUTER_PAID_CALL_APPROVED: 503 before any write) and records
 * its outcome exactly once. It never retries a provider call and never touches a school, organization or school AI budget.
 */
@Injectable()
export class HqHonService {
  constructor(
    private readonly billing: SaasBillingService,
    @Inject(HON_REPLY_PROVIDER_RUNTIME) private readonly provider: HonReplyProviderRuntime,
  ) {}

  private connected(): boolean { return this.provider.readiness('OPENROUTER') === 'READY'; }

  async conversation(subject: string): Promise<HqHonConversation> {
    const records = await this.billing.call('readHqHonConversation', [subject], validateHqHonConversationRecords);
    try { return validateHqHonConversation({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async setBudget(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateHqHonBudgetInput(body), saasUuid(key)] as const);
    return this.billing.call('setHqHonBudget', [subject, JSON.stringify(input), k], (v) => {
      const r = validateHqHonBudgetReceipt(v); if (r.budget.periodStart !== input.periodStart) throw new Error('mismatch'); return r;
    });
  }

  async resolve(subject: string, id: unknown, body: unknown, key: unknown) {
    const [turnId, input, k] = parse(() => [saasUuid(id), validateHqHonResolveInput(body), saasUuid(key)] as const);
    return this.billing.call('resolveHqHonTurn', [subject, turnId, JSON.stringify(input), k], (v) => {
      const r = validateHqHonTurnReceipt(v);
      if (r.turn.turnId.toLowerCase() !== turnId.toLowerCase()
        || r.turn.status !== (input.resolution === 'CHARGED' ? 'RESOLVED_CHARGED' : 'RESOLVED_NOT_CHARGED')) throw new Error('mismatch');
      return r;
    });
  }

  /** Reserve -> one provider call -> record. The same key returns the same turn and never calls the provider again. */
  async ask(subject: string, body: unknown, key: unknown): Promise<HqHonTurnReceipt> {
    const [input, idempotencyKey] = parse(() => [validateHqHonAskInput(body), saasUuid(key)] as const);
    if (!this.connected()) throw new ServiceUnavailableException({ code: 'HQ_HON_PROVIDER_NOT_CONNECTED' });
    const asked = await this.billing.call('askHqHon', [subject, JSON.stringify(input), idempotencyKey], (v) => {
      const r = validateHqHonAskRecords(v);
      if (r.turn.question !== input.question || r.turn.replyMode !== input.replyMode || r.turn.agentKey !== input.agentKey) throw new Error('mismatch');
      return r;
    });
    const receipt: HqHonTurnReceipt = { turn: asked.turn, budget: asked.budget, replayed: asked.replayed };
    if (asked.replayed) return asked.turn.status === 'ANSWERING' ? this.recoverInterrupted(subject, receipt) : receipt;
    if (!asked.invocation) return receipt;
    const outcome = await this.invoke(asked.invocation);
    try { return await this.record(subject, asked.turn.turnId, outcome); }
    catch {
      // The turn stays ANSWERING and is held for the HQ owner after the in-flight window; it is never resent.
      throw new ServiceUnavailableException({ code: 'HQ_HON_PERSISTENCE_UNKNOWN', detail: 'The provider outcome needs reconciliation. It will not be resent.' });
    }
  }

  /** A replay of a turn that never got an answer recorded: after the in-flight window it is held for the HQ owner. */
  private async recoverInterrupted(subject: string, replay: HqHonTurnReceipt): Promise<HqHonTurnReceipt> {
    if (Date.now() - Date.parse(replay.turn.createdAt) < HQ_HON_LIMITS.interruptedAfterSeconds * 1000) return replay;
    try { return { ...(await this.record(subject, replay.turn.turnId, unknown('INTERRUPTED'))), replayed: true }; }
    catch (error) { if (error instanceof ConflictException) return replay; throw error; }
  }

  private async invoke(i: HqHonInvocation): Promise<Outcome> {
    try {
      const result = await this.provider.generate({ specialist: 'hq_hon', hqAgent: i.agentKey, providerId: i.providerId, modelId: i.modelId, providerRequestId: i.providerRequestId,
        replyMode: i.replyMode, step: 1, question: i.question, facts: i.facts, inputBudget: i.inputBudget, outputBudget: i.outputBudget,
        maxCostMicrounits: i.maxCostMicrounits });
      return verified(result, i);
    } catch (error) {
      if (error instanceof HonReplyProviderRuntimeError && error.outcome === 'PRE_SEND') {
        const reason = ['CONFIGURATION_REQUIRED', 'UNSUPPORTED_PROVIDER', 'INVALID_REQUEST'].includes(error.reason) ? error.reason : 'INVALID_REQUEST';
        return { outcome: 'NOT_SENT', ...nothing, failureReason: reason };
      }
      if (error instanceof HonReplyProviderRuntimeError && error.outcome === 'FAILED') {
        // The reply runtime reports no cost for a rejection: it stays UNKNOWN, never a guessed zero.
        return { outcome: 'FAILED', ...nothing, failureReason: 'PROVIDER_REJECTED' };
      }
      return unknown('PROVIDER_UNKNOWN');
    }
  }

  private record(subject: string, turnId: string, outcome: Outcome): Promise<HqHonTurnReceipt> {
    return this.billing.call('recordHqHonResult', [subject, turnId, JSON.stringify(outcome)], recorded);
  }
}
