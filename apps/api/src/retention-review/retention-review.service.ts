import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { verifyRetentionReviewAcknowledgementEvidence, verifyRetentionReviewAcknowledgementInput, verifyRetentionReviewAcknowledgement, type RetentionReviewAcknowledgementInput, communityUuid, verifyRetentionReviewSignals, type RetentionReviewSignals, type RetentionReviewSignalsContext } from '@hon/contracts';
import { verifyRetentionAttentionEvidence, verifyRetentionAttentionAlerts, verifyRetentionAttentionRecordInput, verifyRetentionAttentionResolutionInput, verifyRetentionAttentionRecord, verifyRetentionAttentionResolution, type RetentionAttentionRecordInput, type RetentionAttentionResolutionInput } from '@hon/contracts';
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

export type RetentionMemberRow = Readonly<{ membershipId: string; displayName: string; state: string; termEndsAt: string | null }>;
const MEMBER_STATES = ['ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'EXPIRED'];
/** 0407 rows, closed and bounded: id, participant name, state and term end only. Anything else fails closed. */
export function parseRetentionMembers(value: unknown): RetentionMemberRow[] {
  const bad = (): never => { throw new ServiceUnavailableException({ code: 'RETENTION_REVIEW_UNAVAILABLE', detail: 'The member list could not be verified.' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'items') bad();
  const items = (value as { items: unknown }).items;
  if (!Array.isArray(items) || items.length > 200) bad();
  const rows = (items as unknown[]).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join() !== 'displayName,membershipId,state,termEndsAt') bad();
    const r = row as Record<string, unknown>;
    if (typeof r.membershipId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.membershipId) || typeof r.displayName !== 'string' || !r.displayName || r.displayName.length > 120
      || typeof r.state !== 'string' || !MEMBER_STATES.includes(r.state) || !(r.termEndsAt === null || (typeof r.termEndsAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.termEndsAt)))) bad();
    return { membershipId: (r.membershipId as string).toLowerCase(), displayName: r.displayName as string, state: r.state as string, termEndsAt: r.termEndsAt as string | null };
  });
  if (new Set(rows.map((r) => r.membershipId)).size !== rows.length) bad();
  return rows;
}

@Injectable()
export class RetentionReviewService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private attentionError(error: unknown): never {
    if (['40001','40P01','55P03'].includes((error as { code?: string }).code ?? '')) throw new ConflictException({ code: 'RETENTION_ATTENTION_CONFLICT', detail: 'Evidence, version or retry changed. No current alert state is shown. Reload verified evidence and alert state.' });
    return boundaryError(error);
  }
  /** Members of this school by name, so staff choose one instead of typing a membership UUID (0407). */
  async memberships(context: RetentionReviewSignalsContext) {
    human(context);
    let value: unknown;
    try { value = await this.database.listRetentionReviewMemberships(context); }
    catch (error) { return boundaryError(error); }
    return parseRetentionMembers(value);
  }
  async attentionAlerts(context: RetentionReviewSignalsContext, membershipId: string) {
    human(context); retentionReviewId(membershipId);
    try { return verifyRetentionAttentionAlerts(await this.database.readRetentionAttentionAlerts(context, membershipId), membershipId); }
    catch (error) { return this.attentionError(error); }
  }
  async attentionEvidence(context: RetentionReviewSignalsContext, membershipId: string) {
    human(context); retentionReviewId(membershipId);
    try { return verifyRetentionAttentionEvidence(await this.database.readRetentionAttentionEvidence(context, membershipId), membershipId); }
    catch (error) { return this.attentionError(error); }
  }
  async recordAttention(context: RetentionReviewSignalsContext, membershipId: string, value: unknown) {
    human(context); retentionReviewId(membershipId);
    let input: RetentionAttentionRecordInput;
    try { input = verifyRetentionAttentionRecordInput(value); }
    catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only exact verified evidence, a closed derived code and a UUID retry key are accepted.' }); }
    try { return verifyRetentionAttentionRecord(await this.database.recordRetentionAttentionAlert(context, membershipId, input), membershipId, input); }
    catch (error) { return this.attentionError(error); }
  }
  async resolveAttention(context: RetentionReviewSignalsContext, membershipId: string, value: unknown) {
    human(context); retentionReviewId(membershipId);
    let input: RetentionAttentionResolutionInput;
    try { input = verifyRetentionAttentionResolutionInput(value); }
    catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only one exact alert, its open version, a closed no-note resolution reason and a UUID retry key are accepted.' }); }
    try { return verifyRetentionAttentionResolution(await this.database.resolveRetentionAttentionAlert(context, membershipId, input), membershipId, input); }
    catch (error) { return this.attentionError(error); }
  }

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
