import { Injectable } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

@Injectable()
export class TestingHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'testing';
}
