import { Injectable } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
@Injectable()
export class ClassPassHumanUiGuard extends CurriculumHumanUiGuard { protected override readonly command = 'classpass'; }
// Domain and database each close the action-specific field set; DTO forbids nonoperational fields globally.
export class ClassPassCommandDto {
 @IsInt() @Min(0) @Max(2147483646) expectedVersion!: number;
 @IsOptional() @IsUUID() programId?: string;
 @IsOptional() @IsUUID() studentProfileId?: string;
 @IsOptional() @IsUUID() passId?: string;
 @IsOptional() @IsString() @MaxLength(100) name?: string;
 @IsOptional() @IsInt() @Min(1) @Max(1000) allowedUses?: number;
 @IsOptional() @IsInt() @Min(1) @Max(365) validityDays?: number;
 @IsOptional() @IsIn(['MANUAL_NONFINANCIAL']) issuanceKind?: 'MANUAL_NONFINANCIAL';
 @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
