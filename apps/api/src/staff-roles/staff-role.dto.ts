import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { CreateCustomRoleInput, GrantStaffRoleInput, RevokeStaffRoleInput, UpdateCustomRoleInput } from '@hon/contracts';

export class RolePermissionsDto {
  @IsString() @MinLength(1) @MaxLength(100)
  name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsString({ each: true }) @MaxLength(100, { each: true })
  permissionCodes!: string[];
}
export class CreateCustomRoleDto extends RolePermissionsDto implements CreateCustomRoleInput {
  @IsString() @Matches(/^CUSTOM_[A-Z][A-Z0-9_]{1,47}$/)
  code!: string;
}
export class UpdateCustomRoleDto extends RolePermissionsDto implements UpdateCustomRoleInput {
  @IsInt() @Min(1) @Max(999999999)
  expectedVersion!: number;
}
export class GrantStaffRoleDto implements GrantStaffRoleInput {
  @IsUUID() roleId!: string;
  @IsUUID() targetPrincipalId!: string;
  @IsString() @MinLength(1) @MaxLength(200)
  targetExternalSubject!: string;
  @IsOptional() @IsString() @MaxLength(40)
  effectiveUntil?: string | undefined;
}
export class RevokeStaffRoleDto implements RevokeStaffRoleInput {
  @IsInt() @Min(1) @Max(999999999)
  expectedVersion!: number;
}
