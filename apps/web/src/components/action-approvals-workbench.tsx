'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ACTION_REVIEW_STATUSES, actionReviewFingerprint, type HumanActionReview, type ActionReviewQueue, type HumanActionDecision, type ActionReviewStatus } from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { ActionReviewAccessError, loadActionReviews, readActionReview, decideActionReview } from './action-approvals-http';
import { InterfaceThemePicker } from './interface-theme-picker';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from './interface-theme-preference';
import styles from './action-approvals-workbench.module.css';

type InterfaceThemeState = 'UNAVAILABLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

type RetryState = {
  school: string;
  id: string;
  input: HumanActionDecision;
  key: string;
  fingerprint: string;
};

function materialFields(payload: Record<string, unknown>, pattern: RegExp, prefix = ''): Array<[string, unknown]> {
  return Object.entries(payload).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return pattern.test(key)
      ? [[path, value] as [string, unknown]]
      : value && typeof value === 'object' && !Array.isArray(value)
        ? materialFields(value as Record<string, unknown>, pattern, path)
        : [];
  });
}

function PlatformViewSelector({
  interfaceTheme,
  interfaceThemeState,
  interfaceThemeMessage,
  busy,
  onChange,
}: {
  interfaceTheme: HonInterfaceTheme;
  interfaceThemeState: InterfaceThemeState;
  interfaceThemeMessage: string;
  busy: boolean;
  onChange: (theme: HonInterfaceTheme) => void;
}): React.ReactElement {
  return <section className={styles.platformView} aria-labelledby="approval-platform-view-heading">
    <div>
      <p className={styles.eyebrow}>PRESENTATION ONLY / VERIFIED REVIEWER</p>
      <h2 id="approval-platform-view-heading">Platform View</h2>
      <p>Big-Button / Phone, Modern HON, and Classic CRM change touch targets and density only. They preserve the exact proposal queue, immutable payload, reviewer permission, approval binding, idempotency, decision controls, and no-execution posture.</p>
    </div>
    <InterfaceThemePicker
      current={interfaceTheme}
      onChange={onChange}
      disabled={busy || interfaceThemeState !== 'READY'}
      busy={busy || interfaceThemeState === 'LOADING' || interfaceThemeState === 'SAVING'}
      presentation={interfaceTheme === 'classic' ? 'compact' : 'cards'}
      ariaLabel="Platform View for the verified Action Engine reviewer and current school"
    />
    <p className={styles.platformViewStatus} role="status" aria-live="polite">{interfaceThemeMessage}</p>
  </section>;
}

