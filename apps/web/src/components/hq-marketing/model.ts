'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { HQ_MARKETING_BUDGET_MAX_MINOR, HQ_MARKETING_AUDIENCES, HQ_MARKETING_CHANNELS, validateHqMarketingCreateInput, validateHqMarketingUpdateInput,
  type HqMarketingCampaign, type HqMarketingCreateInput, type HqMarketingPlan, type HqMarketingReceipt, type HqMarketingUpdateInput } from '@hon/contracts';
import { MarketingError, type Owned } from './http';

export { useConcealment } from '../hq-support/model';

/** What the last command attempt means. Only DONE saved something; UNKNOWN may have. */
export type MarketingOutcome<R = HqMarketingReceipt> = null
  | { kind: 'SENDING' } | { kind: 'DONE'; receipt: R } | { kind: 'UNKNOWN' } | { kind: 'CHANGED' }
  | { kind: 'REFUSED'; code: string | null } | { kind: 'KEY_REUSED' } | { kind: 'DENIED' } | { kind: 'INVALID' } | { kind: 'GONE' } | { kind: 'LOCAL_INVALID' };
export type Run<R = HqMarketingReceipt> = (key: string, signal: AbortSignal, owned: Owned) => Promise<R>;

/** The person's typed form, as strings. */
export type PlanDraft = Readonly<{ code: string; name: string; goal: string; audience: string; offerLabel: string; channel: string;
  startsOn: string; endsOn: string; budget: string }>;

/** Dollars typed by a person ("2500", "2500.5", "2,500.50") as exact cents, or null. */
export function budgetMinorFrom(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= HQ_MARKETING_BUDGET_MAX_MINOR ? minor : null;
}
/** Exact cents as a dollar string a person can edit ("2500.50"). */
export function budgetTextFrom(minor: number): string {
  const cents = minor % 100;
  return cents === 0 ? String(Math.floor(minor / 100)) : `${Math.floor(minor / 100)}.${String(cents).padStart(2, '0')}`;
}
export function draftFrom(c: HqMarketingCampaign): PlanDraft {
  return { code: c.code, name: c.name, goal: c.goal, audience: c.audience, offerLabel: c.offerLabel, channel: c.channel,
    startsOn: c.startsOn, endsOn: c.endsOn, budget: budgetTextFrom(c.plannedBudgetMinor) };
}
function planFrom(d: PlanDraft): HqMarketingPlan | null {
  const minor = budgetMinorFrom(d.budget);
  if (minor === null || !(HQ_MARKETING_AUDIENCES as readonly string[]).includes(d.audience) || !(HQ_MARKETING_CHANNELS as readonly string[]).includes(d.channel)) return null;
  // A goal typed over several lines is one line of plan text; control characters are never sent.
  return { name: d.name.trim(), goal: d.goal.replace(/\s+/g, ' ').trim(), audience: d.audience as HqMarketingPlan['audience'], offerLabel: d.offerLabel.trim(),
    channel: d.channel as HqMarketingPlan['channel'], startsOn: d.startsOn, endsOn: d.endsOn, plannedBudgetMinor: minor };
}
/** The form as a closed create request, or null when it is not one. */
export function createInputFrom(d: PlanDraft): HqMarketingCreateInput | null {
  const plan = planFrom(d);
  if (!plan) return null;
  try { return validateHqMarketingCreateInput({ code: d.code.trim().toUpperCase(), ...plan }); } catch { return null; }
}
export function updateInputFrom(d: PlanDraft, expectedVersion: number): HqMarketingUpdateInput | null {
  const plan = planFrom(d);
  if (!plan) return null;
  try { return validateHqMarketingUpdateInput({ expectedVersion, ...plan }); } catch { return null; }
}

/** Map a command failure to what it means for the person. Anything not definitive is UNKNOWN, and the request is kept. */
export function marketingOutcomeFor(error: unknown): { outcome: MarketingOutcome<never>; keep: boolean } {
  const kind = error instanceof MarketingError ? error.kind : 'UNKNOWN';
  switch (kind) {
    case 'CHANGED': return { outcome: { kind: 'CHANGED' }, keep: false };
    case 'REFUSED': return { outcome: { kind: 'REFUSED', code: (error as MarketingError).code }, keep: false };
    case 'KEY_REUSED': return { outcome: { kind: 'KEY_REUSED' }, keep: false };
    case 'DENIED': return { outcome: { kind: 'DENIED' }, keep: false };
    case 'INVALID': return { outcome: { kind: 'INVALID' }, keep: false };
    case 'GONE': return { outcome: { kind: 'GONE' }, keep: false };
    case 'SESSION': return { outcome: null, keep: false };
    default: return { outcome: { kind: 'UNKNOWN' }, keep: true };
  }
}

const newKey = () => globalThis.crypto.randomUUID();
type Pending<R> = Readonly<{ key: string; run: Run<R> }>;

/**
 * One command at a time. A command whose outcome is unknown is kept in memory (exact body and key) so Try again replays
 * it; the database answers a replay with the saved result and never saves it twice. Concealing or unmounting drops it.
 */
export function useMarketingCommand<R = HqMarketingReceipt>(privacy: React.MutableRefObject<number>, after: (outcome: MarketingOutcome<R>) => void) {
  const [outcome, setOutcome] = useState<MarketingOutcome<R>>(null);
  const [lock, setLock] = useState<'NONE' | 'SENDING' | 'KEPT'>('NONE');
  const pending = useRef<Pending<R> | null>(null), sending = useRef(false), mounted = useRef(false), afterRef = useRef(after);
  afterRef.current = after;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING' });
    let next: MarketingOutcome<R>, keep: boolean;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      next = { kind: 'DONE', receipt: await request.run(request.key, AbortSignal.timeout(30000), owned) }; keep = false;
    } catch (error) { ({ outcome: next, keep } = marketingOutcomeFor(error)); }
    finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    if (!mounted.current) return;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current) { setOutcome(null); return; }
    setOutcome(next); afterRef.current(next);
  }, [privacy]);
  const start = useCallback((run: Run<R>): boolean => {
    if (pending.current || sending.current) return false;
    pending.current = { key: newKey(), run }; void send(); return true;
  }, [send]);
  const tryAgain = useCallback(() => { void send(); }, [send]);
  const drop = useCallback(() => { pending.current = null; setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE'); }, []);
  const local = useCallback(() => { if (!pending.current && !sending.current) setOutcome({ kind: 'LOCAL_INVALID' }); }, []);
  return { outcome, locked: lock !== 'NONE', canRetry: lock === 'KEPT', start, tryAgain, drop, local, setOutcome };
}
