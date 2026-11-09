import { saasUuid } from '@hon/contracts';
export type AccountInitialSelectors = { initialSchoolId?: string; initialOrganizationId?: string };
/** The accepted reads need an exact school. An optional organization only narrows the response check. */
export function parseAccountSelectors(query: unknown): AccountInitialSelectors {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some(key => key !== 'schoolId' && key !== 'organizationId')) return {};
  try {
    const initialSchoolId = saasUuid(values.schoolId).toLowerCase();
    return values.organizationId === undefined ? { initialSchoolId } : { initialSchoolId, initialOrganizationId: saasUuid(values.organizationId).toLowerCase() };
  } catch { return {}; }
}
