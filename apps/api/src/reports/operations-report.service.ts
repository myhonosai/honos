import { BadRequestException, Injectable } from '@nestjs/common';
import type { OperationalSnapshot } from '@hon/contracts';
import type { TenantTransactionContext } from '@hon/database';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const MAX_RANGE_MILLISECONDS = 92 * 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export interface OperationsReportRangeInput {
  from?: string;
  to?: string;
}

export interface NormalizedOperationsReportRange {
  from: string;
  to: string;
}

interface OperationsReportReadContext extends TenantTransactionContext {
  organizationId: string;
  schoolId: string;
}

type CountValue = string | number;

interface OperationalSnapshotRow {
  generatedAt: Date | string;
  studentProfilesTotal: CountValue;
  leadOpen: CountValue;
  leadWon: CountValue;
  leadLost: CountValue;
  leadArchived: CountValue;
  sessionsScheduled: CountValue;
  sessionsCompleted: CountValue;
  sessionsCancelled: CountValue;
  attendancePresent: CountValue;
  attendanceLate: CountValue;
  attendanceExcusedAbsence: CountValue;
  attendanceUnexcusedAbsence: CountValue;
  attendanceMakeup: CountValue;
  membershipsDraft: CountValue;
  membershipsActive: CountValue;
  membershipsFrozen: CountValue;
  membershipsCancellationPending: CountValue;
  membershipsCancelled: CountValue;
  membershipsExpired: CountValue;
  invoicesDraft: CountValue;
  invoicesOpen: CountValue;
  invoicesPaid: CountValue;
  invoicesVoid: CountValue;
  invoicesUncollectible: CountValue;
  paymentsPending: CountValue;
  paymentsProcessing: CountValue;
  paymentsSucceeded: CountValue;
  paymentsFailed: CountValue;
  paymentsRequiresAction: CountValue;
  paymentsUnknown: CountValue;
  paymentsRefunded: CountValue;
}

function validationError(detail: string): BadRequestException {
  return new BadRequestException({ code: 'VALIDATION_FAILED', detail });
}

function parseIsoInstant(value: string, field: 'from' | 'to'): Date {
  const normalized = value.trim();
  if (!ISO_INSTANT.test(normalized)) {
    throw validationError(`${field} must be an ISO 8601 timestamp with a timezone.`);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError(`${field} must be a valid ISO 8601 timestamp.`);
  }
  return parsed;
}

/**
 * The upper bound is exclusive. A client must provide both timezone-qualified
 * bounds, otherwise the service supplies a trailing 30-day UTC range. This
 * deliberately prevents unbounded operational reads on a pooled runtime role.
 */
export function normalizeOperationsReportRange(
  input: OperationsReportRangeInput,
): NormalizedOperationsReportRange {
  if (input.from === undefined && input.to === undefined) {
    const to = new Date();
    const from = new Date(to.getTime() - DEFAULT_RANGE_MILLISECONDS);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw validationError('from and to must be supplied together as ISO 8601 timestamps with timezones.');
  }

  const from = parseIsoInstant(input.from, 'from');
  const to = parseIsoInstant(input.to, 'to');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0) throw validationError('to must be later than from.');
  if (duration > MAX_RANGE_MILLISECONDS) {
    throw validationError('The requested operations report range cannot exceed 92 days.');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function asSafeNonNegativeInteger(value: CountValue, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`HON operations report query returned an invalid ${field} aggregate.`);
  }
  return numeric;
}

function asIso(value: Date | string, field: string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`HON operations report query returned an invalid ${field}.`);
  return parsed.toISOString();
}

