import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { withTenantTransaction, type TenantTransactionContext } from '@hon/database';
import type { HonTier, AiControlPlaneSnapshot, AiControlPlaneKind, AiProviderConnectionWrite, AiCatalogEntryWrite, AiRoutingPolicyWrite, AiRoutingRegistry, OrganizationOperationsSummary } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResponse } from '@hon/contracts';

export interface ResolvedPrincipalScope {
  principalId: string;
  organizationId: string;
  schoolId: string;
}

export interface ResolvedHqOperatorScope {
  principalId: string;
  hqRole: 'HON_HQ_OWNER' | 'HON_HQ_OPERATOR' | 'HON_HQ_SUPPORT';
}

export interface ResolvedParentFamilyScope extends ResolvedPrincipalScope {
  familyId: string;
  accessLevel: 'PRIMARY_GUARDIAN' | 'SECONDARY_GUARDIAN' | 'VIEWER';
}

export interface HqSchoolProvisioningCommand {
  externalSubject: string;
  legalName: string;
  displayName: string;
  schoolName: string;
  schoolSlug: string;
  timezone: string;
  initialTier: HonTier;
  idempotencyKey: string;
  requestFingerprint: string;
  requestId: string;
  correlationId: string;
}

export interface HqSchoolProvisioningResult {
  organizationId: string;
  schoolId: string;
  ownerRoleId: string;
  replayed: boolean;
}

@Injectable()
export class RuntimeDatabaseService implements OnModuleDestroy {
  private pool: Pool | undefined;
  private postureCheck: Promise<void> | undefined;

  isConfigured(): boolean {
    return Boolean(process.env.HON_RUNTIME_DATABASE_URL);
  }

  private getPool(): Pool {
    const connectionString = process.env.HON_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      throw new ServiceUnavailableException({
        type: 'https://hon.example/problems/runtime-database-not-configured',
        title: 'HON runtime database is not configured',
        status: 503,
        code: 'PERSISTENCE_NOT_CONFIGURED',
        detail: 'HON refuses to use the privileged migration connection at runtime.',
      });
    }

    this.pool ??= new Pool({
      connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    return this.pool;
  }

  async probe(): Promise<void> {
    await this.assertRuntimePosture();
    await this.getPool().query('SELECT 1');
  }

  private async assertRuntimePosture(): Promise<void> {
    this.postureCheck ??= (async () => {
      const result = await this.getPool().query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      const role = result.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls) {
        throw new ServiceUnavailableException({
          type: 'https://hon.example/problems/runtime-database-role-unsafe',
          title: 'HON runtime database role is unsafe',
          status: 503,
          code: 'PERSISTENCE_NOT_CONFIGURED',
          detail: 'HON requires a non-superuser PostgreSQL role without BYPASSRLS for runtime data access.',
        });
      }
    })();
    try {
      await this.postureCheck;
    } catch (error) {
      this.postureCheck = undefined;
      throw error;
    }
  }

