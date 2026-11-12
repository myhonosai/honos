import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** B-SCH-3 (0261): each school event command is its own same-origin browser command; the reads are GET only. */
@Injectable()
export class SchoolEventReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.event.read';
}
@Injectable()
export class SchoolEventSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.event.save';
}
@Injectable()
export class SchoolEventStatusHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.event.status';
}
@Injectable()
export class SchoolEventBookingStatusHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.event.booking_status';
}
