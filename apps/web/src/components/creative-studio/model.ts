import type { SaasCreativeSchoolWallet } from '@hon/contracts';

/**
 * What Creative Studio shows from the school's own creative wallet read. School views carry no provider
 * cost or provider identity, and this projection keeps only what a school person needs.
 */
export type StudioRate = Readonly<{ operationCode: string; mediaKind: 'IMAGE' | 'VIDEO'; displayName: string; billingUnit: 'IMAGE' | 'VIDEO_SECOND' | 'REQUEST';
  creditsPerUnit: number; maxUnitsPerRequest: number; provisional: boolean }>;
export type StudioEntry = Readonly<{ entryId: string; entryKind: string; lotKind: string; credits: number; occurredAt: string }>;
export type StudioPackage = Readonly<{ packageCode: string; totalCredits: number; bonusCredits: number; priceMinor: number; currency: 'usd' }>;
export type StudioWallet = Readonly<{
  programActive: boolean; eligible: boolean; reason: string | null; window: Readonly<{ startsAt: string; endsAt: string }> | null;
  available: number; held: number; monthlyIncluded: number; rates: readonly StudioRate[] | null;
  history: readonly StudioEntry[]; packages: readonly StudioPackage[];
}>;
export type StudioState =
  | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; wallet: StudioWallet }>;

/** Most recent first, at most this many ledger lines. */
export const STUDIO_HISTORY_LIMIT = 12;

export function studioWallet(data: SaasCreativeSchoolWallet): StudioWallet {
  return {
    programActive: data.program.status === 'ACTIVE', eligible: data.eligibility.eligible, reason: data.eligibility.reason,
    window: data.eligibility.window && { startsAt: data.eligibility.window.startsAt, endsAt: data.eligibility.window.endsAt },
    available: data.balance.availableCredits, held: data.balance.heldCredits, monthlyIncluded: data.program.monthlyIncludedCredits,
    rates: data.rates && data.rates.rates.map(rate => ({ operationCode: rate.operationCode, mediaKind: rate.mediaKind, displayName: rate.displayName,
      billingUnit: rate.billingUnit, creditsPerUnit: rate.creditsPerUnit, maxUnitsPerRequest: rate.maxUnitsPerRequest, provisional: rate.rateBasis === 'PROVISIONAL' })),
    history: [...data.history].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, STUDIO_HISTORY_LIMIT)
      .map(entry => ({ entryId: entry.entryId, entryKind: entry.entryKind, lotKind: entry.lotKind, credits: entry.credits, occurredAt: entry.occurredAt })),
    packages: data.packages.map(pack => ({ packageCode: pack.packageCode, totalCredits: pack.totalCredits, bonusCredits: pack.bonusCredits, priceMinor: pack.priceMinor, currency: pack.currency })),
  };
}
