import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  CommandCenterAvailableCount,
  CommandCenterCountFact,
  CommandCenterMetrics,
  CommandCenterPaidInvoices,
  CommandCenterRecommendation,
  SchoolCommandCenterProjection,
  SchoolCommandCenterSnapshot,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const UNAVAILABLE_REASONS = {
  unansweredInquiries: 'No approved inquiry response-state projection exists.',
  attendanceDecline: 'No approved attendance-decline policy or longitudinal projection exists.',
  trialConversion: 'No authoritative trial-to-enrollment linkage is available.',
  revenue: 'Current paid invoice state is not authoritative cash revenue or collection data.',
} as const;

type Row = Record<string, unknown>;
function invalid(message = 'Invalid HON Command Center projection.'): never { throw new Error(message); }
function row(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Row;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key))) invalid();
  return result;
}
function text(value: unknown, max = 240): string {
  if (typeof value !== 'string' || !value || value.length > max || UNSAFE.test(value)) invalid();
  return value;
}
function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const parsed = new Date(text(value, 80));
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}
function scopedId(value: unknown, expected: string): string {
  const id = text(value, 36).toLowerCase();
  if (!UUID.test(id) || id !== expected) invalid();
  return id;
}
function windowedAvailable(value: unknown, milliseconds: number): CommandCenterAvailableCount {
  const source = row(value, ['availability', 'windowFrom', 'windowTo', 'count']);
  if (source.availability !== 'AVAILABLE') invalid();
  const windowFrom = timestamp(source.windowFrom); const windowTo = timestamp(source.windowTo);
  if (Date.parse(windowTo) - Date.parse(windowFrom) !== milliseconds) invalid();
  return { availability: 'AVAILABLE', windowFrom, windowTo, count: safeCount(source.count) };
}
function available(value: unknown): CommandCenterAvailableCount {
  const source = row(value, ['availability', 'count']);
  if (source.availability !== 'AVAILABLE') invalid();
  return { availability: 'AVAILABLE', count: safeCount(source.count) };
}
function unavailable(
  value: unknown,
  expectedAvailability: 'UNAVAILABLE' | 'INSUFFICIENT_DATA',
  expectedReason: string,
): Extract<CommandCenterCountFact, { availability: 'UNAVAILABLE' | 'INSUFFICIENT_DATA' }> {
  const source = row(value, ['availability', 'reason']);
  if (source.availability !== expectedAvailability || text(source.reason) !== expectedReason) invalid();
  return { availability: expectedAvailability, reason: expectedReason };
}
function paidInvoices(value: unknown): CommandCenterPaidInvoices {
  const source = row(value, ['availability', 'windowFrom', 'windowTo', 'count', 'amountsByCurrency']);
  if (source.availability !== 'AVAILABLE' || !Array.isArray(source.amountsByCurrency)) invalid();
  const windowFrom = timestamp(source.windowFrom); const windowTo = timestamp(source.windowTo);
  if (Date.parse(windowTo) - Date.parse(windowFrom) !== 30 * 86_400_000) invalid();
  const currencies = new Set<string>(); let total = 0; let previous = '';
  const amountsByCurrency = source.amountsByCurrency.map((value) => {
    const currencyRow = row(value, ['currency', 'count', 'totalMinor']);
    const currency = text(currencyRow.currency, 3);
    if (!/^[A-Z]{3}$/.test(currency) || currencies.has(currency) || currency <= previous) invalid();
    currencies.add(currency); previous = currency;
    const count = safeCount(currencyRow.count); const totalMinor = safeCount(currencyRow.totalMinor);
    total += count;
    if (!Number.isSafeInteger(total)) invalid();
    return { currency, count, totalMinor };
  });
  const count = safeCount(source.count);
  if (count !== total) invalid();
  return { availability: 'AVAILABLE', windowFrom, windowTo, count, amountsByCurrency };
}

