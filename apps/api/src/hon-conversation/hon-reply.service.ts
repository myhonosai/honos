import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  HON_SUGGESTED_AGENTS, HON_REPLY_LIMITS, isHonAnalystAgent, HON_REPLY_MAX_FOLLOW_UPS, HON_REPLY_MAX_SOURCES, HON_REPLY_MAX_SUGGESTIONS, HON_REPLY_MODES, isHonReplyFollowUp, isHonReplySourceKey,
  type HonAiTone, type HonAnalystAgentKey, type HonReplyMode,
} from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedPrincipalScope } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import {
  HON_REPLY_PROVIDER_RUNTIME, HonReplyProviderRuntimeError, type HonReplyInvocation, type HonReplyProviderRuntime, type HonReplyResult, type HonReplySpecialist,
} from '../ai/hon-reply-provider-runtime.js';

type Scope = ResolvedPrincipalScope & { externalSubject: string };
type Limits = { replyMode: HonReplyMode; taskClass: string; inputBudget: number; outputBudget: number; maxProviderCostMicrounits: number };
/** planKey (0336): the planning idempotency key, the invocation id first and the fallback attempt id after one reopen. */
type Reference = { invocationId: string; planKey?: string; workItemId: string; workVersion: number; limits: Limits; agentKey: 'hon' | HonAnalystAgentKey };

/** The database names the mode; its budgets must be exactly the contract's (no caller or stored value can raise them). */
function modeLimits(limits: Limits | undefined) {
  const mode = limits?.replyMode;
  const fixed = mode && Object.prototype.hasOwnProperty.call(HON_REPLY_MODES, mode) ? HON_REPLY_MODES[mode] : null;
  if (!fixed || limits!.taskClass !== fixed.taskClass || limits!.inputBudget !== fixed.inputTokens || limits!.outputBudget !== fixed.outputTokens
    || limits!.maxProviderCostMicrounits !== fixed.maxProviderCostMicrounits) throw new Error('HON_REPLY_LIMITS_DRIFT');
  return fixed;
}

const tokens = (n: unknown, max: number) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= max;
/** Optional closed list: delegate keys and Claire (K2c) only, unique, at most HON_REPLY_MAX_SUGGESTIONS, never on a cut-off answer. */
function suggestionsValid(v: unknown, truncated: boolean): boolean {
  if (v === undefined) return true;
  return Array.isArray(v) && v.length <= HON_REPLY_MAX_SUGGESTIONS && (!truncated || v.length === 0) && new Set(v).size === v.length
    && v.every((k) => (HON_SUGGESTED_AGENTS as readonly unknown[]).includes(k));
}
/** 0254: optional follow-ups (bounded plain text, unique ignoring case) and sources (closed set, unique); none on a cut-off answer. */
function followUpsValid(v: unknown, truncated: boolean): boolean {
  if (v === undefined) return true;
  return Array.isArray(v) && v.length <= HON_REPLY_MAX_FOLLOW_UPS && (!truncated || v.length === 0) && v.every(isHonReplyFollowUp)
    && new Set(v.map((x) => String(x).toLowerCase())).size === v.length;
}
function sourcesValid(v: unknown, truncated: boolean): boolean {
  if (v === undefined) return true;
  return Array.isArray(v) && v.length <= HON_REPLY_MAX_SOURCES && (!truncated || v.length === 0) && v.every(isHonReplySourceKey) && new Set(v).size === v.length;
}
function verified(result: HonReplyResult, specialist: HonReplySpecialist): HonReplyResult {
  // An analysis specialist (K2, 0260) never suggests specialists; any suggestion from its runtime is unverified output.
  if (specialist !== 'hon' && (result?.suggestions ?? []).length > 0) throw new HonReplyProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
  const reply = typeof result?.reply === 'string' ? result.reply.trim() : '';
  if (reply.length < 1 || reply.length > HON_REPLY_LIMITS.replyCharacters || !tokens(result.inputTokens, 1_000_000) || !tokens(result.outputTokens, 1_000_000)
    || !Number.isSafeInteger(result.providerCostMicrounits) || result.providerCostMicrounits < 0 || result.providerCostMicrounits > 1_000_000_000
    || typeof result.truncated !== 'boolean' || !suggestionsValid(result.suggestions, result.truncated)
    || !followUpsValid(result.followUps, result.truncated) || !sourcesValid(result.sources, result.truncated)) {
    throw new HonReplyProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
  }
  return { reply, inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits, truncated: result.truncated, suggestions: [...(result.suggestions ?? [])],
    followUps: [...(result.followUps ?? [])], sources: [...(result.sources ?? [])] };
}

/**
 * C2 "Ask HON". Answers one question turn through the established secure AI runtime: the planning boundary (HQ route,
 * fixed budgets), prepare under the S4 budget lock and access decision (context built in the database), one provider
 * call through the injected runtime, a durable usage record before any reply is shown, and UNKNOWN for anything
 * ambiguous (never resent; resolved by an HQ owner). The turn id is the reply's key: a resend never plans or calls again.
 * Database errors are returned raw; the conversation service maps them at its boundary.
 */
