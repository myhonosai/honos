import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0478: each read and command is its own same-origin browser command. */
@Injectable()
export class StaffTimeReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_time.read';
}
@Injectable()
export class StaffTimePunchHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_time.punch';
}
@Injectable()
export class StaffTimeEntrySaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_time.entry.save';
}
@Injectable()
export class StaffTimesheetDecideHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'staff_timesheet.decide';
}
