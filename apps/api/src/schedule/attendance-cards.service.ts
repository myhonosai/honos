import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  accountUuid, attendanceCardCheckDigits, validateAttendanceCard, validateAttendanceCardIssueInput, validateAttendanceCardIssueResult,
  validateAttendanceCardRevokeInput, validateAttendanceCardRevokeResult, validateAttendanceCardSettings, validateAttendanceCardSettingsInput,
  validateAttendanceCardSettingsResult, validateAttendanceCardsRead, validateAttendanceCheckInInput, validateAttendanceCheckInResult,
  validateAttendancePhotoConsentInput, validateAttendancePhotoConsentResult, type AttendancePhotoConsentResult,
  type AttendanceCardIssueResult, type AttendanceCardRevokeResult, type AttendanceCardSettingsResult, type AttendanceCardsRead,
  type AttendanceCheckInResult, type AttendanceCommandContext,
} from '@hon/contracts';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { markAttendanceHuman } from './attendance-policy.service.js';

/** A fresh card code: 24 digits from the operating system's secure random source and 2 check digits. */
export function newAttendanceCardCode(): string {
  const body = String(randomInt(0, 1_000_000_000_000)).padStart(12, '0') + String(randomInt(0, 1_000_000_000_000)).padStart(12, '0');
  return body + attendanceCardCheckDigits(body);
}
/** What the database stores and looks up for a code. */
export const attendanceCardDigest = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

