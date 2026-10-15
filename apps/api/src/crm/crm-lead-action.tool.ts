import { BadRequestException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CommandContext, CreateLeadInput, LeadSummary } from '@hon/contracts';
import { ActionEngineService, type ActionProposalSummary } from '../action/action-engine.service.js';
import { CreateLeadDto } from './create-lead.dto.js';
import { LeadService } from './lead.service.js';

export type CrmLeadActionResult =
  | { proposal: ActionProposalSummary; execution: 'AWAITING_APPROVAL' }
  | { proposal: ActionProposalSummary; execution: 'SUCCEEDED'; lead: LeadSummary };

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
    try {
      const result = await this.leads.create({ ...context, actionRequestId: executable.id, idempotencyKey: `action:${executable.id}` }, normalizedInput);
      await this.actions.recordExecutionOutcome(context, executable.id, 'SUCCEEDED', {
        leadId: result.lead.id,
        leadVersion: result.lead.version,
        leadCommandReplayed: result.replayed,
      });
      return { proposal, execution: 'SUCCEEDED', lead: result.lead };
    } catch (error) {
      await this.actions.recordExecutionOutcome(context, executable.id, 'FAILED', {
        code: 'DOMAIN_COMMAND_FAILED',
        actionCode: 'crm.lead.create',
      });
      throw error;
    }
  }
}
