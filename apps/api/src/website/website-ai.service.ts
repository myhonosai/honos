import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  WEBSITE_AI_LIMITS, applyWebsiteAiEdits, validateWebsiteAiApplyInput, validateWebsiteAiEditRequest, validateWebsiteAiProposal,
  verifySchoolWebsite, verifySchoolWebsiteRead, verifyWebsiteAiEditList, verifyWebsiteAiEditView,
  verifyWebsiteAiPrice, type SchoolWebsite, type WebsiteAiEditView, type WebsiteAiPrice,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import { WEBSITE_PROVIDER_RUNTIME, WebsiteProviderRuntimeError, type WebsiteProviderRuntime, type WebsiteTextInvocation, type WebsiteTextResult } from '../ai/website-provider-runtime.js';
import type { SchoolWebsiteContext } from './school-website.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  SCHOOL_WEBSITE_AI_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Asking Marcus to edit the website needs website editing and Marcus at this school, and an active Complete plan.' }),
  SCHOOL_WEBSITE_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Live website permission at this school and an active subscription are required.' }),
  SCHOOL_WEBSITE_AI_INVALID: code => new BadRequestException({ code, detail: 'Describe the change in up to 1,000 characters of plain text.' }),
  SCHOOL_WEBSITE_AI_STALE: code => new ConflictException({ code, detail: 'The website changed since you loaded it. Reload it and ask again.' }),
  SCHOOL_WEBSITE_NOT_FOUND: code => new NotFoundException({ code }),
  AI_TEXT_PROPOSAL_NOT_FOUND: () => new NotFoundException({ code: 'SCHOOL_WEBSITE_AI_NOT_FOUND' }),
  AI_TEXT_PROPOSAL_NOT_OPEN: () => new ConflictException({ code: 'SCHOOL_WEBSITE_AI_NOT_OPEN', detail: 'This suggestion was already applied or dismissed.' }),
  AI_TEXT_PROPOSAL_REPLAY_SWAP: () => new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different request.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The website changed since you loaded it. Reload it and try again.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' }),
  SCHOOL_WEBSITE_INVALID: code => new BadRequestException({ code, detail: 'The changed website does not fit the page and section rules.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const known = ERRORS[(error as { message?: string })?.message ?? ''];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known((error as { message: string }).message);
  // An S4 spend decision refused the start (an HQ pause, ended access, the school's cost ceiling). Nothing was sent.
  const message = (error as { message?: string })?.message ?? '';
  if (sqlState === '42501' && /^AI_[A-Z_]{1,60}$/.test(message)) throw new ForbiddenException({ code: 'SCHOOL_WEBSITE_AI_SPEND_STOPPED', reason: message, detail: 'AI help is paused or not available for this school right now. Nothing was sent.' });
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_WEBSITE_AI_FORBIDDEN' });
  if (sqlState === 'P0002') throw new NotFoundException({ code: 'SCHOOL_WEBSITE_AI_NOT_FOUND' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_WEBSITE_AI_CONFLICT', detail: 'Keep the same key. A sent request is never sent again.' });
  if (['22023', '22P02', '22003', '23514', '23503'].includes(sqlState)) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_WEBSITE_AI_UNAVAILABLE', detail: 'No success is assumed. Reload before trying again.' });
}
const validUsage = (r: WebsiteTextResult) => [r.inputTokens, r.outputTokens].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000)
  && Number.isSafeInteger(r.providerCostMicrounits) && r.providerCostMicrounits >= 0 && r.providerCostMicrounits <= 1_000_000_000;

/**
 * WB5 (0550): Marcus suggests website edits on the live text route (S4 spend controls, per-school ceiling). A suggestion
 * changes nothing until the owner applies it; applying is the 0361 draft save and the APPLIED close in one transaction.
 * Usage evidence is recorded in its own transaction, never with the draft change.
 */
@Injectable()
export class WebsiteAiService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService,
    @Inject(WEBSITE_PROVIDER_RUNTIME) private readonly provider: WebsiteProviderRuntime) {}

  list(context: SchoolWebsiteContext): Promise<WebsiteAiEditView[]> {
    return this.tx(context, false, async c => verifyWebsiteAiEditList((await c.query<{ data: unknown }>('SELECT hon.read_school_website_ai_edits($1,NULL) data', [context.externalSubject])).rows[0]?.data));
  }
  /** 0690: what the next edit is paid with (creative credits at the HQ rate, or included AI); nothing is reserved. */
  price(context: SchoolWebsiteContext): Promise<WebsiteAiPrice> {
    return this.tx(context, false, async c => verifyWebsiteAiPrice((await c.query<{ data: unknown }>('SELECT hon.read_school_website_ai_price($1) data', [context.externalSubject])).rows[0]?.data));
  }
  read(context: SchoolWebsiteContext, id: string): Promise<WebsiteAiEditView> { return this.view(context, id, false); }
  /** The same read inside a command (the request's key stays set). */
  private view(context: SchoolWebsiteContext, id: string, command: boolean): Promise<WebsiteAiEditView> {
    this.uuid(id);
    return this.tx(context, command, async c => verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.read_school_website_ai_edits($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data));
  }

  async request(context: SchoolWebsiteContext, input: unknown): Promise<WebsiteAiEditView> {
    this.assertHuman(context, true);
    if (!UUID.test(context.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'The Idempotency-Key must be a UUID for this request.' });
    let normalized;
    try { normalized = validateWebsiteAiEditRequest(input); } catch { throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID', detail: 'Describe the change in up to 1,000 characters of plain text.' }); }
    const view = await this.tx(context, true, async c => verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.begin_school_website_ai_edit($1,$2::jsonb,$3::uuid) data',
      [context.externalSubject, JSON.stringify(normalized), context.idempotencyKey])).rows[0]?.data));
    if (!['PENDING', 'CONFIGURATION_REQUIRED', 'BLOCKED'].includes(view.status)) return view;
    return this.generate(context, view.id);
  }

  private async generate(context: SchoolWebsiteContext, id: string): Promise<WebsiteAiEditView> {
    const ref = await this.tx(context, true, async c => (await c.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>(
      'SELECT hon.school_website_ai_edit_planning_reference($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) return this.view(context, id, true);
    let planId = ref.planId;
    if (!planId) {
      try {
        const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT',
          taskClass: 'DRAFT_MARKETING', inputBudget: WEBSITE_AI_LIMITS.inputTokens, outputBudget: WEBSITE_AI_LIMITS.outputTokens, maxProviderCostMicrounits: WEBSITE_AI_LIMITS.maxProviderCostMicrounits });
        planId = planned.status === 'PLANNED' ? planned.plan.id : null;
      } catch (error) { return translate(error); }
    }
    // The draft the edits are checked against. prepare blocks SUBJECT_STALE unless it is still the requested revision.
    const site = await this.currentDraft(context);
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    const invocation = await this.tx(context, true, async c => (await c.query<{ data: WebsiteTextInvocation | null }>('SELECT hon.prepare_school_website_ai_edit($1,$2::uuid,$3::uuid,$4) data',
      [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.view(context, id, true);
    let result: WebsiteTextResult;
    try {
      result = await this.provider.generate(invocation);
      if (!validUsage(result)) throw new WebsiteProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof WebsiteProviderRuntimeError ? error : new WebsiteProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.tx(context, true, async c => { await c.query('SELECT hon.fail_school_website_ai_edit($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.view(context, id, true);
    }
    // The answer is paid for: check it against the draft and record it either way (accepted, or rejected with problems).
    // A proposal outside the closed shape is sent as null; the database stores it empty and adds the one problem line.
    // prepare succeeded, so the draft read above is the revision the facts came from.
    let proposal: unknown = null, problems: string[] = [];
    try {
      const valid = validateWebsiteAiProposal(result.proposal);
      proposal = valid;
      if (site) problems = applyWebsiteAiEdits(site.draft, valid.edits).problems;
    } catch { proposal = null; problems = []; }
    const evidence = { usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, providerCostMicrounits: result.providerCostMicrounits }, proposal, problems };
    try {
      return await this.tx(context, true, async c => verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.record_school_website_ai_edit($1,$2::uuid,$3::jsonb) data',
        [context.externalSubject, id, JSON.stringify(evidence)])).rows[0]?.data));
    } catch {
      try { await this.tx(context, true, async c => { await c.query('SELECT hon.fail_school_website_ai_edit($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays; it reads as UNKNOWN and the HQ owner resolves it. */ }
      throw new ServiceUnavailableException({ code: 'SCHOOL_WEBSITE_AI_PERSISTENCE_UNKNOWN', detail: 'The answer could not be saved. It is held for review and is never sent again.' });
    }
  }

  /** Applies a recorded suggestion to the current draft: one 0361 save plus the APPLIED close, in one transaction. */
  async apply(context: SchoolWebsiteContext, id: string, input: unknown): Promise<{ website: SchoolWebsite; suggestion: WebsiteAiEditView; replayed: boolean }> {
    this.assertHuman(context, true);
    this.uuid(id);
    let expectedRevision: number;
    try { ({ expectedRevision } = validateWebsiteAiApplyInput(input)); } catch { throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID' }); }
    return this.tx(context, true, async c => {
      const view = verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.read_school_website_ai_edits($1,$2::uuid) data', [context.externalSubject, id])).rows[0]?.data);
      const read = verifySchoolWebsiteRead((await c.query<{ data: unknown }>('SELECT hon.read_school_website($1) data', [context.externalSubject])).rows[0]?.data);
      const site = read.website;
      if (!site) throw new NotFoundException({ code: 'SCHOOL_WEBSITE_NOT_FOUND' });
      if (view.status === 'APPLIED') return { website: site, suggestion: view, replayed: true };
      if (view.status !== 'RESULT_RECORDED' || !view.mine || !view.edits) throw new ConflictException({ code: 'SCHOOL_WEBSITE_AI_NOT_OPEN', detail: 'Only your own open suggestion can be applied.' });
      if (site.draftRevision !== expectedRevision) throw new ConflictException({ code: 'VERSION_CONFLICT', detail: 'The website changed since you loaded it. Reload it and try again.' });
      const applied = applyWebsiteAiEdits(site.draft, view.edits);
      if (applied.problems.length) throw new ConflictException({ code: 'SCHOOL_WEBSITE_AI_DOES_NOT_FIT', detail: 'Some suggested changes no longer fit the current draft. Dismiss it and ask again.', problems: applied.problems });
      const saved = await c.query<{ data: Record<string, unknown> }>('SELECT hon.mutate_school_website($1,$2,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
        [context.externalSubject, 'save', JSON.stringify({ expectedRevision, name: site.name, document: applied.document }), context.idempotencyKey, context.requestId, context.correlationId]);
      const data = saved.rows[0]?.data;
      if (saved.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'replayed,website' || typeof data.replayed !== 'boolean') throw new Error('Unverified website receipt.');
      const suggestion = verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.close_school_website_ai_edit($1,$2::uuid,$3) data', [context.externalSubject, id, 'APPLIED'])).rows[0]?.data);
      return { website: verifySchoolWebsite(data.website), suggestion, replayed: data.replayed };
    });
  }

  dismiss(context: SchoolWebsiteContext, id: string): Promise<WebsiteAiEditView> {
    this.uuid(id);
    return this.tx(context, true, async c => verifyWebsiteAiEditView((await c.query<{ data: unknown }>('SELECT hon.close_school_website_ai_edit($1,$2::uuid,$3) data', [context.externalSubject, id, 'DISMISSED'])).rows[0]?.data));
  }

  private async currentDraft(context: SchoolWebsiteContext): Promise<SchoolWebsite | null> {
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async c => {
        await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verifySchoolWebsiteRead((await c.query<{ data: unknown }>('SELECT hon.read_school_website($1) data', [context.externalSubject])).rows[0]?.data).website;
      });
    } catch { return null; }
  }

  private async tx<T>(context: SchoolWebsiteContext, command: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHuman(context, command);
    try {
      return await this.database.withTenantTransaction(context, async c => { await c.query(LIMITS); await c.query(HUMAN_SETTINGS, [context.externalSubject]); return work(c); });
    } catch (error) { return translate(error); }
  }

  private uuid(id: string): void { if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_AI_INVALID' }); }

  private assertHuman(context: SchoolWebsiteContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Website suggestions accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_WEBSITE_AI_FORBIDDEN' });
    if (!command) { if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' }); return; }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
