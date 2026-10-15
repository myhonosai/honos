import { communityUuid, communityVersion, validateMarketplaceInput, validateMarketplaceSelection, verifyMarketplaceAccess, verifyMarketplaceAsset, verifyMarketplacePage, verifyMarketplaceSelection, verifyMarketplaceHistory, type MarketplaceInput } from '@hon/contracts';
export class MarketplaceAccessError extends Error {}
export const marketplaceFingerprint = (v: unknown) => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
async function request(school: string, path: string, query: Record<string, string> = {}, body?: unknown, key?: string): Promise<unknown> {
  communityUuid(school);
  const r = await fetch(`/api/v1/staff/marketplace${path}?${new URLSearchParams({ schoolId: school, ...query })}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'marketplace', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new (r.status === 401 || r.status === 403 ? MarketplaceAccessError : Error)(r.status === 401 || r.status === 403 ? 'Verified owner/operator permission or community opt-in unavailable. Content cleared.' : r.status === 404 ? 'Asset no longer available under current curation and membership.' : r.status === 409 ? 'Version conflict. Reload; retry unchanged uncertain requests only.' : 'No verified result; no save assumed.');
  const e: unknown = await r.json();
  if (!e || typeof e !== 'object' || !Object.hasOwn(e, 'data')) throw new Error('Unverified response.');
  return (e as { data: unknown }).data;
}
export async function loadMarketplaceAccess(school: string) { return verifyMarketplaceAccess(await request(school, '/access')); }
export async function loadMarketplace(school: string, mode: 'BROWSE' | 'OWN', after: string | null = null) {
  if (!['BROWSE', 'OWN'].includes(mode)) throw new Error('Closed mode required'); if (after !== null) communityUuid(after);
  const p = verifyMarketplacePage(await request(school, '', { mode, ...(after ? { after } : {}) }), x => verifyMarketplaceAsset(x, mode === 'BROWSE'));
  if (after && p.items.some(x => x.id <= after)) throw new Error('Unverified page scope'); return p;
}
export async function loadMarketplaceSelections(school: string, after: string | null = null) {
  if (after !== null) communityUuid(after);
  return verifyMarketplacePage(await request(school, '', { mode: 'SAVED', ...(after ? { after } : {}) }), verifyMarketplaceSelection);
}
export async function loadMarketplaceHistory(school: string, id: string, before: number | null = null) {
  communityUuid(id); if (before !== null) communityVersion(before, 1);
  const h = verifyMarketplaceHistory(await request(school, `/${id}/history`, before === null ? {} : { before: String(before) }));
  if (h.id !== id || (before !== null && h.items.some(x => x.version >= before))) throw new Error('Unverified history scope'); return h;
}
export type MarketplaceMutation = { op: 'ASSET'; id: string | null; input: MarketplaceInput } | { op: 'SAVE'; id: string; input: { expectedVersion: 0; assetVersion: number } };
export async function saveMarketplace(school: string, m: MarketplaceMutation, key: string) {
  if (!key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Retain a valid retry key');
  if (m.id !== null) communityUuid(m.id);
  if (m.op === 'ASSET') { validateMarketplaceInput(m.input); if ((m.id === null) !== (m.input.expectedVersion === 0)) throw new Error('Closed version scope'); }
  else validateMarketplaceSelection(m.input);
  const path = m.op === 'SAVE' ? `/${m.id}/selections` : m.id === null ? '' : `/${m.id}/revisions`;
  const v = await request(school, path, {}, m.input, key);
  if (m.op === 'SAVE') { const s = verifyMarketplaceSelection(v); if (s.assetId !== m.id || s.assetVersion !== m.input.assetVersion) throw new Error('Unverified save'); return s; }
  const a = verifyMarketplaceAsset(v); const { id, version, ...fields } = a;
  if ((m.id !== null && id !== m.id) || version !== m.input.expectedVersion + 1 || marketplaceFingerprint({ expectedVersion: version - 1, ...fields }) !== marketplaceFingerprint(m.input)) throw new Error('Unverified save'); return a;
}
