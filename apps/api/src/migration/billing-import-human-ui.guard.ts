import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0334: staging, decisions, finalize and the reads are each their own same-origin browser command; no delegated or automated selector. */
@Injectable()
export class BillingImportStageHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.import.stage';
}
@Injectable()
export class BillingImportDecideHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.import.decide';
}
@Injectable()
export class BillingImportFinalizeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.import.finalize';
}
@Injectable()
export class BillingImportReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'billing.import.read';
}
