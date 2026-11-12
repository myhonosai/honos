'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  TRIAL_POLICY_CONFIRMATION, TRIAL_PUBLICATION_CONFIRMATION,
  type TrialCampaignDraftInput, type TrialCampaignPublishInput, type TrialCampaignWithdrawInput, type TrialGovernanceView, type TrialPolicyDecisionInput,
  type TrialPolicyProposalInput, type TrialPublicationPreview,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { TrialsError, keepForRetry, toMinor, trialsApi, utcDay, type TrialsApi } from './http';
import type { Fields, TrialForm, TrialOutcome } from './forms';
import { TrialsView, campaignsOf, type PreviewState, type ReadState } from './view';

const systemNow = () => Date.now();
const failed = (error: unknown): 'DENIED' | 'UNAVAILABLE' => error instanceof TrialsError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE';

/** The exact command to send, built once from the form and the reads it was opened on. Try again replays it with the same key. */
export type TrialRequest = Readonly<
  | { action: 'propose'; body: TrialPolicyProposalInput }
  | { action: 'approve' | 'end'; body: TrialPolicyDecisionInput }
  | { action: 'draft'; body: TrialCampaignDraftInput }
  | { action: 'publish'; campaignId: string; body: TrialCampaignPublishInput }
  | { action: 'withdraw'; campaignId: string; body: TrialCampaignWithdrawInput }>;

const invalid = (): never => { throw new TrialsError('INVALID'); };
const whole = (v: string | undefined) => { const s = (v ?? '').trim(); return /^\d{1,10}$/.test(s) ? Number(s) : invalid(); };
const money = (v: string | undefined) => toMinor(v ?? '') ?? invalid();
const list = (v: string | undefined) => (v ?? '').split(',').filter(Boolean);
const date = (v: string | undefined) => utcDay(v ?? '') ?? invalid();

