import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** School booking types (0286): each command is its own same-origin browser command; the reads are GET only. */
@Injectable()
export class BookingTypeReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.booking_type.read';
}
@Injectable()
export class BookingTypeSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.booking_type.save';
}
@Injectable()
export class BookingTypeStatusHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.booking_type.status';
}
@Injectable()
export class BookingTypeBookingStatusHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.booking_type.booking_status';
}
