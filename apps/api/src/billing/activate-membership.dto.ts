import type { ActivateMembershipInput } from '@hon/contracts';
import { IsInt, Min } from 'class-validator';

/** Human activation accepts only the membership version observed by the operator. */
export class ActivateMembershipDto implements ActivateMembershipInput {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