/** The request body for a form, from its fields and the governance read it was opened on. It throws INVALID when the details are not acceptable. */
export function trialRequest(form: Exclude<TrialForm, null>, fields: Fields, view: TrialGovernanceView, preview: TrialPublicationPreview | null): TrialRequest {
  const reason = (fields.reason ?? '').trim();
  const latestRevision = view.policyDecisions.reduce((n, d) => Math.max(n, d.revision), 0);
  const campaign = (id: string) => campaignsOf(view).find((c) => c.campaignId === id.toLowerCase()) ?? invalid();
  switch (form.kind) {
    case 'propose': {
      const promo = fields.promo === 'on';
      return { action: 'propose', body: { expectedVersion: view.policyVersions.reduce((n, v) => Math.max(n, v.version), 0), reason, terms: {
        allowedDurationsDays: list(fields.dur).map(Number), allowedCapabilityProfiles: list(fields.profile), allowedEligibilityCodes: list(fields.elig),
        allowedLinkModes: list(fields.link), maxEnrollmentCapacity: whole(fields.capacity), maxEnrollmentWindowDays: whole(fields.windowDays),
        maxPublishedCampaigns: whole(fields.maxCampaigns), maxTotalEnrollmentCapacity: whole(fields.totalCapacity), termsReference: (fields.termsReference ?? '').trim(),
        promotionalLimits: promo ? { maxCreditsPerEnrollment: whole(fields.promoCredits), maxCreditExpiryDays: whole(fields.promoExpiry), maxDailyCreditCap: whole(fields.promoDaily),
          maxPerRequestCreditCap: whole(fields.promoRequest), maxCampaignCostMinor: money(fields.promoCost), maxTotalCampaignCostMinor: money(fields.promoTotal) } : null } } };
    }
    case 'approve': {
      // The backend approves only the latest version; naming it makes a newer proposal a definite conflict, never a silent switch.
      const latest = view.policyVersions[0] ?? invalid();
      if (fields.confirm !== 'on') invalid();
      return { action: 'approve', body: { decision: 'APPROVED', policyId: latest.policyId, expectedRevision: latestRevision, validFrom: date(fields.validFrom),
        validUntil: date(fields.validUntil), reason, confirmation: TRIAL_POLICY_CONFIRMATION } };
    }
    case 'end': return { action: 'end', body: { decision: form.decision, expectedRevision: latestRevision, reason } };
    case 'draft': {
      const prior = form.campaignId === null ? null : campaign(form.campaignId);
      const promo = fields.promo === 'on';
      return { action: 'draft', body: { campaignId: prior?.campaignId ?? null, expectedVersion: prior?.latest.version ?? 0, reason, definition: {
        name: (fields.name ?? '').trim(), durationDays: whole(fields.duration), capabilityProfile: fields.profile as 'CORE', eligibility: fields.elig as 'NEW_ORGANIZATIONS_ONLY',
        linkMode: fields.link as 'PUBLIC', enrollmentOpensAt: date(fields.opens), enrollmentClosesAt: date(fields.closes), maximumEnrollments: whole(fields.maxEnrollments),
        termsReference: (fields.termsReference ?? '').trim(),
        promotionalBudget: promo ? { currency: 'USD', creditsPerEnrollment: whole(fields.promoCredits), creditExpiryDays: whole(fields.promoExpiry),
          dailyCreditCap: whole(fields.promoDaily), perRequestCreditCap: whole(fields.promoRequest), maximumCampaignCostMinor: money(fields.promoCost) } : null } } };
    }
    case 'publish': {
      // Bound to the readiness read: its version, revision and digest. Any change since then is refused by the database.
      const c = campaign(form.campaignId);
      if (!preview || !preview.ready || preview.campaignId.toLowerCase() !== c.campaignId || preview.versionId.toLowerCase() !== c.latest.versionId.toLowerCase()) return invalid();
      if (fields.confirm !== 'on') invalid();
      return { action: 'publish', campaignId: c.campaignId, body: { versionId: preview.versionId, expectedRevision: preview.expectedRevision, previewDigest: preview.digest,
        confirmation: TRIAL_PUBLICATION_CONFIRMATION, reason } };
    }
    case 'withdraw': {
      const c = campaign(form.campaignId);
      if (c.status !== 'PUBLISHED') invalid();
      return { action: 'withdraw', campaignId: c.campaignId, body: { expectedRevision: c.publications[0]!.revision, reason } };
    }
  }
}
type Pending = Readonly<{ key: string; request: TrialRequest }>;
function run(api: TrialsApi, r: TrialRequest, key: string, signal: AbortSignal, owned: () => boolean): Promise<{ replayed: boolean }> {
  switch (r.action) {
    case 'propose': return api.propose(r.body, key, signal, owned);
    case 'approve': case 'end': return api.decide(r.body, key, signal, owned);
    case 'draft': return api.draft(r.body, key, signal, owned);
    case 'publish': return api.publish(r.campaignId, r.body, key, signal, owned);
    case 'withdraw': return api.withdraw(r.campaignId, r.body, key, signal, owned);
  }
}
type Lock = 'NONE' | 'SENDING' | 'KEPT';

/**
 * HQ Free Trials: trial rules, decisions and campaign definitions, with the HQ owner's governance commands. Blur, a hidden
 * tab, page hide or a session end hide everything, retire every read and drop a kept command; Show again reads fresh.
 * Every command answer is followed by a fresh read. Nothing here turns trials on, issues credits or charges anyone.
 */
