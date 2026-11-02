import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { TrialAppointmentReadGuard } from './trial-appointment-human-ui.guard.js';
import { resolveTrialReadContext } from './trial-appointment.controller.js';
import { TrialAppointmentService } from './trial-appointment.service.js';

/** Direct-human detail read of one trial appointment, for reconciliation after an unknown command result. */
@Controller('organizations/:organizationId/schools/:schoolId/crm/appointments')
export class TrialAppointmentReadController {
  constructor(
    private readonly database: RuntimeDatabaseService,
    private readonly trials: TrialAppointmentService,
  ) {}

  @Get(':appointmentId')
  @UseGuards(TrialAppointmentReadGuard, HonIdentityGuard)
  async read(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string,
    @Req() request: HonRequest,
  ) {
    const context = await resolveTrialReadContext(this.database, request, organizationId, schoolId);
    const data = await this.trials.readOne(context, appointmentId, { externalSubject: request.honIdentity!.externalSubject });
    return { data, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }
}
