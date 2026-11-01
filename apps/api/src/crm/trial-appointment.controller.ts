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
import { CreateTrialAppointmentDto } from './create-trial-appointment.dto.js';
import { TrialAppointmentService } from './trial-appointment.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/trials')
@UseGuards(TrialAppointmentHumanUiGuard, HonIdentityGuard)
export class TrialAppointmentController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly trials: TrialAppointmentService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async schedule(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('leadId', new ParseUUIDPipe()) leadId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateTrialAppointmentDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for trial scheduling.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    // Permission, tenant, school, and principal are all resolved server-side.
    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'crm.trial.schedule',
    );
    if (!scope || scope.organizationId !== organizationId) {
      throw new ForbiddenException('HON trial scheduling is not authorized for this school.');
    }

    const requestId = randomUUID();
    const command: CommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.trials.schedule(command, leadId, input);

    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
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
