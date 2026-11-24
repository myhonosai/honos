/** HON OS schedule billing, piece 4 (0279): the founder 50-spot count. Reads only. A spot is counted by the first verified
 * schedule payment of a founder plan, never by a sign-up, a preview or these reads (`spotReserved: false`). v1 checkouts and
 * legacy founder reservations are outside this count (`legacyFounderSalesCounted: false`). */
import { championsExactKeys as keys, championsIsInt as integer, championsIsTimestamp as timestamp,
  championsIsUuid as uuid, championsRecord as record } from './champions-club.js';

export const SAAS_FOUNDER_POOL_CAPACITY = 50 as const;
export const SAAS_FOUNDER_UNAVAILABLE_REASONS = ['FOUNDER_TERMS_NOT_LOCKED','FOUNDER_ALREADY_USED','FOUNDER_SOLD_OUT',
  'FOUNDER_SET_LIMIT_REACHED','FOUNDER_OFFER_LIMIT_REACHED'] as const;
export type SaasFounderUnavailableReason = typeof SAAS_FOUNDER_UNAVAILABLE_REASONS[number];

export interface SaasFounderPool {
  capacity: typeof SAAS_FOUNDER_POOL_CAPACITY; allocated: number; remaining: number;
  countingRule: 'FIRST_VERIFIED_SCHEDULE_PAYMENT'; legacyFounderSalesCounted: false;
}
export interface SaasFounderSpot {
  spotNumber: number; organizationId: string; schoolId: string; bindingId: string; offerId: string;
  offerKind: 'FOUNDER_MONTHLY' | 'FOUNDER_ANNUAL'; lockedPriceMinor: number; allocatedAt: string;
}
export interface SaasFounderPoolHqView extends SaasFounderPool {
  spots: SaasFounderSpot[]; heldWithoutSpot: number; checkoutAvailable: false; asOf: string;
}
export interface SaasFounderOfferAvailability {
  offerId: string; offerKind: 'FOUNDER_MONTHLY' | 'FOUNDER_ANNUAL'; billingInterval: 'MONTHLY' | 'ANNUAL';
  priceMinor: number; standardPriceMinor: number | null; available: boolean; reason: SaasFounderUnavailableReason | null;
}
export interface SaasFounderSchoolAvailability {
  organizationId: string; schoolId: string; pool: SaasFounderPool; organizationUsedFounderSpot: boolean;
  offers: SaasFounderOfferAvailability[]; spotCountedAt: 'FIRST_VERIFIED_PAYMENT'; spotReserved: false; checkoutAvailable: false; asOf: string;
}

const drift = (): never => { throw new Error('SAAS_CONTRACT_DRIFT'); };
const money = (v: unknown) => integer(v, 100, 10_000_000);
const KINDS = ['FOUNDER_MONTHLY','FOUNDER_ANNUAL'];

function pool(value: unknown): SaasFounderPool {
  const r = record(value, drift);
  keys(r, ['capacity','allocated','remaining','countingRule','legacyFounderSalesCounted'], drift);
  if (r.capacity !== SAAS_FOUNDER_POOL_CAPACITY || !integer(r.allocated, 0, SAAS_FOUNDER_POOL_CAPACITY)
    || r.remaining !== SAAS_FOUNDER_POOL_CAPACITY - (r.allocated as number)
    || r.countingRule !== 'FIRST_VERIFIED_SCHEDULE_PAYMENT' || r.legacyFounderSalesCounted !== false) drift();
  return r as unknown as SaasFounderPool;
}

export function validateSaasFounderPoolHqView(value: unknown): SaasFounderPoolHqView {
  const r = record(value, drift);
  keys(r, ['capacity','allocated','remaining','countingRule','legacyFounderSalesCounted','spots','heldWithoutSpot','checkoutAvailable','asOf'], drift);
  const { spots: _s, heldWithoutSpot: _h, checkoutAvailable: _c, asOf: _a, ...p } = r; pool(p);
  if (!Array.isArray(r.spots) || r.spots.length !== r.allocated || !integer(r.heldWithoutSpot, 0, 1_000_000)
    || r.checkoutAvailable !== false || !timestamp(r.asOf)) drift();
  (r.spots as unknown[]).forEach((value, i) => {
    const s = record(value, drift);
    keys(s, ['spotNumber','organizationId','schoolId','bindingId','offerId','offerKind','lockedPriceMinor','allocatedAt'], drift);
    if (s.spotNumber !== i + 1 || ![s.organizationId,s.schoolId,s.bindingId,s.offerId].every(uuid) || !KINDS.includes(s.offerKind as string)
      || !money(s.lockedPriceMinor) || !timestamp(s.allocatedAt)) drift();
  });
  return r as unknown as SaasFounderPoolHqView;
}

export function validateSaasFounderSchoolAvailability(value: unknown): SaasFounderSchoolAvailability {
  const r = record(value, drift);
  keys(r, ['organizationId','schoolId','pool','organizationUsedFounderSpot','offers','spotCountedAt','spotReserved','checkoutAvailable','asOf'], drift);
  pool(r.pool);
  if (!uuid(r.organizationId) || !uuid(r.schoolId) || typeof r.organizationUsedFounderSpot !== 'boolean' || !Array.isArray(r.offers)
    || r.offers.length > 12 || r.spotCountedAt !== 'FIRST_VERIFIED_PAYMENT' || r.spotReserved !== false || r.checkoutAvailable !== false
    || !timestamp(r.asOf)) drift();
  for (const value of r.offers as unknown[]) {
    const o = record(value, drift);
    keys(o, ['offerId','offerKind','billingInterval','priceMinor','standardPriceMinor','available','reason'], drift);
    if (!uuid(o.offerId) || !KINDS.includes(o.offerKind as string)
      || o.billingInterval !== (o.offerKind === 'FOUNDER_ANNUAL' ? 'ANNUAL' : 'MONTHLY') || !money(o.priceMinor)
      || !(o.standardPriceMinor === null || money(o.standardPriceMinor)) || typeof o.available !== 'boolean'
      || (o.available ? o.reason !== null : !SAAS_FOUNDER_UNAVAILABLE_REASONS.includes(o.reason as SaasFounderUnavailableReason))
      || (r.organizationUsedFounderSpot && o.available)) drift();
  }
  return r as unknown as SaasFounderSchoolAvailability;
}
