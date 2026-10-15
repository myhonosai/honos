import { IsISO8601, IsOptional, IsString } from 'class-validator';

/** Both bounds are optional only as a pair; the service supplies the trailing 30-day default. */
export class OperationsReportQueryDto {
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true })
  to?: string;
}
