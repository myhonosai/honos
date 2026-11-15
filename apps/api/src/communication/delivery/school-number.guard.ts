import { Injectable } from '@nestjs/common';
import { SCHOOL_NUMBER_CANCEL_COMMAND, SCHOOL_NUMBER_ORDER_COMMAND } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../../billing/membership-activation-human-ui.guard.js';

/** 0352: search and the order list are same-origin GETs; ordering and cancelling are each their own browser command. */
@Injectable()
export class SchoolNumberReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'communication.number.read';
}
@Injectable()
export class SchoolNumberOrderHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_NUMBER_ORDER_COMMAND;
}
@Injectable()
export class SchoolNumberCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_NUMBER_CANCEL_COMMAND;
}
