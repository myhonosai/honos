import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** WB2 (0361): the read and each website command are their own same-origin browser command; no delegated or automated selector. */
@Injectable()
export class SchoolWebsiteReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.read';
}
@Injectable()
export class SchoolWebsiteCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.create';
}
@Injectable()
export class SchoolWebsiteSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.save';
}
@Injectable()
export class SchoolWebsitePublishHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.publish';
}
@Injectable()
export class SchoolWebsiteRollbackHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.rollback';
}
@Injectable()
export class SchoolWebsiteUnpublishHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.unpublish';
}
/** WB5 (0380): asking Marcus, applying and dismissing a suggestion are each their own browser command. */
@Injectable()
export class SchoolWebsiteAiRequestHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.ai.request';
}
@Injectable()
export class SchoolWebsiteAiApplyHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.ai.apply';
}
@Injectable()
export class SchoolWebsiteAiDismissHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'website.ai.dismiss';
}
