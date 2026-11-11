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
