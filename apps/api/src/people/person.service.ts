import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, CreatePersonInput, HonTier, PersonSummary } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { decodeListCursor, encodeListCursor, staleListCursor } from '../foundation/list-cursor.js';

function fingerprint(input: CreatePersonInput): string {
  return createHash('sha256').update(JSON.stringify({
    givenName: input.givenName.trim(), familyName: input.familyName.trim(),
    email: input.email?.trim().toLowerCase() ?? null, phoneE164: input.phoneE164 ?? null,
  })).digest('hex');
}

/** A directory position is the last person's (id, version); their live name keys are read from the row. */
const PERSON_CURSOR = ['uuid', 'version'] as const;

@Injectable()
export class PersonService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: CommandContext, query?: string, page: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<{ people: PersonSummary[]; nextCursor: string | null; limit: number }> {
    const needle = query?.trim() || null;
    const limit = page.limit ?? 50;
    // Signed and bound to the exact school and search text; verified before any database work. The cursor names the
    // last row by (id, version) only, so no name text travels in URLs or logs and its size is fixed.
    const after = decodeListCursor(page.cursor, 'people.directory', context.schoolId, { query: needle }, PERSON_CURSOR);
    return this.database.withTenantTransaction(context, async (client) => {
      if (after) {
        // The anchor's live sort keys position the page. If that person was edited or removed since the previous page,
        // the position is no longer the one the reader saw: refuse and let the client reload rather than skip rows.
        const anchor = await client.query(
          'SELECT 1 FROM hon.people WHERE organization_id = $1 AND school_id = $2 AND id = $3::uuid AND version = $4::bigint',
          [context.organizationId, context.schoolId, after[0], after[1]],
        );
        if (anchor.rowCount !== 1) staleListCursor();
      }
      // Keyset page in directory order with the id as a unique tiebreaker. The row comparison uses the same collation
      // as the ORDER BY, so no row is repeated or skipped between pages.
      const result = await client.query<PersonSummary>(
        `SELECT p.id, p.given_name AS "givenName", p.family_name AS "familyName", p.email::text AS email,
                p.phone_e164 AS "phoneE164", p.version, p.created_at AS "createdAt"
         FROM hon.people AS p
         WHERE p.organization_id = $1 AND p.school_id = $2
           AND ($3::text IS NULL OR concat_ws(' ', p.given_name, p.family_name, p.email::text, p.phone_e164) ILIKE '%' || $3 || '%')
           AND ($5::uuid IS NULL OR (p.family_name, p.given_name, p.created_at, p.id) > (
             SELECT a.family_name, a.given_name, a.created_at, a.id FROM hon.people AS a
             WHERE a.organization_id = $1 AND a.school_id = $2 AND a.id = $5::uuid))
         ORDER BY p.family_name ASC, p.given_name ASC, p.created_at ASC, p.id ASC
         LIMIT $4`,
        [context.organizationId, context.schoolId, needle, limit + 1, after?.[0] ?? null],
      );
      const rows = result.rows.slice(0, limit);
      const last = result.rows.length > limit ? rows[rows.length - 1] : undefined;
      const nextCursor = last
        ? encodeListCursor('people.directory', context.schoolId, { query: needle }, PERSON_CURSOR, [last.id, String(last.version)])
        : null;
      return { people: rows, nextCursor, limit };
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
