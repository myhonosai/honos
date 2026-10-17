import { Controller, ForbiddenException, Get, Header, HttpException, Injectable, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyPlannedAbsenceReviewQueue, type PlannedAbsenceReviewContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { PlannedAbsenceReviewHumanUiGuard, rejectPlannedAbsenceReviewInputs } from './planned-absence-review-human-ui.guard.js';

@Injectable()
export class PlannedAbsenceReviewQueueService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async get(externalSubject: string) {
    try {
      const scope = await this.database.resolvePlannedAbsenceReviewScope(externalSubject);
      if (!scope) throw new ForbiddenException({ code: 'PLANNED_ABSENCE_REVIEW_FORBIDDEN' });
      const requestId = randomUUID();
      const context: PlannedAbsenceReviewContext = { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId, idempotencyKey: requestId };
      const data = verifyPlannedAbsenceReviewQueue(await this.database.readPlannedAbsenceReviewQueue(context));
      if (data.organizationId !== scope.organizationId || data.schoolId !== scope.schoolId) throw new ForbiddenException({ code: 'PLANNED_ABSENCE_REVIEW_SCOPE_CHANGED' });
      return { data, meta: { requestId, correlationId: requestId } };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'PLANNED_ABSENCE_REVIEW_FORBIDDEN' });
      throw new ServiceUnavailableException({ code: 'PLANNED_ABSENCE_REVIEW_UNAVAILABLE' });
    }
  }
}
@Controller('staff/attendance/planned-absences')
@UseGuards(HonIdentityGuard, PlannedAbsenceReviewHumanUiGuard)
export class PlannedAbsenceReviewQueueController {
  constructor(private readonly queue: PlannedAbsenceReviewQueueService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  async get(@Req() request: HonRequest) {
    rejectPlannedAbsenceReviewInputs(request);
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return this.queue.get(request.honIdentity.externalSubject);
  }
}