const ERRORS: Record<string, (code: string) => HttpException> = {
  ATTENDANCE_CARDS_INVALID: code => new BadRequestException({ code }),
  CHECK_IN_INVALID: () => new BadRequestException({ code: 'ATTENDANCE_CARDS_INVALID' }),
  VALIDATION_FAILED: () => new BadRequestException({ code: 'ATTENDANCE_CARDS_INVALID' }),
  ATTENDANCE_CARD_NOT_FOUND: code => new NotFoundException({ code }),
  ATTENDANCE_CARD_STUDENT_NOT_FOUND: code => new NotFoundException({ code }),
  STUDENT_NOT_FOUND: () => new NotFoundException({ code: 'ATTENDANCE_CARD_STUDENT_NOT_FOUND' }),
  SESSION_NOT_FOUND: () => new NotFoundException({ code: 'ATTENDANCE_SESSION_NOT_FOUND' }),
  VERSION_CONFLICT: () => new ConflictException({ code: 'ATTENDANCE_CARD_VERSION_CONFLICT', outcome: 'NOT_SUBMITTED', detail: 'This changed. Reload and try again.' }),
  IDEMPOTENCY_KEY_REUSED: () => new ConflictException({ code: 'ATTENDANCE_CARD_KEY_REUSED' }),
  ATTENDANCE_CARDS_BUSY: () => new HttpException({ code: 'ATTENDANCE_CARDS_BUSY', outcome: 'NOT_SUBMITTED' }, 503),
  IDEMPOTENCY_IN_PROGRESS: () => new HttpException({ code: 'ATTENDANCE_CARDS_BUSY', outcome: 'NOT_SUBMITTED' }, 503),
  // Two random codes met (practically never): nothing was saved, so the same request may be sent again.
  ATTENDANCE_CARD_CODE_TAKEN: () => new HttpException({ code: 'ATTENDANCE_CARDS_BUSY', outcome: 'NOT_SUBMITTED' }, 503),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'ATTENDANCE_CARDS_FORBIDDEN' });
  if (['22023', '22P02'].includes(sqlState)) throw new BadRequestException({ code: 'ATTENDANCE_CARDS_INVALID' });
  if (['55P03', '40P01'].includes(sqlState)) throw new HttpException({ code: 'ATTENDANCE_CARDS_BUSY', outcome: 'NOT_SUBMITTED' }, 503);
  throw new ServiceUnavailableException({ code: 'ATTENDANCE_CARDS_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });
}
const invalid = () => new BadRequestException({ code: 'ATTENDANCE_CARDS_INVALID' });
const unavailable = () => new ServiceUnavailableException({ code: 'ATTENDANCE_CARDS_UNAVAILABLE', outcome: 'UNKNOWN_OR_RETRY_REQUIRED' });

/**
 * 0394 attendance cards and scan check-in. The subject comes only from the signed HON session. The school the browser
 * names is only a selector: the API resolves the staff member's scope for that school with the needed permission
 * (attendance.cards.manage for cards, attendance.record for a scan) and the database decides it again with live
 * authority. Codes are made here, shown once and never stored; only their SHA-256 digest reaches the database.
 */
@Injectable()
export class AttendanceCardsService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async context(req: HonRequest, schoolId: unknown, permission: string, key: string): Promise<AttendanceCommandContext> {
    const subject = req.honIdentity?.externalSubject;
    if (!subject) throw new ForbiddenException({ code: 'ATTENDANCE_CARDS_FORBIDDEN' });
    let school: string;
    try { school = accountUuid(schoolId).toLowerCase(); } catch { throw invalid(); }
    let scope;
    try { scope = await this.database.resolveAuthorizedScope(subject, school, permission); } catch { throw unavailable(); }
    if (!scope || scope.schoolId.toLowerCase() !== school) throw new ForbiddenException({ code: 'ATTENDANCE_CARDS_FORBIDDEN' });
    const requestId = randomUUID();
    return { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER',
      externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: key, source: 'HUMAN_UI' };
  }
  private async call(context: AttendanceCommandContext, sql: string, args: (string | null)[]): Promise<unknown> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await markAttendanceHuman(client, context);
        const r = await client.query<{ data: unknown }>(sql, args);
        if (r.rows.length !== 1) throw new Error('no result');
        return r.rows[0]!.data;
      });
    } catch (error) { translate(error); }
  }
  private static key(key: unknown): string { try { return accountUuid(key).toLowerCase(); } catch { throw invalid(); } }

  async read(req: HonRequest, schoolId: unknown): Promise<AttendanceCardsRead> {
    const c = await this.context(req, schoolId, 'attendance.cards.manage', '');
    const raw = await this.call(c, 'SELECT hon.read_attendance_cards($1) data', [c.externalSubject]);
    try { return validateAttendanceCardsRead(raw); } catch { throw unavailable(); }
  }

  async configure(req: HonRequest, body: unknown, key: unknown): Promise<AttendanceCardSettingsResult> {
    const k = AttendanceCardsService.key(key);
    let input; try { input = validateAttendanceCardSettingsInput(body); } catch { throw invalid(); }
    const c = await this.context(req, input.schoolId, 'attendance.cards.manage', k);
    const { schoolId: _school, ...settings } = input;
    const raw = await this.call(c, 'SELECT hon.configure_attendance_cards($1,$2::jsonb,$3,$4::uuid,$5::uuid) data',
      [c.externalSubject, JSON.stringify(settings), k, c.requestId, c.correlationId]) as { record?: unknown; replayed?: unknown };
    try { return validateAttendanceCardSettingsResult({ settings: validateAttendanceCardSettings(raw?.record), replayed: raw?.replayed }); } catch { throw unavailable(); }
  }

  /** Prints new cards. A fresh print returns each code once; a replay of a saved print returns the cards without codes. */
  async issue(req: HonRequest, body: unknown, key: unknown): Promise<AttendanceCardIssueResult> {
    const k = AttendanceCardsService.key(key);
    let input; try { input = validateAttendanceCardIssueInput(body); } catch { throw invalid(); }
    const c = await this.context(req, input.schoolId, 'attendance.cards.manage', k);
    const codes = new Map(input.studentProfileIds.map(id => [id, newAttendanceCardCode()]));
    const cards = [...codes].map(([studentProfileId, code]) => ({ studentProfileId, codeDigest: attendanceCardDigest(code), last4: code.slice(-4) }));
    const raw = await this.call(c, 'SELECT hon.issue_attendance_cards($1,$2::jsonb,$3,$4::uuid,$5::uuid) data',
      [c.externalSubject, JSON.stringify({ cards }), k, c.requestId, c.correlationId]) as { record?: { printId?: unknown; cards?: unknown; replaced?: unknown }; replayed?: unknown };
    try {
      const replayed = raw?.replayed, saved = raw?.record?.cards;
      if (typeof replayed !== 'boolean' || !Array.isArray(saved)) throw new Error('shape');
      const out = validateAttendanceCardIssueResult({ printId: raw?.record?.printId, replaced: raw?.record?.replaced, replayed,
        cards: saved.map(s => {
          const { printPhoto, ...rest } = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
          const card = validateAttendanceCard(rest);
          return { ...card, code: replayed ? null : codes.get(card.studentProfileId) ?? 'missing', printPhoto };
        }) });
      const named = new Set(out.cards.map(x => x.studentProfileId));
      if (named.size !== input.studentProfileIds.length || input.studentProfileIds.some(id => !named.has(id))) throw new Error('mismatch');
      return out;
    } catch { throw unavailable(); }
  }

  async revoke(req: HonRequest, body: unknown, key: unknown): Promise<AttendanceCardRevokeResult> {
    const k = AttendanceCardsService.key(key);
    let input; try { input = validateAttendanceCardRevokeInput(body); } catch { throw invalid(); }
    const c = await this.context(req, input.schoolId, 'attendance.cards.manage', k);
    const raw = await this.call(c, 'SELECT hon.revoke_attendance_card($1,$2::jsonb,$3,$4::uuid,$5::uuid) data',
      [c.externalSubject, JSON.stringify({ cardId: input.cardId, expectedVersion: input.expectedVersion }), k, c.requestId, c.correlationId]) as { record?: unknown; replayed?: unknown };
    try {
      const out = validateAttendanceCardRevokeResult({ card: raw?.record, replayed: raw?.replayed });
      if (out.card.cardId !== input.cardId) throw new Error('mismatch');
      return out;
    } catch { throw unavailable(); }
  }

  /** Records that a parent (or the adult student) agreed to the photo on the card, or withdrew. */
  async photoConsent(req: HonRequest, body: unknown, key: unknown): Promise<AttendancePhotoConsentResult> {
    const k = AttendanceCardsService.key(key);
    let input; try { input = validateAttendancePhotoConsentInput(body); } catch { throw invalid(); }
    const c = await this.context(req, input.schoolId, 'attendance.cards.manage', k);
    const raw = await this.call(c, 'SELECT hon.set_student_photo_consent($1,$2::jsonb,$3,$4::uuid,$5::uuid) data',
      [c.externalSubject, JSON.stringify({ studentProfileId: input.studentProfileId, given: input.given, expectedVersion: input.expectedVersion }), k, c.requestId, c.correlationId]) as { record?: Record<string, unknown>; replayed?: unknown };
    try {
      const out = validateAttendancePhotoConsentResult({ ...(raw?.record ?? {}), replayed: raw?.replayed });
      if (out.studentProfileId !== input.studentProfileId) throw new Error('mismatch');
      return out;
    } catch { throw unavailable(); }
  }

  /** One scan at a class session. The code is checked here (wrong digits never reach the database) and only its digest is sent. */
  async checkIn(req: HonRequest, body: unknown, key: unknown): Promise<AttendanceCheckInResult> {
    const k = AttendanceCardsService.key(key);
    let input; try { input = validateAttendanceCheckInInput(body); } catch { throw invalid(); }
    const c = await this.context(req, input.schoolId, 'attendance.record', k);
    const raw = await this.call(c, 'SELECT hon.check_in_with_attendance_card($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data',
      [c.externalSubject, input.sessionId, JSON.stringify({ codeDigest: attendanceCardDigest(input.code), status: input.status }), k, c.requestId, c.correlationId]);
    try { return validateAttendanceCheckInResult(raw); } catch { throw unavailable(); }
  }
}
