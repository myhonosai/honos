import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { validateEianAskInput, verifyEianAskResult, verifyEianStatus, verifyEianTurn, type EianAskResult, type EianStatus, type EianTurn } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { ParentClassBookingService } from '../families/parent-class-booking.service.js';
import { ParentSchoolBookingService } from '../families/parent-school-bookings.service.js';
import { ParentBillingViewService } from '../families/parent-billing-view.service.js';
import { ParentClassPassViewService } from '../families/parent-classpass-view.service.js';
import { FamilyMessagesService } from '../families/family-messages.service.js';
import { ParentTestingStatusService } from '../testing/parent-testing-status.service.js';
import { ParentFamilyKnowledgeService } from '../knowledge/parent-family-knowledge.service.js';
import { buildEianFacts, type EianFacts } from './eian-facts.js';
import { EIAN_PROVIDER_RUNTIME, EianProviderRuntimeError, verifiedEianResult, type EianInvocation, type EianProviderRuntime } from './eian-provider-runtime.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  EIAN_FORBIDDEN: code => new ForbiddenException({ code }),
  EIAN_AI_UNAVAILABLE: code => new HttpException({ code, detail: 'Eian AI is not available for this school right now.' }, HttpStatus.SERVICE_UNAVAILABLE),
  EIAN_BUSY: code => new HttpException({ code, detail: 'Too many questions in the last few minutes. Please try again shortly.' }, HttpStatus.TOO_MANY_REQUESTS),
  EIAN_TURN_NOT_FOUND: code => new NotFoundException({ code }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different question.' }),
};
const STATES: Record<string, string> = { VALIDATION_FAILED: '22023', EIAN_FORBIDDEN: '42501', EIAN_AI_UNAVAILABLE: '55000', EIAN_BUSY: '54000', EIAN_TURN_NOT_FOUND: 'P0002', IDEMPOTENCY_KEY_REUSED: '23505' };
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  if (ERRORS[message] && STATES[message] === sqlState) throw ERRORS[message]!(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
  if (['40001', '40P01', '55P03'].includes(sqlState)) throw new ConflictException({ code: 'EIAN_CONFLICT' });
  throw new ServiceUnavailableException({ code: 'EIAN_UNAVAILABLE', detail: 'No verified Eian result is available.' });
}
const subjectOk = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && s.trim() === s;
const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200 && k.trim() === k && !/[\u0000-\u001f\u007f]/.test(k);
const sameScope = (a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope) =>
  (['principalId', 'organizationId', 'schoolId', 'familyId'] as const).every(k => a[k] === b[k]);

/**
 * E-AI1 Eian family AI. Begins one turn, plans it on the parent path, builds the allow-listed facts from the parent's own
 * guarded reads under one resolved scope, prepares under the S4 budget lock (the database re-checks that scope, the shape
 * and the gate), calls the injected provider runtime once, and records usage before any answer is shown. Anything
 * ambiguous is UNKNOWN and never resent. A resend with the same key and question never plans or calls again once the
 * turn has left PENDING.
 */
