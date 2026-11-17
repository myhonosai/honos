import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0439: the demo data read is a GET; load and remove are each their own same-origin browser command. */
@Injectable()
export class SchoolDemoDataReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school.demo_data.read';
}
@Injectable()
export class SchoolDemoDataLoadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school.demo_data.load';
}
@Injectable()
export class SchoolDemoDataRemoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'school.demo_data.remove';
}
