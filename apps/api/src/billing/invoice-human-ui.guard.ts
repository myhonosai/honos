import { Injectable } from '@nestjs/common';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';

/** Transport only: existing invoice permissions, entitlement and tenant RLS stay decisive. */
@Injectable()
export class InvoiceHumanUiGuard extends CurriculumHumanUiGuard {
  protected override readonly command = 'billing-invoice';
}
