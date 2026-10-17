import { BadRequestException, Controller, ForbiddenException, Get, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type StaffReportingSchoolChoice } from '../foundation/runtime-database.service.js';
import { CurrentStaffReportingSchoolNoStoreGuard } from './current-staff-reporting-school.controller.js';

export type StaffReportingSchools = { state: 'SELECTION_REQUIRED'; schools: StaffReportingSchoolChoice[] }
  | { state: 'MANUAL_ENTRY_REQUIRED' };

@Controller('staff/reporting-schools')
@UseGuards(CurrentStaffReportingSchoolNoStoreGuard, HonIdentityGuard)
export class StaffReportingSchoolsController {
  constructor(private readonly database: RuntimeDatabaseService) {}

  @Get()
  async read(@Req() request: HonRequest, @Res({ passthrough: true }) response: Response): Promise<{ data: StaffReportingSchools }> {
    response.setHeader('Cache-Control', 'private, no-store');
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new ForbiddenException('A same-origin staff read is required.');
    }
    const authorityHeaders = ['authorization', 'idempotency-key', 'x-subject', 'x-user-id', 'x-principal-id', 'x-organization-id', 'x-school-id', 'x-role', 'x-tier', 'x-source', 'x-delegated-by-principal-id', 'x-action-request-id'];
    if (Object.keys(request.query ?? {}).length || request.body !== undefined
      || request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
      || Object.keys(request.headers).some((header) => header.toLowerCase().startsWith('x-hon-') || authorityHeaders.includes(header.toLowerCase()))) {
      throw new BadRequestException('This fixed staff read accepts no selector, role, tier, delegation or command input.');
    }
    try {
      const schools = await this.database.readStaffReportingSchools(identity.externalSubject);
      if (schools.length !== 0 && (schools.length < 2 || schools.length > 20)) {
        throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
      }
      // Runtime strictly verifies the fixed function output. Rebuild the closed
      // public DTO: no principal, permission, count, reason, or database metadata.
      return { data: schools.length >= 2 ? { state: 'SELECTION_REQUIRED', schools: schools.map((school) => ({
        organizationId: school.organizationId, schoolId: school.schoolId,
        organizationName: school.organizationName, schoolName: school.schoolName,
      })) } : { state: 'MANUAL_ENTRY_REQUIRED' } };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
        throw new ForbiddenException('Staff reporting schools are not authorized.');
      }
      throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
    }
  }
}
