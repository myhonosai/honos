import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CommandContext,
  CreateTrialAppointmentInput,
  CrmAppointmentStatus,
  CrmAppointmentSummary,
  CrmAppointmentType,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const MAX_FUTURE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const TIMEZONE_QUALIFIED_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

interface TrialAppointmentRow {
  id: string;
  crmLeadId: string;
  appointmentType: CrmAppointmentType;
  status: CrmAppointmentStatus;
  startsAt: Date | string;
  endsAt: Date | string;
  location: string | null;
  notes: string | null;
  createdByPrincipalId: string;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface IdempotencyRecord {
  request_fingerprint: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  response_body: CrmAppointmentSummary | null;
}

interface NormalizedTrialAppointmentInput {
  startsAt: string;
  endsAt: string;
  location?: string;
  notes?: string;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function parseStrictTimestamp(value: unknown, field: 'startsAt' | 'endsAt'): Date {
  if (typeof value !== 'string' || !TIMEZONE_QUALIFIED_ISO_TIMESTAMP.test(value)) {
    throw validationError(`${field} must be a timezone-qualified ISO 8601 timestamp.`);
  }

  // Date accepts normalized invalid calendar dates (for example February 30),
  // so validate the individual UTC-calendar components before parsing.
  const [datePart = '', timePart = ''] = value.split('T');
  const [yearPart = '', monthPart = '', dayPart = ''] = datePart.split('-');
  const [hourPart = '', minutePart = '', secondPart = ''] = timePart.slice(0, 8).split(':');
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  if (![year, month, day, hour, minute, second].every(Number.isInteger)
    || year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw validationError('Trial appointment timestamps must be valid ISO 8601 values.');
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) {
    throw validationError('Trial appointment timestamps must be valid ISO 8601 values.');
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError('Trial appointment timestamps must be valid ISO 8601 values.');
  }
  return parsed;
}

/** Repeats transport validation so future adapters cannot bypass command invariants. */
function normalizeInput(input: CreateTrialAppointmentInput): NormalizedTrialAppointmentInput {
  const startsAt = parseStrictTimestamp(input?.startsAt, 'startsAt');
  const endsAt = parseStrictTimestamp(input?.endsAt, 'endsAt');
  const now = Date.now();

  if (startsAt.getTime() <= now) {
    throw validationError('Trial appointments must start in the future.');
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw validationError('Trial appointment end must be strictly later than its start.');
  }
  if (startsAt.getTime() > now + MAX_FUTURE_WINDOW_MS
    || endsAt.getTime() > now + MAX_FUTURE_WINDOW_MS
    || endsAt.getTime() - startsAt.getTime() > MAX_FUTURE_WINDOW_MS) {
    throw validationError('Trial appointments must fit within the next 90 days.');
  }

  const normalizeOptionalText = (
    value: unknown,
    field: 'location' | 'notes',
    maximumLength: number,
  ): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw validationError(`${field} must be a string when provided.`);
    const normalized = value.trim();
    if (!normalized) throw validationError(`${field} cannot be blank when provided.`);
    if (normalized.length > maximumLength) {
      throw validationError(`${field} must be at most ${maximumLength} characters.`);
    }
    return normalized;
  };

  const location = normalizeOptionalText(input.location, 'location', 160);
  const notes = normalizeOptionalText(input.notes, 'notes', 2000);
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
  };
}

