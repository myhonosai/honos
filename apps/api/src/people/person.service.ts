import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, CreatePersonInput, HonTier, PersonSummary } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

function fingerprint(input: CreatePersonInput): string {
  return createHash('sha256').update(JSON.stringify({
    givenName: input.givenName.trim(), familyName: input.familyName.trim(),
    email: input.email?.trim().toLowerCase() ?? null, phoneE164: input.phoneE164 ?? null,
  })).digest('hex');
}

@Injectable()
export class PersonService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: CommandContext, query?: string): Promise<PersonSummary[]> {
    const needle = query?.trim() || null;
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<PersonSummary>(
        `SELECT id, given_name AS "givenName", family_name AS "familyName", email::text AS email,
                phone_e164 AS "phoneE164", version, created_at AS "createdAt"
         FROM hon.people
         WHERE organization_id = $1 AND school_id = $2
           AND ($3::text IS NULL OR concat_ws(' ', given_name, family_name, email::text, phone_e164) ILIKE '%' || $3 || '%')
         ORDER BY family_name ASC, given_name ASC, created_at ASC
         LIMIT 50`,
        [context.organizationId, context.schoolId, needle],
      );
      return result.rows;
    });
  }

  async create(context: CommandContext, input: CreatePersonInput): Promise<{ person: PersonSummary; replayed: boolean }> {
    const requestFingerprint = fingerprint(input);
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(
        'SELECT tier FROM hon.read_current_organization_entitlement()',
      );
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'students.families')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON school-management entitlement is required to create people.' });
      }
      const reserved = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours')
         ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );
      if (!reserved.rowCount) {
        const existing = await client.query<{ request_fingerprint: string; status: string; response_body: PersonSummary | null }>(
          `SELECT request_fingerprint,status,response_body FROM hon.idempotency_records
           WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON person idempotency record unexpectedly disappeared.');
        if (record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different person.' });
        if (record.status === 'COMPLETED' && record.response_body) return { person: record.response_body, replayed: true };
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching person command is being processed.' });
      }
      const created = await client.query<PersonSummary>(
        `INSERT INTO hon.people (organization_id,school_id,given_name,family_name,email,phone_e164)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id,given_name AS "givenName",family_name AS "familyName",email::text AS email,
                   phone_e164 AS "phoneE164",version,created_at AS "createdAt"`,
        [context.organizationId, context.schoolId, input.givenName.trim(), input.familyName.trim(), input.email?.trim().toLowerCase() ?? null, input.phoneE164 ?? null],
      );
      const person = created.rows[0];
      if (!person) throw new Error('HON person insert did not return a record.');
      const payload = { personId: person.id, version: person.version };
      await client.query(
        `INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
         VALUES ($1,$2,$3,$4,'people.create','PERSON',$5::uuid,NULL,$6::jsonb,'SUCCEEDED',$7::uuid,$8::uuid,now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, person.id, JSON.stringify({ ...payload, person }), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
         VALUES ($1::uuid,$2,$3,'people.person.created',1,'PERSON',$4::uuid,$5,$6::uuid,$7::uuid,$8::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, person.id, person.version, context.correlationId, context.requestId, JSON.stringify(payload)],
      );
      await client.query(
        `UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb
         WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(person)],
      );
      return { person, replayed: false };
    });
  }
}
