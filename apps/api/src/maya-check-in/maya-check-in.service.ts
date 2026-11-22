import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MAYA_CHECK_IN_LIMITS, mayaCheckInProblems, validateMayaCheckInApproval, validateMayaCheckInBrief, validateMayaCheckInProposal, verifyMayaCheckInList, verifyMayaCheckInView, type MayaCheckInChannel, type MayaCheckInView } from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MerchProviderRuntimeError, type MerchProviderRuntime, type MerchTextInvocation, type MerchTextResult } from '../commerce/shopify/merch-provider-runtime.js';
import { MAYA_CHECK_IN_PROVIDER_RUNTIME } from './maya-check-in-provider.js';

export type MayaCheckInContext = MembershipLifecycleContext;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  MAYA_CHECK_IN_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Check-in drafts with Maya need Maya, message sending and AI planning access at this school, and an active Complete plan.' }),
  MAYA_AT_RISK_FORBIDDEN: () => new ForbiddenException({ code: 'MAYA_CHECK_IN_FORBIDDEN', detail: 'Check-in drafts with Maya need Maya, message sending and AI planning access at this school, and an active Complete plan.' }),
  MAYA_CHECK_IN_INVALID: code => new BadRequestException({ code, detail: 'That draft or approval was not accepted as written. Nothing was sent.' }),
  MAYA_CHECK_IN_NOT_AT_RISK: () => new NotFoundException({ code: 'MAYA_CHECK_IN_NOT_AT_RISK', detail: 'This student is not on the at-risk list now. Nothing was sent.' }),
  MAYA_CHECK_IN_NO_CONSENT: code => new ConflictException({ code, detail: 'This person has not agreed to messages on that channel. Nothing was sent.' }),
  MAYA_CHECK_IN_NO_ADDRESS: code => new ConflictException({ code, detail: 'This person has no phone number or email for that channel. Nothing was sent.' }),
  MAYA_CHECK_IN_DAILY_CAP: code => new ConflictException({ code, detail: 'This person already got 3 approved AI-drafted messages in the last 24 hours. Nothing was sent.' }),
  MAYA_CHECK_IN_NOT_CANCELLABLE: code => new ConflictException({ code, detail: 'This message is already being sent, or was never queued.' }),
  AI_TEXT_PROPOSAL_NOT_FOUND: () => new NotFoundException({ code: 'MAYA_CHECK_IN_NOT_FOUND' }),
  AI_TEXT_PROPOSAL_NOT_OPEN: () => new ConflictException({ code: 'MAYA_CHECK_IN_NOT_OPEN', detail: 'This draft was already approved or dismissed.' }),
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
  if (sqlState === '42501' && /^AI_[A-Z_]{1,60}$/.test(message)) throw new ForbiddenException({ code: 'MAYA_CHECK_IN_SPEND_STOPPED', reason: message, detail: 'AI help is paused or not available for this school right now. Nothing was sent.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MAYA_CHECK_IN_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'MAYA_CHECK_IN_NOT_FOUND' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'MAYA_CHECK_IN_CONFLICT', detail: 'Keep the same key. A sent request is never sent again.' });
  if (['22023', '22P02', '22003', '23514', '23503'].includes(sqlState)) throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID' });
  throw new ServiceUnavailableException({ code: 'MAYA_CHECK_IN_UNAVAILABLE', detail: 'No success is assumed. Reload before trying again.' });
}
const validUsage = (r: MerchTextResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;

/**
 * P8 (0649): Maya writes a check-in text or email for one at-risk student on the live text route (S4 spend controls, the per-school
 * ceiling) through the shared AI text proposals (0550). A draft sends nothing; the requester's approval (button or voice) queues one
 * message through the ordinary communication queue, where the delivery worker still checks consent, STOP and quiet hours at send
 * time. Usage evidence is recorded in its own transaction.
 */
@Injectable()
export class MayaCheckInService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService,
    @Inject(MAYA_CHECK_IN_PROVIDER_RUNTIME) private readonly provider: MerchProviderRuntime) {}

  /** Whether the paid text route is configured on this server (the database still decides everything else). */
  available(): boolean { return this.provider.readiness('OPENROUTER') === 'READY'; }

  list(context: MayaCheckInContext): Promise<MayaCheckInView[]> {
    return this.tx(context, false, async c => verifyMayaCheckInList((await c.query<{ data: unknown }>('SELECT hon.read_maya_check_in_drafts($1,NULL) data', [context.externalSubject])).rows[0]?.data));
  }
  async read(context: MayaCheckInContext, id: string): Promise<MayaCheckInView> { return this.view(context, id, false); }
  private async view(context: MayaCheckInContext, id: string, command: boolean): Promise<MayaCheckInView> {
    this.uuid(id);
    return this.tx(context, command, async c => verifyMayaCheckInView((await c.query<{ data: unknown }>('SELECT hon.read_maya_check_in_drafts($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data));
  }

  async request(context: MayaCheckInContext, input: unknown): Promise<MayaCheckInView> {
    this.assertHuman(context, true);
    if (!UUID.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be a UUID for this request.' });
    let brief;
    try { brief = validateMayaCheckInBrief(input); } catch { throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID', detail: 'Pick a student, text or email, and an optional note of up to 300 characters.' }); }
    const view = await this.tx(context, true, async c => verifyMayaCheckInView((await c.query<{ data: unknown }>('SELECT hon.begin_maya_check_in_draft($1,$2::jsonb,$3::uuid) data',
      [context.externalSubject, JSON.stringify(brief), context.idempotencyKey])).rows[0]?.data));
    if (!['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED'].includes(view.status)) return view;
    return this.generate(context, view);
  }

  private async generate(context: MayaCheckInContext, begun: MayaCheckInView): Promise<MayaCheckInView> {
    const id = begun.id;
    const ref = await this.tx(context, true, async c => (await c.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.plan_maya_check_in_draft($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) return this.view(context, id, true);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'maya', modality: 'TEXT',
          taskClass: 'DRAFT_FOLLOW_UP', inputBudget: MAYA_CHECK_IN_LIMITS.inputTokens, outputBudget: MAYA_CHECK_IN_LIMITS.outputTokens, maxProviderCostMicrounits: MAYA_CHECK_IN_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) { return translate(error); }
    }
    const ready = this.available();
    const invocation = await this.tx(context, true, async c => (await c.query<{ data: MerchTextInvocation | null }>('SELECT hon.prepare_maya_check_in_draft($1,$2::uuid,$3::uuid,$4) data',
      [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.view(context, id, true);
    let result: MerchTextResult;
    try {
      result = await this.provider.generate(invocation);
      if (!validUsage(result)) throw new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof MerchProviderRuntimeError ? error : new MerchProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.tx(context, true, async c => { await c.query('SELECT hon.fail_maya_check_in_draft($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.view(context, id, true);
    }
    // A paid answer: check it and record it either way (accepted, or rejected with its problems).
    let proposal: unknown = null, problems: string[] = [];
    try {
      const valid = validateMayaCheckInProposal(result.proposal, begun.brief.channel as MayaCheckInChannel);
      proposal = valid;
      problems = mayaCheckInProblems(valid);
    } catch { proposal = null; problems = []; }
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits }, proposal, problems };
    try {
      return await this.tx(context, true, async c => {
        const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.record_maya_check_in_draft($1,$2::uuid,$3::jsonb) data', [context.externalSubject, id, JSON.stringify(evidence)])).rows[0]?.data;
        const { recorded: _recorded, ...view } = data ?? {};
        return verifyMayaCheckInView(view);
      });
    } catch {
      try { await this.tx(context, true, async c => { await c.query('SELECT hon.fail_maya_check_in_draft($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'MAYA_CHECK_IN_PERSISTENCE_UNKNOWN', detail: 'The answer could not be saved. It is held for review and is never sent again.' });
    }
  }

  /** Approve the requester's own draft and queue one message (button or voice). The school's delivery checks still run at send time. */
  async approve(context: MayaCheckInContext, id: string, input: unknown): Promise<{ checkIn: MayaCheckInView; replayed: boolean }> {
    this.uuid(id); this.assertHuman(context, true);
    if (context.idempotencyKey.length > 160) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be at most 160 characters.' });
    const current = await this.view({ ...context, idempotencyKey: '' }, id, false);
    let approval;
    try { approval = validateMayaCheckInApproval(input, current.brief.channel); } catch { throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID', detail: 'Pick who gets it and when, and keep the message within its length with no links.' }); }
    return this.tx(context, true, async c => {
      const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.approve_maya_check_in_draft($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data',
        [context.externalSubject, id, JSON.stringify(approval), context.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data;
      const { replayed, ...view } = data ?? {};
      return { checkIn: verifyMayaCheckInView(view), replayed: replayed === true };
    });
  }

  /** Cancel the queued message before the delivery worker claims it. The requester only. */
  async cancel(context: MayaCheckInContext, id: string): Promise<MayaCheckInView> {
    this.uuid(id);
    return this.tx(context, true, async c => {
      const data = (await c.query<{ data: Record<string, unknown> }>('SELECT hon.cancel_maya_check_in_send($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data;
      const { replayed: _replayed, ...view } = data ?? {};
      return verifyMayaCheckInView(view);
    });
  }

  /** DISMISSED. The requester only. */
  async dismiss(context: MayaCheckInContext, id: string): Promise<MayaCheckInView> {
    this.uuid(id);
    return this.tx(context, true, async c => verifyMayaCheckInView((await c.query<{ data: unknown }>("SELECT hon.close_maya_check_in_draft($1,$2::uuid,'DISMISSED') data", [context.externalSubject, id])).rows[0]?.data));
  }

  private async tx<T>(context: MayaCheckInContext, command: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHuman(context, command);
    try {
      return await this.database.withTenantTransaction(context, async c => { await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]); return work(c); });
    } catch (error) { return translate(error); }
  }

  private uuid(id: string): void { if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException({ code: 'MAYA_CHECK_IN_INVALID' }); }

  private assertHuman(context: MayaCheckInContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Maya check-in drafts accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'MAYA_CHECK_IN_FORBIDDEN' });
    if (!command) { if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' }); return; }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
