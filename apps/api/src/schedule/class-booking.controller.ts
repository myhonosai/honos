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
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ClassBookingHumanUiGuard } from './class-booking-human-ui.guard.js';
import { ClassBookingService, type ClassBookingCommandContext } from './class-booking.service.js';
import { CreateClassBookingDto } from './create-class-booking.dto.js';

@Controller('organizations/:organizationId/schools/:schoolId/schedule/sessions')
@UseGuards(HonIdentityGuard, ClassBookingHumanUiGuard)
export class ClassBookingController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly bookings: ClassBookingService,
  ) {}

  /**
   * This is an idempotency-keyed staff command rather than a representation
   * replacement. The actor and source are derived below, never accepted from
   * the request body.
   */
  @Post(':sessionId/bookings')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateClassBookingDto,
    @Req() request: HonRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 200) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: 'A unique Idempotency-Key header of at most 200 characters is required for class booking.',
      });
    }

    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');

    const scope = await this.database.resolveAuthorizedScope(
      identity.externalSubject,
      schoolId,
      'schedule.booking.manage',
    );
    // Do not trust an organization path parameter merely because the school
    // resolved: require the resolver's exact organization/school pair.
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) {
      throw new ForbiddenException('HON class booking is not authorized for this school.');
    }

    const requestId = randomUUID();
    const context: ClassBookingCommandContext = {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      externalSubject: identity.externalSubject,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey: normalizedIdempotencyKey,
      source: 'HUMAN_UI',
    };
    const result = await this.bookings.create(context, sessionId, input);

    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      data: result.booking,
      meta: {
        requestId,
        correlationId: requestId,
        replayed: result.replayed,
      },
    };
  }
}
