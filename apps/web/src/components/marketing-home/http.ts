import { CAMPAIGN_CHANNELS, CAMPAIGN_CURRENCIES, CAMPAIGN_STATUSES, validateCampaignWindow, type CampaignFunnel, type CampaignSummary } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * U7 Marketing home: read-only. The campaign API resolves the one school this human may plan campaigns for from the
 * signed session and refuses when that is not exactly one school. Nothing is sent from this page: changes happen in the
 * existing campaign planner it links to, and nothing here publishes, spends or sends.
 */
export type MarketingErrorKind = 'SESSION' | 'DENIED' | 'UNAVAILABLE';
export class MarketingError extends Error { constructor(readonly kind: MarketingErrorKind) { super(kind); } }
/** True only while the read is still the one shown (mounted, same privacy epoch, same generation). */
export type Owned = () => boolean;
export const CAMPAIGN_LIST_MAX = 500;
const BASE = '/api/v1/marketing/campaigns';
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUMMARY_KEYS = ['id', 'version', 'code', 'name', 'goal', 'offerLabel', 'channel', 'status', 'startsAt', 'endsAt', 'plannedBudgetMinor', 'currency', 'createdAt', 'updatedAt', 'planningOnly'];
const FUNNEL_KEYS = ['campaign', 'from', 'to', 'asOf', 'leads', 'trialLeads', 'trialAppointments', 'completedTrialAppointments', 'wonLeads', 'lostLeads', 'archivedLeads', 'enrollmentLinkage', 'revenueLinkage'];
const COUNT_KEYS = ['leads', 'trialLeads', 'trialAppointments', 'completedTrialAppointments', 'wonLeads', 'lostLeads', 'archivedLeads'] as const;

const fail = (): never => { throw new Error('shape'); };
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some((k) => !own.includes(k))) fail();
  return value as Record<string, unknown>;
}
const text = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const instant = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
export function verifyCampaign(value: unknown): CampaignSummary {
  const c = closed(value, SUMMARY_KEYS);
  if (typeof c.id !== 'string' || !UUID.test(c.id) || !Number.isSafeInteger(c.version) || (c.version as number) < 1 || !text(c.code, 1, 40) || !text(c.name, 1, 120)
    || !text(c.goal, 1, 500) || !text(c.offerLabel, 0, 120) || !(CAMPAIGN_CHANNELS as readonly unknown[]).includes(c.channel)
    || !(CAMPAIGN_STATUSES as readonly unknown[]).includes(c.status) || typeof c.startsAt !== 'string' || !UTC.test(c.startsAt) || typeof c.endsAt !== 'string' || !UTC.test(c.endsAt)
    || !Number.isSafeInteger(c.plannedBudgetMinor) || (c.plannedBudgetMinor as number) < 0 || !(CAMPAIGN_CURRENCIES as readonly unknown[]).includes(c.currency)
    || !instant(c.createdAt) || !instant(c.updatedAt) || c.planningOnly !== true) fail();
  return c as unknown as CampaignSummary;
}
export function verifyCampaignList(value: unknown): CampaignSummary[] {
  if (!Array.isArray(value) || value.length > CAMPAIGN_LIST_MAX) return fail();
  const items = value.map(verifyCampaign);
  if (new Set(items.map((c) => c.id.toLowerCase())).size !== items.length) fail();
  return items;
}
export function verifyFunnel(value: unknown, campaignId: string, from: string, to: string): CampaignFunnel {
  const f = closed(value, FUNNEL_KEYS), campaign = verifyCampaign(f.campaign);
  if (campaign.id.toLowerCase() !== campaignId.toLowerCase() || f.from !== from || f.to !== to || !instant(f.asOf)
    || f.enrollmentLinkage !== 'UNAVAILABLE' || f.revenueLinkage !== 'UNAVAILABLE'
    || COUNT_KEYS.some((k) => !Number.isSafeInteger(f[k]) || (f[k] as number) < 0)) fail();
  // Subsets of the cohort cannot exceed it; trial people cannot exceed trial appointments.
  const n = f as unknown as CampaignFunnel;
  if (n.trialLeads > n.leads || n.trialLeads > n.trialAppointments || n.completedTrialAppointments > n.trialAppointments
    || n.wonLeads + n.lostLeads + n.archivedLeads > n.leads) fail();
  return n;
}

/** The last 30 days, ending a minute ago so the server's "not in the future" rule holds despite small clock differences. */
export function funnelWindow(now = Date.now()): Readonly<{ from: string; to: string }> {
  const to = new Date(Math.floor((now - 60_000) / 1000) * 1000), from = new Date(to.getTime() - 30 * 86_400_000);
  const w = { from: from.toISOString(), to: to.toISOString() };
  validateCampaignWindow(w.from, w.to);
  return w;
}

async function read(path: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal });
  } catch (error) { if (signal.aborted) throw error; throw new MarketingError('UNAVAILABLE'); }
  // A retired read (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (response.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MarketingError('SESSION'); }
  if (response.status === 403) throw new MarketingError('DENIED');
  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new MarketingError('UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { throw new MarketingError('UNAVAILABLE'); }
  try { return closed(body, ['data', 'meta']).data; } catch { throw new MarketingError('UNAVAILABLE'); }
}

export interface MarketingApi {
  campaigns(signal: AbortSignal, owned: Owned): Promise<CampaignSummary[]>;
  funnel(campaignId: string, signal: AbortSignal, owned: Owned, now?: number): Promise<CampaignFunnel>;
}
export const marketingApi: MarketingApi = {
  async campaigns(signal, owned) {
    const data = await read(BASE, signal, owned);
    try { return verifyCampaignList(data); } catch { throw new MarketingError('UNAVAILABLE'); }
  },
  async funnel(campaignId, signal, owned, now = Date.now()) {
    if (!UUID.test(campaignId)) throw new MarketingError('UNAVAILABLE');
    const { from, to } = funnelWindow(now);
    const data = await read(`${BASE}/${campaignId.toLowerCase()}/funnel?${new URLSearchParams({ from, to })}`, signal, owned);
    try { return verifyFunnel(data, campaignId, from, to); } catch { throw new MarketingError('UNAVAILABLE'); }
  },
};