@Injectable()
export class OperationsReportService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /**
   * Read-only, aggregate-only school snapshot. The query deliberately selects no
   * person/contact fields, IDs, invoice/payment amounts, provider data, or row
   * records. The current schema does not preserve historical state transitions,
   * so current-state entity counts are kept distinct from range-bounded activity.
   */
  async read(
    context: OperationsReportReadContext,
    input: OperationsReportRangeInput,
  ): Promise<OperationalSnapshot> {
    const range = normalizeOperationsReportRange(input);
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<OperationalSnapshotRow>(
        `WITH
           scoped_student_profiles AS MATERIALIZED (
             SELECT 1
             FROM hon.student_profiles
             WHERE organization_id = $1::uuid AND school_id = $2::uuid
           ),
           scoped_leads AS MATERIALIZED (
             SELECT status::text AS status
             FROM hon.crm_leads
             WHERE organization_id = $1::uuid AND school_id = $2::uuid
           ),
           ranged_sessions AS MATERIALIZED (
             SELECT id, status::text AS status
             FROM hon.class_sessions
             WHERE organization_id = $1::uuid
               AND school_id = $2::uuid
               AND starts_at >= $3::timestamptz
               AND starts_at < $4::timestamptz
           ),
           ranged_attendance AS MATERIALIZED (
             SELECT attendance.status::text AS status
             FROM hon.attendance_records AS attendance
             JOIN ranged_sessions AS session ON session.id = attendance.class_session_id
             WHERE attendance.organization_id = $1::uuid
               AND attendance.school_id = $2::uuid
           ),
           scoped_memberships AS MATERIALIZED (
             SELECT state::text AS state
             FROM hon.memberships
             WHERE organization_id = $1::uuid AND school_id = $2::uuid
           ),
           ranged_invoices AS MATERIALIZED (
             SELECT status::text AS status
             FROM hon.invoices
             WHERE organization_id = $1::uuid
               AND school_id = $2::uuid
               AND created_at >= $3::timestamptz
               AND created_at < $4::timestamptz
           ),
           ranged_payment_attempts AS MATERIALIZED (
             SELECT state::text AS state
             FROM hon.payment_attempts
             WHERE organization_id = $1::uuid
               AND school_id = $2::uuid
               AND initiated_at >= $3::timestamptz
               AND initiated_at < $4::timestamptz
           )
         SELECT
           now() AS "generatedAt",
           (SELECT COUNT(*) FROM scoped_student_profiles) AS "studentProfilesTotal",
           (SELECT COUNT(*) FILTER (WHERE status = 'OPEN') FROM scoped_leads) AS "leadOpen",
           (SELECT COUNT(*) FILTER (WHERE status = 'WON') FROM scoped_leads) AS "leadWon",
           (SELECT COUNT(*) FILTER (WHERE status = 'LOST') FROM scoped_leads) AS "leadLost",
           (SELECT COUNT(*) FILTER (WHERE status = 'ARCHIVED') FROM scoped_leads) AS "leadArchived",
           (SELECT COUNT(*) FILTER (WHERE status = 'SCHEDULED') FROM ranged_sessions) AS "sessionsScheduled",
           (SELECT COUNT(*) FILTER (WHERE status = 'COMPLETED') FROM ranged_sessions) AS "sessionsCompleted",
           (SELECT COUNT(*) FILTER (WHERE status = 'CANCELLED') FROM ranged_sessions) AS "sessionsCancelled",
           (SELECT COUNT(*) FILTER (WHERE status = 'PRESENT') FROM ranged_attendance) AS "attendancePresent",
           (SELECT COUNT(*) FILTER (WHERE status = 'LATE') FROM ranged_attendance) AS "attendanceLate",
           (SELECT COUNT(*) FILTER (WHERE status = 'EXCUSED_ABSENCE') FROM ranged_attendance) AS "attendanceExcusedAbsence",
           (SELECT COUNT(*) FILTER (WHERE status = 'UNEXCUSED_ABSENCE') FROM ranged_attendance) AS "attendanceUnexcusedAbsence",
           (SELECT COUNT(*) FILTER (WHERE status = 'MAKEUP') FROM ranged_attendance) AS "attendanceMakeup",
           (SELECT COUNT(*) FILTER (WHERE state = 'DRAFT') FROM scoped_memberships) AS "membershipsDraft",
           (SELECT COUNT(*) FILTER (WHERE state = 'ACTIVE') FROM scoped_memberships) AS "membershipsActive",
           (SELECT COUNT(*) FILTER (WHERE state = 'FROZEN') FROM scoped_memberships) AS "membershipsFrozen",
           (SELECT COUNT(*) FILTER (WHERE state = 'CANCELLATION_PENDING') FROM scoped_memberships) AS "membershipsCancellationPending",
           (SELECT COUNT(*) FILTER (WHERE state = 'CANCELLED') FROM scoped_memberships) AS "membershipsCancelled",
           (SELECT COUNT(*) FILTER (WHERE state = 'EXPIRED') FROM scoped_memberships) AS "membershipsExpired",
           (SELECT COUNT(*) FILTER (WHERE status = 'DRAFT') FROM ranged_invoices) AS "invoicesDraft",
           (SELECT COUNT(*) FILTER (WHERE status = 'OPEN') FROM ranged_invoices) AS "invoicesOpen",
           (SELECT COUNT(*) FILTER (WHERE status = 'PAID') FROM ranged_invoices) AS "invoicesPaid",
           (SELECT COUNT(*) FILTER (WHERE status = 'VOID') FROM ranged_invoices) AS "invoicesVoid",
           (SELECT COUNT(*) FILTER (WHERE status = 'UNCOLLECTIBLE') FROM ranged_invoices) AS "invoicesUncollectible",
           (SELECT COUNT(*) FILTER (WHERE state = 'PENDING') FROM ranged_payment_attempts) AS "paymentsPending",
           (SELECT COUNT(*) FILTER (WHERE state = 'PROCESSING') FROM ranged_payment_attempts) AS "paymentsProcessing",
           (SELECT COUNT(*) FILTER (WHERE state = 'SUCCEEDED') FROM ranged_payment_attempts) AS "paymentsSucceeded",
           (SELECT COUNT(*) FILTER (WHERE state = 'FAILED') FROM ranged_payment_attempts) AS "paymentsFailed",
           (SELECT COUNT(*) FILTER (WHERE state = 'REQUIRES_ACTION') FROM ranged_payment_attempts) AS "paymentsRequiresAction",
           (SELECT COUNT(*) FILTER (WHERE state = 'UNKNOWN') FROM ranged_payment_attempts) AS "paymentsUnknown",
           (SELECT COUNT(*) FILTER (WHERE state = 'REFUNDED') FROM ranged_payment_attempts) AS "paymentsRefunded"`,
        [context.organizationId, context.schoolId, range.from, range.to],
      );
      const row = result.rows[0];
      if (!row) throw new Error('HON operations report aggregation did not return a result.');

      return {
        organizationId: context.organizationId,
        schoolId: context.schoolId,
        generatedAt: asIso(row.generatedAt, 'generatedAt'),
        from: range.from,
        to: range.to,
        studentProfiles: {
          total: asSafeNonNegativeInteger(row.studentProfilesTotal, 'studentProfilesTotal'),
        },
        leads: {
          byStatus: {
            OPEN: asSafeNonNegativeInteger(row.leadOpen, 'leadOpen'),
            WON: asSafeNonNegativeInteger(row.leadWon, 'leadWon'),
            LOST: asSafeNonNegativeInteger(row.leadLost, 'leadLost'),
            ARCHIVED: asSafeNonNegativeInteger(row.leadArchived, 'leadArchived'),
          },
        },
        classSessions: {
          inRange: {
            scheduled: asSafeNonNegativeInteger(row.sessionsScheduled, 'sessionsScheduled'),
            completed: asSafeNonNegativeInteger(row.sessionsCompleted, 'sessionsCompleted'),
            cancelled: asSafeNonNegativeInteger(row.sessionsCancelled, 'sessionsCancelled'),
          },
        },
        attendance: {
          inRangeByStatus: {
            PRESENT: asSafeNonNegativeInteger(row.attendancePresent, 'attendancePresent'),
            LATE: asSafeNonNegativeInteger(row.attendanceLate, 'attendanceLate'),
            EXCUSED_ABSENCE: asSafeNonNegativeInteger(row.attendanceExcusedAbsence, 'attendanceExcusedAbsence'),
            UNEXCUSED_ABSENCE: asSafeNonNegativeInteger(row.attendanceUnexcusedAbsence, 'attendanceUnexcusedAbsence'),
            MAKEUP: asSafeNonNegativeInteger(row.attendanceMakeup, 'attendanceMakeup'),
          },
        },
        memberships: {
          byState: {
            DRAFT: asSafeNonNegativeInteger(row.membershipsDraft, 'membershipsDraft'),
            ACTIVE: asSafeNonNegativeInteger(row.membershipsActive, 'membershipsActive'),
            FROZEN: asSafeNonNegativeInteger(row.membershipsFrozen, 'membershipsFrozen'),
            CANCELLATION_PENDING: asSafeNonNegativeInteger(row.membershipsCancellationPending, 'membershipsCancellationPending'),
            CANCELLED: asSafeNonNegativeInteger(row.membershipsCancelled, 'membershipsCancelled'),
            EXPIRED: asSafeNonNegativeInteger(row.membershipsExpired, 'membershipsExpired'),
          },
        },
        invoices: {
          inRangeByStatus: {
            DRAFT: asSafeNonNegativeInteger(row.invoicesDraft, 'invoicesDraft'),
            OPEN: asSafeNonNegativeInteger(row.invoicesOpen, 'invoicesOpen'),
            PAID: asSafeNonNegativeInteger(row.invoicesPaid, 'invoicesPaid'),
            VOID: asSafeNonNegativeInteger(row.invoicesVoid, 'invoicesVoid'),
            UNCOLLECTIBLE: asSafeNonNegativeInteger(row.invoicesUncollectible, 'invoicesUncollectible'),
          },
        },
        paymentAttempts: {
          inRangeByState: {
            PENDING: asSafeNonNegativeInteger(row.paymentsPending, 'paymentsPending'),
            PROCESSING: asSafeNonNegativeInteger(row.paymentsProcessing, 'paymentsProcessing'),
            SUCCEEDED: asSafeNonNegativeInteger(row.paymentsSucceeded, 'paymentsSucceeded'),
            FAILED: asSafeNonNegativeInteger(row.paymentsFailed, 'paymentsFailed'),
            REQUIRES_ACTION: asSafeNonNegativeInteger(row.paymentsRequiresAction, 'paymentsRequiresAction'),
            UNKNOWN: asSafeNonNegativeInteger(row.paymentsUnknown, 'paymentsUnknown'),
            REFUNDED: asSafeNonNegativeInteger(row.paymentsRefunded, 'paymentsRefunded'),
          },
        },
      };
    });
  }
}
