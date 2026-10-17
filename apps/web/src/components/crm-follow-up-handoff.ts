import { FOLLOW_UP_UUID, type CrmAppointmentSummary } from '@hon/contracts';

const terminalTrialStatuses = new Set<CrmAppointmentSummary['status']>(['COMPLETED', 'NO_SHOW', 'CANCELLED']);

/** An untrusted query may carry one bounded UUID only; it never establishes authority. */
export function crmFollowUpLeadId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length === 36 && FOLLOW_UP_UUID.test(value) ? value : undefined;
}

/** Ordinary navigation only: the destination independently loads and authorizes its queue. */
export function crmFollowUpHref(leadId: unknown): string | undefined {
  const verifiedLeadId = crmFollowUpLeadId(leadId);
  return verifiedLeadId ? `/staff/crm/follow-ups?${new URLSearchParams({ leadId: verifiedLeadId }).toString()}` : undefined;
}

/** A trial handoff exists only for the current, verified terminal receipt. */
export function terminalTrialFollowUpHref(appointment: Pick<CrmAppointmentSummary, 'crmLeadId' | 'status'>): string | undefined {
  return terminalTrialStatuses.has(appointment.status) ? crmFollowUpHref(appointment.crmLeadId) : undefined;
}
