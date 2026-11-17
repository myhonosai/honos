import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0467: the week read is a GET; the save is its own same-origin browser command. */
@Injectable()
export class StaffShiftReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_shift.read';
}
@Injectable()
export class StaffShiftSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_shift.save';
}
