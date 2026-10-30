import { a2pPublicHttpsUrl } from '@hon/contracts';
export const A2P_INSPECTION_LIMITS = Object.freeze({ pages: 4, redirects: 2, bytesPerPage: 65536, totalBytes: 262144, timeoutMs: 5000 });
function refused(): never { throw new Error('A2P_WEBSITE_INSPECTION_NOT_ALLOWED'); }
function publicIpv4(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
  const [a,b,c] = value.split('.').map(Number) as [number,number,number,number];
  if (value.split('.').some(n => Number(n)>255)) return false;
  return !(a===0 || a===10 || a===127 || a>=224 || a===100 && b>=64 && b<=127 || a===169 && b===254
    || a===172 && b>=16 && b<=31 || a===192 && (b===168 || b===0 || b===88 && c===99)
    || a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113);
}
/** No DNS or HTTP is performed. All answers, including unsupported IPv6, must pass before a future pinned fetch. */
export function approveA2pDnsAnswers(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return refused();
  const result: string[] = [];
  for (const address of value) { if (typeof address !== 'string' || !publicIpv4(address)) return refused(); result.push(address); }
  return Object.freeze([...new Set(result)].sort());
}
export function assertA2pPinnedAddress(approved: readonly string[], connected: string): void {
  if (!approveA2pDnsAnswers(approved).includes(connected) || !publicIpv4(connected)) refused();
}
export function approveA2pRedirect(initial: string, destination: string, previousRedirects: number): string {
  if (!Number.isSafeInteger(previousRedirects) || previousRedirects < 0 || previousRedirects >= A2P_INSPECTION_LIMITS.redirects) return refused();
  if (typeof destination!=='string' || !destination || destination.length>2048 || /[\x00-\x20\x7f-\uffff\\%]/.test(destination)) return refused();
  if (destination.startsWith('https:')) a2pPublicHttpsUrl(destination);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) && !destination.startsWith('https://')) return refused();
  const from = a2pPublicHttpsUrl(initial);
  let target: string;
  const origin = from.split('/').slice(0,3).join('/');
  if (destination.startsWith('//')) return refused();
  try { target = a2pPublicHttpsUrl(destination.startsWith('https://') ? destination : destination.startsWith('/')
    ? origin+destination : from.slice(0,from.lastIndexOf('/')+1)+destination); } catch { return refused(); }
  if (origin !== target.split('/').slice(0,3).join('/')) return refused();
  return target;
}
export function assertA2pInspectionBudget(budget: {pages:number;redirects:number;bytesPerPage:number;totalBytes:number;elapsedMs:number}): void {
  if (Object.values(budget).some(n=>!Number.isSafeInteger(n)||n<0) || budget.pages>A2P_INSPECTION_LIMITS.pages
    || budget.redirects>A2P_INSPECTION_LIMITS.redirects || budget.bytesPerPage>A2P_INSPECTION_LIMITS.bytesPerPage
    || budget.totalBytes>A2P_INSPECTION_LIMITS.totalBytes || budget.totalBytes<budget.bytesPerPage
    || budget.elapsedMs>A2P_INSPECTION_LIMITS.timeoutMs) refused();
}