  async resolveAuthorizedScope(
    externalSubject: string,
    schoolId: string,
    permissionCode: string,
  ): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      `SELECT
         principal_id AS "principalId",
         organization_id AS "organizationId",
         school_id AS "schoolId"
       FROM hon.resolve_authorized_scope($1, $2::uuid, $3)`,
      [externalSubject, schoolId, permissionCode],
    );
    return result.rows[0];
  }

  async resolvePublicFormScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_public_form_scope($1,$2)', [externalSubject, permission],
    )).rows[0];
  }
  async readPublishedLeadForm(publicId: string): Promise<import('@hon/contracts').PublishedLeadForm | null> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<{ data: import('@hon/contracts').PublishedLeadForm | null }>('SELECT hon.read_published_form($1) data', [publicId])).rows[0]!.data;
  }
  async submitPublishedLeadForm(publicId: string, input: object, key: string): Promise<string> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      const result = await client.query<{ result: string }>('SELECT hon.submit_public_form($1,$2::jsonb,$3) result', [publicId, JSON.stringify(input), key]);
      await client.query('COMMIT');
      return result.rows[0]!.result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveHumanWorkScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_human_work_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveFollowUpScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_follow_up_scope($1)', [externalSubject],
    );
    return result.rows[0];
  }
  async resolveMarketplaceScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_marketplace_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveAchievementScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_achievement_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveCommunityScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_community_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveRenewalScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_renewal_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveAutomationRuleScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_automation_rule_scope($1,$2)', [externalSubject, permission],
    )).rows[0];
  }

  async resolveStaffAvailabilityScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_staff_availability_scope($1,$2)',
      [externalSubject, permission],
    )).rows[0];
  }

  async resolveCampaignScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_campaign_scope($1,$2)',
      [externalSubject, permission],
    )).rows[0];
  }
  async resolveLeadImportScope(externalSubject: string, permission: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_lead_import_scope($1,$2)',
      [externalSubject,permission],
    )).rows[0];
  }

  async readOrganizationOperationsSummary(
    externalSubject: string, organizationId: string, from: string, to: string,
  ): Promise<OrganizationOperationsSummary> {
    await this.assertRuntimePosture();
    // One read-only statement: IAM, entitlement, school set and metrics use the
    // same database snapshot. Never widen school RLS or set an organization GUC.
    const result = await this.getPool().query<{ data: OrganizationOperationsSummary }>(
      'SELECT hon.read_organization_operations_summary($1, $2::uuid, $3::timestamptz, $4::timestamptz) AS data',
      [externalSubject, organizationId, from, to],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON operations summary projection did not return a result.');
    return row.data;
  }

  async readStaffSearch(externalSubject: string, organizationId: string, schoolId: string,
    q: string, types: StaffSearchKind[], entityId?: string): Promise<StaffSearchResponse> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      const result = await client.query<{ data: StaffSearchResponse }>(
        'SELECT hon.search_school($1,$2::uuid,$3::uuid,$4,$5::text[],$6::uuid) AS data',
        [externalSubject, organizationId, schoolId, q, types, entityId ?? null],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON search projection did not return a result.');
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveHqOperatorScope(
    externalSubject: string,
    permissionCode: string,
  ): Promise<ResolvedHqOperatorScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedHqOperatorScope>(
      `SELECT principal_id AS "principalId", hq_role AS "hqRole"
       FROM hon.resolve_hq_operator_scope($1, $2)`,
      [externalSubject, permissionCode],
    );
    return result.rows[0];
  }

  async resolveParentFamilyScopes(externalSubject: string, schoolId: string): Promise<ResolvedParentFamilyScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedParentFamilyScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId",
              family_id AS "familyId", access_level::text AS "accessLevel"
       FROM hon.resolve_parent_family_scope($1, $2::uuid)`,
      [externalSubject, schoolId],
    );
    return result.rows;
  }

  async provisionSchoolFromHq(command: HqSchoolProvisioningCommand): Promise<HqSchoolProvisioningResult> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<HqSchoolProvisioningResult>(
      `SELECT organization_id AS "organizationId", school_id AS "schoolId", owner_role_id AS "ownerRoleId", replayed
       FROM hon.provision_school_from_hq($1, $2, $3, $4, $5, $6, $7::hon.plan_tier, $8, $9, $10::uuid, $11::uuid)`,
      [
        command.externalSubject,
        command.legalName,
        command.displayName,
        command.schoolName,
        command.schoolSlug,
        command.timezone,
        command.initialTier,
        command.idempotencyKey,
        command.requestFingerprint,
        command.requestId,
        command.correlationId,
      ],
    );
    const provisioned = result.rows[0];
    if (!provisioned) throw new Error('HON HQ tenant provisioning did not return a result.');
    return provisioned;
  }

  async readAiControlPlaneFromHq(externalSubject: string): Promise<AiControlPlaneSnapshot> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiControlPlaneSnapshot }>(
      'SELECT hon.hq_ai_control_plane_read($1) AS data', [externalSubject],
    );
    return result.rows[0]!.data;
  }

  async writeAiControlPlaneFromHq(externalSubject: string, kind: AiControlPlaneKind, payload: AiProviderConnectionWrite | AiCatalogEntryWrite | AiRoutingPolicyWrite, idempotencyKey: string, requestId: string): Promise<{ recordId: string; version: number; replayed: boolean }> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: { recordId: string; version: number; replayed: boolean } }>(
      'SELECT hon.hq_ai_control_plane_write($1, $2, $3::jsonb, $4::uuid, $5::uuid) AS data',
      [externalSubject, kind, JSON.stringify(payload), idempotencyKey, requestId],
    );
    return result.rows[0]!.data;
  }

  async resolveAiRoutingRegistryFromHq(externalSubject: string, policyId: string): Promise<AiRoutingRegistry> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiRoutingRegistry }>(
      'SELECT hon.hq_ai_routing_registry($1, $2::uuid) AS data', [externalSubject, policyId],
    );
    return result.rows[0]!.data;
  }

  async withTenantTransaction<T>(
    context: TenantTransactionContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      return await withTenantTransaction(client, context, work);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
