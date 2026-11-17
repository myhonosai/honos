import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  accountUuid, PERSON_PHOTO_MAX_BYTES, validateFaceCheckInConfirmInput, validateFaceCheckInConfirmResult, validateFaceCheckInConsentInput,
  validateFaceCheckInConsentResult, validateFaceCheckInEnrollInput, validateFaceCheckInEnrollResult, validateFaceCheckInMatchInput,
  validateFaceCheckInMatchResult, validateFaceCheckInRead, validateFaceCheckInSettingsInput, validateFaceCheckInSettingsResult,
  validateFaceCheckInWithdrawInput, validateFamilyFaceCheckInRead, validateFamilyFaceCheckInSignInput, validateFamilyFaceCheckInWithdrawInput,
  type AttendanceCommandContext, type FaceCheckInConfirmResult, type FaceCheckInConsentResult, type FaceCheckInEnrollResult,
  type FaceCheckInMatchResult, type FaceCheckInRead, type FaceCheckInSettingsResult, type FamilyFaceCheckInRead,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { ImageRefused, stripImageMetadata } from '../paper-import/image-metadata.js';
import { markAttendanceHuman } from '../schedule/attendance-policy.service.js';

const FAMILY_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const FAMILY_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const bad = (code: string) => new BadRequestException({ code });
const conflict = (code: string, detail?: string) => new ConflictException(detail ? { code, outcome: 'NOT_SUBMITTED', detail } : { code, outcome: 'NOT_SUBMITTED' });
const ERRORS: Record<string, (code: string) => HttpException> = {
  FACE_CHECKIN_INVALID: bad,
  CHECK_IN_INVALID: () => bad('FACE_CHECKIN_INVALID'),
  FACE_CHECKIN_LOCATION_REQUIRED: code => new BadRequestException({ code, detail: 'Add the school address before turning face check-in on.' }),
  FACE_CHECKIN_CITY_LIMITS_REQUIRED: code => new BadRequestException({ code, detail: 'Answer whether the school is inside the city limits.' }),
  FACE_CHECKIN_ACKNOWLEDGEMENTS_REQUIRED: code => new BadRequestException({ code, detail: 'Confirm every step this location requires.' }),
  FACE_CHECKIN_GUARDIAN_REQUIRED: code => new BadRequestException({ code, detail: 'A parent or guardian must sign for a student under 18.' }),
  FACE_CHECKIN_ADULT_SIGNS: code => new BadRequestException({ code, detail: 'A student who is 18 or older signs for themselves.' }),
  FACE_CHECKIN_STUDENT_NOT_ACTIVE: code => new BadRequestException({ code }),
  FACE_CHECKIN_PHOTO_REQUIRED: code => new BadRequestException({ code, detail: 'Add a profile photo first.' }),
  FACE_CHECKIN_FORBIDDEN: code => new ForbiddenException({ code }),
  HUMAN_COMMAND_REQUIRED: () => new ForbiddenException({ code: 'FACE_CHECKIN_FORBIDDEN' }),
  ATTENDANCE_FORBIDDEN: () => new ForbiddenException({ code: 'FACE_CHECKIN_FORBIDDEN' }),
  FACE_CHECKIN_CLOSED: code => new ForbiddenException({ code, detail: 'Face check-in is not open yet.' }),
  FACE_CHECKIN_OFF: code => new ForbiddenException({ code, detail: 'Face check-in is off at this school.' }),
  FACE_CHECKIN_NOT_AVAILABLE: code => new ForbiddenException({ code, detail: 'Face check-in is not available at this location.' }),
  FACE_CHECKIN_CONSENT_REQUIRED: code => new ForbiddenException({ code, detail: 'A current signed consent is needed first.' }),
  FACE_CHECKIN_STUDENT_NOT_FOUND: code => new NotFoundException({ code }),
  STUDENT_NOT_FOUND: () => new NotFoundException({ code: 'FACE_CHECKIN_STUDENT_NOT_FOUND' }),
  FACE_CHECKIN_CONSENT_NOT_FOUND: code => new NotFoundException({ code }),
  FACE_CHECKIN_MATCH_NOT_FOUND: code => new NotFoundException({ code }),
  SESSION_NOT_FOUND: () => new NotFoundException({ code: 'FACE_CHECKIN_SESSION_NOT_FOUND' }),
  FACE_CHECKIN_ALREADY_ON: code => conflict(code),
  FACE_CHECKIN_ALREADY_OFF: code => conflict(code),
  FACE_CHECKIN_CONSENT_EXISTS: code => conflict(code),
  FACE_CHECKIN_FORM_CHANGED: code => conflict(code, 'The form changed. Reload it, read it again and sign.'),
  VERSION_CONFLICT: () => conflict('FACE_CHECKIN_VERSION_CONFLICT', 'This changed. Reload and try again.'),
  IDEMPOTENCY_KEY_REUSED: () => conflict('FACE_CHECKIN_KEY_REUSED'),
  FACE_TEMPLATE_DUPLICATE: code => conflict(code, 'This photo is already used by another student.'),
  FACE_CHECKIN_BUSY: () => new HttpException({ code: 'FACE_CHECKIN_BUSY', outcome: 'NOT_SUBMITTED' }, 503),
};
export function translateFaceCheckInError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'FACE_CHECKIN_FORBIDDEN' });
  if (['22023', '22P02'].includes(sqlState)) throw bad('FACE_CHECKIN_INVALID');
  if (['55P03', '40P01', '40001'].includes(sqlState)) throw new HttpException({ code: 'FACE_CHECKIN_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
  throw unavailable();
}
const invalid = () => bad('FACE_CHECKIN_INVALID');
const unavailable = () => new ServiceUnavailableException({ code: 'FACE_CHECKIN_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
const forbidden = () => new ForbiddenException({ code: 'FACE_CHECKIN_FORBIDDEN' });
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function key(k: unknown): string { try { return accountUuid(k).toLowerCase(); } catch { throw invalid(); } }

/**
 * The SHA-256 of the metadata-stripped camera picture: the only thing the synthetic matcher (0434) ever sees. The picture
 * itself is never stored, logged or sent anywhere. Wrong-type or malformed pictures are refused before the database.
 */
export function faceCheckInPictureDigest(mediaType: Parameters<typeof stripImageMetadata>[0], data: string): string {
  const raw = Buffer.from(data, 'base64');
  if (raw.length < 1 || raw.length > PERSON_PHOTO_MAX_BYTES || raw.toString('base64') !== data) throw bad('FACE_CHECKIN_IMAGE_REFUSED');
  let clean: Buffer;
  try { clean = stripImageMetadata(mediaType, raw); } catch (error) {
    if (error instanceof ImageRefused) throw bad('FACE_CHECKIN_IMAGE_REFUSED');
    throw error;
  }
  return createHash('sha256').update(clean).digest('hex');
}

/**
 * 0434 face check-in. The subject comes only from the signed HON session. For staff the school in the request is only a
 * selector: the API resolves the staff scope for that school (face_checkin.manage to manage, attendance.record to scan)
 * and the database decides authority again, live, before and after each write. For parents no school, family or child
 * selector is trusted: their one live family grant decides the tenant. No real face provider is called: the matcher is
 * synthetic and test-only, and the program stays CLOSED until the owner opens it.
 */
@Injectable()
export class FaceCheckInService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async staff(req: HonRequest, schoolId: unknown, permission: string, idempotencyKey: string): Promise<AttendanceCommandContext> {
    const subject = req.honIdentity?.externalSubject;
    if (!subjectOk(subject)) throw forbidden();
    let school: string;
    try { school = accountUuid(schoolId).toLowerCase(); } catch { throw invalid(); }
    let scope;
    try { scope = await this.database.resolveAuthorizedScope(subject, school, permission); } catch { throw unavailable(); }
    if (!scope || scope.schoolId.toLowerCase() !== school) throw forbidden();
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
  }
  private async call(context: AttendanceCommandContext, sql: string, args: (string | null)[]): Promise<unknown> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        return one(client, sql, args);
      });
    } catch (error) { translateFaceCheckInError(error); }
  }
  private command(context: AttendanceCommandContext, fn: string, input: unknown): Promise<unknown> {
    return this.call(context, `SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) data`,
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
  }

  /** Staff read. It runs the retention sweep (deletes stale templates), so it is a read-write transaction. */
  async read(req: HonRequest, schoolId: unknown): Promise<FaceCheckInRead> {
    const c = await this.staff(req, schoolId, 'face_checkin.manage', '');
    const raw = await this.call(c, 'SELECT hon.read_face_checkin($1) data', [c.externalSubject]);
    try { return validateFaceCheckInRead(raw); } catch { throw unavailable(); }
  }

  async saveSettings(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInSettingsResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInSettingsInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, 'face_checkin.manage', ik);
    const { schoolId: _s, ...rest } = input;
    const raw = await this.command(c, 'save_face_checkin_settings', rest);
    try { return validateFaceCheckInSettingsResult(raw); } catch { throw unavailable(); }
  }

  /** A consent signed on paper or a tablet at the desk; the staff member attests they saw the signer. */
  async recordConsent(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInConsentResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInConsentInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, 'face_checkin.manage', ik);
    const { schoolId: _s, ...rest } = input;
    const raw = await this.command(c, 'record_face_checkin_consent', rest);
    let out; try { out = validateFaceCheckInConsentResult(raw); } catch { throw unavailable(); }
    if (out.studentProfileId !== input.studentProfileId) throw unavailable();
    return out;
  }

  async withdrawConsent(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInConsentResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInWithdrawInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, 'face_checkin.manage', ik);
    const raw = await this.command(c, 'withdraw_face_checkin_consent', { consentId: input.consentId, expectedVersion: input.expectedVersion });
    let out; try { out = validateFaceCheckInConsentResult(raw); } catch { throw unavailable(); }
    if (out.consent.consentId !== input.consentId) throw unavailable();
    return out;
  }

  async enroll(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInEnrollResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInEnrollInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, 'face_checkin.manage', ik);
    const raw = await this.command(c, 'enroll_face_checkin_student', { studentProfileId: input.studentProfileId });
    let out; try { out = validateFaceCheckInEnrollResult(raw); } catch { throw unavailable(); }
    if (out.studentProfileId !== input.studentProfileId) throw unavailable();
    return out;
  }

  /** One camera picture: stripped and hashed here, then discarded. Only the digest reaches the database, which proposes at most one student. */
  async match(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInMatchResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInMatchInput(body); } catch { throw invalid(); }
    const pictureDigest = faceCheckInPictureDigest(input.mediaType, input.data);
    const c = await this.staff(req, input.schoolId, 'attendance.record', ik);
    const raw = await this.call(c, 'SELECT hon.match_face_checkin($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data',
      [c.externalSubject, input.sessionId, JSON.stringify({ pictureDigest }), ik, c.requestId, c.correlationId]);
    let out; try { out = validateFaceCheckInMatchResult(raw); } catch { throw unavailable(); }
    if (out.sessionId !== input.sessionId) throw unavailable();
    return out;
  }

  /** Staff confirm or reject a proposal. Nothing is recorded unless a person accepts it. */
  async confirm(req: HonRequest, body: unknown, k: unknown): Promise<FaceCheckInConfirmResult> {
    const ik = key(k);
    let input; try { input = validateFaceCheckInConfirmInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, 'attendance.record', ik);
    const raw = await this.command(c, 'confirm_face_checkin_match', { matchId: input.matchId, accept: input.accept, status: input.status });
    let out; try { out = validateFaceCheckInConfirmResult(raw); } catch { throw unavailable(); }
    if (out.matchId !== input.matchId || (out.outcome === 'CONFIRMED' && !input.accept) || (out.outcome === 'REJECTED' && input.accept)) throw unavailable();
    return out;
  }

  // ---------- parent portal ----------
  private async family(subject: unknown): Promise<{ subject: string; scope: ResolvedParentFamilyScope }> {
    if (!subjectOk(subject)) throw forbidden();
    let scopes;
    try { scopes = await this.database.resolveParentJourneyScopes(subject); } catch { throw unavailable(); }
    if (scopes.length !== 1) throw forbidden();
    return { subject, scope: scopes[0]! };
  }
  private familyContext(scope: ResolvedParentFamilyScope) {
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
  }

  async familyRead(subject: unknown): Promise<FamilyFaceCheckInRead> {
    const f = await this.family(subject);
    let raw: unknown;
    try {
      raw = await this.database.withTenantReadOnlyTransaction(this.familyContext(f.scope), async client => {
        await client.query(FAMILY_LIMITS);
        await client.query(FAMILY_SETTINGS, [f.subject]);
        return one(client, 'SELECT hon.read_family_face_checkin($1) data', [f.subject]);
      });
    } catch (error) { translateFaceCheckInError(error); }
    try { return validateFamilyFaceCheckInRead(raw); } catch { throw unavailable(); }
  }

  async familySign(subject: unknown, body: unknown, k: unknown): Promise<FaceCheckInConsentResult> {
    const ik = key(k);
    let input; try { input = validateFamilyFaceCheckInSignInput(body); } catch { throw invalid(); }
    const out = await this.familyWrite(subject, ik, 'sign_family_face_checkin_consent', input);
    if (out.studentProfileId !== input.studentProfileId) throw unavailable();
    return out;
  }

  async familyWithdraw(subject: unknown, body: unknown, k: unknown): Promise<FaceCheckInConsentResult> {
    const ik = key(k);
    let input; try { input = validateFamilyFaceCheckInWithdrawInput(body); } catch { throw invalid(); }
    const out = await this.familyWrite(subject, ik, 'withdraw_family_face_checkin_consent', input);
    if (out.consent.consentId !== input.consentId) throw unavailable();
    return out;
  }

  private async familyWrite(subject: unknown, ik: string, fn: string, input: unknown): Promise<FaceCheckInConsentResult> {
    const f = await this.family(subject);
    const context = this.familyContext(f.scope);
    let raw: unknown;
    try {
      raw = await this.database.withTenantTransaction(context, async client => {
        await client.query(FAMILY_LIMITS);
        await client.query(FAMILY_SETTINGS, [f.subject]);
        return one(client, `SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) data`, [f.subject, JSON.stringify(input), ik, context.requestId, context.requestId]);
      });
    } catch (error) { translateFaceCheckInError(error); }
    try { return validateFaceCheckInConsentResult(raw); } catch { throw unavailable(); }
  }
}

async function one(client: PoolClient, sql: string, args: unknown[]): Promise<unknown> {
  const r = await client.query<{ data: unknown }>(sql, args);
  if (r.rows.length !== 1) throw new Error('no result');
  return r.rows[0]!.data;
}
