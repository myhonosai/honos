import { Injectable } from '@nestjs/common';
import {
  SOCIAL_ACCOUNT_CHANGE_COMMAND, SOCIAL_CONNECT_COMMAND, SOCIAL_CONNECT_COMPLETE_COMMAND, SOCIAL_POST_APPROVE_COMMAND, SOCIAL_POST_CANCEL_COMMAND,
  SOCIAL_POST_CREATE_COMMAND, SOCIAL_POST_EDIT_COMMAND, SOCIAL_POST_RESOLVE_COMMAND, SOCIAL_READ_COMMAND,
} from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../../billing/membership-activation-human-ui.guard.js';

/** 0347: the read is a same-origin GET; starting, completing and changing are each their own browser command. */
@Injectable()
export class SchoolSocialReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_READ_COMMAND;
}
@Injectable()
export class SchoolSocialConnectHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_CONNECT_COMMAND;
}
@Injectable()
export class SchoolSocialCompleteHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_CONNECT_COMPLETE_COMMAND;
}
@Injectable()
export class SchoolSocialChangeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_ACCOUNT_CHANGE_COMMAND;
}

/** 0348 posts: the calendar read is a same-origin GET (the 0347 read command); each post change is its own browser command. */
@Injectable()
export class SchoolSocialPostCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_POST_CREATE_COMMAND;
}
@Injectable()
export class SchoolSocialPostEditHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_POST_EDIT_COMMAND;
}
@Injectable()
export class SchoolSocialPostApproveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_POST_APPROVE_COMMAND;
}
@Injectable()
export class SchoolSocialPostCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_POST_CANCEL_COMMAND;
}
@Injectable()
export class SchoolSocialPostResolveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SOCIAL_POST_RESOLVE_COMMAND;
}
