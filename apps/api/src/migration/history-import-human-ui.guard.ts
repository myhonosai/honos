import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0333: staging, decisions, finalize and the reads are each their own same-origin browser command; no delegated or automated selector. */
@Injectable()
export class HistoryImportStageHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'history.import.stage';
}
@Injectable()
export class HistoryImportDecideHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'history.import.decide';
}
@Injectable()
export class HistoryImportFinalizeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'history.import.finalize';
}
@Injectable()
export class HistoryImportReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'history.import.read';
}
