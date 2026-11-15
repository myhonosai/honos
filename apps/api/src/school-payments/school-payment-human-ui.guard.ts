import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** B-TUI-2 (0258): each processor-connection call is its own same-origin browser command, so none replays as another. */
@Injectable()
export class SchoolPayReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.processors.read';
}
@Injectable()
export class SchoolPayStartHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.start';
}
@Injectable()
export class SchoolPayOnboardingLinkHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.onboarding_link';
}
@Injectable()
export class SchoolPayFinishHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.finish';
}
@Injectable()
export class SchoolPayRefreshHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.refresh';
}
@Injectable()
export class SchoolPayDefaultHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.default';
}
@Injectable()
export class SchoolPayDisconnectHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.connection.disconnect';
}

/** B-TUI-2 (0321): saved payment methods, one browser command per call. */
@Injectable()
export class SchoolPayMethodsReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.methods.read';
}
@Injectable()
export class SchoolPayExpiringReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.methods.expiring_read';
}
@Injectable()
export class SchoolPayMethodSetupHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.method.setup';
}
@Injectable()
export class SchoolPayMethodFinishHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.method.finish';
}
@Injectable()
export class SchoolPayMethodDefaultHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.method.default';
}
@Injectable()
export class SchoolPayMethodRemoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.method.remove';
}

/** B-TUI-2 (0322): autopay and sibling discounts, one browser command per call. */
@Injectable()
export class SchoolPayAutopayReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.read';
}
@Injectable()
export class SchoolPayDiscountReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.discount.read';
}
@Injectable()
export class SchoolPayDiscountSetHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.discount.set';
}
@Injectable()
export class SchoolPayAutopayEnrollHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.enroll';
}
@Injectable()
export class SchoolPayAutopayMethodHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.method';
}
@Injectable()
export class SchoolPayAutopayStateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.state';
}
@Injectable()
export class SchoolPayAutopayCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.cancel';
}
@Injectable()
export class SchoolPayAutopayCycleHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school_pay.autopay.cycle';
}
