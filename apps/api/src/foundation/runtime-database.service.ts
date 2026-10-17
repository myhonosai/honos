import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { withTenantTransaction, type TenantTransactionContext } from '@hon/database';
import type { HonTier, AiControlPlaneSnapshot, AiControlPlaneKind, AiProviderConnectionWrite, AiCatalogEntryWrite, AiRoutingPolicyWrite, AiTaskProfileWrite, AiTaskProfileRegistry, AiRoutingRegistry, HqPlatformOverview, HqSchoolDirectory, OrganizationOperationsSummary, SchoolCommandCenterProjection, SchoolHealthScoreProjection, RetentionReviewSignals, RetentionReviewSignalsContext } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResponse } from '@hon/contracts';

export interface ResolvedStaffReportingScope {
  organizationId: string;
  schoolId: string;
}

export interface StaffReportingSchoolChoice extends ResolvedStaffReportingScope {
  organizationName: string;
  schoolName: string;
}

export interface ResolvedPrincipalScope {
  principalId: string;
  organizationId: string;
  schoolId: string;
}

interface TestingCertificateRuntimeContext extends TenantTransactionContext {
  externalSubject: string;
  source: 'HUMAN_UI';
  idempotencyKey: string;
  correlationId: string;
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

  async submitKioskHandoff(terminalSession: string, claim: string): Promise<void> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const logging = await client.query<{ safe: boolean }>("SELECT current_setting('log_parameter_max_length')='0' safe");
      if (logging.rows[0]?.safe !== true) throw new Error('KIOSK_UNAVAILABLE');
      await client.query('SELECT hon.submit_kiosk_handoff($1,$2)', [terminalSession,claim]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      throw new Error('KIOSK_UNAVAILABLE');
    } finally { client.release(); }
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

