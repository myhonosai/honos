'use client';

/**
 * Provider-control writes (review [19]). One press makes one frozen request: its path, exact body and Idempotency-Key.
 * It is the only thing a retry may send, and it lives until the server gives a definite answer. A validated receipt
 * (record id, new version, replayed) is returned so the editor can move to the version the server now holds instead of
 * keeping the stale one.
 */
export type ControlWritePath = 'connections' | 'catalog' | 'routing-policies';
export type ControlWrite = Readonly<{ path: ControlWritePath; body: string; key: string }>;
export type ControlReceipt = Readonly<{ recordId: string; version: number; replayed: boolean }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_IDS = new Set(['OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD']);

/** A definite refusal: the request did not change anything, so its key is dropped. */
export class ControlWriteRefused extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** The answer was lost or unreadable: the request may have been applied, so only a same-key retry is safe. */
export class ControlWriteUnknown extends Error {}

export function prepareControlWrite(path: ControlWritePath, body: object, key: string): ControlWrite {
  if (!UUID.test(key)) throw new Error('A control-plane write needs a UUID Idempotency-Key.');
  return Object.freeze({ path, body: JSON.stringify(body), key });
}

/**
 * Only an exact `{ data: { recordId, version, replayed } }` answer is a receipt. A connection's record id is its
 * provider type (0113); catalog and policy records are UUIDs.
 */
export function parseControlReceipt(value: unknown, path: ControlWritePath): ControlReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { recordId, version, replayed } = data as Record<string, unknown>;
  const idOk = typeof recordId === 'string' && (path === 'connections' ? PROVIDER_IDS.has(recordId) : UUID.test(recordId));
  if (typeof recordId !== 'string' || !idOk || !Number.isSafeInteger(version) || (version as number) < 1 || typeof replayed !== 'boolean') return null;
  return Object.freeze({ recordId: path === 'connections' ? recordId : recordId.toLowerCase(), version: version as number, replayed });
}

function detail(body: unknown, fallback: string): string {
  const value = body && typeof body === 'object' ? body as { detail?: unknown } : {};
  return typeof value.detail === 'string' && value.detail.length <= 300 ? value.detail : fallback;
}

export async function sendControlWrite(write: ControlWrite, fetcher: typeof fetch = fetch): Promise<ControlReceipt> {
  let response: Response;
  try {
    response = await fetcher(`/api/v1/hq/ai-providers/${write.path}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': write.key }, body: write.body,
    });
  } catch { throw new ControlWriteUnknown('HON could not confirm this save. Retry sends the same request.'); }
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (response.ok) {
    const receipt = parseControlReceipt(payload, write.path);
    if (!receipt) throw new ControlWriteUnknown('HON answered without a readable receipt. Retry sends the same request.');
    return receipt;
  }
  const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : undefined;
  if (response.status >= 500 || response.status === 408 || response.status === 429 || code === 'IDEMPOTENCY_IN_PROGRESS') {
    throw new ControlWriteUnknown('HON could not confirm this save. Retry sends the same request.');
  }
  throw new ControlWriteRefused(detail(payload, 'HON could not complete the governed control-plane request.'), response.status);
}
