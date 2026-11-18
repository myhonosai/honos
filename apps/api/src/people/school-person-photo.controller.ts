import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { PERSON_PHOTO_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SchoolPersonPhotoService } from './school-person-photo.service.js';

/** 0390: same-origin human browser requests only, with their own command header for set and remove; never cached. */
@Injectable()
export class SchoolPersonPhotoHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, PERSON_PHOTO_HUMAN_COMMAND); }
}

@Controller() @UseGuards(SchoolPersonPhotoHumanGuard, HonIdentityGuard)
export class SchoolPersonPhotoController {
  constructor(private readonly photos: SchoolPersonPhotoService) {}
  @Get('school/schools/:schoolId/people/:personId/photo')
  read(@Req() r: HonRequest, @Param('schoolId') s: string, @Param('personId') p: string) { return this.photos.read(r, s, p).then(data => ({ data })); }
  @Post('school/people/photo') @HttpCode(200)
  set(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.photos.set(r, b, k).then(data => ({ data })); }
  @Post('school/people/photo/remove') @HttpCode(200)
  remove(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.photos.remove(r, b, k).then(data => ({ data })); }
}
