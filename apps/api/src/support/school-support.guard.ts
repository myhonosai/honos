import { Injectable } from '@nestjs/common';
import { SUPPORT_MESSAGE_COMMAND, SUPPORT_SUBMIT_COMMAND } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0335: the read is a same-origin GET; asking for help and adding a message are each their own browser command. */
@Injectable()
export class SchoolSupportReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'support.request.read';
}
@Injectable()
export class SchoolSupportSubmitHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SUPPORT_SUBMIT_COMMAND;
}
@Injectable()
export class SchoolSupportMessageHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SUPPORT_MESSAGE_COMMAND;
}
