import type { CommandContext } from './index.js';
export const KIOSK_OUTCOME = 'NEEDS_STAFF_ASSISTANCE' as const;
export type KioskOutcome = { result: typeof KIOSK_OUTCOME };
export type KioskContext = CommandContext & { externalSubject: string };
export type KioskTerminalInput = { terminalSessionId: string; terminalSession: string };
export type KioskClaimInput = { studentProfileId: string; classSessionId: string; claim: string };
export type KioskPublicInput = { terminalSession: string; claim: string };
export interface KioskTerminalResult {
 terminalId: string; state: 'ACTIVE' | 'RETIRED'; terminalSessionId?: string; createdAt?: string; expiresAt?: string; retiredAt?: string;
}
export interface KioskClaimResult {
 claimId: string; studentProfileId: string; classSessionId: string; state: 'ISSUED' | 'CONSUMED' | 'EXPIRED'; issuedAt: string; expiresAt: string; consumedAt?: string | null;
 handoff?: { id: string; terminalSessionId: string; state: 'PENDING_STAFF_REVIEW'; createdAt: string } | null;
}
