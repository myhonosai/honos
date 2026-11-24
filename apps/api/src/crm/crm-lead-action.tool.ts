import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CommandContext, CreateLeadInput, LeadSummary } from '@hon/contracts';
import { ActionEngineService, type ActionProposalSummary } from '../action/action-engine.service.js';
import { CreateLeadDto } from './create-lead.dto.js';
import { LeadService } from './lead.service.js';

export type CrmLeadActionResult =
  | { proposal: ActionProposalSummary; execution: 'AWAITING_APPROVAL' }
  | { proposal: ActionProposalSummary; execution: 'SUCCEEDED'; lead: LeadSummary }
  /**
   * The lead command committed, but HON could not record the Action Engine success receipt. The proposal stays
   * EXECUTING (never FAILED) so reconciliation sees a committed mutation, not a failure (review [21]).
   */
  | { proposal: ActionProposalSummary; execution: 'RECEIPT_UNCONFIRMED'; lead: LeadSummary };

/** A domain refusal (4xx) changed nothing; anything else may have committed and is UNKNOWN, never FAILED. */
function domainOutcome(error: unknown): 'FAILED' | 'UNKNOWN' {
  return error instanceof HttpException && error.getStatus() < 500 ? 'FAILED' : 'UNKNOWN';
}

/**
 * Internal only: the AI runtime calls this adapter after it has resolved the
 * requesting agent/principal to the `crm.lead.create` school permission. The
 * browser and external API cannot send raw Action Engine proposals here.
 */
@Injectable()
export class CrmLeadActionTool {
  constructor(private readonly actions: ActionEngineService, private readonly leads: LeadService) {}

  async invoke(context: CommandContext, rawInput: unknown): Promise<CrmLeadActionResult> {
    const input = plainToInstance(CreateLeadDto, rawInput);
    const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'The typed CRM lead tool input is invalid.' });
    }
    const normalizedInput: CreateLeadInput = {
      pipelineId: input.pipelineId,
      pipelineStageId: input.pipelineStageId,
      primaryContact: {
        givenName: input.primaryContact.givenName.trim(),
        familyName: input.primaryContact.familyName.trim(),
        ...(input.primaryContact.email ? { email: input.primaryContact.email.trim().toLowerCase() } : {}),
        ...(input.primaryContact.phoneE164 ? { phoneE164: input.primaryContact.phoneE164 } : {}),
      },
      ...(input.sourceId ? { sourceId: input.sourceId.trim() } : {}),
      ...(input.programInterestCode ? { programInterestCode: input.programInterestCode.trim() } : {}),
      ...(input.nextFollowUpAt ? { nextFollowUpAt: input.nextFollowUpAt } : {}),
      ...(input.attribution ? { attribution: input.attribution } : {}),
    };
    const normalizedPayload: Record<string, unknown> = {
      pipelineId: normalizedInput.pipelineId,
      pipelineStageId: normalizedInput.pipelineStageId,
      primaryContact: normalizedInput.primaryContact,
      ...(normalizedInput.sourceId ? { sourceId: normalizedInput.sourceId } : {}),
      ...(normalizedInput.programInterestCode ? { programInterestCode: normalizedInput.programInterestCode } : {}),
      ...(normalizedInput.nextFollowUpAt ? { nextFollowUpAt: normalizedInput.nextFollowUpAt } : {}),
      ...(normalizedInput.attribution ? { attribution: normalizedInput.attribution } : {}),
    };
    const proposal = await this.actions.propose(context, { actionCode: 'crm.lead.create', normalizedPayload });
    if (proposal.status === 'AWAITING_APPROVAL') return { proposal, execution: 'AWAITING_APPROVAL' };

    const executable = await this.actions.beginExecution(context, proposal.id);
    if (executable.actionCode !== 'crm.lead.create') {
      throw new BadRequestException({ code: 'POLICY_BLOCKED', detail: 'The CRM lead tool received an invalid execution proposal.' });
    }
    let result: Awaited<ReturnType<LeadService['create']>>;
    try {
      result = await this.leads.create({ ...context, actionRequestId: executable.id, idempotencyKey: `action:${executable.id}` }, normalizedInput);
    } catch (error) {
      const outcome = domainOutcome(error);
      // Recording the outcome is best effort: its own failure must not hide the domain error.
      await this.actions.recordExecutionOutcome(context, executable.id, outcome, {
        code: outcome === 'FAILED' ? 'DOMAIN_COMMAND_FAILED' : 'DOMAIN_COMMAND_OUTCOME_UNKNOWN',
        actionCode: 'crm.lead.create',
      }).catch(() => undefined);
      throw error;
    }
    // The lead is committed from here on. A failed receipt write is retried once and otherwise reported as
    // RECEIPT_UNCONFIRMED; it is never turned into a FAILED action.
    const receipt = { leadId: result.lead.id, leadVersion: result.lead.version, leadCommandReplayed: result.replayed };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.actions.recordExecutionOutcome(context, executable.id, 'SUCCEEDED', receipt);
        return { proposal, execution: 'SUCCEEDED', lead: result.lead };
      } catch { /* retried once, then reported as unconfirmed */ }
    }
    return { proposal, execution: 'RECEIPT_UNCONFIRMED', lead: result.lead };
  }
}
