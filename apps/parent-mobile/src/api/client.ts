import { verifyParentJourneyView, type ParentJourneyView } from '@hon/contracts/parent-journey-view';

/**
 * What a screen shows when a read does not return verified data. Every protected read maps to one of these;
 * there is no state in which unverified or stale data is presented as current.
 */
export type ParentFailureState = 'signed-out' | 'access-denied' | 'choose-family' | 'unavailable' | 'offline';
export type ParentRead<T> = { ok: true; data: T } | { ok: false; state: ParentFailureState };

export interface ParentApiOptions {
  baseUrl: string;
  /** Returns the signed HON mobile session, or null when signed out. Never a family, school or child id. */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ACCESS_DENIED = new Set(['PARENT_SCOPE_DENIED', 'PARENT_SCOPE_CHANGED', 'CHILD_SCOPE_CHANGED']);

export function classifyFailure(status: number, code: unknown): ParentFailureState {
  if (status === 401) return 'signed-out';
  if (status === 403 && typeof code === 'string' && ACCESS_DENIED.has(code)) return 'access-denied';
  if (status === 409 && code === 'PARENT_SCOPE_AMBIGUOUS') return 'choose-family';
  return 'unavailable';
}

function checkedBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('The HON API address is not a valid URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The HON API address must use https.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The HON API address must be a plain origin.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { return null; }
}

export function createParentApi(options: ParentApiOptions) {
  const baseUrl = checkedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function get<T>(path: string, verify: (body: unknown) => T): Promise<ParentRead<T>> {
    const token = await options.getToken();
    if (!token) return { ok: false, state: 'signed-out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch {
      return { ok: false, state: 'offline' };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* an unreadable body is handled below */ }
    if (!response.ok) return { ok: false, state: classifyFailure(response.status, (body as { code?: unknown } | null)?.code) };
    try { return { ok: true, data: verify(body) }; } catch { return { ok: false, state: 'unavailable' }; }
  }

  return {
    journey: (): Promise<ParentRead<ParentJourneyView>> => get('/v1/parent/journey', verifyParentJourneyView),
    /** The school's IANA time zone from the class booking read; null when that read is not available. */
    async schoolTimeZone(): Promise<string | null> {
      const read = await get('/v1/parent/class-bookings', body => {
        const zone = validTimeZone((body as { data?: { timezone?: unknown } } | null)?.data?.timezone);
        if (!zone) throw new Error('no time zone');
        return zone;
      });
      return read.ok ? read.data : null;
    },
  };
}
export type ParentApi = ReturnType<typeof createParentApi>;
