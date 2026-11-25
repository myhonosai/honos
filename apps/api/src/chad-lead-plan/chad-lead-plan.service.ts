import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CHAD_LEAD_PLAN_LIMITS, chadLeadPlanProblems, validateChadLeadPlanStep, validateChadLeadPlanBrief, validateChadLeadPlanProposal, verifyChadLeadPlanList, verifyChadLeadPlanView, type ChadLeadPlanView } from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MerchProviderRuntimeError, type MerchProviderRuntime, type MerchTextInvocation, type MerchTextResult } from '../commerce/shopify/merch-provider-runtime.js';
import { CHAD_LEAD_PLAN_PROVIDER_RUNTIME } from './chad-lead-plan-provider.js';

export type ChadLeadPlanContext = MembershipLifecycleContext;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  CHAD_HUMAN_STAFF_REQUIRED: () => new ForbiddenException({ code: 'CHAD_LEAD_PLAN_FORBIDDEN', detail: 'Lead next steps with Chad need Chad\'s follow-up assistant, lead read and AI planning access at this school, and an active Complete plan.' }),
  CHAD_FOLLOW_UP_FORBIDDEN: () => new ForbiddenException({ code: 'CHAD_LEAD_PLAN_FORBIDDEN', detail: 'Lead next steps with Chad need Chad\'s follow-up assistant, lead read and AI planning access at this school, and an active Complete plan.' }),
  CHAD_LEAD_PLAN_INVALID: code => new BadRequestException({ code, detail: 'Pick all open leads or leads with no trial yet, with an optional note of up to 300 characters.' }),
  CHAD_LEAD_PLAN_NOT_DONE: code => new ConflictException({ code, detail: 'HON could not find that change made by you since Chad wrote this list. Run the step first, then record it.' }),
  AI_TEXT_PROPOSAL_NOT_FOUND: () => new NotFoundException({ code: 'CHAD_LEAD_PLAN_NOT_FOUND' }),
  AI_TEXT_PROPOSAL_NOT_OPEN: () => new ConflictException({ code: 'CHAD_LEAD_PLAN_NOT_OPEN', detail: 'This step was already recorded, or the list was dismissed.' }),
  AI_TEXT_PROPOSAL_REPLAY_SWAP: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different request.' }),
  IDEMPOTENCY_KEY_REUSED: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different request.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  // An S4 spend decision refused the start (an HQ pause, ended access, the school's cost ceiling). Nothing was sent.
  if (sqlState === '42501' && /^AI_[A-Z_]{1,60}$/.test(message)) throw new ForbiddenException({ code: 'CHAD_LEAD_PLAN_SPEND_STOPPED', reason: message, detail: 'AI help is paused or not available for this school right now. Nothing was sent.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CHAD_LEAD_PLAN_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'CHAD_LEAD_PLAN_NOT_FOUND' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CHAD_LEAD_PLAN_CONFLICT', detail: 'Keep the same key. A sent request is never sent again.' });
  if (['22023', '22P02', '22003', '23514', '23503'].includes(sqlState)) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' });
  throw new ServiceUnavailableException({ code: 'CHAD_LEAD_PLAN_UNAVAILABLE', detail: 'No success is assumed. Reload before trying again.' });
}
const validUsage = (r: MerchTextResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;

/**
 * P9 (0650): Chad suggests a next step (a stage move or a trial in a coming class) for up to ten open leads, on the live text route
 * (S4 spend controls, the per-school ceiling) through the shared AI text proposals (0550). Suggestions change nothing: the
 * person runs the ordinary human command for a step, then records it here, and the database checks that the requester's own
 * command really made that change after Chad wrote the list. Usage evidence is recorded in its own transaction.
 */
@Injectable()
export class ChadLeadPlanService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService,
    @Inject(CHAD_LEAD_PLAN_PROVIDER_RUNTIME) private readonly provider: MerchProviderRuntime) {}

  /** Whether the paid text route is configured on this server (the database still decides everything else). */
  available(): boolean { return this.provider.readiness('OPENROUTER') === 'READY'; }

  list(context: ChadLeadPlanContext): Promise<ChadLeadPlanView[]> {
    return this.tx(context, false, async c => verifyChadLeadPlanList((await c.query<{ data: unknown }>('SELECT hon.read_chad_lead_plans($1,NULL) data', [context.externalSubject])).rows[0]?.data));
  }
  async read(context: ChadLeadPlanContext, id: string): Promise<ChadLeadPlanView> { return this.view(context, id, false); }
  private async view(context: ChadLeadPlanContext, id: string, command: boolean): Promise<ChadLeadPlanView> {
    this.uuid(id);
    return this.tx(context, command, async c => verifyChadLeadPlanView((await c.query<{ data: unknown }>('SELECT hon.read_chad_lead_plans($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data));
  }

  async request(context: ChadLeadPlanContext, input: unknown): Promise<ChadLeadPlanView> {
    this.assertHuman(context, true);
    if (!UUID.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be a UUID for this request.' });
    let brief;
    try { brief = validateChadLeadPlanBrief(input); } catch { throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID', detail: 'Pick all open leads or leads with no trial yet, with an optional note of up to 300 characters.' }); }
    const view = await this.tx(context, true, async c => verifyChadLeadPlanView((await c.query<{ data: unknown }>('SELECT hon.begin_chad_lead_plan($1,$2::jsonb,$3::uuid) data',
      [context.externalSubject, JSON.stringify(brief), context.idempotencyKey])).rows[0]?.data));
    if (!['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED'].includes(view.status)) return view;
    return this.generate(context, view);
  }

  private async generate(context: ChadLeadPlanContext, begun: ChadLeadPlanView): Promise<ChadLeadPlanView> {
    const id = begun.id;
    const ref = await this.tx(context, true, async c => (await c.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.plan_chad_lead_plan($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) return this.view(context, id, true);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'chad', modality: 'TEXT',
          taskClass: 'DRAFT_FOLLOW_UP', inputBudget: CHAD_LEAD_PLAN_LIMITS.inputTokens, outputBudget: CHAD_LEAD_PLAN_LIMITS.outputTokens, maxProviderCostMicrounits: CHAD_LEAD_PLAN_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) { return translate(error); }
    }
    const ready = this.available();
    const invocation = await this.tx(context, true, async c => (await c.query<{ data: MerchTextInvocation | null }>('SELECT hon.prepare_chad_lead_plan($1,$2::uuid,$3::uuid,$4) data',
      [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.view(context, id, true);
    let result: MerchTextResult;
    try {
      result = await this.provider.generate(invocation);
      if (!validUsage(result)) throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof MerchProviderRuntimeError ? error : new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.tx(context, true, async c => { await c.query('SELECT hon.fail_chad_lead_plan($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.view(context, id, true);
    }
    // A paid answer: check it and record it either way (accepted, or rejected with its problems).
    let proposal: unknown = null, problems: string[] = [];
    try {
      const valid = validateChadLeadPlanProposal(result.proposal);
      proposal = valid;
      problems = chadLeadPlanProblems(valid);
    } catch { proposal = null; problems = []; }
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits }, proposal, problems };
    try {
      return await this.tx(context, true, async c => {
        const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.record_chad_lead_plan($1,$2::uuid,$3::jsonb) data', [context.externalSubject, id, JSON.stringify(evidence)])).rows[0]?.data;
        const { recorded: _recorded, ...view } = data ?? {};
        return verifyChadLeadPlanView(view);
      });
    } catch {
      try { await this.tx(context, true, async c => { await c.query('SELECT hon.fail_chad_lead_plan($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'CHAD_LEAD_PLAN_PERSISTENCE_UNKNOWN', detail: 'The answer could not be saved. It is held for review and is never sent again.' });
    }
  }

  /** Record what the requester's own human command produced for one suggestion (a stage move, or a trial appointment). */
  async recordStep(context: ChadLeadPlanContext, id: string, index: number, input: unknown): Promise<{ leadPlan: ChadLeadPlanView; replayed: boolean }> {
    this.uuid(id); this.assertHuman(context, true);
    if (!Number.isInteger(index) || index < 0 || index > 9) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' });
    let step;
    try { step = validateChadLeadPlanStep(input); } catch { throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID', detail: 'Send the trial appointment id for a booking, or null for a stage move.' }); }
    return this.tx(context, true, async c => {
      const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.record_chad_lead_plan_step($1,$2::uuid,$3::integer,$4::jsonb) data',
        [context.externalSubject, id, index, JSON.stringify(step)])).rows[0]?.data;
      const { replayed, ...view } = data ?? {};
      return { leadPlan: verifyChadLeadPlanView(view), replayed: replayed === true };
    });
  }

  /** DISMISSED. The requester only. */
  async dismiss(context: ChadLeadPlanContext, id: string): Promise<ChadLeadPlanView> {
    this.uuid(id);
    return this.tx(context, true, async c => verifyChadLeadPlanView((await c.query<{ data: unknown }>("SELECT hon.close_chad_lead_plan($1,$2::uuid,'DISMISSED') data", [context.externalSubject, id])).rows[0]?.data));
  }

  private async tx<T>(context: ChadLeadPlanContext, command: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHuman(context, command);
    try {
      return await this.database.withTenantTransaction(context, async c => { await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]); return work(c); });
    } catch (error) { return translate(error); }
  }

  private uuid(id: string): void { if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException({ code: 'CHAD_LEAD_PLAN_INVALID' }); }

  private assertHuman(context: ChadLeadPlanContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Chad lead next steps accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'CHAD_LEAD_PLAN_FORBIDDEN' });
    if (!command) { if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' }); return; }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
