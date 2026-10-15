import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ActionDecisionDto {
  @IsIn(['APPROVED', 'DENIED'])
  decision!: 'APPROVED' | 'DENIED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
