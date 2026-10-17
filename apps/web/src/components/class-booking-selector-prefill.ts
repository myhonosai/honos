const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['organizationId', 'schoolId', 'sessionId'] as const;
function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

export type ClassBookingSelectorPrefill = Readonly<{
  organizationId: string;
  schoolId: string;
  sessionId: string;
}>;

/** Closed URL handoff only; selectors remain untrusted and never imply authority. */
export function exactClassBookingSelectorPrefill(value: unknown): ClassBookingSelectorPrefill | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const query = value as Record<string, unknown>;
  const keys = Object.keys(query);
  if (keys.length !== FIELDS.length || keys.some(key => !FIELDS.includes(key as typeof FIELDS[number])) || FIELDS.some(field => !Object.hasOwn(query, field))) return undefined;
  const [organizationId, schoolId, sessionId] = FIELDS.map(field => query[field]);
  if (!isUuid(organizationId) || !isUuid(schoolId) || !isUuid(sessionId)) return undefined;
  return Object.freeze({ organizationId: organizationId.toLowerCase(), schoolId: schoolId.toLowerCase(), sessionId: sessionId.toLowerCase() });
}
