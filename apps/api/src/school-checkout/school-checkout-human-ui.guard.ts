import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** Checkout pages (0402): the read is a GET; each save is its own same-origin browser command. */
@Injectable()
export class SchoolCheckoutReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.pages.read';
}
@Injectable()
export class SchoolCheckoutSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.page.save';
}
@Injectable()
export class SchoolCheckoutSettingsSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.settings.save';
}
@Injectable()
export class SchoolCheckoutOrdersReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_checkout.orders.read';
}
