import { validateAiTeamReadiness, type AiTeamReadiness } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 401/403: the requester may not see AI team readiness for this school (content cleared, never assumed available). */
export class AiTeamReadinessAccessError extends Error {
  constructor(readonly status: 401 | 403) { super('AI team readiness is not available to this staff session for this school.'); }
}
function invalid(): never { throw new Error('AI team readiness could not be verified. No agent is shown as available.'); }

/** Fixed same-origin read. The ids are selectors only; the API derives authority from the verified identity. */
export function aiTeamReadinessPath(organizationId: string, schoolId: string): string {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  if (!UUID.test(organization) || !UUID.test(school)) invalid();
  return `/api/v1/organizations/${organization}/schools/${school}/ai/team/capabilities`;
}

/** Strict: the exact contract shape for exactly the requested school, or nothing. */
export function verifyAiTeamReadiness(envelope: unknown, organizationId: string, schoolId: string): AiTeamReadiness {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid();
  const keys = Object.keys(envelope);
  if (keys.length !== 2 || !keys.includes('data') || !keys.includes('meta')) invalid();
  let readiness: AiTeamReadiness;
  try { readiness = validateAiTeamReadiness((envelope as { data: unknown }).data); } catch { invalid(); }
  if (readiness.organizationId.toLowerCase() !== organizationId.toLowerCase() || readiness.schoolId.toLowerCase() !== schoolId.toLowerCase()) invalid();
  return readiness;
}

export async function loadAiTeamReadiness(organizationId: string, schoolId: string, signal?: AbortSignal): Promise<AiTeamReadiness> {
  const response = await fetch(aiTeamReadinessPath(organizationId, schoolId), {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}),
  });
  if (response.status === 401 || response.status === 403) throw new AiTeamReadinessAccessError(response.status);
  if (!response.ok) invalid();
  let envelope: unknown;
  try { envelope = await response.json(); } catch { invalid(); }
  return verifyAiTeamReadiness(envelope, organizationId, schoolId);
}
