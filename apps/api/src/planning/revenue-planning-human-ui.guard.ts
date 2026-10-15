import { Injectable } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
@Injectable()
export class RevenuePlanningHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command: string = 'revenue-planning';
}
