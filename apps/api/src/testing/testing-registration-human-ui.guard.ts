import { Injectable } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Same-origin marker is CSRF defense only; live family/staff authority is rechecked in SQL. */
@Injectable()
export class TestingRegistrationHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'testing-registration';
}
