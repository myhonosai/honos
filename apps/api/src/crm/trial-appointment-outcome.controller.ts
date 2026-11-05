import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import { TrialAppointmentHumanUiGuard } from './trial-appointment-human-ui.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { RecordTrialAppointmentOutcomeDto } from './record-trial-appointment-outcome.dto.js';
import { TrialAppointmentOutcomeService } from './trial-appointment-outcome.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/appointments')
@UseGuards(TrialAppointmentHumanUiGuard, HonIdentityGuard)
export class TrialAppointmentOutcomeController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly outcomes: TrialAppointmentOutcomeService,
  ) {}

  /**
   * Records one final result for a scheduled trial appointment. Route scope,
   * permission, actor, and source are established here rather than accepted
   * from the request body.
   */
  @Post(':appointmentId/outcome')
  @HttpCode(HttpStatus.OK)
  async record(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RecordTrialAppointmentOutcomeDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for recording a trial outcome.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'crm.trial.manage',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON trial outcome recording is not authorized for this school.');
    }

    const requestId = randomUUID();
    const context: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.outcomes.record(context, appointmentId, input, { externalSubject: identity.externalSubject });

    response.status(HttpStatus.OK);
    return {
      data: result.appointment,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