export function ActionApprovalsWorkbench(): React.ReactElement {
  const [school, setSchool] = useState('');
  const [status, setStatus] = useState<ActionReviewStatus | 'ALL'>('AWAITING_APPROVAL');
  const [queue, setQueue] = useState<ActionReviewQueue | null>(null);
  const [detail, setDetail] = useState<HumanActionReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [interfaceTheme, setInterfaceTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [interfaceThemeState, setInterfaceThemeState] = useState<InterfaceThemeState>('UNAVAILABLE');
  const [interfaceThemeMessage, setInterfaceThemeMessage] = useState('Load a verified current-school approval queue to view or change your personal Platform View preference.');
  const retry = useRef<RetryState | null>(null);
  const interfaceThemeGeneration = useRef(0);

  useEffect(() => () => { interfaceThemeGeneration.current += 1; }, []);
  useEffect(() => {
    if (!queue) {
      interfaceThemeGeneration.current += 1;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);
      setInterfaceThemeState('UNAVAILABLE');
      setInterfaceThemeMessage('Load a verified current-school approval queue to view or change your personal Platform View preference.');
      return;
    }
    const current = ++interfaceThemeGeneration.current;
    const scope = { organizationId: queue.organizationId, schoolId: queue.schoolId };
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);
    setInterfaceThemeState('LOADING');
    setInterfaceThemeMessage('Loading your personal Platform View preference for this verified Action Engine reviewer and current school…');
    void loadInterfaceThemePreference(scope).then(preference => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme);
      setInterfaceThemeState('READY');
      setInterfaceThemeMessage(preference.selectedVia === 'DEFAULT'
        ? 'Modern HON is the visual default for this verified current-school reviewer. Choosing another presentation is optional.'
        : 'Saved for your current user and this verified current school only. It never changes proposal details, approval authority, idempotency, decisions, or execution behavior.');
    }).catch(reason => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);
      setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} Modern HON remains a visual default only; no preference was loaded or saved.`);
    });
    return () => { if (current === interfaceThemeGeneration.current) interfaceThemeGeneration.current += 1; };
  }, [queue?.organizationId, queue?.schoolId]);

  function clearDetail() {
    setDetail(null);
    setReason('');
    setConfirmed(false);
  }

  function clearScope() {
    interfaceThemeGeneration.current += 1;
    setQueue(null);
    clearDetail();
    retry.current = null;
    setUncertain(false);
    setNotice('');
    setError('');
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME);
    setInterfaceThemeState('UNAVAILABLE');
    setInterfaceThemeMessage('Load a verified current-school approval queue to view or change your personal Platform View preference.');
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (caught) {
      if (caught instanceof ActionReviewAccessError) clearScope();
      else clearDetail();
      setError(caught instanceof Error ? caught.message : 'No verified result.');
    } finally {
      setBusy(false);
    }
  }

  async function load(after: string | null = null) {
    await run(async () => {
      setQueue(null);
      clearDetail();
      setQueue(await loadActionReviews(school, status, after));
    });
  }

  async function open(id: string) {
    await run(async () => {
      clearDetail();
      const nextDetail = await readActionReview(school, id);
      if (!queue || nextDetail.organizationId !== queue.organizationId || nextDetail.reviewerPrincipalId !== queue.reviewerPrincipalId) throw new Error('Reviewer or school context changed. Reload the queue.');
      setDetail(nextDetail);
    });
  }

  async function chooseInterfaceTheme(next: HonInterfaceTheme) {
    if (!queue || interfaceThemeState !== 'READY') return;
    const current = ++interfaceThemeGeneration.current;
    const scope = { organizationId: queue.organizationId, schoolId: queue.schoolId };
    setInterfaceThemeState('SAVING');
    setInterfaceThemeMessage('Saving your personal Platform View preference for this verified Action Engine reviewer and current school…');
    try {
      const preference = await saveInterfaceThemePreference(scope, next, crypto.randomUUID(), 'SETTINGS');
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme);
      setInterfaceThemeState('READY');
      setInterfaceThemeMessage('Saved for your current user and this verified current school only. It never changes proposal details, approval authority, idempotency, decisions, or execution behavior.');
    } catch (caught) {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${caught instanceof Error ? caught.message : 'The personal Platform View preference is unavailable.'} No presentation preference was saved.`);
    }
  }

  async function submit(schoolId: string, id: string, input: HumanActionDecision) {
    const fingerprint = actionReviewFingerprint({ school: schoolId, id, input });
    if (retry.current?.fingerprint !== fingerprint) retry.current = { school: schoolId, id, input: structuredClone(input), key: crypto.randomUUID(), fingerprint };
    setUncertain(true);
    const receipt = await decideActionReview(schoolId, id, input, retry.current.key);
    setUncertain(false);
    clearDetail();
    setQueue(current => current ? { ...current, items: current.items.filter(item => item.id !== id) } : current);
    setNotice(`Verified human decision receipt: ${receipt.status === 'APPROVED' ? 'APPROVED' : 'REFUSED'} at ${receipt.reviewedAt}. Hash ${receipt.payloadHash}, policy ${receipt.policyVersion}. This is a decision receipt, not current execution status. No action was executed. Reload current detail to inspect later state.`);
  }

  async function decide(decision: 'APPROVED' | 'DENIED') {
    if (!detail || !confirmed || detail.reviewBlock || !detail.approvalExpiresAt) return;
    const input: HumanActionDecision = {
      decision,
      binding: {
        actionRequestId: detail.id,
        actionCode: detail.actionCode,
        requestedByPrincipalId: detail.requestedByPrincipalId,
        payloadHash: detail.payloadHash,
        policyVersion: detail.policyVersion,
        approvalExpiresAt: detail.approvalExpiresAt,
        effectiveAuthorityMode: detail.effectiveAuthorityMode,
      },
      ...(reason ? { reason } : {}),
    };
    await run(() => submit(school, detail.id, input));
  }

  const themeClass = interfaceTheme === 'big-button' ? styles.bigButton : interfaceTheme === 'classic' ? styles.classic : styles.modern;
  return <main className={`${styles.page} ${themeClass}`} data-interface-theme={interfaceTheme}>
    <nav><a href="/core">HON Core</a><a href="/complete">HON Complete</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN ACTION ENGINE · TWO-PERSON REVIEW</p><h1>Action approvals</h1><p>Review exact immutable proposals. Approve or refuse intent—not execution.</p></header>
    <aside><strong>No execution. No provider or AI call.</strong><p>This workbench only records a human decision. It does not charge, refund, change memberships, publish marketing or send communications. Existing executors remain separate and must revalidate before any action.</p><p>Exact reviewer permission: <code>action.approve</code>. Requesters and human delegators cannot approve their own proposals. Parent and HQ authority cannot be borrowed.</p></aside>
    <section><h2>Authorized school queue</h2><div className={styles.row}><label>Already-known school UUID<input disabled={busy} value={school} onChange={event => { clearScope(); setSchool(event.target.value.toLowerCase()); }} placeholder="School UUID; selector only" /></label><label>Status<select disabled={busy} value={status} onChange={event => { setStatus(event.target.value as ActionReviewStatus | 'ALL'); setQueue(null); clearDetail(); }}>{['AWAITING_APPROVAL', 'ALL', ...ACTION_REVIEW_STATUSES.filter(value => value !== 'AWAITING_APPROVAL')].map(value => <option key={value}>{value}</option>)}</select></label><button disabled={busy || !school} onClick={() => void load()}>Load / refresh queue</button></div><p>The server derives organization and reviewer from your verified session and current school permission. No identity directory. Up to 50 proposals per page, ordered by immutable request ID; select ALL for decision history.</p></section>
    {busy && <p role="status">Checking current scope and exact proposal…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    {queue && <PlatformViewSelector interfaceTheme={interfaceTheme} interfaceThemeState={interfaceThemeState} interfaceThemeMessage={interfaceThemeMessage} busy={busy} onChange={theme => void chooseInterfaceTheme(theme)} />}
    {uncertain && retry.current && <aside><p>An uncertain request is retained in memory only. No automatic retry; no successful decision is assumed.</p><button disabled={busy || !queue || retry.current.school !== school} onClick={() => void run(async () => { const next = retry.current!; await submit(next.school, next.id, next.input); })}>Retry exact retained decision</button></aside>}
    {queue && <section><h2>Proposal queue</h2><p>Organization {queue.organizationId}<br />School {queue.schoolId}<br />Human reviewer {queue.reviewerPrincipalId} · {queue.reviewerPermission}</p>{queue.items.length === 0 && <p>No proposals in this school and status. This is not a provider or execution result.</p>}<div className={styles.actions}>{queue.items.map(item => <button disabled={busy} key={item.id} onClick={() => void open(item.id)}>{item.actionCode} · {item.status}<br />Request {item.id}<br />Authority {item.effectiveAuthorityMode} · policy {item.policyVersion}<br />Expires {item.approvalExpiresAt ?? 'Not applicable'}</button>)}</div>{queue.nextAfter && <button disabled={busy} onClick={() => void load(queue.nextAfter)}>Next 50 proposals</button>}</section>}
    {detail && <section><h2>Exact proposal · {detail.status}</h2><dl className={styles.facts}>{Object.entries({ Request: detail.id, Action: detail.actionCode, 'Normalized payload SHA-256': detail.payloadHash, Requester: detail.requestedByPrincipalId, 'Delegated by': detail.delegatedByPrincipalId ?? 'Not applicable', 'Required action permission': detail.requiredPermission, 'Reviewer permission': detail.reviewerPermission, Reviewer: detail.reviewerPrincipalId, 'Proposal policy version': detail.policyVersion, 'Current policy version': detail.currentPolicyVersion, 'Proposal authority': detail.effectiveAuthorityMode, 'Current authority': detail.currentAuthorityMode ?? 'Unavailable', Expiry: detail.approvalExpiresAt ?? 'Not applicable', Created: detail.createdAt }).map(([key, value]) => <React.Fragment key={key}><dt>{key}</dt><dd>{value}</dd></React.Fragment>)}</dl>
      {detail.reviewBlock && <p role="status" className={styles.error}>Decision blocked: {detail.reviewBlock}. Reload or obtain a new separately validated proposal; this payload cannot be edited here.</p>}
      {detail.normalizedPayload ? <><h3>Material exact values</h3>{([['Target / resource', /target|(?:Id$)|version/i], ['Amount / financial terms', /amount|currency|price|quantity/i], ['Recipient / audience', /recipient|contact|audience|destination/i], ['Content', /content|body|subject|text/i], ['Provider account', /provider.*account|account.*provider/i], ['Schedule', /schedule|followUp|scheduled|time|date/i]] as Array<[string, RegExp]>).map(([label, pattern]) => { const fields = materialFields(detail.normalizedPayload!, pattern); return <div key={label}><h4>{label}</h4>{fields.length ? fields.map(([path, value]) => <p key={path}><code>{path}</code>: <span className={styles.value}>{JSON.stringify(value)}</span></p>) : <p>No applicable field recorded in this proposal. Nothing is inferred.</p>}</div>; })}<h3>Full exact normalized payload · read only</h3><pre>{JSON.stringify(detail.normalizedPayload, null, 2)}</pre><p>Hash is independently verified in this browser over canonical JSON. This is the persisted intent, not an editable form or a provider credential.</p></> : <p>Entire payload withheld because it is unsafe or hash-invalid. No redacted substitute may be approved. No credential or failure/result blob is displayed.</p>}
      <h3>Recorded decisions</h3>{detail.decisions.length ? detail.decisions.map((decision, index) => <p key={index}>{decision.decision} · reviewer {decision.reviewerPrincipalId}<br />{decision.decidedAt} · hash {decision.payloadHash} · policy {decision.policyVersion}</p>) : <p>No human decision recorded.</p>}{detail.decisionsTruncated && <p>First 50 records only; not a complete history.</p>}
      <fieldset disabled={busy || !!detail.reviewBlock || detail.payloadVisibility !== 'EXACT'}><legend>Confirm the exact reviewed intent</legend><label>Optional human decision reason (no credentials)<textarea maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I reviewed this exact payload/hash, requester, policy, authority and expiry. Approval does not execute it.</label><div className={styles.row}><button disabled={!confirmed} onClick={() => void decide('APPROVED')}>Approve exact proposal</button><button disabled={!confirmed} onClick={() => void decide('DENIED')}>Refuse exact proposal</button><button onClick={() => void open(detail.id)}>Reload current detail</button></div></fieldset>
    </section>}
  </main>;
}
