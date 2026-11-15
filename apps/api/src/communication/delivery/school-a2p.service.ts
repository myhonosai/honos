import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  A2P_FACT_CONFIRMATION, validateA2pDraftInput, validateSchoolA2pRegistrationRequest, verifySchoolA2pRegistration, verifySchoolA2pRegistrationList,
  type SchoolA2pRegistration,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { A2pPreparationService } from '../../a2p/a2p-preparation.service.js';
import type { SchoolNumberContext } from './school-number.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SET LOCAL log_parameter_max_length_on_error=0";
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const ERRORS: Record<string, [string[], (code: string) => HttpException]> = {
  SENDER_MANAGE_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Only a school owner with an active HON plan can register the school for texting.' })],
  A2P_OWNER_REQUIRED: [['42501'], code => new ForbiddenException({ code, detail: 'Only a current school owner can confirm these facts.' })],
  INVALID_A2P_REGISTRATION: [['22023'], code => new BadRequestException({ code })],
  IDEMPOTENCY_KEY_REUSED: [['22023'], code => new ConflictException({ code, detail: 'This key was already used for a different registration.' })],
  A2P_ALREADY_APPROVED: [['55000'], code => new ConflictException({ code, detail: 'This school is already registered for texting.' })],
  A2P_REGISTRATION_OPEN: [['55000'], code => new ConflictException({ code, detail: 'This school already has a registration in progress.' })],
  A2P_REGISTRATION_NOT_CANCELLABLE: [['55000'], code => new ConflictException({ code, detail: 'HON has already started submitting this registration.' })],
  A2P_REGISTRATION_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'The registration changed. Reload and try again.' })],
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '', message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && known[0].includes(sqlState)) throw known[1](message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SENDER_MANAGE_FORBIDDEN' });
  if (['22023', '22P02', '22003'].includes(sqlState)) throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' });
  throw new ServiceUnavailableException({ code: 'A2P_REGISTRATION_UNAVAILABLE', detail: 'Nothing was submitted. Reload, or retry with the same key.' });
}

/** The parts of the 0190 draft Twilio needs, nothing about the engine's own read-only flags. */
function frozenDraft(draft: { engineVersion: string; answers: unknown; sampleMessages: unknown; helpResponseSample: unknown; stopResponseSample: unknown;
  warnings: unknown; copyPreparationAvailable: boolean }) {
  return { engineVersion: draft.engineVersion, answers: draft.answers, sampleMessages: draft.sampleMessages, helpResponseSample: draft.helpResponseSample,
    stopResponseSample: draft.stopResponseSample, warnings: draft.warnings, copyPreparationAvailable: draft.copyPreparationAvailable };
}

/**
 * T3a (0379): the school owner submits the A2P draft they confirmed, with the business facts for the brand. The API
 * regenerates the draft with the 0190 engine from the exact input, refuses it if the digest the owner saw no longer
 * matches or the draft is incomplete, and the database re-proves a live OWNER with communication.sender.manage and an
 * active plan. Submitting sends nothing to Twilio: a human HQ owner approves first, and the worker needs its switch.
 */
@Injectable()
export class SchoolA2pService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly preparation: A2pPreparationService) {}

  async request(context: SchoolNumberContext, body: unknown): Promise<SchoolA2pRegistration> {
    this.assertHuman(context, true);
    let input;
    try { input = validateSchoolA2pRegistrationRequest(body); } catch { throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' }); }
    if (!KEY.test(context.idempotencyKey)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    let draftInput;
    try { draftInput = validateA2pDraftInput(input.draftInput); } catch { throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' }); }
    if (draftInput.ownerConfirmation !== A2P_FACT_CONFIRMATION) throw new BadRequestException({ code: 'A2P_OWNER_CONFIRMATION_REQUIRED' });
    const generated = await this.preparation.draft(context.externalSubject, context.organizationId, context.schoolId, input.draftInput);
    if (generated.computationDigest !== input.expectedDigest) throw new ConflictException({ code: 'A2P_DRAFT_CHANGED', detail: 'The draft changed. Review it again.' });
    if (!generated.draft.copyPreparationAvailable || !generated.draft.answers) throw new ConflictException({ code: 'A2P_DRAFT_INCOMPLETE' });
    const payload = { brandType: input.brandType, draftInput, draft: frozenDraft(generated.draft), draftDigest: generated.computationDigest, business: input.business };
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: unknown }>('SELECT hon.request_school_a2p_registration($1,$2::jsonb,$3) AS data',
          [context.externalSubject, JSON.stringify(payload), context.idempotencyKey])).rows[0]?.data;
        const registration = verifySchoolA2pRegistration(data);
        if (registration.schoolId !== context.schoolId || registration.draftDigest !== generated.computationDigest) throw new Error('Unverified school A2P registration.');
        return registration;
      });
    } catch (error) { return translate(error); }
  }

  async list(context: SchoolNumberContext): Promise<SchoolA2pRegistration[]> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: { registrations?: unknown } }>('SELECT hon.read_school_a2p_registrations($1) AS data', [context.externalSubject])).rows[0]?.data;
        if (!data || Object.keys(data).join(',') !== 'registrations') throw new Error('Unverified school A2P registration list.');
        return verifySchoolA2pRegistrationList(data.registrations);
      });
    } catch (error) { return translate(error); }
  }

  async cancel(context: SchoolNumberContext, registrationId: string, body: unknown): Promise<SchoolA2pRegistration> {
    this.assertHuman(context, true);
    const input = body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'expectedVersion'
      || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) throw new BadRequestException({ code: 'INVALID_A2P_REGISTRATION' });
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS); await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const data = (await client.query<{ data: unknown }>('SELECT hon.cancel_school_a2p_registration($1,$2::uuid,$3::integer) AS data',
          [context.externalSubject, registrationId, input.expectedVersion])).rows[0]?.data;
        const registration = verifySchoolA2pRegistration(data);
        if (registration.registrationId.toLowerCase() !== registrationId.toLowerCase()) throw new Error('Unverified school A2P registration.');
        return registration;
      });
    } catch (error) { return translate(error); }
  }

  private assertHuman(context: SchoolNumberContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 128 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SENDER_MANAGE_FORBIDDEN' });
  }
}
