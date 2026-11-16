import { Injectable } from '@nestjs/common';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';

/** 0400: the board read is a GET; moving a lead and saving stages are each their own same-origin browser command. */
@Injectable()
export class CrmPipelineBoardReadHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.pipeline.board.read';
}
@Injectable()
export class CrmLeadStageMoveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.lead.stage.move';
}
@Injectable()
export class CrmPipelineStagesSaveHumanUiGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'crm.pipeline.stages.save';
}
