import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { COMMERCE_REVIEW_LIMITS, commerceReviewProblems, validateCommerceReviewBrief, validateCommerceReviewProposal, verifyCommerceReviewList, verifyCommerceReviewView, type CommerceReviewView } from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../../ai/ai-invocation-plan.service.js';
import type { MembershipLifecycleContext } from '../../billing/membership.service.js';
import { COMMERCE_REVIEW_PROVIDER_RUNTIME, MerchProviderRuntimeError, type MerchProviderRuntime, type MerchTextInvocation, type MerchTextResult } from './merch-provider-runtime.js';

export type CommerceReviewContext = MembershipLifecycleContext;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  SHOPIFY_MERCH_AI_FORBIDDEN: () => new ForbiddenException({ code: 'SHOPIFY_REVIEW_FORBIDDEN', detail: 'Asking Marcus for a commerce review needs Shopify management and Marcus at this school, and an active Complete plan.' }),
  SHOPIFY_REVIEW_INVALID: code => new BadRequestException({ code, detail: 'Pick what to review and keep the question to 300 characters.' }),
  SHOPIFY_REVIEW_NOT_CONNECTED: code => new ConflictException({ code, detail: 'Connect the school\'s Shopify store first.' }),
  AI_TEXT_PROPOSAL_NOT_FOUND: () => new NotFoundException({ code: 'SHOPIFY_REVIEW_NOT_FOUND' }),
  AI_TEXT_PROPOSAL_NOT_OPEN: () => new ConflictException({ code: 'SHOPIFY_REVIEW_NOT_OPEN', detail: 'This review was already closed.' }),
  AI_TEXT_PROPOSAL_REPLAY_SWAP: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different request.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  // An S4 spend decision refused the start (an HQ pause, ended access, the school's cost ceiling). Nothing was sent.
  if (sqlState === '42501' && /^AI_[A-Z_]{1,60}$/.test(message)) throw new ForbiddenException({ code: 'SHOPIFY_REVIEW_SPEND_STOPPED', reason: message, detail: 'AI help is paused or not available for this school right now. Nothing was sent.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SHOPIFY_REVIEW_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'SHOPIFY_REVIEW_NOT_FOUND' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SHOPIFY_REVIEW_CONFLICT', detail: 'Keep the same key. A sent request is never sent again.' });
  if (['22023', '22P02', '22003', '23514', '23503'].includes(sqlState)) throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID' });
  throw new ServiceUnavailableException({ code: 'SHOPIFY_REVIEW_UNAVAILABLE', detail: 'No success is assumed. Reload before trying again.' });
}
const validUsage = (r: MerchTextResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;

/**
 * CA1 (0615): Marcus reviews how the store is doing on the live text route (S4 spend controls, per-school ceiling) through
 * the shared AI text proposals (0550). He sees store totals only and a review changes nothing. Usage evidence is recorded
 * in its own transaction.
 */
@Injectable()
export class CommerceReviewService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService,
    @Inject(COMMERCE_REVIEW_PROVIDER_RUNTIME) private readonly provider: MerchProviderRuntime) {}

  /** Whether the paid text route is configured on this server (the database still decides everything else). */
  available(): boolean { return this.provider.readiness('OPENROUTER') === 'READY'; }

  list(context: CommerceReviewContext): Promise<CommerceReviewView[]> {
    return this.tx(context, false, async c => verifyCommerceReviewList((await c.query<{ data: unknown }>('SELECT hon.read_shopify_commerce_reviews($1,NULL) data', [context.externalSubject])).rows[0]?.data));
  }
  async read(context: CommerceReviewContext, id: string): Promise<CommerceReviewView> { return this.view(context, id, false); }
  private async view(context: CommerceReviewContext, id: string, command: boolean): Promise<CommerceReviewView> {
    this.uuid(id);
    return this.tx(context, command, async c => verifyCommerceReviewView((await c.query<{ data: unknown }>('SELECT hon.read_shopify_commerce_reviews($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data));
  }

  async request(context: CommerceReviewContext, input: unknown): Promise<CommerceReviewView> {
    this.assertHuman(context, true);
    if (!UUID.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be a UUID for this request.' });
    let brief;
    try { brief = validateCommerceReviewBrief(input); } catch { throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID', detail: 'Pick what to review and keep the question to 300 characters.' }); }
    const view = await this.tx(context, true, async c => verifyCommerceReviewView((await c.query<{ data: unknown }>('SELECT hon.begin_shopify_commerce_review($1,$2::jsonb,$3::uuid) data',
      [context.externalSubject, JSON.stringify(brief), context.idempotencyKey])).rows[0]?.data));
    if (!['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED'].includes(view.status)) return view;
    return this.generate(context, view);
  }

  private async generate(context: CommerceReviewContext, begun: CommerceReviewView): Promise<CommerceReviewView> {
    const id = begun.id;
    const ref = await this.tx(context, true, async c => (await c.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.plan_shopify_commerce_review($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) return this.view(context, id, true);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT',
          taskClass: 'DRAFT_MARKETING', inputBudget: COMMERCE_REVIEW_LIMITS.inputTokens, outputBudget: COMMERCE_REVIEW_LIMITS.outputTokens, maxProviderCostMicrounits: COMMERCE_REVIEW_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) { return translate(error); }
    }
    const ready = this.available();
    const invocation = await this.tx(context, true, async c => (await c.query<{ data: MerchTextInvocation | null }>('SELECT hon.prepare_shopify_commerce_review($1,$2::uuid,$3::uuid,$4) data',
      [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.view(context, id, true);
    let result: MerchTextResult;
    try {
      result = await this.provider.generate(invocation);
      if (!validUsage(result)) throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof MerchProviderRuntimeError ? error : new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.tx(context, true, async c => { await c.query('SELECT hon.fail_shopify_commerce_review($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.view(context, id, true);
    }
    // A paid answer: check it against the brief and record it either way (accepted, or rejected with its problems).
    let proposal: unknown = null, problems: string[] = [];
    try {
      const valid = validateCommerceReviewProposal(result.proposal);
      proposal = valid;
      problems = commerceReviewProblems(valid);
    } catch { proposal = null; problems = []; }
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits }, proposal, problems };
    try {
      return await this.tx(context, true, async c => {
        const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.record_shopify_commerce_review($1,$2::uuid,$3::jsonb) data', [context.externalSubject, id, JSON.stringify(evidence)])).rows[0]?.data;
        const { recorded: _recorded, ...view } = data ?? {};
        return verifyCommerceReviewView(view);
      });
    } catch {
      try { await this.tx(context, true, async c => { await c.query('SELECT hon.fail_shopify_commerce_review($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'SHOPIFY_REVIEW_PERSISTENCE_UNKNOWN', detail: 'The answer could not be saved. It is held for review and is never sent again.' });
    }
  }

  /** REVIEWED (APPLIED) or DISMISSED. The requester only. */
  async close(context: CommerceReviewContext, id: string, status: 'APPLIED' | 'DISMISSED'): Promise<CommerceReviewView> {
    this.uuid(id);
    if (status !== 'APPLIED' && status !== 'DISMISSED') throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID', detail: 'A review can only be marked reviewed or dismissed.' });
    return this.tx(context, true, async c => verifyCommerceReviewView((await c.query<{ data: unknown }>('SELECT hon.close_shopify_commerce_review($1,$2::uuid,$3) data', [context.externalSubject, id, status])).rows[0]?.data));
  }

  private async tx<T>(context: CommerceReviewContext, command: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHuman(context, command);
    try {
      return await this.database.withTenantTransaction(context, async c => { await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]); return work(c); });
    } catch (error) { return translate(error); }
  }

  private uuid(id: string): void { if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException({ code: 'SHOPIFY_REVIEW_INVALID' }); }

  private assertHuman(context: CommerceReviewContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Commerce reviews accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SHOPIFY_REVIEW_FORBIDDEN' });
    if (!command) { if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' }); return; }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
