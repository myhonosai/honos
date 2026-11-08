import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListLeadsDto {
  @IsOptional()
  @IsIn(['OPEN', 'WON', 'LOST', 'ARCHIVED'])
  status?: 'OPEN' | 'WON' | 'LOST' | 'ARCHIVED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque keyset cursor from the previous page's meta.nextCursor. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}
