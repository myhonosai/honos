'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChampionsContestCommand, ChampionsContestConfig, ChampionsContestDetail } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { contestText, type ContestKey } from './copy';
import { ContestError, contestApi, contestId as checkId, type ContestApi } from './http';
import { dayToInstant, draftFrom, formatMoney, scheduleBlockers } from './form';
import { useConcealment, useContestCommand, type ContestOutcome } from './model';
import { ContestForm, Facts, Outcome, formatTime, statusTone, type SchoolChoices } from './parts';
import { directorySchools, type SchoolsLoader } from './hq-contests-list';
import styles from '../hq-access/hq-access.module.css';
import local from './contests.module.css';

export type ContestState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'GONE' } | { state: 'INVALID' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: ChampionsContestDetail };
/** A step on the contest without its version; the version read is added when it is sent. */
export type Step = { action: 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'END' | 'PROPOSE_WINNERS' | 'COMPLETE' }
  | { action: 'SCHEDULE'; schoolVisibility: 'HIDDEN' | 'ELIGIBLE_SCHOOLS' }
  | { action: 'CANCEL'; reasonCode: 'OWNER_DECISION' | 'POLICY_CHANGE' | 'FRAUD_CONCERN' | 'LEGAL_REVIEW' }
  | { action: 'APPROVE_WINNER'; winnerId: string } | { action: 'DISPUTE_WINNER'; winnerId: string; reasonCode: 'DISPUTE_RAISED' }
  | { action: 'REJECT_WINNER'; winnerId: string; reasonCode: 'DISPUTE_UPHELD' | 'FRAUD_CONFIRMED' | 'INELIGIBLE' }
  | { action: 'RESOLVE_WINNER'; winnerId: string; schoolId: string };

/**
 * One HQ referral contest: rules, prizes, standings, winners, liabilities and history, with the lifecycle steps that
 * apply now. Every step carries the version that was read and any answer is followed by a fresh read. Leaving the tab
 * or a session end hides the contest, its drafts and any kept command. The server decides who may act, every time.
 */
export function HqContest({ contestId, api = contestApi, schools: loadSchools = directorySchools, navigate = (href: string) => { window.location.assign(href); } }:
  { contestId: string; api?: ContestApi; schools?: SchoolsLoader; navigate?: (href: string) => void }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const valid = checkId(contestId) !== null;
  const [state, setState] = useState<ContestState>(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [schools, setSchools] = useState<SchoolChoices>({ state: 'LOADING' });
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; dropRef.current(); setEditing(false); setState(valid ? { state: 'LOADING' } : { state: 'INVALID' });
  });
  const after = useCallback((outcome: ContestOutcome) => {
    if (outcome?.kind === 'DONE') {
      setEditing(false);
      if (outcome.receipt.action === 'DUPLICATE') { navigate(`/hq/growth/contests/${outcome.receipt.contest.contestId}`); return; }
    }
    setRefresh(n => n + 1);
  }, [navigate]);
  const command = useContestCommand(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed || !valid) return;
    const current = ++generation.current, shown = privacy.current, owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.read(contestId, signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); }, error => {
      if (!owned() || abort.signal.aborted) return;
      const kind = error instanceof ContestError ? error.kind : 'UNKNOWN';
      if (kind === 'DENIED') dropRef.current();
      setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'INVALID' ? 'INVALID' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, contestId, valid, refresh, concealed, privacy]);

  useEffect(() => {
    if (!editing || concealed) return;
    const abort = new AbortController(); setSchools({ state: 'LOADING' });
    loadSchools(AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then(s => { if (!abort.signal.aborted) setSchools(s); });
    return () => { abort.abort(); };
  }, [editing, concealed, loadSchools]);

  const view = state.state === 'READY' ? state.view : null;
  const { start, local: localInvalid } = command;
  const send = useCallback((input: ChampionsContestCommand) => {
    if (!view) return;
    const id = view.contest.contestId;
    start((key, signal, owned) => api.command(id, input, key, signal, owned));
  }, [api, view, start]);
  const onStep = useCallback((step: Step) => { if (view) send({ ...step, expectedVersion: view.contest.version } as ChampionsContestCommand); }, [view, send]);
  const onUpdate = useCallback((config: ChampionsContestConfig) => { if (view) send({ action: 'UPDATE', expectedVersion: view.contest.version, ...config }); }, [view, send]);
  const onDuplicate = useCallback((name: string, startsOn: string, endsOn: string) => {
    const startsAt = dayToInstant(startsOn, false), endsAt = dayToInstant(endsOn, true), clean = name.trim();
    if (!startsAt || !endsAt || clean.length < 3 || clean.length > 120 || Date.parse(endsAt) <= Date.parse(startsAt)) { localInvalid('duplicate'); return; }
    send({ action: 'DUPLICATE', name: clean, startsAt, endsAt });
  }, [send, localInvalid]);

  return <HqContestView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} editing={editing} schools={schools}
    outcome={command.outcome} locked={command.locked} canRetry={command.canRetry} now={Date.now()}
    onRefresh={() => setRefresh(n => n + 1)} onReveal={reveal} onEdit={setEditing} onUpdate={onUpdate} onInvalid={() => localInvalid('update')}
    onStep={onStep} onDuplicate={onDuplicate} onTryAgain={command.tryAgain}/>;
}

