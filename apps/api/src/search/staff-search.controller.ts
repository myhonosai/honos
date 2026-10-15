import { Controller, ForbiddenException, Get, Header, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { StaffSearchQueryDto } from './staff-search.dto.js';
import { StaffSearchService } from './staff-search.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/search')
@UseGuards(HonIdentityGuard)
export class StaffSearchController {
  constructor(private readonly searches: StaffSearchService) {}
  private subject(request: HonRequest): string {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'SEARCH_FORBIDDEN', detail: 'Verified HON identity is required.' });
    return request.honIdentity.externalSubject;
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async search(@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Query() query: StaffSearchQueryDto, @Req() request: HonRequest) {
    const search = await this.searches.search(this.subject(request), organizationId, schoolId, query);
    const requestId = randomUUID();
    return { data: { search }, meta: { requestId, correlationId: requestId } };
  }
  @Get('results/:kind/:entityId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async readResult(@Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string, @Param('kind') kind: string,
    @Param('entityId', new ParseUUIDPipe()) entityId: string, @Req() request: HonRequest) {
    const result = await this.searches.readResult(this.subject(request), organizationId, schoolId, kind, entityId);
    const requestId = randomUUID();
    return { data: { result }, meta: { requestId, correlationId: requestId } };
  }
}
