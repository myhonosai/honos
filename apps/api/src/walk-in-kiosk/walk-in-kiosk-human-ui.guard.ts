import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** Walk-in kiosk (0396): each staff command is its own same-origin browser command; the reads are GET only. */
@Injectable()
export class WalkInKioskReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'walkin_kiosk.read';
}
@Injectable()
export class WalkInKioskSettingsHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'walkin_kiosk.settings.save';
}
@Injectable()
export class WalkInKioskDeviceStartHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'walkin_kiosk.device.start';
}
@Injectable()
export class WalkInKioskDeviceEndHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'walkin_kiosk.device.end';
}
@Injectable()
export class WalkInKioskDeskPaidHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'walkin_kiosk.visit.desk_paid';
}
