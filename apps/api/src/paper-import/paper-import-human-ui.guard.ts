import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0388: every paper import call is its own same-origin browser command; no delegated or automated selector. */
@Injectable()
export class PaperImportReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.read';
}
@Injectable()
export class PaperImportCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.create';
}
@Injectable()
export class PaperImportPageHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.page';
}
@Injectable()
export class PaperImportReadingHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.reading';
}
@Injectable()
export class PaperImportSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.save';
}
@Injectable()
export class PaperImportSendHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.send';
}
@Injectable()
export class PaperImportDeleteHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'students.paper_import.delete';
}
