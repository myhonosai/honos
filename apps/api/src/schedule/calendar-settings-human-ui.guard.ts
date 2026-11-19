import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0568 calendar settings: every write is its own same-origin browser command; the reads are GET only. */
@Injectable()
export class CalendarSettingsReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.settings.read';
}
@Injectable()
export class CalendarBlockOutsReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.block_outs.read';
}
@Injectable()
export class CalendarShareSettingsSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.settings.save';
}
@Injectable()
export class CalendarBlockOutAddHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.block_out.add';
}
@Injectable()
export class CalendarBlockOutRemoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.block_out.remove';
}
@Injectable()
export class ShareCalendarSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.share.save';
}
@Injectable()
export class ShareCalendarDeleteHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.share.delete';
}
