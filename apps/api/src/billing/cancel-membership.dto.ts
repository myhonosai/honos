import type { CancelMembershipInput } from '@hon/contracts';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A direct human cancellation records a bounded reason and optional
 * timezone-qualified effective timestamp. Tenant, actor, source, and lifecycle
 * target are derived at the guarded route boundary.
 */
export class CancelMembershipDto implements CancelMembershipInput {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  cancellationReason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  effectiveAt?: string | undefined;
}
