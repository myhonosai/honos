import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PERSON_RECORD_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SchoolPersonRecordService } from './school-person-record.service.js';

/** Same-origin human browser requests only, with their own command header for the edit; the database re-checks the school. */
@Injectable()
export class SchoolPersonRecordHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, PERSON_RECORD_HUMAN_COMMAND); }
}

@Controller() @UseGuards(SchoolPersonRecordHumanGuard, HonIdentityGuard)
export class SchoolPersonRecordController {
  constructor(private readonly people: SchoolPersonRecordService) {}
  @Get('school/schools/:schoolId/people/:personId')
  read(@Req() r: HonRequest, @Param('schoolId') s: string, @Param('personId') p: string) { return this.people.read(r, s, p).then(data => ({ data })); }
  @Post('school/people/update') @HttpCode(200)
  update(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.people.update(r, b, k).then(data => ({ data })); }
  @Post('school/people/birth-date') @HttpCode(200)
  updateBirthDate(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.people.updateBirthDate(r, b, k).then(data => ({ data })); }
}
