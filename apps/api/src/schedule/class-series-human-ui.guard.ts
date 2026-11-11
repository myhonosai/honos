import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** B-SCH-1 (0239): each class-series command is its own same-origin browser command; the reads are GET only. */
@Injectable()
export class ClassSeriesCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.create';
}
@Injectable()
export class ClassSeriesReviseHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.revise';
}
@Injectable()
export class ClassSeriesEndHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.end';
}
@Injectable()
export class ClassSeriesFillHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.fill';
}
@Injectable()
export class ClassSeriesReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.read';
}
/** B-SCH-2 (0251): switching a series to ongoing and the page's top-up are their own same-origin browser commands. */
@Injectable()
export class ClassSeriesOngoingHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.ongoing';
}
@Injectable()
export class ClassSeriesTopUpHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'schedule.series.top_up';
}
