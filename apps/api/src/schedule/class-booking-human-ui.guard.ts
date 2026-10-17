import { Injectable } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** HTTP transport gate only; never replaces live canonical booking authorization. */
@Injectable()
export class ClassBookingHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'class-booking';
}
