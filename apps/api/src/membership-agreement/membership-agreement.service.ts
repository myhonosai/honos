import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  accountUuid, PERSON_PHOTO_MAX_BYTES, validateFamilyMembershipAgreementRead, validateFamilyMembershipAgreementSignInput,
  validateFamilyMembershipAgreementSignResult, validateFamilyPersonPhotoRemoveInput, validateFamilyPersonPhotoResult, validateFamilyPersonPhotoSetInput,
  validateMembershipAgreementDraftInput, validateMembershipAgreementDraftResult, validateMembershipAgreementPublishInput,
  validateMembershipAgreementPublishResult, validateMembershipAgreementRead,
  type AttendanceCommandContext, type FamilyMembershipAgreementRead, type FamilyMembershipAgreementSignResult, type FamilyPersonPhotoResult,
  type MembershipAgreementDraftResult, type MembershipAgreementPublishResult, type MembershipAgreementRead,
  MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS, MEMBERSHIP_AGREEMENT_LINK_TOKEN, validateMembershipAgreementLinkSendInput, validateMembershipAgreementLinkSendResult,
  validateMembershipAgreementLinkSignInput, validateMembershipAgreementLinkView, validateMembershipAgreementSendRead,
  type MembershipAgreementLinkSendResult, type MembershipAgreementLinkSignResult, type MembershipAgreementLinkView, type MembershipAgreementSendRead,
} from '@hon/contracts';
import { configuredPublicOrigin } from '@hon/auth';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { ImageRefused, stripImageMetadata } from '../paper-import/image-metadata.js';
import { markAttendanceHuman } from '../schedule/attendance-policy.service.js';

const FAMILY_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const FAMILY_LIMITS = "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

