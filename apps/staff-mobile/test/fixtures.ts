/** Synthetic test-only fixtures. Shapes match the server contracts exactly; no real school or staff data. */
export function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
export const ORG = '11111111-1111-4111-8111-111111111111';
export const SCHOOL_A = '22222222-2222-4222-8222-222222222222';
export const SCHOOL_B = '33333333-3333-4333-8333-333333333333';
export const RESOLVED = { data: { state: 'RESOLVED', organizationId: ORG, schoolId: SCHOOL_A } };
export const MANUAL = { data: { state: 'MANUAL_ENTRY_REQUIRED' } };
export const CHOICES = { data: { state: 'SELECTION_REQUIRED', schools: [
  { organizationId: ORG, schoolId: SCHOOL_A, organizationName: 'Test Organization', schoolName: 'North Test School' },
  { organizationId: ORG, schoolId: SCHOOL_B, organizationName: 'Test Organization', schoolName: 'South Test School' },
] } };

/** A fetch that answers by path, recording each call. */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route();
  }) as unknown as typeof fetch;
  return { impl, calls };
}
