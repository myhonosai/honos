import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0497: the journal reads are GETs; the save is its own same-origin browser command. */
@Injectable()
export class KaiJournalReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'kai_journal.read';
}
@Injectable()
export class KaiJournalSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'kai_journal.save';
}
@Injectable()
export class KaiTeamJournalReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'kai_journal.team_read';
}
