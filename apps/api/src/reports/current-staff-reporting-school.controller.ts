import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Req, Res, ServiceUnavailableException, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type ResolvedStaffReportingScope } from '../foundation/runtime-database.service.js';

export type CurrentStaffReportingSchool = { state: 'RESOLVED' } & ResolvedStaffReportingScope
  | { state: 'MANUAL_ENTRY_REQUIRED' };

/** Runs before authentication so denied/unconfigured session responses cannot cache. */
@Injectable()
export class CurrentStaffReportingSchoolNoStoreGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'private, no-store');
    return true;
  }
}

@Controller('staff/current-reporting-school')
@UseGuards(CurrentStaffReportingSchoolNoStoreGuard, HonIdentityGuard)
export class CurrentStaffReportingSchoolController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get()
  async read(@Req() request: HonRequest, @Res({ passthrough: true }) response: Response): Promise<{ data: CurrentStaffReportingSchool }> {
    response.setHeader('Cache-Control', 'private, no-store');
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new ForbiddenException('A same-origin staff read is required.');
    }
    if (Object.keys(request.query ?? {}).length || request.body !== undefined
      || request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      || Object.keys(request.headers).some((header) => header.startsWith('x-hon-') || header === 'idempotency-key')) {
      throw new BadRequestException('This fixed staff read accepts no selector, role, tier, delegation or command input.');
    }
    try {
      const scope = await this.database.resolveCurrentStaffReportingScope(identity.externalSubject);
      // Never forward a principal, candidates, counts, or arbitrary database fields.
      return { data: scope ? { state: 'RESOLVED', organizationId: scope.organizationId, schoolId: scope.schoolId }
        : { state: 'MANUAL_ENTRY_REQUIRED' } };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
        throw new ForbiddenException('Current staff reporting scope is not authorized.');
      }
      throw new ServiceUnavailableException('Current staff reporting scope is unavailable.');
    }
  }
}
