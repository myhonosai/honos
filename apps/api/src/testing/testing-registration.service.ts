import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  DecideTestingRegistrationInterestInput,
  ParentTestingInterestReceipt,
  ParentTestingRegistrationView,
  StaffTestingRegistrationReviewReceipt,
  StaffTestingRegistrationView,
  SubmitTestingRegistrationInterestInput,
  TestingRegistrationContext,
} from '@hon/contracts';
import {
  validateTestingRegistrationInterestInput,
  validateTestingRegistrationReviewInput,
  verifyParentTestingInterestReceipt,
  verifyParentTestingRegistrationView,
  verifyStaffTestingRegistrationReviewReceipt,
  verifyStaffTestingRegistrationView,
} from '@hon/contracts';
import type { ResolvedParentFamilyScope, ResolvedPrincipalScope } from '../foundation/runtime-database.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { testingDatabaseError } from './testing-database-error.js';

function sameParentScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope): boolean {
  return a.principalId === b.principalId && a.organizationId === b.organizationId
    && a.schoolId === b.schoolId && a.familyId === b.familyId && a.accessLevel === b.accessLevel;
}
function exactStaffScope(scopes: ResolvedPrincipalScope[]): ResolvedPrincipalScope {
  const distinct = new Map(scopes.map(scope => [`${scope.principalId}/${scope.organizationId}/${scope.schoolId}`, scope]));
  if (distinct.size !== 1) throw new ForbiddenException({ code: distinct.size ? 'TESTING_REGISTRATION_SCOPE_AMBIGUOUS' : 'TESTING_REGISTRATION_REVIEW_FORBIDDEN', detail: 'One current reviewed staff scope is required. No school is selected automatically.' });
  return [...distinct.values()][0]!;
}

@Injectable()
export class TestingRegistrationService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async parentScope(externalSubject: string): Promise<ResolvedParentFamilyScope> {
    const discovered = await this.database.resolveParentJourneyScopes(externalSubject);
    if (!discovered.length) throw new ForbiddenException({ code: 'PARENT_SCOPE_DENIED', detail: 'Current verified family access is required.' });
    if (discovered.length !== 1) throw new ConflictException({ code: 'PARENT_SCOPE_AMBIGUOUS', detail: 'A verified current-family selector is not available. No family is selected automatically.' });
    const candidate = discovered[0]!;
    const exact = (await this.database.resolveParentFamilyScopes(externalSubject, candidate.schoolId)).find(scope => sameParentScope(scope, candidate));
    if (!exact) throw new ForbiddenException({ code: 'PARENT_SCOPE_DENIED', detail: 'Current verified family access is required.' });
    return exact;
  }

  private context(scope: ResolvedPrincipalScope, externalSubject: string, idempotencyKey = ''): TestingRegistrationContext {
    const requestId = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey };
  }
  private async markHumanUi(client: { query: (query: string) => Promise<unknown> }): Promise<void> {
    await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
    await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
  }

  async parentView(externalSubject: string): Promise<{ view: ParentTestingRegistrationView; context: TestingRegistrationContext }> {
    const scope = await this.parentScope(externalSubject), context = this.context(scope, externalSubject);
    try {
      const view = await this.database.withTenantTransaction(context, async client => {
        await this.markHumanUi(client);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_parent_testing_registration_view($1,$2::uuid) data', [externalSubject, scope.familyId]);
        return verifyParentTestingRegistrationView(result.rows[0]?.data);
      });
      return { view, context };
    } catch (error) { return testingDatabaseError(error); }
  }

  async submitInterest(externalSubject: string, idempotencyKey: string, input: SubmitTestingRegistrationInterestInput): Promise<{ receipt: ParentTestingInterestReceipt; replayed: boolean; context: TestingRegistrationContext }> {
    validateTestingRegistrationInterestInput(input);
    const scope = await this.parentScope(externalSubject), context = this.context(scope, externalSubject, idempotencyKey.trim());
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique retry key is required.' });
    try {
      const outcome = await this.database.withTenantTransaction(context, async client => {
        await this.markHumanUi(client);
        const result = await client.query<{ data: { record?: unknown; replayed?: unknown } }>(
          'SELECT hon.mutate_parent_testing_registration_interest($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::uuid) data',
          [externalSubject, scope.familyId, input.testingEventId, input.studentProfileId, input.note?.trim() ?? null, context.idempotencyKey, context.requestId, context.correlationId],
        );
        const data = result.rows[0]?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.replayed !== 'boolean' || !Object.hasOwn(data, 'record')) throw new Error('Testing registration command did not return a verified result.');
        return { receipt: verifyParentTestingInterestReceipt(data.record), replayed: data.replayed };
      });
      return { ...outcome, context };
    } catch (error) { return testingDatabaseError(error); }
  }

  private async reviewerScope(externalSubject: string): Promise<ResolvedPrincipalScope> {
    return exactStaffScope(await this.database.resolveTestingRegistrationReviewScopes(externalSubject));
  }

  async staffView(externalSubject: string): Promise<{ view: StaffTestingRegistrationView; context: TestingRegistrationContext }> {
    const scope = await this.reviewerScope(externalSubject), context = this.context(scope, externalSubject);
    try {
      const view = await this.database.withTenantTransaction(context, async client => {
        await this.markHumanUi(client);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_staff_testing_registrations($1) data', [externalSubject]);
        return verifyStaffTestingRegistrationView(result.rows[0]?.data);
      });
      return { view, context };
    } catch (error) { return testingDatabaseError(error); }
  }

  async review(externalSubject: string, interestId: string, idempotencyKey: string, input: DecideTestingRegistrationInterestInput): Promise<{ receipt: StaffTestingRegistrationReviewReceipt; replayed: boolean; context: TestingRegistrationContext }> {
    validateTestingRegistrationReviewInput(input);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(interestId)) throw new ConflictException({ code: 'VALIDATION_FAILED', detail: 'A testing registration ID is required.' });
    const scope = await this.reviewerScope(externalSubject), context = this.context(scope, externalSubject, idempotencyKey.trim());
    if (!context.idempotencyKey || context.idempotencyKey.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique retry key is required.' });
    try {
      const outcome = await this.database.withTenantTransaction(context, async client => {
        await this.markHumanUi(client);
        const result = await client.query<{ data: { record?: unknown; replayed?: unknown } }>(
          'SELECT hon.mutate_staff_testing_registration_decision($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data',
          [externalSubject, interestId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
        );
        const data = result.rows[0]?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.replayed !== 'boolean' || !Object.hasOwn(data, 'record')) throw new Error('Testing registration review did not return a verified result.');
        return { receipt: verifyStaffTestingRegistrationReviewReceipt(data.record), replayed: data.replayed };
      });
      return { ...outcome, context };
    } catch (error) { return testingDatabaseError(error); }
  }
}
