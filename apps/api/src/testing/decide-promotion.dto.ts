import {
  PROMOTION_DECISION_STATUSES,
  type DecidePromotionInput,
  type PromotionDecisionStatus,
} from '@hon/contracts';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** A human instructor's final decision for an already-final testing candidate. */
export class DecidePromotionDto implements DecidePromotionInput {
  @IsIn([...PROMOTION_DECISION_STATUSES])
  status!: PromotionDecisionStatus;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  rationale!: string;
}
