import { Injectable } from '@nestjs/common';
import { ONBOARDING_HUMAN_COMMAND } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0323: the read is a same-origin GET; saving answers is its own browser command. No delegated or automated selector. */
@Injectable()
export class SchoolOnboardingReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'onboarding.read';
}
@Injectable()
export class SchoolOnboardingSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = ONBOARDING_HUMAN_COMMAND;
}
