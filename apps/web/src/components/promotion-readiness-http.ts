import { parsePromotionReadiness, readinessUuid, type PromotionReadiness } from '@hon/contracts';
export class PromotionReadinessAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function loadPromotionReadiness(organizationId: string, schoolId: string, curriculumId: string, enrollmentId: string): Promise<PromotionReadiness> {
 if (![organizationId, schoolId, curriculumId, enrollmentId].every(readinessUuid)) throw new Error('Enter exact known organization, school, curriculum and enrollment UUIDs.');
 const response = await fetch(`/api/v1/organizations/${organizationId}/schools/${schoolId}/curricula/${curriculumId}/enrollments/${enrollmentId}/promotion-readiness`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
 if (!response.ok) {
  const message = response.status === 401 ? 'Your session has ended. Sign in again.' : response.status === 403 ? 'Current direct human readiness permission is unavailable. The result has been cleared.' : response.status === 404 ? 'That exact curriculum and enrollment are unavailable together in your current school.' : 'Readiness is unavailable. No eligibility or approval is assumed.';
  if ([401, 403].includes(response.status)) throw new PromotionReadinessAccessError(message, response.status);
  throw new Error(message);
 }
 if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Unverified readiness response.');
 const envelope: unknown = await response.json();
 if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join('|') !== 'data|meta') throw new Error('Unverified readiness response.');
 const meta = (envelope as { meta: unknown }).meta;
 if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).sort().join('|') !== 'correlationId|requestId' || !Object.values(meta).every(readinessUuid)) throw new Error('Unverified readiness response.');
 return parsePromotionReadiness((envelope as { data: unknown }).data, { organizationId, schoolId, curriculumId, enrollmentId });
}
