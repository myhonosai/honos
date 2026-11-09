import type { LeadListItem } from '@hon/contracts';
import { crmLeadListPath, verifyCrmLeadList, type CrmLeadStatus } from '../crm-leads-http';
import { JourneyError } from '../crm-journey/http';
import { readTrialRecovery, type TrialRecovery } from '../crm-journey/trial-recovery-http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * U4 Leads: read-only. The school is the one the shell verified; ids are selectors only and the API re-derives the
 * human, school and CRM permission from the signed session. No command is sent from this page: every change happens in
 * the existing CRM flows it links to.
 */
export type LeadsErrorKind = 'SESSION' | 'DENIED' | 'UNAVAILABLE';
export class LeadsError extends Error { constructor(readonly kind: LeadsErrorKind) { super(kind); } }
export type LeadsScope = Readonly<{ organizationId: string; schoolId: string }>;
/** True only while the read is still the one shown (mounted, same privacy epoch, same school and generation). */
export type Owned = () => boolean;
export const LEADS_LIST_LIMIT = 50;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

export interface LeadsApi {
  list(scope: LeadsScope, status: CrmLeadStatus | null, signal: AbortSignal, owned: Owned): Promise<LeadListItem[]>;
  trials(scope: LeadsScope, leadId: string, signal: AbortSignal): Promise<TrialRecovery>;
}

async function list(scope: LeadsScope, status: CrmLeadStatus | null, signal: AbortSignal, owned: Owned): Promise<LeadListItem[]> {
  let path: string;
  try { path = crmLeadListPath(scope.organizationId, scope.schoolId, status ?? undefined); } catch { throw new LeadsError('UNAVAILABLE'); }
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal });
  } catch (error) { if (signal.aborted) throw error; throw new LeadsError('UNAVAILABLE'); }
  // A retired read (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new LeadsError('SESSION'); }
  if (response.status === 403) throw new LeadsError('DENIED');
  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new LeadsError('UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { throw new LeadsError('UNAVAILABLE'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,meta') throw new LeadsError('UNAVAILABLE');
  try {
    const leads = verifyCrmLeadList((body as { data: unknown }).data);
    if (status !== null && leads.some((lead) => lead.status !== status)) throw new Error('filter drift');
    return leads;
  } catch { throw new LeadsError('UNAVAILABLE'); }
}

async function trials(scope: LeadsScope, leadId: string, signal: AbortSignal): Promise<TrialRecovery> {
  try { return await readTrialRecovery(scope, leadId, signal); }
  catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof JourneyError) throw new LeadsError(error.kind === 'SESSION' ? 'SESSION' : error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE');
    throw new LeadsError('UNAVAILABLE');
  }
}

export const leadsApi: LeadsApi = { list, trials };
