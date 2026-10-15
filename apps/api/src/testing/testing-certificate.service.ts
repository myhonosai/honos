import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CommandContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface TestingCertificateContext extends Omit<CommandContext, 'source'> {
  externalSubject: string;
  source: 'HUMAN_UI';
}

export interface CertificateProjection {
  id: string;
  targetRankId: string;
  targetRankName: string;
  title: string;
  issuedAt: string;
  version: number;
  status: 'ISSUED';
}

export interface TestingCertificateCandidateProjection {
  testingCandidateId: string;
  targetRankId: string;
  candidateVersion: number;
  status: 'ELIGIBLE_TO_ISSUE' | 'ISSUED';
  certificate: CertificateProjection | null;
}

export interface IssueTestingCertificateInput {
  testingCandidateId: string;
  expectedCandidateVersion: number;
  expectedCertificateVersion: number;
  title: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectionKeys = ['candidateVersion', 'certificate', 'status', 'targetRankId', 'testingCandidateId'];
const certificateKeys = ['id', 'issuedAt', 'status', 'targetRankId', 'targetRankName', 'title', 'version'];

function failValidation(detail = 'Known school, candidate, version, and bounded certificate title fields are required.'): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) failValidation(); }
function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value as Record<string, unknown>).sort().join('|') === [...expected].sort().join('|');
}
function positive(value: unknown, allowZero = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 999_999_999) failValidation();
}
function title(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 120 || value.trim() !== value
    || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\[\]{}=`$]/.test(value)
    || /https?:|www\.|\b(javascript|eval|function|script|automatic|automated|guaranteed|guarantee|legal|credential|license|certified)\b/i.test(value)) failValidation('Certificate title is not a safe bounded internal title.');
}
function directHuman(context: TestingCertificateContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'A direct human staff certificate command is required.' });
  }
  for (const value of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) uuid(value);
  if (typeof context.externalSubject !== 'string' || context.externalSubject.length < 1 || context.externalSubject.length > 200) failValidation();
}
function parseCertificate(value: unknown): CertificateProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, certificateKeys)) throw new Error('Unsafe certificate projection.');
  const row = value as Record<string, unknown>;
  uuid(row.id); uuid(row.targetRankId); title(row.targetRankName); title(row.title); positive(row.version);
  if (row.status !== 'ISSUED' || typeof row.issuedAt !== 'string' || !Number.isFinite(Date.parse(row.issuedAt))) throw new Error('Unsafe certificate projection.');
  return { id: row.id, targetRankId: row.targetRankId, targetRankName: row.targetRankName, title: row.title, issuedAt: row.issuedAt, version: row.version, status: 'ISSUED' };
}
function parseProjection(value: unknown, expectedCandidateId: string): TestingCertificateCandidateProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, projectionKeys)) throw new Error('Unsafe certificate projection.');
  const row = value as Record<string, unknown>;
  uuid(row.testingCandidateId); uuid(row.targetRankId); positive(row.candidateVersion);
  if (row.testingCandidateId !== expectedCandidateId || !['ELIGIBLE_TO_ISSUE', 'ISSUED'].includes(String(row.status))) throw new Error('Unsafe certificate projection.');
  if ((row.status === 'ISSUED') !== (row.certificate !== null)) throw new Error('Unsafe certificate projection.');
  const certificate = row.certificate === null ? null : parseCertificate(row.certificate);
  return {
    testingCandidateId: row.testingCandidateId,
    targetRankId: row.targetRankId,
    candidateVersion: row.candidateVersion,
    status: row.status as TestingCertificateCandidateProjection['status'],
    certificate,
  };
}
function databaseError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'TESTING_CERTIFICATE_FORBIDDEN', detail: 'Current direct human staff scope, exact certificate permission, and active entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'TESTING_CERTIFICATE_UNAVAILABLE', detail: 'No eligible certificate record is available for that known testing candidate in the current school.' });
  if (['40001', '40P01', '55P03', '23505', '23514'].includes(code ?? '')) throw new ConflictException({ code: 'TESTING_CERTIFICATE_CONFLICT', detail: 'The candidate, promotion, certificate, or idempotency receipt changed. Refresh and retain the original key only for an unchanged retry.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'TESTING_CERTIFICATE_TIMEOUT', detail: 'No certificate is assumed. Retry the unchanged request with its original key.' });
  if (['22023', '22P02', '22008', '22007'].includes(code ?? '')) failValidation();
  throw new ServiceUnavailableException({ code: 'TESTING_CERTIFICATE_UNAVAILABLE', detail: 'No verified testing certificate result is available.' });
}

@Injectable()
export class TestingCertificateService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: TestingCertificateContext, testingCandidateId: string): Promise<TestingCertificateCandidateProjection> {
    directHuman(context); uuid(testingCandidateId);
    try { return parseProjection(await this.database.readTestingCertificate(context, testingCandidateId), testingCandidateId); }
    catch (error) { return databaseError(error); }
  }

  async issue(context: TestingCertificateContext, input: IssueTestingCertificateInput): Promise<{ certificate: CertificateProjection; replayed: boolean }> {
    directHuman(context);
    if (!input || typeof input !== 'object' || !exactKeys(input, ['testingCandidateId', 'expectedCandidateVersion', 'expectedCertificateVersion', 'title'])) failValidation();
    uuid(input.testingCandidateId); positive(input.expectedCandidateVersion); positive(input.expectedCertificateVersion, true);
    if (input.expectedCertificateVersion !== 0) failValidation('Certificates are immutable creation-only records; expectedCertificateVersion must be zero.');
    title(input.title);
    if (typeof context.idempotencyKey !== 'string' || context.idempotencyKey.length < 1 || context.idempotencyKey.length > 200 || context.idempotencyKey.trim() !== context.idempotencyKey || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) failValidation('A bounded Idempotency-Key is required.');
    try {
      const receipt = await this.database.issueTestingCertificate(context, input.testingCandidateId, {
        expectedCandidateVersion: input.expectedCandidateVersion,
        expectedCertificateVersion: input.expectedCertificateVersion,
        title: input.title,
      });
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !exactKeys(receipt, ['certificate', 'replayed']) || typeof (receipt as Record<string, unknown>).replayed !== 'boolean') throw new Error('Unsafe certificate receipt.');
      return { certificate: parseCertificate((receipt as Record<string, unknown>).certificate), replayed: (receipt as { replayed: boolean }).replayed };
    } catch (error) { return databaseError(error); }
  }
}
