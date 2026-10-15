import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateCustomRoleInput, CustomRoleSummary, GrantStaffRoleInput, RevokeStaffRoleInput, StaffRoleActionCode, StaffRoleCommandContext, StaffRoleGrantSummary, StaffRoleMutationResult, UpdateCustomRoleInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only the closed, bounded staff role command contract is accepted.' }); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
}
function object(input: unknown, keys: string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) invalid();
}
function version(input: unknown): void { if (!Number.isSafeInteger(input) || (input as number) < 1 || (input as number) > 999999999) invalid(); }
function human(context: StaffRoleCommandContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
    throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'Staff role administration requires a direct human UI session, never Action Engine, AI, automation, integration or delegation.' });
  }
  for (const id of [context.principalId, context.organizationId, context.schoolId, context.requestId, context.correlationId]) uuid(id);
  text(context.externalSubject, 200);
  if (!context.idempotencyKey || context.idempotencyKey.length > 200 || context.idempotencyKey.trim() !== context.idempotencyKey) {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A bounded Idempotency-Key is required.' });
  }
}
function permissions(input: CreateCustomRoleInput | UpdateCustomRoleInput): void {
  text(input.name, 100);
  if (!Array.isArray(input.permissionCodes) || input.permissionCodes.length < 1 || input.permissionCodes.length > 100 || new Set(input.permissionCodes).size !== input.permissionCodes.length) invalid();
  for (const code of input.permissionCodes) { text(code, 100); if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(code) || /^(hq|platform|system)\./.test(code)) invalid(); }
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'Live scoped human authority, permitted role subset and an eligible registered target are required.' });
  if (code === '22023' || code === '22P02' || code === '22007' || code === '22008') invalid();
  if (code === 'P0002') throw new NotFoundException({ code: 'STAFF_ROLE_NOT_FOUND', detail: 'The role or grant is not available in this school.' });
  if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT', detail: 'Refresh the role/grant state and version before retrying.' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_OR_ROLE_CODE_CONFLICT', detail: 'The key or organization role code is already used.' });
  if (code === '55P03') throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching staff role command is in progress.' });
  throw error;
}

@Injectable()
export class StaffRoleService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  create(context: StaffRoleCommandContext, input: CreateCustomRoleInput): Promise<StaffRoleMutationResult<CustomRoleSummary>> {
    human(context); object(input, ['code', 'name', 'permissionCodes']); permissions(input);
    if (typeof input.code !== 'string' || !/^CUSTOM_[A-Z][A-Z0-9_]{1,47}$/.test(input.code)) invalid();
    return this.mutate(context, 'iam.custom_role.create', null, { ...input, name: input.name.trim(), permissionCodes: [...input.permissionCodes].sort() });
  }
  update(context: StaffRoleCommandContext, roleId: string, input: UpdateCustomRoleInput): Promise<StaffRoleMutationResult<CustomRoleSummary>> {
    human(context); uuid(roleId); object(input, ['name', 'permissionCodes', 'expectedVersion']); permissions(input); version(input.expectedVersion);
    return this.mutate(context, 'iam.custom_role.update', roleId, { ...input, name: input.name.trim(), permissionCodes: [...input.permissionCodes].sort() });
  }
  grant(context: StaffRoleCommandContext, input: GrantStaffRoleInput): Promise<StaffRoleMutationResult<StaffRoleGrantSummary>> {
    human(context); object(input, ['roleId', 'targetPrincipalId', 'targetExternalSubject', 'effectiveUntil']); uuid(input.roleId); uuid(input.targetPrincipalId); text(input.targetExternalSubject, 200);
    if (input.targetPrincipalId === context.principalId) throw new ForbiddenException({ code: 'SELF_ROLE_MUTATION_DENIED', detail: 'An actor cannot grant a role to themself.' });
    if (input.effectiveUntil !== undefined) {
      if (typeof input.effectiveUntil !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(input.effectiveUntil)) invalid();
      const end = Date.parse(input.effectiveUntil);
      if (!Number.isFinite(end) || end <= Date.now() || end > Date.now() + 90 * 86400000) invalid();
      // Reject normalized impossible calendar dates (e.g. February 30).
      const day = Number(input.effectiveUntil.slice(8, 10)); const month = Number(input.effectiveUntil.slice(5, 7)); const year = Number(input.effectiveUntil.slice(0, 4));
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) invalid();
    }
    return this.mutate(context, 'iam.staff_role.grant', null, input);
  }
  revoke(context: StaffRoleCommandContext, grantId: string, input: RevokeStaffRoleInput): Promise<StaffRoleMutationResult<StaffRoleGrantSummary>> {
    human(context); uuid(grantId); object(input, ['expectedVersion']); version(input.expectedVersion);
    return this.mutate(context, 'iam.staff_role.revoke', grantId, input);
  }
  async read(context: StaffRoleCommandContext, kind: 'ROLE' | 'GRANT', id: string): Promise<CustomRoleSummary | StaffRoleGrantSummary> {
    human(context); uuid(id);
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)");
        const result = await client.query<{ data: CustomRoleSummary | StaffRoleGrantSummary }>('SELECT hon.read_staff_role($1,$2,$3::uuid) AS data', [context.externalSubject, kind, id]);
        return result.rows[0]!.data;
      });
    } catch (error) { return boundaryError(error); }
  }
  private async mutate<T extends CustomRoleSummary | StaffRoleGrantSummary>(context: StaffRoleCommandContext, action: StaffRoleActionCode, id: string | null, input: CreateCustomRoleInput | UpdateCustomRoleInput | GrantStaffRoleInput | RevokeStaffRoleInput): Promise<StaffRoleMutationResult<T>> {
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true), set_config('app.hon_action_request_id','',true), set_config('app.hon_delegated_by_principal_id','',true)");
        const result = await client.query<{ data: StaffRoleMutationResult<T> }>('SELECT hon.mutate_staff_role($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) AS data', [context.externalSubject, action, id, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        return result.rows[0]!.data;
      });
    } catch (error) { return boundaryError(error); }
  }
}