/** A fixed, stable order ensures equal facts always produce identical user advice. */
export function commandCenterBriefing(metrics: CommandCenterMetrics): string {
  const priorities: string[] = [];
  if (metrics.newLeads24h.count) priorities.push(`${metrics.newLeads24h.count} new ${metrics.newLeads24h.count === 1 ? 'lead' : 'leads'} in the last 24 hours`);
  if (metrics.upcomingTrials24h.count) priorities.push(`${metrics.upcomingTrials24h.count} trial ${metrics.upcomingTrials24h.count === 1 ? 'appointment' : 'appointments'} scheduled in the next 24 hours`);
  if (metrics.upcomingTestingEvents30d.count) priorities.push(`${metrics.upcomingTestingEvents30d.count} testing ${metrics.upcomingTestingEvents30d.count === 1 ? 'event' : 'events'} in the next 30 days`);
  if (metrics.membershipTermsEnding30d.count) priorities.push(`${metrics.membershipTermsEnding30d.count} membership ${metrics.membershipTermsEnding30d.count === 1 ? 'term' : 'terms'} ending in the next 30 days`);
  if (metrics.pendingActionApprovals.count) priorities.push(`${metrics.pendingActionApprovals.count} action ${metrics.pendingActionApprovals.count === 1 ? 'approval' : 'approvals'} awaiting review`);
  if (metrics.outstandingWorkItems.count) priorities.push(`${metrics.outstandingWorkItems.count} outstanding durable ${metrics.outstandingWorkItems.count === 1 ? 'work item' : 'work items'}`);
  if (!priorities.length) return 'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.';
  return `Daily briefing: ${priorities.join('; ')}.`;
}

export function commandCenterRecommendations(metrics: CommandCenterMetrics): CommandCenterRecommendation[] {
  const result: CommandCenterRecommendation[] = [];
  if (metrics.pendingActionApprovals.count) result.push({
    id: 'REVIEW_PENDING_APPROVALS', title: 'Review pending approvals',
    why: `${metrics.pendingActionApprovals.count} current action ${metrics.pendingActionApprovals.count === 1 ? 'request is' : 'requests are'} awaiting a qualified human review.`,
    route: '/staff/action-center/approvals', action: 'NAVIGATE', automaticExecution: false,
  });
  if (metrics.outstandingWorkItems.count) result.push({
    id: 'REVIEW_OUTSTANDING_WORK', title: 'Review outstanding work',
    why: `${metrics.outstandingWorkItems.count} durable ${metrics.outstandingWorkItems.count === 1 ? 'work item remains' : 'work items remain'} in a nonterminal state.`,
    route: '/staff/work', action: 'NAVIGATE', automaticExecution: false,
  });
  if (metrics.upcomingTrials24h.count) result.push({
    id: 'PREPARE_UPCOMING_TRIALS', title: 'Prepare upcoming trials',
    why: `${metrics.upcomingTrials24h.count} scheduled trial ${metrics.upcomingTrials24h.count === 1 ? 'appointment starts' : 'appointments start'} within 24 hours.`,
    route: '/staff/search', action: 'NAVIGATE', automaticExecution: false,
  });
  if (metrics.newLeads24h.count) result.push({
    id: 'REVIEW_NEW_LEADS', title: 'Review new leads',
    why: `${metrics.newLeads24h.count} CRM ${metrics.newLeads24h.count === 1 ? 'lead was' : 'leads were'} created in the last 24 hours.`,
    route: '/staff/search', action: 'NAVIGATE', automaticExecution: false,
  });
  if (metrics.membershipTermsEnding30d.count) result.push({
    id: 'PREPARE_MEMBERSHIP_RENEWALS', title: 'Prepare membership reviews',
    why: `${metrics.membershipTermsEnding30d.count} active or cancellation-pending membership ${metrics.membershipTermsEnding30d.count === 1 ? 'term ends' : 'terms end'} within 30 days.`,
    route: '/staff/billing/renewals', action: 'NAVIGATE', automaticExecution: false,
  });
  return result;
}

