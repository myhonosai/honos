import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { STAFF_SEARCH_QUERY_MAX } from '@hon/contracts';

export class StaffSearchQueryDto {
  @IsString() @MinLength(1) @MaxLength(STAFF_SEARCH_QUERY_MAX)
  q!: string;

  @IsOptional() @IsString() @MaxLength(80)
  types?: string;
}