@Injectable()
export class EianService {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly classes: ParentClassBookingService,
    private readonly bookings: ParentSchoolBookingService,
    private readonly billing: ParentBillingViewService,
    private readonly classPasses: ParentClassPassViewService,
    private readonly messages: FamilyMessagesService,
    private readonly testing: ParentTestingStatusService,
    private readonly knowledge: ParentFamilyKnowledgeService,
    @Inject(EIAN_PROVIDER_RUNTIME) private readonly provider: EianProviderRuntime,
  ) {}

  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const scopes = await this.database.resolveParentJourneyScopes(subject);
    if (scopes.length !== 1) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    return scopes[0]!;
  }
  private transaction<T>(subject: string, scope: ResolvedParentFamilyScope, work: (client: PoolClient, requestId: string) => Promise<T>): Promise<T> {
    const requestId = randomUUID();
    return this.database.withTenantTransaction({ organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId,
      principalType: 'HUMAN_USER', requestId }, async (client) => {
      await client.query(LIMITS);
      await client.query(HUMAN_SETTINGS, [subject]);
      return work(client, requestId);
    });
  }
  private ready(): boolean { return this.provider.readiness('OPENROUTER') === 'READY'; }

  async status(subject: string): Promise<EianStatus> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    try {
      const scope = await this.scope(subject);
      return await this.transaction(subject, scope, async (client) =>
        verifyEianStatus((await client.query<{ data: unknown }>('SELECT hon.read_eian_status($1,$2) AS data', [subject, this.ready()])).rows[0]?.data));
    } catch (error) { return translate(error); }
  }

  async read(subject: string, turnId: string): Promise<EianTurn> {
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    try {
      const scope = await this.scope(subject);
      return await this.transaction(subject, scope, async (client) =>
        verifyEianTurn((await client.query<{ data: unknown }>('SELECT hon.read_eian_turn($1,$2::uuid) AS data', [subject, turnId])).rows[0]?.data));
    } catch (error) { return translate(error); }
  }

  async ask(subject: string, body: unknown, key: unknown): Promise<EianAskResult> {
    let input;
    try { input = validateEianAskInput(body); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    if (!subjectOk(subject)) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    if (!keyOk(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    try {
      const scope = await this.scope(subject);
      const begun = await this.transaction(subject, scope, async (client) =>
        verifyEianAskResult((await client.query<{ data: unknown }>('SELECT hon.begin_eian_turn($1,$2,$3) AS data', [subject, input.question, key])).rows[0]?.data));
      // Only a PENDING turn is carried forward; every later state is final for this key (no second plan or call).
      if (begun.turn.status === 'PENDING') await this.carry(subject, scope, begun.turn.id);
      const turn = await this.transaction(subject, scope, async (client) =>
        verifyEianTurn((await client.query<{ data: unknown }>('SELECT hon.read_eian_turn($1,$2::uuid) AS data', [subject, begun.turn.id])).rows[0]?.data));
      return { turn, replayed: begun.replayed };
    } catch (error) { return translate(error); }
  }

  private async carry(subject: string, scope: ResolvedParentFamilyScope, turnId: string): Promise<void> {
    const planned = await this.transaction(subject, scope, async (client, requestId) =>
      (await client.query<{ data: { status: string; planId?: string } }>('SELECT hon.plan_eian_turn($1,$2::uuid,$3::uuid,$3::uuid) AS data', [subject, turnId, requestId])).rows[0]!.data);
    const planId = planned?.status === 'PLANNED' && typeof planned.planId === 'string' ? planned.planId : null;
    const facts = await this.facts(subject, scope);
    const invocation = await this.transaction(subject, scope, async (client) =>
      (await client.query<{ data: EianInvocation | null }>('SELECT hon.prepare_eian_turn($1,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb) AS data',
        [subject, turnId, planId, this.ready(), JSON.stringify({ organizationId: scope.organizationId, schoolId: scope.schoolId, familyId: scope.familyId }), JSON.stringify(facts)])).rows[0]!.data);
    if (!invocation) return;
    let result;
    try {
      result = verifiedEianResult(await this.provider.generate(invocation));
    } catch (error) {
      const failure = error instanceof EianProviderRuntimeError ? error : new EianProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.transaction(subject, scope, async (client) => { await client.query('SELECT hon.fail_eian_turn($1,$2::uuid,$3,$4)', [subject, turnId, failure.outcome, failure.reason]); });
      return;
    }
    try {
      await this.transaction(subject, scope, async (client) => { await client.query('SELECT hon.record_eian_turn_result($1,$2::uuid,$3::jsonb)', [subject, turnId, JSON.stringify(result)]); });
    } catch {
      try { await this.transaction(subject, scope, async (client) => { await client.query('SELECT hon.fail_eian_turn($1,$2::uuid,$3,$4)', [subject, turnId, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); }
      catch { /* The SENDING hold stays and becomes UNKNOWN after the stale limit; HQ resolves it. */ }
      throw new ServiceUnavailableException({ code: 'EIAN_OUTCOME_UNKNOWN', detail: 'The answer needs checking. It will not be asked again.' });
    }
  }

  /**
   * The facts, from the parent's own guarded reads only, each called with the subject (each re-resolves and re-checks the
   * parent scope). A read that refuses (a viewer has no billing, a section is off) is listed as unavailable, never guessed.
   * The scope must be the same before and after, and prepare checks it again against the turn after its locks.
   */
  private async facts(subject: string, scope: ResolvedParentFamilyScope): Promise<EianFacts> {
    const safe = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read(); } catch { return null; } };
    const [classes, bookings, billing, classPasses, messages, testing, knowledge] = await Promise.all([
      safe(() => this.classes.choices(subject)),
      safe(() => this.bookings.choices(subject)),
      safe(async () => (await this.billing.get(subject)).data),
      safe(async () => (await this.classPasses.get(subject)).data),
      safe(() => this.messages.parentRead(subject)),
      safe(async () => (await this.testing.get(subject)).data),
      safe(() => this.knowledge.get(scope, scope.familyId, randomUUID())),
    ]);
    if (!sameScope(scope, await this.scope(subject))) throw new ForbiddenException({ code: 'EIAN_FORBIDDEN' });
    return buildEianFacts({ now: new Date(), timezone: classes?.timezone ?? bookings?.timezone ?? null, schoolName: messages?.schoolName ?? null,
      classes, bookings, billing, classPasses, messages: messages?.messages ?? null, testing, knowledge });
  }
}