@Injectable()
export class CommandCenterService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(externalSubject: string, organizationId: string, schoolId: string): Promise<SchoolCommandCenterSnapshot> {
    organizationId = organizationId.toLowerCase(); schoolId = schoolId.toLowerCase();
    if (!UUID.test(organizationId) || !UUID.test(schoolId)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A known organization and school UUID are required.' });
    }
    let source: SchoolCommandCenterProjection;
    try {
      source = await this.database.readSchoolCommandCenter(externalSubject, organizationId, schoolId);
    } catch (error) {
      const failure = error as { code?: string; message?: string } | undefined;
      if (failure?.code === '42501') {
        const tier = failure.message === 'TIER_ENTITLEMENT_REQUIRED';
        throw new ForbiddenException({
          code: tier ? 'TIER_ENTITLEMENT_REQUIRED' : 'COMMAND_CENTER_FORBIDDEN',
          detail: tier ? 'An active Essential, Core, or Complete entitlement is required.' : 'HON School Command Center is not authorized for this school.',
        });
      }
      if (failure?.code === '22023') throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A known organization and school UUID are required.' });
      throw error;
    }
    const root = row(source, ['organizationId', 'schoolId', 'entitlementTier', 'generatedAt', 'metrics']);
    const entitlementTier = text(root.entitlementTier, 10);
    if (!['ESSENTIAL', 'CORE', 'COMPLETE'].includes(entitlementTier)) invalid();
    const generatedAt = timestamp(root.generatedAt);
    const sourceMetrics = row(root.metrics, [
      'newLeads24h', 'upcomingTrials24h', 'upcomingTestingEvents30d', 'pendingActionApprovals', 'outstandingWorkItems',
      'membershipTermsEnding30d', 'paidInvoicesCreated30d', 'unansweredInquiries', 'attendanceDecline', 'trialConversion', 'revenue',
    ]);
    const metrics: CommandCenterMetrics = {
      newLeads24h: windowedAvailable(sourceMetrics.newLeads24h, 86_400_000),
      upcomingTrials24h: windowedAvailable(sourceMetrics.upcomingTrials24h, 86_400_000),
      upcomingTestingEvents30d: windowedAvailable(sourceMetrics.upcomingTestingEvents30d, 30 * 86_400_000),
      pendingActionApprovals: available(sourceMetrics.pendingActionApprovals),
      outstandingWorkItems: available(sourceMetrics.outstandingWorkItems),
      membershipTermsEnding30d: windowedAvailable(sourceMetrics.membershipTermsEnding30d, 30 * 86_400_000),
      paidInvoicesCreated30d: paidInvoices(sourceMetrics.paidInvoicesCreated30d),
      unansweredInquiries: unavailable(sourceMetrics.unansweredInquiries, 'UNAVAILABLE', UNAVAILABLE_REASONS.unansweredInquiries),
      attendanceDecline: unavailable(sourceMetrics.attendanceDecline, 'INSUFFICIENT_DATA', UNAVAILABLE_REASONS.attendanceDecline),
      trialConversion: unavailable(sourceMetrics.trialConversion, 'UNAVAILABLE', UNAVAILABLE_REASONS.trialConversion),
      revenue: unavailable(sourceMetrics.revenue, 'UNAVAILABLE', UNAVAILABLE_REASONS.revenue),
    };
    // Briefing and cards are deliberately rebuilt, never trusted from SQL or a client.
    return {
      organizationId: scopedId(root.organizationId, organizationId), schoolId: scopedId(root.schoolId, schoolId),
      entitlementTier: entitlementTier as SchoolCommandCenterSnapshot['entitlementTier'], generatedAt, metrics,
      dailyBriefing: commandCenterBriefing(metrics), recommendations: commandCenterRecommendations(metrics),
    };
  }
}
