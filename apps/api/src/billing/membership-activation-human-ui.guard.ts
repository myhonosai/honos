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

/** The read-only preview is its own browser command, so a preview can never be replayed as a confirmation. */
@Injectable()
export class MembershipActivationPreviewHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.activation.preview';
}

/** E1b-1 (0178): each date-management call is its own browser command, so no call can be replayed as another. */
@Injectable()
export class MembershipDatePreviewHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.dates.preview';
}
@Injectable()
export class MembershipDateRevisionHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.dates.revise';
}
@Injectable()
export class MembershipDateHistoryHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.dates.history';
}
@Injectable()
export class MembershipDateQueueHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.dates.queue';
}
/** The status summary is a GET: the base guard admits it, and the source/delegation headers stay refused. */
@Injectable()
export class MembershipStatusSummaryHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'reporting.membership-status';
}
