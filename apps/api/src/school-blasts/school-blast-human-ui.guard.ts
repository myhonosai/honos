import { Injectable } from '@nestjs/common';
import { SCHOOL_BLAST_COMMANDS, SCHOOL_BLAST_READ_COMMAND } from '@hon/contracts';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0524: each read and command is its own same-origin browser command. */
@Injectable()
export class SchoolBlastReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_BLAST_READ_COMMAND;
}
@Injectable()
export class SchoolBlastSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_BLAST_COMMANDS.save;
}
@Injectable()
export class SchoolBlastSendHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_BLAST_COMMANDS.send;
}
@Injectable()
export class SchoolBlastCancelHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = SCHOOL_BLAST_COMMANDS.cancel;
}
