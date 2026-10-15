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
import type { Response } from 'express';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AttendanceService } from './attendance.service.js';
import { RecordAttendanceDto } from './record-attendance.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/schedule/sessions')
@UseGuards(HonIdentityGuard)
export class AttendanceController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly attendance: AttendanceService,
  ) {}

  /**
   * POST is intentional: this is an idempotency-keyed command which may create
   * an attendance record or perform a version-checked state transition, rather
   * than a client-addressable representation replacement.
   */
  @Post(':sessionId/attendance')
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: RecordAttendanceDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for attendance recording.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'attendance.record',
    );
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON attendance recording is not authorized for this school.');
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
    const result = await this.attendance.record(context, sessionId, input);

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      data: result.attendance,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
