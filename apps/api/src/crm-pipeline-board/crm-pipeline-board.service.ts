import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  validateMoveCrmLeadStageInput, validateSaveCrmPipelineStagesInput, verifyCrmLeadStageMoveReceipt, verifyCrmPipelineBoard, verifyCrmPipelineStagesReceipt,
  type CrmBoardStatus, type CrmLeadStageMoveReceipt, type CrmPipelineBoard, type CrmPipelineStagesReceipt,
} from '@hon/contracts';
import type { PoolClient } from 'pg';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";
const WRITE_LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";

// Exact 0400 error codes; every unknown database failure is unavailable, never success.
const ERRORS: Record<string, (code: string) => HttpException> = {
  VALIDATION_FAILED: code => new BadRequestException({ code }),
  CRM_STAGE_NOT_ALLOWED: code => new BadRequestException({ code, detail: 'Choose a visible stage of this lead\'s pipeline that is not its current stage.' }),
  CRM_STAGES_MISMATCH: code => new BadRequestException({ code, detail: 'The stage list changed. Reload the board and try again.' }),
  CRM_STAGE_NAME_TAKEN: code => new BadRequestException({ code, detail: 'Each stage needs its own name.' }),
  CRM_STAGE_VISIBLE_REQUIRED: code => new BadRequestException({ code, detail: 'Keep at least one stage visible.' }),
  CRM_STAGE_MOVE_REQUIRED: code => new BadRequestException({ code, detail: 'Choose where the open leads of each hidden stage go.' }),
  CRM_BOARD_FORBIDDEN: code => new ForbiddenException({ code }),
  CRM_LEAD_UNAVAILABLE: code => new NotFoundException({ code }),
  CRM_PIPELINE_UNAVAILABLE: code => new NotFoundException({ code }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'This changed since the board was loaded. Reload it and try again with a new Idempotency-Key.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different command.' }),
  IDEMPOTENCY_IN_PROGRESS: code => new ConflictException({ code, detail: 'The matching command is being processed.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', '40001', '23505', 'P0002'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'CRM_BOARD_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'CRM_BOARD_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  throw new ServiceUnavailableException({ code: 'CRM_BOARD_UNAVAILABLE' });
}

/**
 * 0400: the lead pipeline board. Each read and command is one protected definer call that re-proves the direct human
 * subject, the exact school, the live permission and the CRM entitlement. Closing a lead stays the 0145 close command.
 */
@Injectable()
export class CrmPipelineBoardService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: MembershipLifecycleContext, pipelineId: string | null, status: CrmBoardStatus): Promise<CrmPipelineBoard> {
    this.assertHumanContext(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client: PoolClient) => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_crm_pipeline_board($1,$2::uuid,$3) AS data', [context.externalSubject, pipelineId, status]);
        if (result.rows.length !== 1) throw new Error('Unverified lead board.');
        const board = verifyCrmPipelineBoard(result.rows[0]!.data, { status });
        if (pipelineId && board.pipeline?.id !== pipelineId) throw new Error('Unverified lead board pipeline.');
        return board;
      });
    } catch (error) { return translate(error); }
  }

  async move(context: MembershipLifecycleContext, leadId: string, value: unknown): Promise<{ receipt: CrmLeadStageMoveReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateMoveCrmLeadStageInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.move_crm_lead_stage($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', leadId, input,
      receipt => verifyCrmLeadStageMoveReceipt(receipt, { leadId, stageId: input.stageId }));
  }

  async saveStages(context: MembershipLifecycleContext, pipelineId: string, value: unknown): Promise<{ receipt: CrmPipelineStagesReceipt; replayed: boolean }> {
    this.assertHumanContext(context, true);
    let input;
    try { input = validateSaveCrmPipelineStagesInput(value); } catch { throw new BadRequestException({ code: 'VALIDATION_FAILED' }); }
    return this.command(context, 'SELECT hon.save_crm_pipeline_stages($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', pipelineId, input,
      receipt => verifyCrmPipelineStagesReceipt(receipt, { pipelineId }));
  }

  private async command<T>(context: MembershipLifecycleContext, sql: string, target: string, input: unknown, verify: (receipt: unknown) => T): Promise<{ receipt: T; replayed: boolean }> {
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(WRITE_LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>(sql,
          [context.externalSubject, target, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'receipt,replayed' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified lead board receipt.');
        }
        return { receipt: verify(data.receipt), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  private assertHumanContext(context: MembershipLifecycleContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'The lead board accepts only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 2048) throw new ForbiddenException({ code: 'CRM_BOARD_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
