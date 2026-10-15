import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CommandContext,
  CreateProgramInput,
  ProgramSummary,
  ScheduleItemStatus,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

interface ProgramRow {
  id: string;
  name: string;
  description: string | null;
  minimumAgeMonths: number | null;
  maximumAgeMonths: number | null;
  status: ScheduleItemStatus;
  version: number;
  createdAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: ProgramSummary | null;
}

interface NormalizedProgramInput {
  name: string;
  description: string | null;
  minimumAgeMonths: number | null;
  maximumAgeMonths: number | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '23505';
}

function toProgramSummary(row: ProgramRow): ProgramSummary {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.minimumAgeMonths === null ? {} : { minimumAgeMonths: row.minimumAgeMonths }),
    ...(row.maximumAgeMonths === null ? {} : { maximumAgeMonths: row.maximumAgeMonths }),
    status: row.status,
    version: row.version,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function normalizeInput(input: CreateProgramInput): NormalizedProgramInput {
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const minimumAgeMonths = input.minimumAgeMonths ?? null;
  const maximumAgeMonths = input.maximumAgeMonths ?? null;

  if (!name) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      detail: 'Program name cannot be blank.',
    });
  }
  if ((minimumAgeMonths !== null && (!Number.isInteger(minimumAgeMonths) || minimumAgeMonths < 0))
    || (maximumAgeMonths !== null && (!Number.isInteger(maximumAgeMonths) || maximumAgeMonths < 0))) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      detail: 'Program ages must be non-negative whole months.',
    });
  }
  if (minimumAgeMonths !== null && maximumAgeMonths !== null && maximumAgeMonths < minimumAgeMonths) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      detail: 'Maximum age must be greater than or equal to minimum age.',
    });
  }

  return { name, description, minimumAgeMonths, maximumAgeMonths };
}

@Injectable()
export class ProgramService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(
    context: CommandContext,
    input: CreateProgramInput,
  ): Promise<{ program: ProgramSummary; replayed: boolean }> {
    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          requestFingerprint,
        ],
      );

      if (!reservation.rowCount) {
        const existing = await client.query<IdempotencyRecord>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1
             AND school_id = $2
             AND principal_id = $3
             AND idempotency_key = $4
           FOR UPDATE`,
          [
            context.organizationId,
            context.schoolId,
            context.principalId,
            context.idempotencyKey,
          ],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON program idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different program command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { program: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching program command is being processed.',
        });
      }

      let created;
      try {
        created = await client.query<ProgramRow>(
          `INSERT INTO hon.programs (
             organization_id, school_id, name, description, minimum_age_months, maximum_age_months
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING
             id,
             name,
             description,
             minimum_age_months AS "minimumAgeMonths",
             maximum_age_months AS "maximumAgeMonths",
             status::text AS status,
             version,
             created_at AS "createdAt"`,
          [
            context.organizationId,
            context.schoolId,
            normalized.name,
            normalized.description,
            normalized.minimumAgeMonths,
            normalized.maximumAgeMonths,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({
            code: 'PROGRAM_NAME_EXISTS',
            detail: 'A program with this name already exists for the school.',
          });
        }
        throw error;
      }
      const row = created.rows[0];
      if (!row) throw new Error('HON program insert did not return a record.');

      const program = toProgramSummary(row);
      const payload = {
        programId: program.id,
        name: program.name,
        description: program.description ?? null,
        minimumAgeMonths: program.minimumAgeMonths ?? null,
        maximumAgeMonths: program.maximumAgeMonths ?? null,
        status: program.status,
        version: program.version,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         )
         VALUES (
           $1, $2, $3, $4, 'program.create', 'PROGRAM', $5::uuid,
           NULL, $6::jsonb, 'SUCCEEDED', $7::uuid, $8::uuid, $9::uuid, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          program.id,
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
          context.actionRequestId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         )
         VALUES (
           $1::uuid, $2, $3, 'program.created', 1, 'PROGRAM', $4::uuid,
           $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          program.id,
          program.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1
           AND school_id = $2
           AND principal_id = $3
           AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(program),
        ],
      );

      return { program, replayed: false };
    });
  }
}
