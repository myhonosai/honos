import { Allow } from 'class-validator';
import type { CurriculumEnrollmentPreparationInput } from '@hon/contracts';

/** Only a previously known student profile UUID may be submitted. */
export class CurriculumEnrollmentPreparationDto implements CurriculumEnrollmentPreparationInput {
  @Allow() declare studentProfileId: string;
}
