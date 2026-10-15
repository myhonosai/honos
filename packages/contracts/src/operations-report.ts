import type { AttendanceStatus, TenantScope } from './index.js';

/** Aggregate-only, current-state CRM lead counts. */
export const CRM_LEAD_STATUSES = ['OPEN', 'WON', 'LOST', 'ARCHIVED'] as const;
export type CrmLeadStatus = (typeof CRM_LEAD_STATUSES)[number];

/** Aggregate-only, current-state membership counts. */
export const MEMBERSHIP_STATES = [
  'DRAFT',
  'ACTIVE',
  'FROZEN',
  'CANCELLATION_PENDING',
  'CANCELLED',
  'EXPIRED',
] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

/** Current invoice state for invoices created during the requested range. */
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Current processor-attempt state for attempts initiated during the requested range. */
export const PAYMENT_ATTEMPT_STATES = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'REQUIRES_ACTION',
  'UNKNOWN',
  'REFUNDED',
] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

/**
 * A server-derived, aggregate-only operational snapshot for exactly one school.
 *
 * `from` is inclusive and `to` is exclusive. Student, lead, and membership
 * values are current school-scope counts at `generatedAt`; they are intentionally
 * not historical reconstructions because the current schema has no state-change
 * history for those relations. Class-session and attendance values are bounded by
 * class-session `starts_at`. Invoice values are bounded by invoice `created_at`,
 * and payment-attempt values by `initiated_at`. No monetary totals, people,
 * contacts, identifiers, provider data, or row-level records are represented.
 */
export interface OperationalSnapshot extends TenantScope {
  generatedAt: string;
  from: string;
  to: string;
  studentProfiles: {
    total: number;
  };
  leads: {
    byStatus: Record<CrmLeadStatus, number>;
  };
  classSessions: {
    inRange: {
      scheduled: number;
      completed: number;
      cancelled: number;
    };
  };
  attendance: {
    /** Attendance outcomes for sessions whose starts_at falls within the range. */
    inRangeByStatus: Record<AttendanceStatus, number>;
  };
  memberships: {
    byState: Record<MembershipState, number>;
  };
  invoices: {
    inRangeByStatus: Record<InvoiceStatus, number>;
  };
  paymentAttempts: {
    inRangeByState: Record<PaymentAttemptState, number>;
  };
}

/** The endpoint uses an explicit label so consumers cannot mistake it for raw data. */
export interface OperationalReportResponse {
  operationalSnapshot: OperationalSnapshot;
}
