'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaasPlanOffer, SaasSchoolCredits } from '@hon/contracts';
import { canPurchase, loadSchoolAccount, loadSchoolAllowance, offerFingerprint, reviewFingerprint, SchoolCheckoutError, startSchoolCheckout, type SchoolAccount } from './http';

type Attempt = { key: string; fingerprint: string; offerId: string; schoolId: string; organizationId: string };
export function useSchoolCheckout() {
  const [account, setAccount] = useState<SchoolAccount | null>(null);
  const [credits, setCredits] = useState<SaasSchoolCredits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [posting, setPosting] = useState(false), [pendingAttempt, setPendingAttempt] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), lock = useRef(false), mounted = useRef(true);
  const attempt = useRef<Attempt | null>(null);
  const refresh = useCallback(async () => {
    const run = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setLoading(true); setAccount(null); setCredits(null); setError(null); setCreditError(null); setCheckedAt(null); setCommandError(null);
    try {
      const data = await loadSchoolAccount(abort.signal); if (!mounted.current || run !== generation.current) return;
      const c = data.plan.checkout;
      if (attempt.current && c?.offerId === attempt.current.offerId && data.context.schoolId === attempt.current.schoolId && (c.status === 'OPEN' || ['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED', 'PAID_NEEDS_REVIEW'].includes(c.status))) { attempt.current = null; setPendingAttempt(false); }
      setAccount(data); setCheckedAt(new Date().toISOString()); setLoading(false);
      try { const balance = await loadSchoolAllowance(data, abort.signal); if (mounted.current && run === generation.current) setCredits(balance); }
      catch (e) { if (mounted.current && run === generation.current && !abort.signal.aborted) {
        if (e instanceof SchoolCheckoutError && e.kind === 'UNAUTHORIZED') { setAccount(null); setError(e.message); }
        else setCreditError(e instanceof SchoolCheckoutError ? e.message : 'AI allowance is unavailable. No balance is assumed.');
      } }
    } catch (e) { if (mounted.current && run === generation.current && !abort.signal.aborted) setError(e instanceof SchoolCheckoutError ? e.message : 'School billing could not be verified. Refresh to try again.'); }
    finally { if (mounted.current && run === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; ++generation.current; controller.current?.abort(); }; }, [refresh]);

  async function start(offer: SaasPlanOffer, reviewed: string) {
    if (lock.current || !account) return; lock.current = true; setPosting(true); setCommandError(null);
    const original = account;
    try {
      // Read current server identity and offer again after human review, immediately before command.
      const current = await loadSchoolAccount(); if (!mounted.current) return;
      const fresh = current.plan.offers.find((o) => o.offerId === offer.offerId);
      if (!fresh || current.context.schoolId !== original.context.schoolId || current.context.organizationId !== original.context.organizationId
        || offerFingerprint(current, fresh) !== offerFingerprint(original, offer)
        || (!attempt.current && reviewFingerprint(current, fresh) !== reviewed)) {
        setAccount(current); setCredits(null); throw new SchoolCheckoutError('CHANGED', 'School, offer or checkout details changed. Review the latest selection before continuing.');
      }
      if (attempt.current) {
        if (attempt.current.fingerprint !== offerFingerprint(current, fresh) || current.plan.subscription || current.plan.checkout?.status === 'PAID_NEEDS_REVIEW') throw new SchoolCheckoutError('CHANGED', 'This unresolved checkout must be reviewed before starting another purchase.');
      } else {
        if (!canPurchase(current, fresh)) { setAccount(current); throw new SchoolCheckoutError('CHANGED', 'This offer is not currently available for checkout. Refresh and review your account.'); }
        attempt.current = { key: crypto.randomUUID(), fingerprint: offerFingerprint(current, fresh), offerId: fresh.offerId, schoolId: current.context.schoolId, organizationId: current.context.organizationId };
      }
      setPendingAttempt(true);
      await startSchoolCheckout(current, fresh, attempt.current.key);
      if (!mounted.current) return;
      // Do not infer paid or activation from command receipt; re-read authoritative account state.
      await refresh();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof SchoolCheckoutError && e.kind === 'CHANGED') { setCommandError(e.message); }
      else { setAccount(null); setCredits(null); setCheckedAt(null); setCommandError(e instanceof SchoolCheckoutError ? e.message : 'Checkout outcome is unverified. Refresh before retrying.'); }
    } finally { lock.current = false; if (mounted.current) setPosting(false); }
  }
  return { account, credits, error, creditError, commandError, loading, posting, pendingAttempt, retryOfferId: pendingAttempt ? attempt.current?.offerId : null, checkedAt, refresh, start };
}
