import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Per-client limiter for the anonymous booking links (0261 event days and 0286 booking types). It sits in front of the per-link
 * and per-contact limits kept in SQL, so one sender can no longer use up a link's hourly attempts or fill spots with made-up
 * contacts.
 *
 * The client address is read from X-Forwarded-For at a fixed position counted from the right, set by
 * HON_PUBLIC_CLIENT_IP_HOPS (1-5): the number of trusted proxies that append to the header. Entries further left can be written
 * by the client, so they are never used. On Render the API is private and only reachable through the hon-web rewrite, so the
 * expected value is 2 (Render's edge appends the client, the web rewrite appends Render's edge): confirm it on staging before
 * launch. With the setting absent or invalid, or a header that does not hold a valid address at that position, no per-client
 * limit applies and the SQL limits stay the only ones (the behavior before this change), so a misconfiguration can never put
 * every family in one shared bucket.
 *
 * Addresses are kept only as keyed hashes in process memory (an IPv6 address counts by its /64). Memory is fixed: when a window
 * already tracks MAX_CLIENTS addresses, a new address is let through untracked rather than refused.
 */
export type PublicClientAction = 'read' | 'book' | 'cancel';
const WINDOWS: Record<PublicClientAction, { ms: number; max: number }> = {
  read: { ms: 60_000, max: 120 },
  book: { ms: 3_600_000, max: 20 },
  cancel: { ms: 3_600_000, max: 30 },
};
export const PUBLIC_CLIENT_LIMITS = WINDOWS;
const MAX_CLIENTS = 20_000;

export function publicClientIpHops(env: Record<string, string | undefined> = process.env): number | null {
  const value = env.HON_PUBLIC_CLIENT_IP_HOPS;
  return value !== undefined && /^[1-5]$/.test(value) ? Number(value) : null;
}

/** The client address the trusted proxies recorded, or null when it cannot be known. */
export function publicClientAddress(header: string | string[] | undefined, hops: number | null): string | null {
  if (hops === null || typeof header !== 'string' || header.length > 2048) return null;
  const parts = header.split(',').map(part => part.trim());
  const entry = parts.length >= hops ? parts[parts.length - hops] : undefined;
  if (!entry) return null;
  const kind = isIP(entry);
  if (kind === 4) return entry;
  if (kind === 6) {
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(entry)) return entry.slice(7);
    const expanded = expand(entry);
    return expanded ? `${expanded.slice(0, 4).join(':')}::/64` : null;
  }
  return null;
}
function expand(address: string): string[] | null {
  const [head, tail, extra] = address.toLowerCase().split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [], right = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
  return groups.length === 8 && groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map(g => g.replace(/^0+(?=.)/, '')) : null;
}

export class PublicClientLimit {
  private readonly secret = randomBytes(32);
  private readonly windows = new Map<PublicClientAction, { start: number; counts: Map<string, number> }>();
  constructor(private readonly hops: number | null = publicClientIpHops(), private readonly now: () => number = () => Date.now()) {}

  /** Seconds to wait when this client is over its limit, otherwise 0. */
  admit(action: PublicClientAction, forwardedFor: string | string[] | undefined): number {
    const address = publicClientAddress(forwardedFor, this.hops);
    if (address === null) return 0;
    const rule = WINDOWS[action], now = this.now();
    let window = this.windows.get(action);
    if (!window || now - window.start >= rule.ms) { window = { start: now, counts: new Map() }; this.windows.set(action, window); }
    const key = createHmac('sha256', this.secret).update(address).digest('base64url');
    const count = window.counts.get(key);
    if (count === undefined && window.counts.size >= MAX_CLIENTS) return 0;
    if ((count ?? 0) >= rule.max) return Math.max(1, Math.ceil((rule.ms - (now - window.start)) / 1000));
    window.counts.set(key, (count ?? 0) + 1);
    return 0;
  }
}

/** One limiter for both kinds of link, so a sender cannot double its allowance by spreading over events and booking types. */
let shared: PublicClientLimit | null = null;
export function sharedPublicClientLimit(): PublicClientLimit { return shared ??= new PublicClientLimit(); }
