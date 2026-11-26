import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CONVERSATION_AI_TEST_LIMITS, validateConversationAiTestAnswer, validateConversationAiTestAsk, verifyConversationAiTestState, verifyConversationAiTestView,
  type ConversationAiTestState, type ConversationAiTestView,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import {
  CONVERSATION_TEST_PROVIDER_RUNTIME, ConversationTestProviderRuntimeError,
  type ConversationTestInvocation, type ConversationTestProviderRuntime, type ConversationTestResult,
} from '../ai/conversation-test-provider-runtime.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  CONVERSATION_AI_FORBIDDEN: code => new ForbiddenException({ code }),
  CONVERSATION_AI_TEST_UNAVAILABLE: code => new ForbiddenException({ code, detail: 'Testing Chad needs Conversation AI setup and Chad at this school, and an active Complete plan.' }),
  CONVERSATION_AI_TEST_INVALID: code => new BadRequestException({ code, detail: 'Type a question of up to 500 characters.' }),
  CONVERSATION_AI_TEST_BUSY: code => new ConflictException({ code, detail: 'That is 30 test questions in 10 minutes. Wait a few minutes and try again.' }),
  AI_TEXT_PROPOSAL_NOT_FOUND: () => new NotFoundException({ code: 'CONVERSATION_AI_TEST_NOT_FOUND' }),
  AI_TEXT_PROPOSAL_REPLAY_SWAP: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different question.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '54000'].includes(sqlState)) throw known(message);
  // An S4 spend decision refused the start (an HQ pause, ended access, the school's cost ceiling). Nothing was sent.
  if (sqlState === '42501' && /^AI_[A-Z_]{1,60}$/.test(message)) throw new ForbiddenException({ code: 'CONVERSATION_AI_TEST_SPEND_STOPPED', reason: message, detail: 'AI help is paused or not available for this school right now. Nothing was sent.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CONVERSATION_AI_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'CONVERSATION_AI_TEST_NOT_FOUND' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CONVERSATION_AI_TEST_CONFLICT', detail: 'Keep the same key. A sent question is never sent again.' });
  if (['22023', '22P02', '22003', '23514', '23503'].includes(sqlState)) throw new BadRequestException({ code: 'CONVERSATION_AI_TEST_INVALID' });
  throw new ServiceUnavailableException({ code: 'CONVERSATION_AI_TEST_UNAVAILABLE_NOW', detail: 'No answer is assumed. Reload before trying again.' });
}
const validUsage = (r: ConversationTestResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;

/**
 * CE2 (0687): "Try it". Chad answers one test question from the school's training on the live text route (S4 spend
 * controls, per-school ceiling). The answer is shown only to the staff member who asked; nothing is sent to anyone.
 * Usage evidence is recorded in its own transaction.
 */
@Injectable()
export class ConversationAiTestService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService,
    @Inject(CONVERSATION_TEST_PROVIDER_RUNTIME) private readonly provider: ConversationTestProviderRuntime) {}

  state(context: MembershipLifecycleContext): Promise<ConversationAiTestState> {
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    return this.tx(context, false, async c => verifyConversationAiTestState((await c.query<{ data: unknown }>('SELECT hon.read_conversation_ai_test($1,$2) data',
      [context.externalSubject, ready])).rows[0]?.data));
  }

  async ask(context: MembershipLifecycleContext, input: unknown): Promise<ConversationAiTestView> {
    this.assertHuman(context, true);
    if (!UUID.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be a UUID for this request.' });
    let normalized;
    try { normalized = validateConversationAiTestAsk(input); } catch { throw new BadRequestException({ code: 'CONVERSATION_AI_TEST_INVALID', detail: 'Type a question of up to 500 characters.' }); }
    const view = await this.tx(context, true, async c => verifyConversationAiTestView((await c.query<{ data: unknown }>('SELECT hon.begin_conversation_ai_test($1,$2::jsonb,$3::uuid) data',
      [context.externalSubject, JSON.stringify(normalized), context.idempotencyKey])).rows[0]?.data));
    if (view.status !== 'WORKING' && view.status !== 'CONFIGURATION_REQUIRED' && view.status !== 'BLOCKED') return view;
    return this.generate(context, view.id);
  }

  private async generate(context: MembershipLifecycleContext, id: string): Promise<ConversationAiTestView> {
    const ref = await this.tx(context, true, async c => (await c.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.conversation_ai_test_planning_reference($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) return this.view(context, id);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'chad', modality: 'TEXT',
          taskClass: 'DRAFT_FOLLOW_UP', inputBudget: CONVERSATION_AI_TEST_LIMITS.inputTokens, outputBudget: CONVERSATION_AI_TEST_LIMITS.outputTokens,
          maxProviderCostMicrounits: CONVERSATION_AI_TEST_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) { return translate(error); }
    }
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    const invocation = await this.tx(context, true, async c => (await c.query<{ data: ConversationTestInvocation | null }>('SELECT hon.prepare_conversation_ai_test($1,$2::uuid,$3::uuid,$4) data',
      [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.view(context, id);
    let result: ConversationTestResult;
    try {
      result = await this.provider.generate(invocation);
      if (!validUsage(result)) throw new ConversationTestProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof ConversationTestProviderRuntimeError ? error : new ConversationTestProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.tx(context, true, async c => { await c.query('SELECT hon.fail_conversation_ai_test($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.view(context, id);
    }
    // The answer is paid for: record it either way. An answer outside the closed shape is sent as null; the database stores
    // it empty and rejects it with its usage kept.
    let answer: unknown = null;
    try { answer = validateConversationAiTestAnswer(result.answer); } catch { answer = null; }
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits }, answer };
    try {
      return await this.tx(context, true, async c => verifyConversationAiTestView((await c.query<{ data: unknown }>('SELECT hon.record_conversation_ai_test($1,$2::uuid,$3::jsonb) data',
        [context.externalSubject, id, JSON.stringify(evidence)])).rows[0]?.data));
    } catch {
      try { await this.tx(context, true, async c => { await c.query('SELECT hon.fail_conversation_ai_test($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'CONVERSATION_AI_TEST_PERSISTENCE_UNKNOWN', detail: 'The answer could not be saved. It is held for review and is never sent again.' });
    }
  }

  /** The test as it stands, read inside the command (its key stays set). */
  private async view(context: MembershipLifecycleContext, id: string): Promise<ConversationAiTestView> {
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    const state = await this.tx(context, true, async c => verifyConversationAiTestState((await c.query<{ data: unknown }>('SELECT hon.read_conversation_ai_test($1,$2) data',
      [context.externalSubject, ready])).rows[0]?.data));
    const found = state.tests.find(t => t.id === id);
    if (!found) throw new NotFoundException({ code: 'CONVERSATION_AI_TEST_NOT_FOUND' });
    return found;
  }

  private async tx<T>(context: MembershipLifecycleContext, command: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHuman(context, command);
    try {
      return await this.database.withTenantTransaction(context, async c => { await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]); return work(c); });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Test questions accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'CONVERSATION_AI_FORBIDDEN' });
    if (!command) { if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' }); return; }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
