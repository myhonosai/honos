import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0268: the branding read is a GET; the save is its own same-origin browser command. */
@Injectable()
export class SchoolBrandingReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_branding.read';
}
@Injectable()
export class SchoolBrandingSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_branding.save';
}
