import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0226: staging, decisions, finalize and the two reads are each their own same-origin browser command; no delegated or automated selector. */
@Injectable()
export class StudentImportStageHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.import.stage';
}
@Injectable()
export class StudentImportDecideHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.import.decide';
}
@Injectable()
export class StudentImportFinalizeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.import.finalize';
}
@Injectable()
export class StudentImportReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.import.read';
}
