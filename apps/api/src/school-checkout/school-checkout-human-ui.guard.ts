import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** B-TUI-2 piece 9a (0269): the checkout settings read is a GET; the save is its own same-origin browser command. */
@Injectable()
export class SchoolCheckoutReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.pages.read';
}
@Injectable()
export class SchoolCheckoutSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.page.save';
}
