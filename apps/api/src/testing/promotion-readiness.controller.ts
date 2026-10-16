import { BadRequestException, Controller, ForbiddenException, Get, Header, Param, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readinessUuid, type PromotionReadinessContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { PromotionReadinessService, readinessError } from './promotion-readiness.service.js';
@Controller('organizations/:organizationId/schools/:schoolId/curricula/:curriculumId/enrollments/:enrollmentId/promotion-readiness')
@UseGuards(HonIdentityGuard)
export class PromotionReadinessController {
 constructor(private readonly database: RuntimeDatabaseService, private readonly readiness: PromotionReadinessService) {}
 @Get()
 @Header('Cache-Control', 'private, no-store')
 @Header('Referrer-Policy', 'no-referrer')
 async read(@Param('organizationId') organizationId: string, @Param('schoolId') schoolId: string, @Param('curriculumId') curriculumId: string, @Param('enrollmentId') enrollmentId: string, @Req() request: HonRequest) {
  if (![organizationId, schoolId, curriculumId, enrollmentId].every(readinessUuid) || Object.keys(request.query ?? {}).length || (request.body !== undefined && request.body !== null && (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  if (!request.honIdentity || request.headers?.['sec-fetch-site'] === 'cross-site') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  let scope;
  try { scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'testing.promotion.readiness.read'); }
  catch (error) { return readinessError(error); }
  if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'PROMOTION_READINESS_SCOPE_DENIED' });
  const requestId = randomUUID();
  const context: PromotionReadinessContext = { ...scope, externalSubject: request.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId };
  return { data: await this.readiness.read(context, curriculumId, enrollmentId), meta: { requestId, correlationId: requestId } };
 }
}
