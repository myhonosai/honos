import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { CommandContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export type TestingScorecardAssessment = 'OBSERVED' | 'NOT_OBSERVED' | 'NEEDS_FOLLOW_UP';

export interface TestingScorecardContext extends Omit<CommandContext, 'source'> {
  externalSubject: string;
  source: 'HUMAN_UI';
}

export interface TestingScorecardEvaluation {
  id: string;
  criterionCode: string;
  assessment: TestingScorecardAssessment;
  recordedAt: string;
  version: number;
  recordedByYou: boolean;
}

export interface TestingScorecardView {
  testingCandidateId: string;
  testingEventId: string;
  candidateVersion: number;
  testingEventVersion: number;
  scorecardId: string | null;
  scorecardVersion: number;
  evaluations: TestingScorecardEvaluation[];
  evaluationsLimited: boolean;
}

export interface RecordTestingScorecardEvaluationInput {
  testingCandidateId: string;
  testingEventId: string;
  criterionCode: string;
  assessment: TestingScorecardAssessment;
  expectedCandidateVersion: number;
  expectedTestingEventVersion: number;
  expectedScorecardVersion: number;
}

export interface TestingScorecardReceipt {
  scorecardId: string;
  scorecardVersion: number;
  evaluation: TestingScorecardEvaluation;
  replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRITERION = /^[A-Z][A-Z0-9_.-]{0,63}$/;
const ASSESSMENTS: TestingScorecardAssessment[] = ['OBSERVED', 'NOT_OBSERVED', 'NEEDS_FOLLOW_UP'];
const evaluationKeys = ['assessment', 'criterionCode', 'id', 'recordedAt', 'recordedByYou', 'version'];
const viewKeys = ['candidateVersion', 'evaluations', 'evaluationsLimited', 'scorecardId', 'scorecardVersion', 'testingCandidateId', 'testingEventId', 'testingEventVersion'];
const receiptKeys = ['evaluation', 'scorecardId', 'scorecardVersion'];

function failValidation(detail = 'Known school, candidate, event, bounded criterion, assessment, and current versions are required.'): never {
  throw new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) failValidation(); }
function positive(value: unknown, allowZero = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 999_999_999) failValidation();
}
function exactKeys(value: object, expected: string[]): boolean {
  return Object.keys(value as Record<string, unknown>).sort().join('|') === [...expected].sort().join('|');
}
function criterion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CRITERION.test(value)) failValidation('criterionCode must be an uppercase bounded code.');
}
function assessment(value: unknown): asserts value is TestingScorecardAssessment {
  if (typeof value !== 'string' || !ASSESSMENTS.includes(value as TestingScorecardAssessment)) failValidation('assessment must be OBSERVED, NOT_OBSERVED, or NEEDS_FOLLOW_UP.');
}
function directHuman(context: TestingScorecardContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'A direct human staff scorecard command is required.' });
  }
  for (const value of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) uuid(value);
  if (typeof context.externalSubject !== 'string' || context.externalSubject.length < 1 || context.externalSubject.length > 200) failValidation();
}
function parseEvaluation(value: unknown): TestingScorecardEvaluation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, evaluationKeys)) throw new Error('Unsafe scorecard evaluation projection.');
  const row = value as Record<string, unknown>;
  uuid(row.id); criterion(row.criterionCode); assessment(row.assessment); positive(row.version);
  if (typeof row.recordedAt !== 'string' || !Number.isFinite(Date.parse(row.recordedAt)) || typeof row.recordedByYou !== 'boolean') {
    throw new Error('Unsafe scorecard evaluation projection.');
  }
  return { id: row.id, criterionCode: row.criterionCode, assessment: row.assessment, recordedAt: row.recordedAt, version: row.version, recordedByYou: row.recordedByYou };
}
function parseView(value: unknown, candidateId: string, eventId: string): TestingScorecardView {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, viewKeys)) throw new Error('Unsafe scorecard projection.');
  const row = value as Record<string, unknown>;
  uuid(row.testingCandidateId); uuid(row.testingEventId); positive(row.candidateVersion); positive(row.testingEventVersion); positive(row.scorecardVersion, true);
  if (row.testingCandidateId !== candidateId || row.testingEventId !== eventId || typeof row.evaluationsLimited !== 'boolean' || !Array.isArray(row.evaluations) || row.evaluations.length > 100) throw new Error('Unsafe scorecard projection.');
  if (row.scorecardId === null ? row.scorecardVersion !== 0 || row.evaluations.length !== 0 : !UUID.test(String(row.scorecardId))) throw new Error('Unsafe scorecard projection.');
  const evaluations = row.evaluations.map(parseEvaluation);
  if (evaluations.some(item => item.version !== 1)) throw new Error('Unsafe scorecard projection.');
  return {
    testingCandidateId: row.testingCandidateId,
    testingEventId: row.testingEventId,
    candidateVersion: row.candidateVersion,
    testingEventVersion: row.testingEventVersion,
    scorecardId: row.scorecardId as string | null,
    scorecardVersion: row.scorecardVersion,
    evaluations,
    evaluationsLimited: row.evaluationsLimited,
  };
}
function parseReceipt(value: unknown): Omit<TestingScorecardReceipt, 'replayed'> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, receiptKeys)) throw new Error('Unsafe scorecard receipt.');
  const row = value as Record<string, unknown>;
  uuid(row.scorecardId); positive(row.scorecardVersion);
  return { scorecardId: row.scorecardId, scorecardVersion: row.scorecardVersion, evaluation: parseEvaluation(row.evaluation) };
}
function databaseError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'TESTING_SCORECARD_FORBIDDEN', detail: 'Current direct human staff scope, exact scorecard permission, and active entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'TESTING_SCORECARD_UNAVAILABLE', detail: 'That known candidate and testing event are not available together in the current school.' });
  if (['40001', '40P01', '55P03', '23505', '23514'].includes(code ?? '')) throw new ConflictException({ code: 'TESTING_SCORECARD_CONFLICT', detail: 'The candidate, testing event, scorecard, criterion, or retry key changed. Reload before recording another independent observation.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'TESTING_SCORECARD_TIMEOUT', detail: 'No evaluation is assumed. Retry the unchanged request with its original key.' });
  if (['22023', '22P02', '22008', '22007'].includes(code ?? '')) failValidation();
  throw new ServiceUnavailableException({ code: 'TESTING_SCORECARD_UNAVAILABLE', detail: 'No verified testing scorecard result is available.' });
}

@Injectable()
export class TestingScorecardService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: TestingScorecardContext, testingCandidateId: string, testingEventId: string): Promise<TestingScorecardView> {
    directHuman(context); uuid(testingCandidateId); uuid(testingEventId);
    try { return parseView(await this.database.readTestingScorecard(context, testingCandidateId, testingEventId), testingCandidateId, testingEventId); }
    catch (error) { return databaseError(error); }
  }

  async record(context: TestingScorecardContext, input: RecordTestingScorecardEvaluationInput): Promise<TestingScorecardReceipt> {
    directHuman(context);
    if (!input || typeof input !== 'object' || !exactKeys(input, ['testingCandidateId', 'testingEventId', 'criterionCode', 'assessment', 'expectedCandidateVersion', 'expectedTestingEventVersion', 'expectedScorecardVersion'])) failValidation();
    uuid(input.testingCandidateId); uuid(input.testingEventId); criterion(input.criterionCode); assessment(input.assessment);
    positive(input.expectedCandidateVersion); positive(input.expectedTestingEventVersion); positive(input.expectedScorecardVersion, true);
    if (typeof context.idempotencyKey !== 'string' || context.idempotencyKey.length < 1 || context.idempotencyKey.length > 200 || context.idempotencyKey.trim() !== context.idempotencyKey || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) failValidation('A bounded Idempotency-Key is required.');
    try {
      const raw = await this.database.recordTestingScorecardEvaluation(context, input.testingCandidateId, input.testingEventId, {
        criterionCode: input.criterionCode,
        assessment: input.assessment,
        expectedCandidateVersion: input.expectedCandidateVersion,
        expectedTestingEventVersion: input.expectedTestingEventVersion,
        expectedScorecardVersion: input.expectedScorecardVersion,
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !exactKeys(raw, ['record', 'replayed']) || typeof (raw as Record<string, unknown>).replayed !== 'boolean') throw new Error('Unsafe scorecard receipt.');
      return { ...parseReceipt((raw as Record<string, unknown>).record), replayed: (raw as { replayed: boolean }).replayed };
    } catch (error) { return databaseError(error); }
  }
}
