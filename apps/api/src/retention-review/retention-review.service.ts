import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { verifyRetentionReviewAcknowledgementEvidence, verifyRetentionReviewAcknowledgementInput, verifyRetentionReviewAcknowledgement, type RetentionReviewAcknowledgementInput, communityUuid, verifyRetentionReviewSignals, type RetentionReviewSignals, type RetentionReviewSignalsContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export function retentionReviewId(value: unknown): asserts value is string {
  try { communityUuid(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Known school and membership UUID selectors are required.' }); }
}
function human(context: RetentionReviewSignalsContext) {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
    throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  }
  for (const value of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) retentionReviewId(value);
  if (typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.length > 200) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '40001' || code === '40P01' || code === '55P03') throw new ConflictException({ code: 'RETENTION_EVIDENCE_CONFLICT', detail: 'No current acknowledgement is shown. Reload verified evidence before reviewing again.' });
  if (code === '42501') throw new ForbiddenException({ code: 'RETENTION_REVIEW_FORBIDDEN', detail: 'A direct verified human staff session, current exact school permission, and active entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'RETENTION_REVIEW_UNAVAILABLE', detail: 'No membership is available in the current authorized school.' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Known school and membership UUID selectors are required.' });
  throw new ServiceUnavailableException({ code: 'RETENTION_REVIEW_UNAVAILABLE', detail: 'No verified Retention Review Signals result is available.' });
}

@Injectable()
export class RetentionReviewService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async acknowledgementEvidence(context: RetentionReviewSignalsContext, membershipId: string) {
    human(context); retentionReviewId(membershipId);
    try { return verifyRetentionReviewAcknowledgementEvidence(await this.database.readRetentionReviewAcknowledgementEvidence(context, membershipId), membershipId); }
    catch (error) { return boundaryError(error); }
  }
  async acknowledge(context: RetentionReviewSignalsContext, membershipId: string, value: unknown) {
    human(context); retentionReviewId(membershipId);
    let input: RetentionReviewAcknowledgementInput;
    try { input = verifyRetentionReviewAcknowledgementInput(value); }
    catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only exact verified evidence and a UUID retry key are accepted.' }); }
    try { return verifyRetentionReviewAcknowledgement(await this.database.acknowledgeRetentionReviewEvidence(context, membershipId, input), membershipId, input); }
    catch (error) { return boundaryError(error); }
  }

  async read(context: RetentionReviewSignalsContext, membershipId: string): Promise<RetentionReviewSignals> {
    human(context); retentionReviewId(membershipId);
    try {
      const result = await this.database.readRetentionReviewSignals(context, membershipId);
      return verifyRetentionReviewSignals(result, membershipId);
    } catch (error) { return boundaryError(error); }
  }
}
