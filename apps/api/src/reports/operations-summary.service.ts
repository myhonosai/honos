import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { CRM_LEAD_STATUSES, INVOICE_STATUSES } from '@hon/contracts';
import type { OrganizationOperationsMetrics, OrganizationOperationsSummary, AttendanceStatus } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { normalizeOperationsReportRange, type OperationsReportRangeInput } from './operations-report.service.js';

const ATTENDANCE_STATUSES: readonly AttendanceStatus[] = ['PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP'];
function safeNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid HON operations summary aggregate.');
  return value;
}
function counts<K extends string>(keys: readonly K[], source: Record<K, number>): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, safeNumber(source[key])])) as Record<K, number>;
}
function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid HON operations summary timestamp.');
  return date.toISOString();
}

/** Explicit response allowlist: never spread an operational/database row. */
function metrics(row: OrganizationOperationsMetrics): OrganizationOperationsMetrics {
  const currencies = new Set<string>();
  return {
    studentProfiles: { total: safeNumber(row.studentProfiles.total), active: safeNumber(row.studentProfiles.active) },
    leads: { byStatus: counts(CRM_LEAD_STATUSES, row.leads.byStatus) },
    classSessions: {
      inRange: counts(['draft', 'scheduled', 'completed', 'cancelled'] as const, row.classSessions.inRange),
      scheduledDueInRange: safeNumber(row.classSessions.scheduledDueInRange),
    },
    attendance: { inRangeByStatus: counts(ATTENDANCE_STATUSES, row.attendance.inRangeByStatus) },
    recentActivity: {
      crmActivitiesInRange: safeNumber(row.recentActivity.crmActivitiesInRange),
      attendanceEntriesRecordedInRange: safeNumber(row.recentActivity.attendanceEntriesRecordedInRange),
    },
    invoices: {
      inRangeByStatus: counts(INVOICE_STATUSES, row.invoices.inRangeByStatus),
      amountsByCurrency: row.invoices.amountsByCurrency.map((amounts) => {
        if (!/^[A-Z]{3}$/.test(amounts.currency) || currencies.has(amounts.currency)) throw new Error('Invalid HON operations summary currency.');
        currencies.add(amounts.currency);
        return { currency: amounts.currency, totalMinorByStatus: counts(INVOICE_STATUSES, amounts.totalMinorByStatus) };
      }),
    },
  };
}

@Injectable()
export class OperationsSummaryService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(externalSubject: string, organizationId: string, input: OperationsReportRangeInput): Promise<OrganizationOperationsSummary> {
    // UUID route parsing accepts uppercase hex; PostgreSQL emits canonical lower case.
    organizationId = organizationId.toLowerCase();
    const range = normalizeOperationsReportRange(input);
    let row: OrganizationOperationsSummary;
    try {
      row = await this.database.readOrganizationOperationsSummary(externalSubject, organizationId, range.from, range.to);
    } catch (error) {
      const failure = error as { code?: string; message?: string } | null | undefined;
      if (failure?.code === '42501') {
        const tierDenied = failure.message === 'TIER_ENTITLEMENT_REQUIRED';
        throw new ForbiddenException({
          code: tierDenied ? 'TIER_ENTITLEMENT_REQUIRED' : 'OPERATIONS_SUMMARY_FORBIDDEN',
          detail: tierDenied ? 'An active Core or Complete entitlement is required.' : 'HON organization operations reporting is not authorized.',
        });
      }
      if (failure?.code === '22023') throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A bounded operations summary range is required.' });
      throw error;
    }
    if (!row || row.organizationId !== organizationId || !['CORE', 'COMPLETE'].includes(row.entitlementTier)
      || row.scope !== 'AUTHORIZED_SCHOOLS_ONLY' || row.schoolCount !== row.schools.length || row.schoolCount < 1
      || iso(row.from) !== range.from || iso(row.to) !== range.to) throw new Error('Invalid HON operations summary scope.');
    const schools = new Set<string>();
    return {
      organizationId, entitlementTier: row.entitlementTier, generatedAt: iso(row.generatedAt),
      from: range.from, to: range.to, scope: 'AUTHORIZED_SCHOOLS_ONLY', schoolCount: safeNumber(row.schoolCount),
      aggregate: metrics(row.aggregate),
      schools: row.schools.map((school) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(school.schoolId)
          || schools.has(school.schoolId)) throw new Error('Invalid HON operations summary school.');
        schools.add(school.schoolId);
        return { schoolId: school.schoolId, metrics: metrics(school.metrics) };
      }),
    };
  }
}
