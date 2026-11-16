import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0392: the school location read is a GET; the save is its own same-origin browser command. */
@Injectable()
export class SchoolLocationReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_location.read';
}
@Injectable()
export class SchoolLocationSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_location.save';
}