  /** Dashboard-only default. No selector, principal metadata, or candidate list. */
  async resolveCurrentStaffReportingScope(externalSubject: string): Promise<ResolvedStaffReportingScope | undefined> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedStaffReportingScope>(
      'SELECT organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_current_staff_reporting_scope($1)',
      [externalSubject],
    );
    if (result.rows.length !== 1) return undefined;
    const scope = result.rows[0]!;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (Object.keys(scope).length !== 2 || typeof scope.organizationId !== 'string' || typeof scope.schoolId !== 'string'
      || !uuid.test(scope.organizationId) || !uuid.test(scope.schoolId)) {
      throw new ServiceUnavailableException('Current staff reporting scope is unavailable.');
    }
    return { organizationId: scope.organizationId, schoolId: scope.schoolId };
  }

  /** Dashboard-only subject read. No tenant GUC, caller selector or table query. */
  async readStaffReportingSchools(externalSubject: string): Promise<StaffReportingSchoolChoice[]> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const posture = await client.query<{ safe: boolean }>(`SELECT current_user = 'hon_runtime'
        AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid) AS safe
        FROM pg_roles WHERE rolname = current_user`);
      if (posture.rows[0]?.safe !== true) throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
      const result = await client.query<StaffReportingSchoolChoice>(
        'SELECT organization_id AS "organizationId", school_id AS "schoolId", organization_name AS "organizationName", school_name AS "schoolName" FROM hon.read_staff_reporting_schools($1)',
        [externalSubject],
      );
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const unsafeName = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
      const safeName = (value: unknown): value is string => typeof value === 'string' && value.length > 0
        && Array.from(value).length <= 120 && value.trim() === value && !unsafeName.test(value);
      const seen = new Set<string>();
      if (result.rows.length === 1 || result.rows.length > 20) throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
      const schools = result.rows.map((school) => {
        if (Object.keys(school).length !== 4 || typeof school.organizationId !== 'string' || typeof school.schoolId !== 'string'
          || !uuid.test(school.organizationId) || !uuid.test(school.schoolId)
          || !safeName(school.organizationName) || !safeName(school.schoolName) || seen.has(school.schoolId.toLowerCase())) {
          throw new ServiceUnavailableException('Staff reporting schools are unavailable.');
        }
        seen.add(school.schoolId.toLowerCase());
        return { organizationId: school.organizationId.toLowerCase(), schoolId: school.schoolId.toLowerCase(),
          organizationName: school.organizationName, schoolName: school.schoolName };
      });
      await client.query('COMMIT');
      return schools;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async resolveOwnerLaunchScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>('SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_owner_launch_scope($1)', [externalSubject])).rows[0];
  }

  async ownerLaunchCommand(context: import('@hon/contracts').OwnerLaunchContext, input?: import('@hon/contracts').RegisterStudentInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      if (!input) return (await client.query<{ data: unknown }>('SELECT hon.read_owner_launch($1) data', [context.externalSubject])).rows[0]!.data;
      return (await client.query<{ data: unknown }>('SELECT hon.register_owner_launch_student($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])).rows[0]!.data;
    });
  }

  /** Fixed selector-free owner receipt confirmation; it never reads a caller-selected student or school. */
  async readOwnerLaunchSavedStudents(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      return (await client.query<{ data: unknown }>('SELECT hon.read_owner_launch_saved_students($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Selector-free confirmation. Ordinary transaction supports existing IAM SHARE locks; zero writes. */
  async readOwnerLaunchFirstClassBookingContext(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.read_owner_launch_first_class_booking_context($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Fixed selector-free current DRAFT confirmation, no table access or command side effect. */
  async readOwnerLaunchMembershipDraft(context: import('@hon/contracts').OwnerLaunchContext): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.read_owner_launch_membership_draft($1) data', [context.externalSubject])).rows[0]!.data;
    });
  }

  /** Fixed receipt-only owner-launch booking wrapper; no client student/class/program/school selector reaches SQL. */
  async bookOwnerLaunchFirstClass(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').BookOwnerLaunchFirstClassInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      return (await client.query<{ data: unknown }>('SELECT hon.book_owner_launch_first_class($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId])).rows[0]!.data;
    });
  }

  /** Fixed receipt-only DRAFT command; canonical writes and evidence are wholly database-owned. */
  async draftOwnerLaunchMembership(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').DraftOwnerLaunchMembershipInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.draft_owner_launch_membership($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId])).rows[0]!.data;
    });
  }

  async ownerLaunchGuardianChildCommand(context: import('@hon/contracts').OwnerLaunchContext, input: import('@hon/contracts').RegisterGuardianChildInput): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source,context.externalSubject,context.actionRequestId ?? '',context.delegatedByPrincipalId ?? '']);
      return (await client.query<{data:unknown}>('SELECT hon.register_owner_launch_guardian_child($1,$2::jsonb,$3,$4::uuid,$5::uuid) data', [context.externalSubject,JSON.stringify(input),context.idempotencyKey,context.requestId,context.correlationId])).rows[0]!.data;
    });
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
  async resolveChadFollowUpAssistantScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_chad_follow_up_scope($1)', [externalSubject],
    )).rows[0];
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
  async resolveTeachingStudioScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_teaching_studio_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  /** Claire has no client school selector; SQL returns only one live eligible staff scope. */
  async resolveTeachingAssistantScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_teaching_assistant_scope($1)', [externalSubject],
    )).rows[0];
  }
  async resolveRetentionReviewScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_retention_review_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveTestingCertificateScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_testing_certificate_scope($1,$2::uuid)', [externalSubject, schoolId],
    )).rows[0];
  }
  async resolveTestingScorecardScope(externalSubject: string, schoolId: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_testing_scorecard_scope($1,$2::uuid)', [externalSubject, schoolId],
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

  /** Fixed direct-human workforce scope; the database rejects ambiguous school scope. */
  async resolveInstructorQualificationScope(externalSubject: string): Promise<ResolvedPrincipalScope | undefined> {
    await this.assertRuntimePosture();
    return (await this.getPool().query<ResolvedPrincipalScope>(
      'SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId" FROM hon.resolve_instructor_qualification_scope($1)',
      [externalSubject],
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

  async readSchoolCommandCenter(
    externalSubject: string, organizationId: string, schoolId: string,
  ): Promise<SchoolCommandCenterProjection> {
    await this.assertRuntimePosture();
    // The fixed SECURITY DEFINER projection independently resolves the verified
    // human, selected school, exact reporting.view, and live entitlement. Do not
    // establish caller-controlled tenant/principal GUCs for this aggregate read.
    const result = await this.getPool().query<{ data: SchoolCommandCenterProjection }>(
      'SELECT hon.read_school_command_center($1,$2::uuid,$3::uuid) AS data',
      [externalSubject, organizationId, schoolId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON Command Center projection did not return a result.');
    return row.data;
  }

  async readSchoolHealthScore(
    externalSubject: string, organizationId: string, schoolId: string,
  ): Promise<SchoolHealthScoreProjection> {
    await this.assertRuntimePosture();
    // This fixed SECURITY DEFINER projection independently resolves verified
    // human/school/reporting/tier authority. Selectors never become caller GUCs.
    const result = await this.getPool().query<{ data: SchoolHealthScoreProjection }>(
      'SELECT hon.read_school_health_score($1,$2::uuid,$3::uuid) AS data',
      [externalSubject, organizationId, schoolId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('HON School Health Score projection did not return a result.');
    return row.data;
  }

  private async retentionAttentionTransaction(context: RetentionReviewSignalsContext, readOnly: boolean, work: (client: PoolClient) => Promise<unknown>): Promise<unknown> {
    const scopedWork = async (client: PoolClient) => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      return work(client);
    };
    // PostgreSQL must enter READ ONLY before any context-setting statement. The
    // fixed helper establishes tenant GUCs and checks context only after BEGIN
    // READ ONLY; the attention-specific source/subject GUCs follow inside that
    // same transaction. Command paths retain the ordinary write boundary.
    return readOnly
      ? this.withTenantReadOnlyTransaction(context, scopedWork)
      : this.withTenantTransaction(context, scopedWork);
  }
  async readRetentionAttentionAlerts(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.retentionAttentionTransaction(context, true, async client => (await client.query('SELECT hon.read_retention_attention_alerts($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data);
  }
  async readRetentionAttentionEvidence(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.retentionAttentionTransaction(context, true, async client => (await client.query('SELECT hon.read_retention_attention_evidence($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data);
  }
  async recordRetentionAttentionAlert(context: RetentionReviewSignalsContext, membershipId: string, input: import('@hon/contracts').RetentionAttentionRecordInput): Promise<unknown> {
    return this.retentionAttentionTransaction(context, false, async client => (await client.query('SELECT hon.record_retention_attention_alert($1,$2::uuid,$3,$4,$5::timestamptz,$6,$7::uuid,$8::uuid,$9::uuid) AS data', [context.externalSubject, membershipId, input.evidenceVersion, input.evidenceFingerprint, input.observedAt, input.evidenceCode, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data);
  }
  async resolveRetentionAttentionAlert(context: RetentionReviewSignalsContext, membershipId: string, input: import('@hon/contracts').RetentionAttentionResolutionInput): Promise<unknown> {
    return this.retentionAttentionTransaction(context, false, async client => (await client.query('SELECT hon.resolve_retention_attention_alert($1,$2::uuid,$3::uuid,$4::integer,$5,$6::uuid,$7::uuid,$8::uuid) AS data', [context.externalSubject, membershipId, input.alertId, input.expectedAlertVersion, input.resolutionReason, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data);
  }

  async readRetentionReviewAcknowledgementEvidence(context: RetentionReviewSignalsContext, membershipId: string): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      return (await client.query('SELECT hon.read_retention_review_acknowledgement_evidence($1,$2::uuid) AS data', [context.externalSubject, membershipId])).rows[0]?.data;
    });
  }
  async acknowledgeRetentionReviewEvidence(context: RetentionReviewSignalsContext, membershipId: string, input: { evidenceVersion: string; evidenceFingerprint: string; observedAt: string; idempotencyKey: string }): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      return (await client.query('SELECT hon.acknowledge_retention_review_evidence($1,$2::uuid,$3,$4,$5::timestamptz,$6::uuid,$7::uuid,$8::uuid) AS data', [context.externalSubject, membershipId, input.evidenceVersion, input.evidenceFingerprint, input.observedAt, input.idempotencyKey, context.requestId, context.correlationId])).rows[0]?.data;
    });
  }

  async readRetentionReviewSignals(
    context: RetentionReviewSignalsContext, membershipId: string,
  ): Promise<RetentionReviewSignals> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      const result = await client.query<{ data: RetentionReviewSignals }>(
        'SELECT hon.read_retention_review_signals($1,$2::uuid) AS data', [context.externalSubject, membershipId],
      );
      if (!result.rows[0]) throw new Error('HON Retention Review Signals projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async readTestingCertificate(
    context: TestingCertificateRuntimeContext, testingCandidateId: string,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_testing_certificate($1,$2::uuid) AS data', [context.externalSubject, testingCandidateId],
      );
      if (!result.rows[0]) throw new Error('HON testing certificate projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async issueTestingCertificate(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, input: object,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.issue_testing_certificate($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
        [context.externalSubject, testingCandidateId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      );
      if (!result.rows[0]) throw new Error('HON testing certificate issue did not return a receipt.');
      return result.rows[0].data;
    });
  }

  async readTestingScorecard(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, testingEventId: string,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET TRANSACTION READ ONLY");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_testing_scorecard($1,$2::uuid,$3::uuid) AS data', [context.externalSubject, testingCandidateId, testingEventId],
      );
      if (!result.rows[0]) throw new Error('HON testing scorecard projection did not return a result.');
      return result.rows[0].data;
    });
  }

  async recordTestingScorecardEvaluation(
    context: TestingCertificateRuntimeContext, testingCandidateId: string, testingEventId: string, input: object,
  ): Promise<unknown> {
    return this.withTenantTransaction(context, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
      await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.record_testing_scorecard_evaluation($1,$2::uuid,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) AS data',
        [context.externalSubject, testingCandidateId, testingEventId, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId],
      );
      if (!result.rows[0]) throw new Error('HON testing scorecard record did not return a receipt.');
      return result.rows[0].data;
    });
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

  /**
   * One fixed, selector-free HQ aggregate projection. The database function
   * independently resolves the exact HQ scope; no tenant/principal GUC or
   * caller-provided role is established here. READ ONLY prevents every audit,
   * outbox, work, Action Engine, provider, usage, financial, membership, school,
   * or communication side effect even if a future implementation drifts.
   */
  async readHqPlatformOverview(externalSubject: string): Promise<HqPlatformOverview> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0");
      const result = await client.query<{ data: HqPlatformOverview }>(
        'SELECT hon.read_hq_platform_overview($1) AS data',
        [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON HQ overview projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One fixed, selector-free HQ customer-account projection. The database
   * independently resolves live HQ authority; the READ ONLY snapshot makes
   * audit, outbox, work, provider, payment, messaging, and domain effects
   * impossible at this boundary.
   */
  async readHqSchoolDirectory(externalSubject: string): Promise<HqSchoolDirectory> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'; SET LOCAL log_parameter_max_length_on_error = 0");
      const result = await client.query<{ data: HqSchoolDirectory }>(
        'SELECT hon.read_hq_school_directory($1) AS data',
        [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON HQ school-directory projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Minimal subject-only choices; no tenant GUC, table read, or command effect. */
  async readParentPlannedAbsenceRequestContext(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
      const result = await client.query<{ data: unknown }>('SELECT hon.read_parent_planned_absence_request_context($1) AS data', [externalSubject]);
      if (!result.rows[0]) throw new Error('HON parent absence context unavailable.');
      await client.query('COMMIT');
      return result.rows[0].data;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async resolveParentJourneyScopes(externalSubject: string): Promise<ResolvedParentFamilyScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedParentFamilyScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId",
              family_id AS "familyId", access_level::text AS "accessLevel"
       FROM hon.resolve_parent_journey_scopes($1)`, [externalSubject],
    );
    return result.rows;
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents accidental audit,
   * outbox, provider, or billing mutation effects at this boundary.
   */
  async readParentTestingStatus(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_testing_status($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent testing status projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents audit, outbox,
   * schedule, attendance, provider, or billing mutation effects at this boundary.
   */
  async readParentPlannedAbsenceHistory(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_planned_absence_history($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent planned-absence history projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed projection resolves its own exact current guardian-family scope.
   * Repeatable-read + READ ONLY makes queue, consent, provider, audit, outbox,
   * action, AI, voice, automation, and payment mutation impossible here.
   */
  async readParentMessageHistory(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_message_history($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent message-history projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The fixed database projection resolves its own exact current guardian-family
   * scope. A repeatable-read, read-only transaction prevents accidental audit,
   * outbox, provider, or billing mutation effects at this boundary.
   */
  async readParentBillingView(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_billing_view($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent billing projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Selector-free, independent live guardian resolver; no tenant GUC or raw table query. */
  async readParentClassPassView(externalSubject: string): Promise<unknown> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '3s'");
      const result = await client.query<{ data: unknown }>(
        'SELECT hon.read_parent_classpass_view($1) AS data', [externalSubject],
      );
      await client.query('COMMIT');
      if (!result.rows[0]) throw new Error('HON parent ClassPass projection did not return a result.');
      return result.rows[0].data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async resolveTestingRegistrationReviewScopes(externalSubject: string): Promise<ResolvedPrincipalScope[]> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<ResolvedPrincipalScope>(
      `SELECT principal_id AS "principalId", organization_id AS "organizationId", school_id AS "schoolId"
       FROM hon.resolve_testing_registration_review_scopes($1)`, [externalSubject],
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

  async writeAiControlPlaneFromHq(externalSubject: string, kind: AiControlPlaneKind, payload: AiProviderConnectionWrite | AiCatalogEntryWrite | AiRoutingPolicyWrite | AiTaskProfileWrite, idempotencyKey: string, requestId: string): Promise<{ recordId: string; version: number; replayed: boolean }> {
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

  async resolveAiTaskProfileRegistryFromHq(externalSubject: string, profileId: string): Promise<AiTaskProfileRegistry> {
    await this.assertRuntimePosture();
    const result = await this.getPool().query<{ data: AiTaskProfileRegistry }>(
      'SELECT hon.hq_ai_task_profile_registry($1, $2::uuid) AS data', [externalSubject, profileId],
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

  /**
   * Starts read-only before establishing tenant GUCs. PostgreSQL rejects
   * `SET TRANSACTION READ ONLY` after any context-setting query, so read-only
   * staff projections must use this boundary rather than changing transaction
   * mode inside an already initialized tenant transaction.
   */
  async withTenantReadOnlyTransaction<T>(
    context: TenantTransactionContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await this.assertRuntimePosture();
    const client = await this.getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `SELECT
          set_config('app.hon_organization_id', $1, true),
          set_config('app.hon_school_id', $2, true),
          set_config('app.hon_principal_id', $3, true),
          set_config('app.hon_principal_type', $4, true),
          set_config('app.hon_request_id', $5, true)`,
        [context.organizationId, context.schoolId, context.principalId, context.principalType, context.requestId],
      );
      await client.query('SELECT hon.require_tenant_context()');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