export function HqTrials({ api = trialsApi, now = systemNow }: { api?: TrialsApi; now?: () => number }): React.ReactElement {
  const { preferences } = useLocale();
  const [governance, setGovernance] = useState<ReadState<TrialGovernanceView>>({ state: 'LOADING' });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [concealed, setConcealed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [clock, setClock] = useState(() => now());
  const [form, setForm] = useState<TrialForm>(null);
  const [outcome, setOutcome] = useState<TrialOutcome>(null);
  const [lock, setLock] = useState<Lock>('NONE');
  const generation = useRef(0), privacy = useRef(0), mounted = useRef(false), check = useRef<AbortController | null>(null);
  const pending = useRef<Pending | null>(null), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; privacy.current++; pending.current = null; check.current?.abort(); }; }, []);
  useEffect(() => {
    const conceal = () => {
      generation.current++; privacy.current++; pending.current = null; check.current?.abort();
      setConcealed(true); setGovernance({ state: 'LOADING' }); setPreview(null); setForm(null); setOutcome(null); setLock(sending.current ? 'SENDING' : 'NONE');
    };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    check.current?.abort(); setPreview(null); setGovernance({ state: 'LOADING' });
    api.governance(signal, owned).then((view) => { if (owned()) { setClock(now()); setGovernance({ state: 'READY', view }); } },
      (error) => { if (owned() && !abort.signal.aborted) setGovernance({ state: failed(error) }); });
    return () => { abort.abort(); };
  }, [api, now, refresh, concealed]);

  const onCheck = useCallback((versionId: string) => {
    check.current?.abort();
    const abort = new AbortController(); check.current = abort;
    const current = generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current && check.current === abort;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setPreview({ state: 'LOADING', versionId }); setForm((f) => f?.kind === 'publish' ? null : f);
    api.preview(versionId, signal, owned).then((p) => { if (owned()) setPreview({ state: 'READY', versionId, preview: p }); },
      (error) => { if (owned() && !abort.signal.aborted) setPreview({ state: failed(error), versionId }); });
  }, [api]);

  const send = useCallback(async () => {
    const request = pending.current;
    if (!request || sending.current) return;
    sending.current = true; const shown = privacy.current;
    setLock('SENDING'); setOutcome({ kind: 'SENDING', action: request.request.action });
    let next: NonNullable<TrialOutcome>, keep = false;
    try {
      const owned = () => mounted.current && shown === privacy.current && pending.current?.key === request.key;
      const signal = AbortSignal.timeout(30000), r = request.request, k = request.key;
      const receipt = await run(api, r, k, signal, owned);
      next = { kind: 'DONE', action: r.action, replayed: receipt.replayed };
    } catch (error) {
      keep = keepForRetry(error);
      next = { kind: error instanceof TrialsError ? error.kind : 'UNKNOWN', action: request.request.action };
    } finally { sending.current = false; }
    if (pending.current?.key === request.key) pending.current = keep ? request : null;
    setLock(pending.current ? 'KEPT' : 'NONE');
    if (shown !== privacy.current || !mounted.current) return;
    setOutcome(next);
    // Any answer closes the form: Try again replays the stored request, never the form as edited since.
    setForm(null);
    setRefresh((n) => n + 1);
  }, [api]);

  const onSubmit = useCallback((fields: Fields) => {
    if (!form || lock !== 'NONE' || pending.current || sending.current || governance.state !== 'READY') return;
    let request: TrialRequest;
    try { request = trialRequest(form, fields, governance.view, preview?.state === 'READY' ? preview.preview : null); }
    catch { setOutcome({ kind: 'INVALID', action: form.kind }); return; }
    pending.current = { key: globalThis.crypto.randomUUID(), request };
    void send();
  }, [form, lock, governance, preview, send]);
  const onStop = useCallback(() => {
    if (lock !== 'KEPT' || sending.current) return;
    pending.current = null; setLock('NONE'); setOutcome(null); setRefresh((n) => n + 1);
  }, [lock]);
  const onOpen = useCallback((next: Exclude<TrialForm, null>) => { if (lock === 'NONE') { setOutcome(null); setForm(next); } }, [lock]);

  return <TrialsView language={preferences.language} concealed={concealed} governance={governance} now={clock} preview={preview}
    onRefresh={() => setRefresh((n) => n + 1)} onCheck={onCheck} onReveal={() => setConcealed(false)}
    form={form} outcome={outcome} locked={lock !== 'NONE'} canRetry={lock === 'KEPT'} onOpen={onOpen} onClose={() => setForm(null)} onSubmit={onSubmit}
    onTryAgain={() => { void send(); }} onStop={onStop}/>;
}
