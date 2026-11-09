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
/** D-M1 (0200): the lead membership discovery read is a GET; source/delegation headers and cross-site fetches stay refused. */
@Injectable()
export class CrmLeadMembershipsHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.lead.memberships';
}
/** 0224: pause, resume, policy and refund-record calls are each their own browser command, so none replays as another. */
@Injectable()
export class MembershipPauseHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.pause';
}
@Injectable()
export class MembershipResumeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.resume';
}
@Injectable()
export class MembershipPausePolicyHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.pause_policy.set';
}
@Injectable()
export class MembershipRefundRecordHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.refund.record';
}
/** The 0177 cancellation, now reachable from the staff page: only a same-origin browser command, never delegated or automated. */
@Injectable()
export class MembershipCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.cancel';
}
/** The two 0224 reads are GETs: the base guard admits them, and the source/delegation headers stay refused. */
@Injectable()
export class MembershipPauseReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.membership.pauses.read';
}
/** B-TUI-1 (0240): recording and voiding a tuition payment are separate same-origin browser commands; reads are GET only. */
@Injectable()
export class TuitionPaymentRecordHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.invoice.payment.record';
}
@Injectable()
export class TuitionPaymentVoidHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.invoice.payment.void';
}
@Injectable()
export class TuitionReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.tuition.read';
}
