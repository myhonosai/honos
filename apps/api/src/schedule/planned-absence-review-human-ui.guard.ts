import { BadRequestException, ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';

export function rejectPlannedAbsenceReviewInputs(request: HonRequest): void {
  if (Object.keys(request.query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'REVIEW_SELECTORS_NOT_ACCEPTED' });
  if (Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  if (request.headers['x-hon-human-command'] !== undefined && request.headers['x-hon-human-command'] !== 'planned-absence-review') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  if (request.method === 'GET' && (request.body !== undefined && request.body !== null || request.headers['sec-fetch-site'] === 'cross-site')) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
}
@Injectable()
export class PlannedAbsenceReviewHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'planned-absence-review';
  override canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    rejectPlannedAbsenceReviewInputs(request);
    if (request.method === 'GET' && request.headers['x-hon-human-command'] !== 'planned-absence-review') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
