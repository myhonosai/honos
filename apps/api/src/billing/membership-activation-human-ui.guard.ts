import { ForbiddenException, Injectable, type ExecutionContext } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Browser activation only; no delegated, automated, or financial command selectors. */
@Injectable()
export class MembershipActivationHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'billing.membership.activate';

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown>; body?: unknown }>();
    if (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin') {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (['x-hon-source', 'x-hon-action-request-id', 'x-hon-delegated-by-principal-id'].some(key => request.headers[key] !== undefined)
      || (request.method === 'GET' && request.body !== undefined && request.body !== null && Object.keys(Object(request.body)).length > 0)) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    return super.canActivate(context);
  }
}