const field = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? '');

export function HqContestView(p: Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: ContestState; editing: boolean; schools: SchoolChoices;
  outcome: ContestOutcome; locked: boolean; canRetry: boolean; now: number; onRefresh: () => void; onReveal: () => void; onEdit: (on: boolean) => void;
  onUpdate: (c: ChampionsContestConfig) => void; onInvalid: () => void; onStep: (s: Step) => void; onDuplicate: (name: string, startsOn: string, endsOn: string) => void;
  onTryAgain: () => void }>): React.ReactElement {
  const t = (key: ContestKey, vars?: Record<string, string>) => contestText(p.language, key, vars);
  const money = (minor: number) => formatMoney(minor, p.formattingLocale);
  const time = (iso: string) => formatTime(p.formattingLocale, iso);
  const ready = p.state.state === 'READY' && !p.concealed ? p.state.view : null;
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/growth/contests">{t('back')}</a></p><h1>{ready ? ready.contest.name : t('title')}</h1></div>
    {!p.concealed && <button type="button" className={styles.secondary} disabled={p.state.state === 'INVALID'} onClick={p.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (p.concealed) return <section className={styles.access} data-hq-contest="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></section>;
  if (!ready) {
    const s = p.state.state, key: ContestKey = s === 'LOADING' ? 'loading' : s === 'DENIED' ? 'denied' : s === 'GONE' ? 'gone' : s === 'INVALID' ? 'invalid' : 'unavailable';
    return <section className={styles.access} data-hq-contest={s.toLowerCase()} aria-busy={s === 'LOADING'}>{head}<p className={styles.notice} role="status">{t(key)}</p></section>;
  }
  const v = ready, c = v.contest, L = v.liabilities, lock = p.locked;
  const button = (label: ContestKey, step: Step, owner = false, danger = false) => <button type="button" className={danger ? styles.danger : styles.secondary} disabled={lock}
    data-contest-step={step.action} onClick={() => p.onStep(step)}>{t(label)}{owner ? ` · ${t('ownerOnly')}` : ''}</button>;
  const blockers = c.status === 'DRAFT' ? scheduleBlockers(c, p.now) : [];
  const early = (c.status === 'ACTIVE' || c.status === 'PAUSED') && Date.parse(c.endsAt) > p.now;
  const eligible = v.standings.filter(s => s.eligible);
  const cancelForm = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED'].includes(c.status) && <form className={`${styles.form} ${local.inline}`} data-contest-form="cancel"
    onSubmit={e => { e.preventDefault(); p.onStep({ action: 'CANCEL', reasonCode: field(e.currentTarget, 'reason') as 'OWNER_DECISION' }); }}>
    <div><label htmlFor="contest-cancel-reason">{t('cancelReason')}</label><select id="contest-cancel-reason" name="reason" defaultValue="OWNER_DECISION">
      {(['OWNER_DECISION', 'POLICY_CHANGE', 'FRAUD_CONCERN', 'LEGAL_REVIEW'] as const).map(r => <option key={r} value={r}>{t(r)}</option>)}</select></div>
    <button type="submit" className={styles.danger} disabled={lock}>{t('cancel')} · {t('ownerOnly')}</button></form>;

  return <section className={styles.access} data-hq-contest="ready">{head}
    <Outcome language={p.language} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain}/>

    <article className={styles.card} aria-labelledby="contest-facts"><div className={styles.cardHead}><h2 id="contest-facts">{t('facts')}</h2>
      <span className={styles.status} data-tone={statusTone(c.status)} data-contest-status={c.status}>{t(c.status)}</span></div>
      <p dir="auto">{c.description}</p>
      <Facts rows={[[t('windowLabel'), `${time(c.startsAt)} – ${time(c.endsAt)} UTC`],
        [t('countBasis'), t(c.countBasis)], [t('minimum'), String(c.minimumQualified)], [t('tieRule'), t(c.tieRule)],
        [t('eligibility'), `${t(c.eligibility.scope)} · ${c.eligibility.tiers.map(x => t(x)).join(', ')}${c.eligibility.scope === 'SELECTED_SCHOOLS' ? ` · ${t('schoolsChosen', { n: String(c.eligibility.schoolIds.length) })}` : ''}`],
        [t('terms'), c.termsReference ?? '—'], [t('giftCards'), t(c.giftCardCompliance)], [t('visibility'), t(c.schoolVisibility)],
        [t('version'), String(c.version)], [t('created'), `${time(c.createdAt)} UTC${c.duplicatedFrom ? ` · ${t('duplicatedFrom')}` : ''}`]]}/>
      {c.due !== 'NONE' && <p className={styles.outcome} data-tone="waiting">{t(c.due === 'START_DUE' ? 'dueSTART_DUE' : 'dueEND_DUE')}</p>}
    </article>

    <article className={styles.card} aria-labelledby="contest-actions" data-contest-actions><div className={styles.cardHead}><h2 id="contest-actions">{t('actions')}</h2></div>
      {c.status === 'DRAFT' && <>
        {!p.editing && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={lock} onClick={() => p.onEdit(true)}>{t('edit')}</button></div>}
        {blockers.length > 0 && <p className={styles.meta} data-contest-blockers={blockers.join(' ')}>{t('blockersTitle')} {blockers.map(b => t(`block${b}` as ContestKey)).join('; ')}.</p>}
        <form className={`${styles.form} ${local.inline}`} data-contest-form="schedule" onSubmit={e => { e.preventDefault();
          p.onStep({ action: 'SCHEDULE', schoolVisibility: field(e.currentTarget, 'visibility') as 'HIDDEN' }); }}>
          <div><label htmlFor="contest-visibility">{t('visibility')}</label><select id="contest-visibility" name="visibility" defaultValue="ELIGIBLE_SCHOOLS">
            {(['ELIGIBLE_SCHOOLS', 'HIDDEN'] as const).map(x => <option key={x} value={x}>{t(x)}</option>)}</select></div>
          <button type="submit" className={styles.primary} disabled={lock}>{t('schedule')} · {t('ownerOnly')}</button>
        </form><p className={styles.meta}>{t('scheduleHelp')}</p>
      </>}
      {c.status === 'SCHEDULED' && <><div className={styles.actions}>{button('activate', { action: 'ACTIVATE' })}</div>
        {Date.parse(c.startsAt) > p.now && <p className={styles.meta}>{t('notStarted', { at: `${time(c.startsAt)} UTC` })}</p>}</>}
      {c.status === 'ACTIVE' && <div className={styles.actions}>{button('pause', { action: 'PAUSE' })}{button(early ? 'endEarly' : 'end', { action: 'END' })}</div>}
      {c.status === 'PAUSED' && <div className={styles.actions}>{button('resume', { action: 'RESUME' }, true)}{button(early ? 'endEarly' : 'end', { action: 'END' })}</div>}
      {c.status === 'ENDED' && <div className={styles.actions}>{button('proposeWinners', { action: 'PROPOSE_WINNERS' })}</div>}
      {c.status === 'PENDING_WINNER_APPROVAL' && <div className={styles.actions}>{button('complete', { action: 'COMPLETE' }, true)}</div>}
      {cancelForm}
      <form className={`${styles.form} ${local.inline}`} data-contest-form="duplicate" onSubmit={e => { e.preventDefault();
        p.onDuplicate(field(e.currentTarget, 'name'), field(e.currentTarget, 'startsOn'), field(e.currentTarget, 'endsOn')); }}>
        <div><label htmlFor="contest-dup-name">{t('duplicateName')}</label><input id="contest-dup-name" name="name" maxLength={120} defaultValue={`${c.name} (copy)`.slice(0, 120)}/></div>
        <div><label htmlFor="contest-dup-start">{t('startsOn')}</label><input id="contest-dup-start" name="startsOn" type="date"/></div>
        <div><label htmlFor="contest-dup-end">{t('endsOn')}</label><input id="contest-dup-end" name="endsOn" type="date"/></div>
        <button type="submit" className={styles.secondary} disabled={lock}>{t('duplicate')}</button>
      </form>
    </article>

    {c.status === 'DRAFT' && p.editing && <ContestForm language={p.language} formattingLocale={p.formattingLocale} initial={draftFrom(c)} schools={p.schools} mode="edit"
      disabled={lock} onSubmit={p.onUpdate} onInvalid={p.onInvalid} onClose={() => p.onEdit(false)}/>}

    <article className={styles.card} aria-labelledby="contest-prizes"><div className={styles.cardHead}><h2 id="contest-prizes">{t('prizes')}</h2></div>
      <div className={local.table} role="region" aria-labelledby="contest-prizes" tabIndex={0}><table><thead><tr><th scope="col">{t('place')}</th><th scope="col">{t('kind')}</th>
        <th scope="col">{t('prizeDescription')}</th><th scope="col">{t('quantity')}</th><th scope="col">{t('unitCost')}</th></tr></thead>
        <tbody>{c.prizes.map(x => <tr key={x.prizeId}><td>{x.placeFrom === x.placeTo ? x.placeFrom : `${x.placeFrom}–${x.placeTo}`}</td><td>{t(x.kind)}</td><td dir="auto">{x.description}</td>
          <td>{x.quantity}</td><td>{money(x.estimatedUnitCostMinor)}</td></tr>)}</tbody></table></div>
    </article>

    <article className={styles.card} aria-labelledby="contest-liabilities"><div className={styles.cardHead}><h2 id="contest-liabilities">{t('liabilities')}</h2></div>
      <Facts rows={[[t('budgetLabel'), L.budgetMinor === null ? t('noBudget') : money(L.budgetMinor)], [t('estimated'), money(L.estimatedPrizeCostMinor)],
        [t('pending'), money(L.pendingWinnerCostMinor)], [t('approved'), money(L.approvedWinnerCostMinor)]]}/>
      <p className={styles.meta}>{t('liabilityNote')}</p>
    </article>

    <article className={styles.card} aria-labelledby="contest-standings"><div className={styles.cardHead}><h2 id="contest-standings">{t('standings')}</h2></div>
      <p className={styles.meta}>{t(v.standingsFrozen ? 'standingsFrozen' : 'standingsLive')}</p>
      {v.standings.length === 0 ? <p className={styles.meta}>{t('noStandings')}</p>
        : <div className={local.table} role="region" aria-labelledby="contest-standings" tabIndex={0}><table><thead><tr><th scope="col">{t('rank')}</th><th scope="col">{t('school')}</th>
          <th scope="col">{t('qualified')}</th><th scope="col">{t('eligibleCol')}</th></tr></thead>
          <tbody>{v.standings.map(s => <tr key={s.schoolId}><td>{s.rank ?? '—'}</td><td dir="auto">{s.schoolName}</td><td>{s.qualifiedReferrals}</td>
            <td>{s.eligible ? t('yes') : t(s.ineligibleReason ?? 'NOT_SELECTED')}</td></tr>)}</tbody></table></div>}
    </article>

    {v.winners.length > 0 && <article className={styles.card} aria-labelledby="contest-winners"><div className={styles.cardHead}><h2 id="contest-winners">{t('winners')}</h2></div>
      <ul className={styles.list}>{v.winners.map(w => {
        const open = c.status === 'PENDING_WINNER_APPROVAL';
        return <li key={w.winnerId} className={styles.form} data-contest-winner={w.winnerId}>
          <div className={styles.cardHead}><h3>{t('place')} {w.place} · <span dir="auto">{w.schoolName}</span></h3>
            <span className={styles.status} data-tone={w.status === 'APPROVED' ? 'ready' : w.status === 'REJECTED' ? 'blocked' : 'waiting'}>{t(w.status)}</span></div>
          <p className={styles.meta}>{t('cost')} {money(w.estimatedCostMinor)}</p>
          {open && <div className={styles.actions}>
            {w.status === 'PROPOSED' && button('approve', { action: 'APPROVE_WINNER', winnerId: w.winnerId }, true)}
            {(w.status === 'PROPOSED' || w.status === 'APPROVED') && button('dispute', { action: 'DISPUTE_WINNER', winnerId: w.winnerId, reasonCode: 'DISPUTE_RAISED' })}
          </div>}
          {open && (w.status === 'PROPOSED' || w.status === 'DISPUTED' || w.status === 'TIE_REVIEW') && <form className={local.inline} data-contest-form="reject"
            onSubmit={e => { e.preventDefault(); p.onStep({ action: 'REJECT_WINNER', winnerId: w.winnerId, reasonCode: field(e.currentTarget, 'reason') as 'INELIGIBLE' }); }}>
            <div><label htmlFor={`reject-${w.winnerId}`}>{t('rejectReason')}</label><select id={`reject-${w.winnerId}`} name="reason" defaultValue="INELIGIBLE">
              {(['INELIGIBLE', 'DISPUTE_UPHELD', 'FRAUD_CONFIRMED'] as const).map(r => <option key={r} value={r}>{t(r)}</option>)}</select></div>
            <button type="submit" className={styles.danger} disabled={lock}>{t('reject')} · {t('ownerOnly')}</button></form>}
          {open && (w.status === 'DISPUTED' || w.status === 'TIE_REVIEW' || w.status === 'REJECTED') && eligible.length > 0 && <form className={local.inline} data-contest-form="resolve"
            onSubmit={e => { e.preventDefault(); p.onStep({ action: 'RESOLVE_WINNER', winnerId: w.winnerId, schoolId: field(e.currentTarget, 'school') }); }}>
            <div><label htmlFor={`resolve-${w.winnerId}`}>{t('resolve')}</label><select id={`resolve-${w.winnerId}`} name="school" defaultValue={w.schoolId}>
              {eligible.map(s => <option key={s.schoolId} value={s.schoolId}>{s.rank}. {s.schoolName}</option>)}</select></div>
            <button type="submit" className={styles.secondary} disabled={lock}>{t('resolveButton')} · {t('ownerOnly')}</button></form>}
        </li>;
      })}</ul>
    </article>}

    {v.pauses.length > 0 && <article className={styles.card} aria-labelledby="contest-pauses"><div className={styles.cardHead}><h2 id="contest-pauses">{t('pauses')}</h2></div>
      <ul className={styles.list}>{v.pauses.map(x => <li key={x.pausedAt}>{t('pausedFrom', { from: `${time(x.pausedAt)} UTC` })}, {x.resumedAt ? t('resumedAt', { to: `${time(x.resumedAt)} UTC` }) : t('stillPaused')}</li>)}</ul>
    </article>}

    <article className={styles.card} aria-labelledby="contest-history"><div className={styles.cardHead}><h2 id="contest-history">{t('history')}</h2></div>
      <ol className={styles.list}>{[...v.history].reverse().map(h => <li key={`${h.contestVersion}-${h.action}`} data-contest-history={h.action}>
        <strong>{h.action.replaceAll('_', ' ').toLowerCase()}</strong> · {h.fromStatus === 'NONE' ? '' : `${t(h.fromStatus as ContestKey)} → `}{t(h.toStatus as ContestKey)} · v{h.contestVersion} · {time(h.occurredAt)} UTC</li>)}</ol>
    </article>
  </section>;
}