const bad = (code: string, detail?: string) => new BadRequestException(detail ? { code, detail } : { code });
const conflict = (code: string, detail?: string) => new ConflictException(detail ? { code, outcome: 'NOT_SUBMITTED', detail } : { code, outcome: 'NOT_SUBMITTED' });
const busy = () => new HttpException({ code: 'MEMBERSHIP_AGREEMENT_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
const ERRORS: Record<string, (code: string) => HttpException> = {
  MEMBERSHIP_AGREEMENT_INVALID: code => bad(code),
  MEMBERSHIP_AGREEMENT_FORBIDDEN: code => new ForbiddenException({ code }),
  HUMAN_COMMAND_REQUIRED: () => new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' }),
  FACE_CHECKIN_FORBIDDEN: () => new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' }),
  MEMBERSHIP_AGREEMENT_UNCHANGED: code => bad(code, 'This text is the same as the version parents already sign.'),
  MEMBERSHIP_AGREEMENT_NOT_COVERED: code => bad(code, 'This child has no current membership at the school.'),
  MEMBERSHIP_AGREEMENT_ADULT_SIGNS: code => bad(code, 'A student who is 18 or older signs for themselves.'),
  MEMBERSHIP_AGREEMENT_PHOTO_REQUIRED: code => bad(code, 'Add a photo of this child before turning on face check-in.'),
  MEMBERSHIP_AGREEMENT_IMAGE_REFUSED: code => bad(code),
  MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND: code => new NotFoundException({ code }),
  MEMBERSHIP_AGREEMENT_CHANGED: code => conflict(code, 'The school changed its agreement. Reload it, read it again and sign.'),
  MEMBERSHIP_AGREEMENT_DRAFT_CHANGED: code => conflict(code, 'The draft changed since the preview. Preview it again.'),
  MEMBERSHIP_AGREEMENT_ALREADY_SIGNED: code => conflict(code),
  VERSION_CONFLICT: () => conflict('MEMBERSHIP_AGREEMENT_VERSION_CONFLICT', 'This changed. Reload and try again.'),
  IDEMPOTENCY_KEY_REUSED: () => conflict('MEMBERSHIP_AGREEMENT_KEY_REUSED'),
  MEMBERSHIP_AGREEMENT_BUSY: () => busy(),
  // 0499 signing link.
  MEMBERSHIP_AGREEMENT_NOT_PUBLISHED: code => bad(code, 'Publish the membership agreement before sending it.'),
  MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED: code => bad(code, 'Send the agreement to a guardian of this student\'s family.'),
  MEMBERSHIP_AGREEMENT_NOTHING_TO_SIGN: code => bad(code, 'Every child in this family has already signed the current agreement, or none needs it.'),
  // The face check-in box (0443): the agreement is not signed either when one of these refuses.
  FACE_CHECKIN_CLOSED: code => new ForbiddenException({ code, detail: 'Face check-in is not open yet.' }),
  FACE_CHECKIN_OFF: code => new ForbiddenException({ code, detail: 'Face check-in is off at this school.' }),
  FACE_CHECKIN_FORM_CHANGED: code => conflict(code, 'The face check-in form changed. Reload it, read it again and sign.'),
  FACE_CHECKIN_CONSENT_EXISTS: code => conflict(code),
  FACE_CHECKIN_ADULT_SIGNS: () => bad('MEMBERSHIP_AGREEMENT_ADULT_SIGNS', 'A student who is 18 or older signs for themselves.'),
  FACE_CHECKIN_GUARDIAN_REQUIRED: code => bad(code),
  FACE_CHECKIN_STUDENT_NOT_FOUND: () => new NotFoundException({ code: 'MEMBERSHIP_AGREEMENT_STUDENT_NOT_FOUND' }),
};
export function translateMembershipAgreementError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' });
  if (['22023', '22P02'].includes(sqlState)) throw bad('MEMBERSHIP_AGREEMENT_INVALID');
  if (['55P03', '40P01', '40001'].includes(sqlState)) throw busy();
  throw unavailable();
}
const invalid = () => bad('MEMBERSHIP_AGREEMENT_INVALID');
const unavailable = () => new ServiceUnavailableException({ code: 'MEMBERSHIP_AGREEMENT_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
const forbidden = () => new ForbiddenException({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' });
function subjectOk(subject: unknown): subject is string {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 200 && subject.trim() === subject;
}
function key(k: unknown): string { try { return accountUuid(k).toLowerCase(); } catch { throw invalid(); } }

/** The 0390 photo rules: decoded, at most 400 KB, then stripped of EXIF/XMP/IPTC and text chunks before the database sees it. */
export function familyPhotoClean(mediaType: Parameters<typeof stripImageMetadata>[0], data: string): string {
  const raw = Buffer.from(data, 'base64');
  if (raw.length < 1 || raw.length > PERSON_PHOTO_MAX_BYTES || raw.toString('base64') !== data) throw bad('MEMBERSHIP_AGREEMENT_IMAGE_REFUSED');
  try { return stripImageMetadata(mediaType, raw).toString('base64'); } catch (error) {
    if (error instanceof ImageRefused) throw bad('MEMBERSHIP_AGREEMENT_IMAGE_REFUSED');
    throw error;
  }
}

/**
 * 0463 membership agreement. The subject comes only from the signed HON session. For staff the school in the request is
 * only a selector: the API resolves the staff scope (membership.agreement.manage) and the database decides authority again,
 * live, before and after each write. For parents no school, family or child selector is trusted: their one live family
 * grant decides the tenant, and the database checks every child against that family.
 */
@Injectable()
export class MembershipAgreementService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async staff(req: HonRequest, schoolId: unknown, idempotencyKey: string): Promise<AttendanceCommandContext> {
    const subject = req.honIdentity?.externalSubject;
    if (!subjectOk(subject)) throw forbidden();
    let school: string;
    try { school = accountUuid(schoolId).toLowerCase(); } catch { throw invalid(); }
    let scope;
    try { scope = await this.database.resolveAuthorizedScope(subject, school, 'membership.agreement.manage'); } catch { throw unavailable(); }
    if (!scope || scope.schoolId.toLowerCase() !== school) throw forbidden();
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI' };
  }
  private async staffCall(context: AttendanceCommandContext, sql: string, args: (string | null)[], readOnly = false): Promise<unknown> {
    const work = async (client: PoolClient) => { await markAttendanceHuman(client, context); return one(client, sql, args); };
    try {
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, work) : await this.database.withTenantTransaction(context, work);
    } catch (error) { translateMembershipAgreementError(error); }
  }
  private staffCommand(context: AttendanceCommandContext, fn: string, input: unknown): Promise<unknown> {
    return this.staffCall(context, `SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) data`,
      [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
  }

  async read(req: HonRequest, schoolId: unknown): Promise<MembershipAgreementRead> {
    const c = await this.staff(req, schoolId, '');
    const raw = await this.staffCall(c, 'SELECT hon.read_membership_agreement($1) data', [c.externalSubject], true);
    try { return validateMembershipAgreementRead(raw); } catch { throw unavailable(); }
  }

  async saveDraft(req: HonRequest, body: unknown, k: unknown): Promise<MembershipAgreementDraftResult> {
    const ik = key(k);
    let input; try { input = validateMembershipAgreementDraftInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, ik);
    const { schoolId: _s, ...rest } = input;
    const raw = await this.staffCommand(c, 'save_membership_agreement_draft', rest);
    let out; try { out = validateMembershipAgreementDraftResult(raw); } catch { throw unavailable(); }
    if (out.draft.language !== input.language) throw unavailable();
    return out;
  }

  async publish(req: HonRequest, body: unknown, k: unknown): Promise<MembershipAgreementPublishResult> {
    const ik = key(k);
    let input; try { input = validateMembershipAgreementPublishInput(body); } catch { throw invalid(); }
    const c = await this.staff(req, input.schoolId, ik);
    const { schoolId: _s, ...rest } = input;
    const raw = await this.staffCommand(c, 'publish_membership_agreement', rest);
    let out; try { out = validateMembershipAgreementPublishResult(raw); } catch { throw unavailable(); }
    const asked = [...input.drafts.map(d => d.language)].sort().join(), got = [...out.texts.map(t => t.language)].sort().join();
    if (asked !== got || out.number !== input.expectedNumber + 1) throw unavailable();
    return out;
  }

  // ---------- 0499 signing link (staff) ----------
  /** Who can receive a link for this student's family (the student named by their person id), and the family's latest link. */
  async sendRead(req: HonRequest, schoolId: unknown, personId: unknown): Promise<MembershipAgreementSendRead> {
    let student: string; try { student = accountUuid(personId).toLowerCase(); } catch { throw invalid(); }
    const c = await this.staff(req, schoolId, '');
    const raw = await this.staffCall(c, 'SELECT hon.read_membership_agreement_send($1,$2::jsonb) data', [c.externalSubject, JSON.stringify({ personId: student })], true);
    try { return validateMembershipAgreementSendRead(raw); } catch { throw unavailable(); }
  }

  /**
   * Make a new one-time link and queue it by email and/or text. The link's origin is this server's configured web origin, never
   * the browser's; the database queues only channels the guardian opted in to and has an address for. Nothing here delivers:
   * the existing communication workers and their gates do.
   */
  async sendLink(req: HonRequest, body: unknown, k: unknown): Promise<MembershipAgreementLinkSendResult> {
    const ik = key(k);
    let input; try { input = validateMembershipAgreementLinkSendInput(body); } catch { throw invalid(); }
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { origin = undefined; }
    if (!origin) throw new ServiceUnavailableException({ code: 'MEMBERSHIP_AGREEMENT_LINK_ORIGIN_NOT_CONFIGURED', outcome: 'NOT_SUBMITTED' });
    const c = await this.staff(req, input.schoolId, ik);
    const { schoolId: _s, ...rest } = input;
    const raw = await this.staffCall(c, 'SELECT hon.send_membership_agreement_link($1,$2::jsonb,$3,$4,$5::uuid,$6::uuid) data',
      [c.externalSubject, JSON.stringify(rest), new URL(origin).origin, c.idempotencyKey, c.requestId, c.correlationId]);
    let out; try { out = validateMembershipAgreementLinkSendResult(raw); } catch { throw unavailable(); }
    const asked = [...input.channels].sort().join(), got = out.deliveries.map(d => d.channel).sort().join();
    if (asked !== got || out.link.recipientPersonId !== input.recipientPersonId) throw unavailable();
    return out;
  }

  // ---------- 0499 signing link (public: the token is the only key) ----------
  /** Null for an unknown or malformed token. Never propagates database text. */
  async linkRead(token: unknown): Promise<MembershipAgreementLinkView | null> {
    if (typeof token !== 'string' || !MEMBERSHIP_AGREEMENT_LINK_TOKEN.test(token)) return null;
    let data: unknown;
    try { data = await this.database.readMembershipAgreementLink(token); } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
    if (data === null) return null;
    try { return validateMembershipAgreementLinkView(data); } catch { throw new ServiceUnavailableException({ result: 'UNAVAILABLE' }); }
  }

  async linkSign(token: unknown, body: unknown): Promise<MembershipAgreementLinkSignResult | 'UNAVAILABLE'> {
    if (typeof token !== 'string' || !MEMBERSHIP_AGREEMENT_LINK_TOKEN.test(token)) return 'GONE';
    let input; try { input = validateMembershipAgreementLinkSignInput(body); } catch { return 'INVALID'; }
    try {
      const result = await this.database.signMembershipAgreementLink(token, input, randomUUID());
      return (MEMBERSHIP_AGREEMENT_LINK_SIGN_RESULTS as readonly string[]).includes(result) ? result as MembershipAgreementLinkSignResult : 'UNAVAILABLE';
    } catch { return 'UNAVAILABLE'; }
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

  async familyRead(subject: unknown): Promise<FamilyMembershipAgreementRead> {
    const f = await this.family(subject);
    let raw: unknown;
    try {
      raw = await this.database.withTenantReadOnlyTransaction(this.familyContext(f.scope), async client => {
        await client.query(FAMILY_LIMITS);
        await client.query(FAMILY_SETTINGS, [f.subject]);
        return one(client, 'SELECT hon.read_family_membership_agreement($1) data', [f.subject]);
      });
    } catch (error) { translateMembershipAgreementError(error); }
    try { return validateFamilyMembershipAgreementRead(raw); } catch { throw unavailable(); }
  }

  /** One signing for every listed child, plus a face consent for each ticked child: all saved together or nothing. */
  async familySign(subject: unknown, body: unknown, k: unknown): Promise<FamilyMembershipAgreementSignResult> {
    const ik = key(k);
    let input; try { input = validateFamilyMembershipAgreementSignInput(body); } catch { throw invalid(); }
    const raw = await this.familyWrite(subject, ik, 'sign_family_membership_agreement', input);
    let out; try { out = validateFamilyMembershipAgreementSignResult(raw); } catch { throw unavailable(); }
    const asked = [...input.studentProfileIds].sort().join(), got = out.children.map(c => c.studentProfileId).sort().join();
    const faces = [...input.faceOptIns.map(f => f.studentProfileId)].sort().join(), gotFaces = out.children.filter(c => c.faceConsent).map(c => c.studentProfileId).sort().join();
    if (out.versionId !== input.versionId || out.language !== input.language || out.digest !== input.digest || asked !== got || faces !== gotFaces) throw unavailable();
    return out;
  }

  async familyPhotoSet(subject: unknown, body: unknown, k: unknown): Promise<FamilyPersonPhotoResult> {
    const ik = key(k);
    let input; try { input = validateFamilyPersonPhotoSetInput(body); } catch { throw invalid(); }
    const data = familyPhotoClean(input.mediaType, input.data);
    const raw = await this.familyWrite(subject, ik, 'set_family_child_photo', { ...input, data });
    let out; try { out = validateFamilyPersonPhotoResult(raw); } catch { throw unavailable(); }
    if (out.studentProfileId !== input.studentProfileId || !out.photo) throw unavailable();
    return out;
  }

  async familyPhotoRemove(subject: unknown, body: unknown, k: unknown): Promise<FamilyPersonPhotoResult> {
    const ik = key(k);
    let input; try { input = validateFamilyPersonPhotoRemoveInput(body); } catch { throw invalid(); }
    const raw = await this.familyWrite(subject, ik, 'remove_family_child_photo', input);
    let out; try { out = validateFamilyPersonPhotoResult(raw); } catch { throw unavailable(); }
    if (out.studentProfileId !== input.studentProfileId || out.photo) throw unavailable();
    return out;
  }

  private async familyWrite(subject: unknown, ik: string, fn: string, input: unknown): Promise<unknown> {
    const f = await this.family(subject);
    const context = this.familyContext(f.scope);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(FAMILY_LIMITS);
        await client.query(FAMILY_SETTINGS, [f.subject]);
        return one(client, `SELECT hon.${fn}($1,$2::jsonb,$3,$4::uuid,$5::uuid) data`, [f.subject, JSON.stringify(input), ik, context.requestId, context.requestId]);
      });
    } catch (error) { translateMembershipAgreementError(error); }
  }
}

async function one(client: PoolClient, sql: string, args: unknown[]): Promise<unknown> {
  const r = await client.query<{ data: unknown }>(sql, args);
  if (r.rows.length !== 1) throw new Error('no result');
  return r.rows[0]!.data;
}