function toSummary(row: TrialAppointmentRow): CrmAppointmentSummary {
  return {
    id: row.id,
    crmLeadId: row.crmLeadId,
    appointmentType: row.appointmentType,
    status: row.status,
    startsAt: asIso(row.startsAt),
    endsAt: asIso(row.endsAt),
    ...(row.location === null ? {} : { location: row.location }),
    ...(row.notes === null ? {} : { notes: row.notes }),
    createdByPrincipalId: row.createdByPrincipalId,
    version: row.version,
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

@Injectable()
export class TrialAppointmentService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async schedule(
    context: CommandContext,
    leadId: string,
    input: CreateTrialAppointmentInput,
  ): Promise<{ appointment: CrmAppointmentSummary; replayed: boolean }> {
    // This is a staff human-UI command only. It is deliberately not exposed to
    // the AI Action Engine, integrations, automation, providers, or messaging.
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI') {
      throw new ForbiddenException('HON trial scheduling requires an authenticated human UI command.');
    }

    const normalized = normalizeInput(input);
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ leadId, ...normalized }))
      .digest('hex');

    return this.database.withTenantTransaction(context, async (client) => {
      // The query relies on the transaction's RLS scope, not a caller-supplied
      // tenant predicate. A foreign lead is indistinguishable from a missing one.
      const lead = await client.query<{ id: string }>(
        'SELECT id FROM hon.crm_leads WHERE id = $1::uuid',
        [leadId],
      );
      if (!lead.rowCount) {
        throw new NotFoundException('CRM lead was not found in this school.');
      }

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
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
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON trial idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            detail: 'The idempotency key was already used for a different trial scheduling command.',
          });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { appointment: record.response_body, replayed: true };
        }
        throw new ConflictException({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          detail: 'The matching trial scheduling command is being processed.',
        });
      }

      const inserted = await client.query<TrialAppointmentRow>(
        `INSERT INTO hon.crm_appointments (
           organization_id, school_id, crm_lead_id, appointment_type, status,
           starts_at, ends_at, location, notes, created_by_principal_id
         ) VALUES (
           $1, $2, $3::uuid, 'TRIAL'::hon.crm_appointment_type, 'SCHEDULED'::hon.crm_appointment_status,
           $4::timestamptz, $5::timestamptz, $6, $7, $8::uuid
         )
         RETURNING
           id,
           crm_lead_id AS "crmLeadId",
           appointment_type::text AS "appointmentType",
           status::text AS status,
           starts_at AS "startsAt",
           ends_at AS "endsAt",
           location,
           notes,
           created_by_principal_id AS "createdByPrincipalId",
           version,
           created_at AS "createdAt",
           updated_at AS "updatedAt"`,
        [
          context.organizationId,
          context.schoolId,
          leadId,
          normalized.startsAt,
          normalized.endsAt,
          normalized.location ?? null,
          normalized.notes ?? null,
          context.principalId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('HON trial appointment insert did not return a record.');
      const appointment = toSummary(row);
      const payload = {
        appointmentId: appointment.id,
        crmLeadId: appointment.crmLeadId,
        appointmentType: appointment.appointmentType,
        status: appointment.status,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        location: appointment.location ?? null,
        notes: appointment.notes ?? null,
        createdByPrincipalId: appointment.createdByPrincipalId,
        version: appointment.version,
      };

      // Appointment, audit evidence, durable event, and completed idempotency
      // response commit together; this command mutates no booking or membership.
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code,
           entity_type, entity_id, prior_state, next_state, result,
           request_id, correlation_id, action_request_id, occurred_at
         ) VALUES (
           $1, $2, $3, $4, 'crm.trial.schedule',
           'CRM_APPOINTMENT', $5::uuid, NULL, $6::jsonb, 'SUCCEEDED',
           $7::uuid, $8::uuid, $9::uuid, now()
         )`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          appointment.id,
          JSON.stringify(payload),
          context.requestId,
          context.correlationId,
          context.actionRequestId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version,
           aggregate_type, aggregate_id, aggregate_version, correlation_id,
           causation_id, payload
         ) VALUES (
           $1::uuid, $2, $3, 'crm.trial.scheduled', 1,
           'CRM_APPOINTMENT', $4::uuid, $5, $6::uuid, $7::uuid, $8::jsonb
         )`,
        [
          randomUUID(),
          context.organizationId,
          context.schoolId,
          appointment.id,
          appointment.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.idempotencyKey,
          JSON.stringify(appointment),
        ],
      );

      return { appointment, replayed: false };
    });
  }
}
