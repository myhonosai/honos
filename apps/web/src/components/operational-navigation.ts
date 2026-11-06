/** Navigation selectors are untrusted form prefills, never authority or a request. */
export type OperationalSchoolScope = Readonly<{ organizationId: string; schoolId: string }>;
export type OperationalSchoolInitialSelectors = { initialOrganizationId?: string; initialSchoolId?: string };
const uuid = (value: unknown): string | undefined => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;

/** Accept one complete, unambiguous pair. Extras/duplicates/partial scopes stay idle and empty. */
export function parseOperationalSchoolSelectors(query: unknown): OperationalSchoolInitialSelectors {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some(key => key !== 'organizationId' && key !== 'schoolId')) return {};
  const initialOrganizationId = uuid(values.organizationId), initialSchoolId = uuid(values.schoolId);
  return initialOrganizationId && initialSchoolId ? { initialOrganizationId, initialSchoolId } : {};
}

export type SchoolWorkflowKey = 'crm' | 'registration' | 'membership' | 'booking' | 'attendance' | 'dashboard' | 'team' | 'family' | 'account';
/** Closed local destinations; no record, identity, token, command or retry selector is admitted. */
export function schoolWorkflowLinks(scope: OperationalSchoolScope): ReadonlyArray<{ key: SchoolWorkflowKey; href: string }> {
  const parsed = parseOperationalSchoolSelectors({ organizationId: scope.organizationId, schoolId: scope.schoolId });
  if (!parsed.initialOrganizationId || !parsed.initialSchoolId) return [];
  const ids = new URLSearchParams({ organizationId: parsed.initialOrganizationId, schoolId: parsed.initialSchoolId }).toString();
  return [
    { key: 'crm', href: `/staff/crm/journey?${ids}` },
    { key: 'registration', href: `/staff/crm/journey?${ids}` },
    { key: 'membership', href: `/staff/crm/journey?${ids}` },
    // Booking and attendance retain the existing verified student/membership journey.
    { key: 'booking', href: `/staff/crm/journey?${ids}` },
    { key: 'attendance', href: `/staff/crm/journey?${ids}` },
    { key: 'dashboard', href: `/staff/dashboard?${ids}` },
    { key: 'team', href: `/staff/team/invitations?${ids}` },
    { key: 'family', href: `/staff/family-access?${ids}` },
    { key: 'account', href: `/staff/account-status?${ids}` },
  ];
}
