import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID,
  validateCrmGuardianChildMembershipDraftConfirmationInput,
  validateCrmGuardianChildMembershipDraftInput,
  validateCrmGuardianChildMembershipPreparationInput,
  validateCrmGuardianChildPayerDesignationInput,
  validateCrmGuardianChildPayerDesignationPreparationInput,
  verifyCrmGuardianChildMembershipDraftConfirmation,
  verifyCrmGuardianChildMembershipDraftReceipt,
  verifyCrmGuardianChildMembershipPreparation,
  verifyCrmGuardianChildPayerDesignationPreparation,
  verifyCrmGuardianChildPayerDesignationReceipt,
  type CrmGuardianChildMembershipDraftConfirmation,
  type CrmGuardianChildMembershipDraftConfirmationInput,
  type CrmGuardianChildMembershipDraftContext,
  type CrmGuardianChildMembershipDraftInput,
  type CrmGuardianChildMembershipDraftReceipt,
  type CrmGuardianChildMembershipPreparation,
  type CrmGuardianChildMembershipPreparationInput,
  type CrmGuardianChildPayerDesignationInput,
  type CrmGuardianChildPayerDesignationPreparation,
  type CrmGuardianChildPayerDesignationPreparationInput,
  type CrmGuardianChildPayerDesignationReceipt,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const CONTEXT_KEYS = ['organizationId', 'schoolId', 'principalId', 'principalType', 'source', 'requestId', 'correlationId', 'idempotencyKey', 'externalSubject'];
const UNAVAILABLE = 'CRM_GUARDIAN_CHILD_MEMBERSHIP_UNAVAILABLE';
const FORBIDDEN = 'CRM_GUARDIAN_CHILD_MEMBERSHIP_FORBIDDEN';
const CONFLICT = 'CRM_GUARDIAN_CHILD_MEMBERSHIP_CONFLICT';
const INVALID = 'INVALID_CRM_GUARDIAN_CHILD_MEMBERSHIP_INPUT';

/** No caller-provided authority, delegation, or alternate source survives this boundary. */
function directHuman(context: CrmGuardianChildMembershipDraftContext, command: boolean): void {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype
    || !CONTEXT_KEYS.every(key => Object.hasOwn(context, key))
    || context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI'
    || context.actionRequestId !== undefined || context.delegatedByPrincipalId !== undefined
    || Object.keys(context).some(key => !CONTEXT_KEYS.includes(key))
    || ![context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]
      .every(value => typeof value === 'string' && CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(value))
    || typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.trim() !== context.externalSubject || context.externalSubject.length > 200) {
    throw new ForbiddenException({ code: FORBIDDEN });
  }
  if (command ? typeof context.idempotencyKey !== 'string' || !CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(context.idempotencyKey) : context.idempotencyKey !== '') {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  }
}
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const code = (error as { code?: string } | undefined)?.code;
  if (code === '42501') throw new ForbiddenException({ code: FORBIDDEN });
  // Deterministic missing, stale, or malformed provenance is a closed unavailable
  // result, not a retryable unknown command outcome. Unknown persistence failures
  // remain indistinguishable 503s below.
  if (code === 'P0002') throw new NotFoundException({ code: UNAVAILABLE });
  if (['23505', '40001', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: CONFLICT });
  if (['22023', '22P02', '22003', '22007', '22008', '23514', '23503'].includes(code ?? '')) throw new BadRequestException({ code: INVALID });
  throw new ServiceUnavailableException({ code: UNAVAILABLE });
}
async function establishDirectHumanGuc(client: { query(query: string, values?: unknown[]): Promise<unknown> }, externalSubject: string): Promise<void> {
  await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [externalSubject]);
}

@Injectable()
export class CrmGuardianChildMembershipDraftService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async preparePayerDesignation(context: CrmGuardianChildMembershipDraftContext, value: CrmGuardianChildPayerDesignationPreparationInput): Promise<CrmGuardianChildPayerDesignationPreparation> {
    directHuman(context, false);
    let input: CrmGuardianChildPayerDesignationPreparationInput;
    try { input = validateCrmGuardianChildPayerDesignationPreparationInput(value); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await establishDirectHumanGuc(client, context.externalSubject);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_guardian_child_payer_designation_preparation($1,$2::uuid) AS data', [context.externalSubject, input.studentProfileId]);
        if (result.rows.length !== 1) throw new Error('Unverified payer-designation preparation.');
        return verifyCrmGuardianChildPayerDesignationPreparation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  async designatePayer(context: CrmGuardianChildMembershipDraftContext, value: CrmGuardianChildPayerDesignationInput): Promise<{ receipt: CrmGuardianChildPayerDesignationReceipt; replayed: boolean }> {
    directHuman(context, true);
    let input: CrmGuardianChildPayerDesignationInput;
    try { input = validateCrmGuardianChildPayerDesignationInput(value); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await establishDirectHumanGuc(client, context.externalSubject);
        const result = await client.query<{ data: { receipt: unknown; replayed: boolean } }>('SELECT hon.designate_crm_guardian_child_payer($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified payer designation.');
        return { receipt: verifyCrmGuardianChildPayerDesignationReceipt(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  async prepareMembershipDraft(context: CrmGuardianChildMembershipDraftContext, value: CrmGuardianChildMembershipPreparationInput): Promise<CrmGuardianChildMembershipPreparation> {
    directHuman(context, false);
    let input: CrmGuardianChildMembershipPreparationInput;
    try { input = validateCrmGuardianChildMembershipPreparationInput(value); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await establishDirectHumanGuc(client, context.externalSubject);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_guardian_child_membership_preparation($1,$2::uuid) AS data', [context.externalSubject, input.studentProfileId]);
        if (result.rows.length !== 1) throw new Error('Unverified membership-draft preparation.');
        return verifyCrmGuardianChildMembershipPreparation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  /** Lock-backed current reader: no audit, outbox, idempotency, provider, or financial mutation. */
  async confirmCurrentMembershipDraft(context: CrmGuardianChildMembershipDraftContext, value: CrmGuardianChildMembershipDraftConfirmationInput): Promise<CrmGuardianChildMembershipDraftConfirmation> {
    directHuman(context, false);
    let input: CrmGuardianChildMembershipDraftConfirmationInput;
    try { input = validateCrmGuardianChildMembershipDraftConfirmationInput(value); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        await establishDirectHumanGuc(client, context.externalSubject);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_guardian_child_membership_draft_confirmation($1,$2::uuid) AS data', [context.externalSubject, input.studentProfileId]);
        if (result.rows.length !== 1) throw new Error('Unverified membership-draft current confirmation.');
        return verifyCrmGuardianChildMembershipDraftConfirmation(result.rows[0]!.data);
      });
    } catch (error) { return translate(error); }
  }

  async draftMembership(context: CrmGuardianChildMembershipDraftContext, value: CrmGuardianChildMembershipDraftInput): Promise<{ receipt: CrmGuardianChildMembershipDraftReceipt; replayed: boolean }> {
    directHuman(context, true);
    let input: CrmGuardianChildMembershipDraftInput;
    try { input = validateCrmGuardianChildMembershipDraftInput(value); }
    catch { throw new BadRequestException({ code: INVALID }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0");
        await establishDirectHumanGuc(client, context.externalSubject);
        const result = await client.query<{ data: { receipt: unknown; replayed: boolean } }>('SELECT hon.draft_crm_guardian_child_membership($1,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified membership draft.');
        return { receipt: verifyCrmGuardianChildMembershipDraftReceipt(data.receipt, input), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }
}
