import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreatePersonDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  givenName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  familyName!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Matches(/^\+[1-9]\d{1,14}$/)
  phoneE164?: string;
}

export class ListPeopleDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque keyset cursor from the previous page's meta.nextCursor. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
