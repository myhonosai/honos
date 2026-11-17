import { Injectable } from '@nestjs/common';
import { CUSTOM_TOOL_CHANGE_COMMAND, CUSTOM_TOOL_READ_COMMAND, CUSTOM_TOOL_RECORD_COMMAND, CUSTOM_TOOL_SAVE_COMMAND } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0415: reads are same-origin GETs; saving a draft, changing a tool and writing a record are each their own browser command. */
@Injectable()
export class CustomToolReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CUSTOM_TOOL_READ_COMMAND;
}
@Injectable()
export class CustomToolSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CUSTOM_TOOL_SAVE_COMMAND;
}
@Injectable()
export class CustomToolChangeHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CUSTOM_TOOL_CHANGE_COMMAND;
}
@Injectable()
export class CustomToolRecordHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CUSTOM_TOOL_RECORD_COMMAND;
}