@Injectable()
export class HonReplyService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly plans: AiInvocationPlanService,
    @Inject(HON_REPLY_PROVIDER_RUNTIME) private readonly provider: HonReplyProviderRuntime,
  ) {}

  private context(scope: Scope) {
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, externalSubject: scope.externalSubject,
      principalType: 'HUMAN_USER' as const, source: 'HUMAN_UI' as const, requestId, correlationId: requestId };
  }

  private transaction<T>(scope: Scope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withTenantTransaction(this.context(scope), async (client) => {
      await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [scope.externalSubject]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
      return work(client);
    });
  }

  /**
   * 0336 (RA-1): one reply, and at most one automatic fallback. A definite PROVIDER_UNAVAILABLE on the profile's default
   * model reopens the reply once (the database decides, records the attempt and excludes that model); the second
   * attempt plans, prepares and calls exactly like the first. Anything else ends the turn as before.
   */
  async run(scope: Scope, turnId: string): Promise<void> {
    if (await this.attempt(scope, turnId) !== 'UNAVAILABLE') return;
    const reopened = await this.transaction(scope, async (client) => (await client.query<{ r: boolean }>('SELECT hon.reopen_hon_reply_for_fallback($1,$2::uuid) r', [scope.externalSubject, turnId])).rows[0]!.r);
    if (reopened) await this.attempt(scope, turnId);
  }

  private async attempt(scope: Scope, turnId: string): Promise<'DONE' | 'UNAVAILABLE'> {
    const ref = await this.transaction(scope, async (client) => (await client.query<{ data: Reference | null }>('SELECT hon.hon_reply_planning_reference($1,$2::uuid) data', [scope.externalSubject, turnId])).rows[0]!.data);
    if (!ref) return 'DONE';
    const limits = modeLimits(ref.limits);
    // The database names the agent: HON, or an analysis specialist whose answer is always the DETAILED (ANALYZE) mode.
    if ((ref.agentKey !== 'hon' && !isHonAnalystAgent(ref.agentKey)) || (ref.agentKey !== 'hon' && ref.limits.replyMode !== 'DETAILED')) throw new Error('HON_REPLY_AGENT_DRIFT');
    let planId: string | null = null;
    try {
      const planned = await this.plans.plan({ ...this.context(scope), idempotencyKey: ref.planKey ?? ref.invocationId }, ref.workItemId, {
        expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: ref.agentKey, modality: 'TEXT', taskClass: limits.taskClass,
        inputBudget: limits.inputTokens, outputBudget: limits.outputTokens, maxProviderCostMicrounits: limits.maxProviderCostMicrounits,
      });
      planId = planned.status === 'PLANNED' ? planned.plan.id : null;
    } catch (error) {
      // An access refusal at planning is recorded by prepare (AI_ACCESS_REFUSED); anything else is not assumed.
      if (!(error instanceof ForbiddenException)) throw error;
    }
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    const invocation = await this.transaction(scope, async (client) => {
      const prepared = (await client.query<{ data: HonReplyInvocation | null }>('SELECT hon.prepare_hon_reply($1,$2::uuid,$3::uuid,$4) data', [scope.externalSubject, turnId, planId, ready])).rows[0]!.data;
      // 0256: HON answers in the school's tone (a closed key from the database, read in the same transaction); analysis specialists keep their own voice.
      if (!prepared || prepared.specialist !== 'hon') return prepared;
      return { ...prepared, tone: (await client.query<{ tone: HonAiTone }>('SELECT hon.hon_ai_tone() tone')).rows[0]!.tone };
    });
    if (!invocation) return 'DONE';
    let result: HonReplyResult;
    try {
      result = verified(await this.provider.generate(invocation), invocation.specialist);
    } catch (error) {
      const failure = error instanceof HonReplyProviderRuntimeError ? error : new HonReplyProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.transaction(scope, async (client) => { await client.query('SELECT hon.fail_hon_reply($1,$2::uuid,$3,$4)', [scope.externalSubject, turnId, failure.outcome, failure.reason]); });
      return failure.outcome === 'FAILED' && failure.reason === 'PROVIDER_UNAVAILABLE' ? 'UNAVAILABLE' : 'DONE';
    }
    try {
      await this.transaction(scope, async (client) => { await client.query('SELECT hon.record_hon_reply_result($1,$2::uuid,$3::jsonb)', [scope.externalSubject, turnId, JSON.stringify(result)]); });
    } catch {
      try { await this.transaction(scope, async (client) => { await client.query('SELECT hon.fail_hon_reply($1,$2::uuid,$3,$4)', [scope.externalSubject, turnId, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays and turns UNKNOWN after the stale limit; it is resolved in the HQ queue. */ }
      throw new ServiceUnavailableException({ code: 'HON_REPLY_PERSISTENCE_UNKNOWN', detail: 'The provider outcome needs reconciliation. It will not be resent.' });
    }
    return 'DONE';
  }

  /** Shows a reply that was recorded while access had lapsed, once access has returned. No provider call. */
  async releaseHeld(scope: Scope, turnId: string): Promise<void> {
    await this.transaction(scope, async (client) => { await client.query('SELECT hon.release_held_hon_reply($1,$2::uuid)', [scope.externalSubject, turnId]); });
  }
}
