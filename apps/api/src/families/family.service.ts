import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { AddFamilyMemberInput, CommandContext, CreateFamilyInput, FamilyMemberSummary, FamilySummary, HonTier } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function fingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

@Injectable()
export class FamilyService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: CommandContext): Promise<FamilySummary[]> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<FamilySummary>(
        `SELECT family.id, family.display_name AS "displayName", family.status::text AS status, family.version,
                count(member.id)::integer AS "memberCount", family.created_at AS "createdAt"
         FROM hon.families AS family
         LEFT JOIN hon.family_members AS member ON member.family_id=family.id AND member.organization_id=family.organization_id AND member.school_id=family.school_id
         WHERE family.organization_id=$1 AND family.school_id=$2
         GROUP BY family.id ORDER BY family.display_name ASC LIMIT 100`, [context.organizationId, context.schoolId],
      );
      return result.rows;
    });
  }

  async create(context: CommandContext, input: CreateFamilyInput): Promise<{ family: FamilySummary; replayed: boolean }> {
    const normalized = input.displayName.trim();
    if (!normalized) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Family display name cannot be blank.' });
    const requestFingerprint = fingerprint({ displayName: normalized });
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(
        `SELECT tier::text AS tier FROM hon.organization_entitlements WHERE organization_id=$1 AND status='ACTIVE'
         AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())`, [context.organizationId],
      );
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'students.families')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON school-management entitlement is required for family records.' });
      }
      const reserved = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
         VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours')
         ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reserved.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: string; response_body: FamilySummary | null }>(
          `SELECT request_fingerprint,status,response_body FROM hon.idempotency_records
           WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record || record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different family command.' });
        if (record.status === 'COMPLETED' && record.response_body) return { family: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching family command is being processed.' });
      }
      const created = await client.query<FamilySummary>(
        `INSERT INTO hon.families (organization_id,school_id,display_name) VALUES ($1,$2,$3)
         RETURNING id,display_name AS "displayName",status::text AS status,version,0::integer AS "memberCount",created_at AS "createdAt"`,
        [context.organizationId, context.schoolId, normalized],
      );
      const family = created.rows[0]; if (!family) throw new Error('HON family insert did not return a record.');
      const payload = { familyId: family.id, version: family.version, displayName: family.displayName };
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
        VALUES ($1,$2,$3,$4,'family.create','FAMILY',$5::uuid,NULL,$6::jsonb,'SUCCEEDED',$7::uuid,$8::uuid,now())`,
      [context.organizationId, context.schoolId, context.principalId, context.source, family.id, JSON.stringify(payload), context.requestId, context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES ($1::uuid,$2,$3,'family.created',1,'FAMILY',$4::uuid,$5,$6::uuid,$7::uuid,$8::jsonb)`,
      [randomUUID(), context.organizationId, context.schoolId, family.id, family.version, context.correlationId, context.requestId, JSON.stringify(payload)]);
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb
        WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`,
      [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(family)]);
      return { family, replayed: false };
    });
  }

  async addMember(context: CommandContext, familyId: string, input: AddFamilyMemberInput): Promise<{ member: FamilyMemberSummary; replayed: boolean }> {
    const requestFingerprint = fingerprint({ familyId, personId: input.personId, memberRole: input.memberRole, isBillingContact: input.isBillingContact ?? false });
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(`SELECT tier::text AS tier FROM hon.organization_entitlements WHERE organization_id=$1 AND status='ACTIVE' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())`, [context.organizationId]);
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'students.families')) throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON school-management entitlement is required for family membership.' });
      const reserved = await client.query<{ id: string }>(`INSERT INTO hon.idempotency_records (organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours') ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint]);
      if (!reserved.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: string; response_body: FamilyMemberSummary | null }>(`SELECT request_fingerprint,status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey]);
        const record = existing.rows[0];
        if (!record || record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different family member command.' });
        if (record.status === 'COMPLETED' && record.response_body) return { member: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching family member command is being processed.' });
      }
      const family = await client.query(`SELECT id FROM hon.families WHERE id=$1::uuid`, [familyId]);
      if (!family.rowCount) throw new BadRequestException({ code: 'FAMILY_NOT_FOUND', detail: 'The family is not available in this school.' });
      const person = await client.query(`SELECT id FROM hon.people WHERE id=$1::uuid`, [input.personId]);
      if (!person.rowCount) throw new BadRequestException({ code: 'PERSON_NOT_FOUND', detail: 'The person is not available in this school.' });
      const existingMember = await client.query(`SELECT id FROM hon.family_members WHERE family_id=$1::uuid AND person_id=$2::uuid`, [familyId, input.personId]);
      if (existingMember.rowCount) throw new ConflictException({ code: 'FAMILY_MEMBER_EXISTS', detail: 'This person is already linked to the family.' });
      if (input.memberRole === 'STUDENT') {
        const profile = await client.query<{ primary_family_id: string | null }>(`SELECT primary_family_id FROM hon.student_profiles WHERE person_id=$1::uuid`, [input.personId]);
        if (profile.rows[0] && profile.rows[0].primary_family_id !== familyId) throw new ConflictException({ code: 'STUDENT_FAMILY_CONFLICT', detail: 'The student is already linked to a different primary family in this school.' });
      }
      const created = await client.query<Omit<FamilyMemberSummary, 'studentProfileId'>>(`INSERT INTO hon.family_members (organization_id,school_id,family_id,person_id,member_role,is_billing_contact)
        VALUES ($1,$2,$3::uuid,$4::uuid,$5::hon.family_member_role,$6)
        RETURNING id,family_id AS "familyId",person_id AS "personId",member_role::text AS "memberRole",is_billing_contact AS "isBillingContact",created_at AS "createdAt"`, [context.organizationId, context.schoolId, familyId, input.personId, input.memberRole, input.isBillingContact ?? false]);
      const member = created.rows[0]; if (!member) throw new Error('HON family member insert did not return a record.');
      let studentProfileId: string | undefined;
      if (input.memberRole === 'STUDENT') {
        const profile = await client.query<{ id: string }>(`INSERT INTO hon.student_profiles (organization_id,school_id,person_id,primary_family_id) VALUES ($1,$2,$3::uuid,$4::uuid) ON CONFLICT (person_id,organization_id,school_id) DO NOTHING RETURNING id`, [context.organizationId, context.schoolId, input.personId, familyId]);
        studentProfileId = profile.rows[0]?.id;
      }
      const summary: FamilyMemberSummary = { ...member, ...(studentProfileId ? { studentProfileId } : {}) };
      const payload = { familyId, personId: input.personId, memberRole: input.memberRole, studentProfileId: studentProfileId ?? null };
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at) VALUES ($1,$2,$3,$4,'family.member.add','FAMILY_MEMBER',$5::uuid,NULL,$6::jsonb,'SUCCEEDED',$7::uuid,$8::uuid,now())`, [context.organizationId, context.schoolId, context.principalId, context.source, member.id, JSON.stringify(payload), context.requestId, context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES ($1::uuid,$2,$3,'family.member.added',1,'FAMILY',$4::uuid,1,$5::uuid,$6::uuid,$7::jsonb)`, [randomUUID(), context.organizationId, context.schoolId, familyId, context.correlationId, context.requestId, JSON.stringify(payload)]);
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(summary)]);
      return { member: summary, replayed: false };
    });
  }
}
