import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0551 calendar cards: create and move are their own same-origin browser commands; the card read is GET only. */
@Injectable()
export class CalendarCardsReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.read';
}
@Injectable()
export class CalendarCardCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.create';
}
@Injectable()
export class CalendarCardMoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.calendar.move';
}
