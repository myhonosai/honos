import type { AttendanceStatus } from './index.js';
import type { CrmLeadStatus, InvoiceStatus } from './operations-report.js';

/** Current entity states, plus range-bounded activity; no historical reconstruction. */
export interface OrganizationOperationsMetrics {
  studentProfiles: { total: number; active: number };
  leads: { byStatus: Record<CrmLeadStatus, number> };
  classSessions: {
    inRange: { draft: number; scheduled: number; completed: number; cancelled: number };
    /** SCHEDULED sessions with starts_at in [from,to) and strictly before generatedAt. */
    scheduledDueInRange: number;
  };
  /** Current attendance outcomes for class sessions whose starts_at is in [from,to). */
  attendance: { inRangeByStatus: Record<AttendanceStatus, number> };
  recentActivity: {
    /** CRM entries whose occurred_at is in [from,to), independent of lead state. */
    crmActivitiesInRange: number;
    /** Attendance entries whose recorded_at is in [from,to), independent of session date. */
    attendanceEntriesRecordedInRange: number;
  };
  invoices: {
    /** Current status of invoices created in [from,to); not revenue or cash receipts. */
    inRangeByStatus: Record<InvoiceStatus, number>;
    /** SUM(total_minor) by current invoice status, never mixing/converting currencies. */
    amountsByCurrency: Array<{ currency: string; totalMinorByStatus: Record<InvoiceStatus, number> }>;
  };
}

/**
 * Single database snapshot. Only ACTIVE schools with a live effective reporting.view
 * grant for the verified human are included. `aggregate` is over exactly `schools`,
 * never an all-organization total or a count of hidden schools. No person, membership,
 * principal, contact, provider, directory or raw operational records are represented.
 * Default UTC window: trailing 30 days; explicit bounds together, at most 92 days.
 * `from` is inclusive and `to` exclusive. Entity statuses are current at read time.
 */
export interface OrganizationOperationsSummary {
  organizationId: string;
  entitlementTier: 'CORE' | 'COMPLETE';
  generatedAt: string;
  from: string;
  to: string;
  scope: 'AUTHORIZED_SCHOOLS_ONLY';
  schoolCount: number;
  aggregate: OrganizationOperationsMetrics;
  schools: Array<{ schoolId: string; metrics: OrganizationOperationsMetrics }>;
}

export interface OrganizationOperationsSummaryResponse {
  operationsSummary: OrganizationOperationsSummary;
}
