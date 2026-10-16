import type { CommandContext } from './index.js';

export const CLASSPASS_ACTIONS = ['CONFIGURE_PRODUCT', 'RETIRE_PRODUCT', 'ISSUE', 'ADMIT', 'REVERSE_ISSUANCE', 'REVERSE_REDEMPTION'] as const;
export type ClassPassAction = (typeof CLASSPASS_ACTIONS)[number];
export type ClassPassReadKind = 'PRODUCT' | 'PASS' | 'BOOKING';
export type ClassPassContext = CommandContext & { externalSubject: string };
export type ClassPassInput =
 | { expectedVersion: number; programId: string; name: string; allowedUses: number; validityDays: number; reason: string }
 | { expectedVersion: number; studentProfileId: string; issuanceKind: 'MANUAL_NONFINANCIAL'; reason: string }
 | { expectedVersion: number; passId: string }
 | { expectedVersion: number; reason: string }
 | { expectedVersion: number; passId: string; reason: string };
export type ClassPassDecision = 'ADMITTED_REDEEMED' | 'WAITLISTED_NOT_REDEEMED' | 'ISSUANCE_REVERSED' | 'REDEMPTION_REVERSED';
export interface ClassPassBooking {
 id: string; classSessionId: string; passId: string; bookingKind: 'CLASS_PASS'; status: 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'CHECKED_IN' | 'NO_SHOW'; version: number;
}
export interface ClassPassProduct {
 id: string; programId: string; name: string; allowedUses: number; validityDays: number; allowedBookingPolicy: 'WALK_IN'; status: 'ACTIVE' | 'RETIRED'; version: number;
}
export interface ClassPassReceipt {
 id: string; version: number; status: string; remainingUses?: number; studentProfileId?: string; passId?: string;
 booking?: ClassPassBooking | null; decision?: ClassPassDecision;
 paymentProviderOutcome: 'UNAVAILABLE'; attendanceOutcome: 'NOT_RECORDED_BY_CLASSPASS'; externalEffects?: 'NONE'; replayed?: boolean;
}
export interface ClassPassProjection extends ClassPassReceipt {
 productId?: string; programId?: string; productVersion?: number; productName?: string; allowedUses?: number; validityDays?: number;
 allowedBookingPolicy?: 'WALK_IN'; issuanceKind?: 'MANUAL_NONFINANCIAL'; programVersion?: number; programName?: string;
 minimumAgeMonths?: number | null; maximumAgeMonths?: number | null; issuedAt?: string; expiresAt?: string; expired?: boolean;
 ledger?: { id: string; kind: 'ISSUANCE' | 'REDEMPTION' | 'ISSUANCE_REVERSAL' | 'REDEMPTION_REVERSAL'; useDelta: number; classBookingId: string | null; reversesLedgerId: string | null; passVersion: number; recordedAt: string }[];
 parentProjection: 'UNAVAILABLE'; name?: string;
}
