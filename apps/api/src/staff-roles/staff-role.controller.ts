import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { StaffRoleActionCode, StaffRoleCommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CreateCustomRoleDto, GrantStaffRoleDto, RevokeStaffRoleDto, UpdateCustomRoleDto } from './staff-role.dto.js';
import { StaffRoleService } from './staff-role.service.js';
import { StaffRoleHumanUiGuard } from './staff-role-human-ui.guard.js';

@Controller('organizations/:organizationId/schools/:schoolId/staff-roles')
@UseGuards(HonIdentityGuard, StaffRoleHumanUiGuard)
export class StaffRoleController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly roles: StaffRoleService) {}
  private async context(organizationId: string, schoolId: string, request: HonRequest, key: string | undefined, permission: StaffRoleActionCode | 'iam.staff_role.manage'): Promise<StaffRoleCommandContext> {
    if (!key || key.length > 200 || key.trim() !== key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A bounded Idempotency-Key header is required.' });
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Staff role administration is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, externalSubject: identity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', idempotencyKey: key, requestId, correlationId: requestId };
  }
  private envelope(context: StaffRoleCommandContext, result: { record: unknown; replayed: boolean }) {
    return { data: result.record, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }
  @Post('custom') @HttpCode(200)
  async create(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Headers('idempotency-key') key: string | undefined, @Body() input: CreateCustomRoleDto, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, key, 'iam.custom_role.create');
    return this.envelope(context, await this.roles.create(context, input));
  }
  @Post('custom/:roleId/update') @HttpCode(200)
  async update(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('roleId', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateCustomRoleDto, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, key, 'iam.custom_role.update');
    return this.envelope(context, await this.roles.update(context, id, input));
  }
  @Post('grants') @HttpCode(200)
  async grant(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Headers('idempotency-key') key: string | undefined, @Body() input: GrantStaffRoleDto, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, key, 'iam.staff_role.grant');
    return this.envelope(context, await this.roles.grant(context, input));
  }
  @Post('grants/:grantId/revoke') @HttpCode(200)
  async revoke(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('grantId', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() input: RevokeStaffRoleDto, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, key, 'iam.staff_role.revoke');
    return this.envelope(context, await this.roles.revoke(context, id, input));
  }
  @Get('custom/:roleId')
  async readRole(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('roleId', new ParseUUIDPipe()) id: string, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, 'read', 'iam.staff_role.manage');
    return this.envelope(context, { record: await this.roles.read(context, 'ROLE', id), replayed: false });
  }
  @Get('grants/:grantId')
  async readGrant(@Param('organizationId', new ParseUUIDPipe()) org: string, @Param('schoolId', new ParseUUIDPipe()) school: string, @Param('grantId', new ParseUUIDPipe()) id: string, @Req() request: HonRequest) {
    const context = await this.context(org, school, request, 'read', 'iam.staff_role.manage');
    return this.envelope(context, { record: await this.roles.read(context, 'GRANT', id), replayed: false });
  }
}
