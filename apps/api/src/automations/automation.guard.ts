import { Injectable } from '@nestjs/common';
import {
  AUTOMATION_ACTIVATE_COMMAND, AUTOMATION_ARCHIVE_COMMAND, AUTOMATION_CREATE_COMMAND, AUTOMATION_PAUSE_COMMAND, AUTOMATION_RESTORE_COMMAND, AUTOMATION_SAVE_COMMAND,
  CONTACT_TAG_ADD_COMMAND, CONTACT_TAG_LOOKUP_COMMAND, CONTACT_TAG_REMOVE_COMMAND,
} from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0416: reads are same-origin GETs; every command (and the batch tag lookup) is its own browser command. */
@Injectable()
export class AutomationReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'automation.workflow.read';
}
@Injectable()
export class AutomationCreateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_CREATE_COMMAND;
}
@Injectable()
export class AutomationSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_SAVE_COMMAND;
}
@Injectable()
export class AutomationRestoreHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_RESTORE_COMMAND;
}
@Injectable()
export class AutomationArchiveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_ARCHIVE_COMMAND;
}
@Injectable()
export class ContactTagAddHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONTACT_TAG_ADD_COMMAND;
}
@Injectable()
export class ContactTagRemoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONTACT_TAG_REMOVE_COMMAND;
}
@Injectable()
export class ContactTagLookupHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CONTACT_TAG_LOOKUP_COMMAND;
}
@Injectable()
export class AutomationActivateHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_ACTIVATE_COMMAND;
}
@Injectable()
export class AutomationPauseHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = AUTOMATION_PAUSE_COMMAND;
}
