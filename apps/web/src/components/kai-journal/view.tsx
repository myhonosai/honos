import React from 'react';
import type { KaiJournalEntry, KaiJournalPeriod, KaiJournalRead, KaiJournalSuggestion, KaiTeamJournalEntry } from '@hon/contracts';
import { journalCopy, journalDate, type JournalOutcomeKind } from './copy';
import type { JournalDraft, JournalProblem } from './draft';
import page from '../membership-changes/membership-changes.module.css';
import styles from './kai-journal.module.css';

export type JournalReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: KaiJournalRead };
export type JournalRecallState = null | { state: 'LOADING'; period: KaiJournalPeriod } | { state: 'UNAVAILABLE'; period: KaiJournalPeriod }
  | { state: 'READY'; period: KaiJournalPeriod; entries: KaiJournalEntry[]; topics: { topic: string; count: number }[] };
export type JournalTeamState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; entries: readonly KaiTeamJournalEntry[] };
export type JournalOutcome = null | Readonly<{ kind: JournalOutcomeKind }>;
export type JournalSpeech = Readonly<{ supported: boolean; listening: boolean; failed: boolean }>;
export type DraftField = 'taughtOn' | 'className' | 'notes' | 'topicInput';
export type KaiJournalViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; today: string;
  read: JournalReadState; draft: JournalDraft; problems: readonly JournalProblem[]; hints: readonly string[];
  speech: JournalSpeech; confirmingRemove: boolean; outcome: JournalOutcome; locked: boolean; canRetry: boolean;
  question: string; recall: JournalRecallState; suggestions: readonly KaiJournalSuggestion[]; team: JournalTeamState;
  onShare?: ((shared: boolean) => void) | undefined;
  onEdit?: ((field: DraftField, value: string) => void) | undefined; onAddTopic?: ((topic?: string) => void) | undefined; onRemoveTopic?: ((topic: string) => void) | undefined;
  onSpeak?: (() => void) | undefined; onSave?: (() => void) | undefined; onCancelEdit?: (() => void) | undefined;
  onAskRemove?: (() => void) | undefined; onConfirmRemove?: (() => void) | undefined; onKeep?: (() => void) | undefined;
  onOpen?: ((entry: KaiJournalEntry) => void) | undefined; onQuestion?: ((value: string) => void) | undefined; onAsk?: ((question?: string) => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const CALM: readonly JournalOutcomeKind[] = ['SAVING', 'SAVED', 'REMOVED'];

function EntryList({ entries, language, onOpen, locked }: { entries: readonly KaiJournalEntry[]; language: string; onOpen?: ((e: KaiJournalEntry) => void) | undefined; locked: boolean }) {
  const c = journalCopy(language);
  return <ul className={styles.entries}>{entries.map((e) => <li key={e.entryId} className={styles.entry} data-entry={e.entryId}>
    <div className={styles.entryHead}><strong>{journalDate(e.taughtOn, language)}{e.className ? ` · ${e.className}` : ''}</strong>
      <span>{e.source === 'SPOKEN' && <span className={styles.tag}>{c.spokenTag} </span>}{e.shared && <span className={styles.tag} data-tag="shared">{c.sharedTag} </span>}
        {onOpen && <button type="button" className={page.secondary} disabled={locked} onClick={() => onOpen(e)}>{c.edit}</button>}</span></div>
    <p className={styles.notes}>{e.notes}</p>
    {e.topics.length > 0 && <div className={styles.chips}>{e.topics.map((t) => <span key={t} className={styles.chip}>{t}</span>)}</div>}
  </li>)}</ul>;
}

/** Kai teaching journal (0476): pure, every state comes from props. */
export function KaiJournalView(p: KaiJournalViewProps): React.ReactElement {
  const c = journalCopy(p.language), read = p.read, d = p.draft;
  const date = (v: string) => journalDate(v, p.language);
  const head = <header className={page.head}><h1>{c.pageTitle}</h1><p className={page.intro}>{c.intro}</p>
    <p className={page.meta}><a href="/staff/teaching-assistant">Kai</a> · <a href="/staff/teaching-studio">Teaching studio</a></p></header>;
  if (p.waiting) return <main className={page.page}>{head}<p role="status">{c.checking}</p></main>;
  if (p.concealed) return <main className={page.page}>{head}<p role="status">{c.hidden}</p></main>;
  if (!p.hasSchool) return <main className={page.page}>{head}<p role="status">{c.chooseSchool}</p></main>;
  if (read.state !== 'READY') {
    if (read.state === 'LOADING') return <main className={page.page}>{head}<p role="status">{c.reading}</p></main>;
    if (read.state === 'DENIED') return <main className={page.page}>{head}<p role="alert" className={page.notice}>{c.denied}</p></main>;
    return <main className={page.page}>{head}<p role="alert" className={page.notice}>{c.unavailable}</p>
      <div className={page.row}><button type="button" className={page.secondary} onClick={p.onRefresh}>{c.refresh}</button></div></main>;
  }
  const recent = read.read.entries.slice(0, 20);
  const problem = (k: JournalProblem) => p.problems.includes(k);
  const outcome = p.outcome;
  return <main className={page.page} data-shell-private="">
    {head}
    {outcome && <p role={CALM.includes(outcome.kind) ? 'status' : 'alert'} className={page.notice} data-outcome={outcome.kind}>{c.outcomes[outcome.kind]}
      {p.canRetry && <> <button type="button" className={page.secondary} onClick={p.onTryAgain}>{c.tryAgain}</button></>}</p>}

    <section className={page.card} aria-labelledby="kai-journal-form">
      <h2 id="kai-journal-form">{d.entryId ? c.formEdit : c.formNew}</h2>
      <p className={page.meta}>{c.privacy}</p>
      <form className={page.form} onSubmit={(event) => { event.preventDefault(); p.onSave?.(); }}>
        <div className={styles.fields}>
          <label className={styles.field}>{c.fieldDate}<input type="date" value={d.taughtOn} max={p.today} disabled={p.locked} aria-invalid={problem('date')}
            onChange={(e) => p.onEdit?.('taughtOn', e.target.value)} /></label>
          <label className={styles.field}>{c.fieldClass}<input value={d.className} maxLength={80} placeholder={c.classPlaceholder} disabled={p.locked} aria-invalid={problem('className')}
            onChange={(e) => p.onEdit?.('className', e.target.value)} /></label>
        </div>
        <label className={styles.field}>{c.fieldNotes}<textarea value={d.notes} maxLength={2000} placeholder={c.notesPlaceholder} disabled={p.locked} aria-invalid={problem('notes')}
          onChange={(e) => p.onEdit?.('notes', e.target.value)} /></label>
        {p.speech.supported && <div className={page.row}>
          <button type="button" className={page.secondary} disabled={p.locked} aria-pressed={p.speech.listening} onClick={p.onSpeak}>{p.speech.listening ? c.stopSpeaking : c.speak}</button>
          {p.speech.listening && <span role="status">{c.listening}</span>}{p.speech.failed && <span role="status">{c.speechFailed}</span>}</div>}
        <div className={styles.field}><span id="kai-journal-topics">{c.fieldTopics}</span>
          <div className={styles.chips} aria-labelledby="kai-journal-topics">{d.topics.map((t) => <button key={t} type="button" className={styles.chip} disabled={p.locked}
            aria-label={c.removeTopic(t)} onClick={() => p.onRemoveTopic?.(t)}>{t} ×</button>)}</div>
          <div className={page.row}><input aria-labelledby="kai-journal-topics" value={d.topicInput} maxLength={40} placeholder={c.topicPlaceholder} disabled={p.locked || d.topics.length >= 10}
            onChange={(e) => p.onEdit?.('topicInput', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); p.onAddTopic?.(); } }} />
            <button type="button" className={page.secondary} disabled={p.locked || !d.topicInput.trim()} onClick={() => p.onAddTopic?.()}>{c.addTopic}</button></div>
          {p.hints.length > 0 && <div className={styles.chips}><span className={page.meta}>{c.usedBefore}</span>{p.hints.map((t) => <button key={t} type="button" data-kind="hint" className={styles.chip}
            disabled={p.locked} onClick={() => p.onAddTopic?.(t)}>+ {t}</button>)}</div>}
        </div>
        <label className={styles.share}><input type="checkbox" checked={d.shared} disabled={p.locked} onChange={(e) => p.onShare?.(e.target.checked)} /> {c.shareLabel}</label>
        <p className={page.meta}>{c.shareNote}</p>
        {p.problems.length > 0 && <ul className={styles.problems}>{p.problems.map((k) => <li key={k}>{c.problems[k]}</li>)}</ul>}
        <div className={page.row}>
          <button type="submit" className={page.primary} disabled={p.locked || p.problems.length > 0}>{c.save}</button>
          {d.entryId && <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onCancelEdit}>{c.cancelEdit}</button>}
          {d.entryId && !p.confirmingRemove && <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onAskRemove}>{c.remove}</button>}
        </div>
        {d.entryId && p.confirmingRemove && <div className={page.row} role="group"><span>{c.confirmRemove}</span>
          <button type="button" className={page.primary} disabled={p.locked} onClick={p.onConfirmRemove}>{c.remove}</button>
          <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onKeep}>{c.keepEntry}</button></div>}
      </form>
    </section>

    <section className={page.card} aria-labelledby="kai-journal-ask">
      <h2 id="kai-journal-ask">{c.askTitle}</h2>
      <form className={page.row} onSubmit={(event) => { event.preventDefault(); p.onAsk?.(); }}>
        <label className={styles.field}>{c.askLabel}<input value={p.question} maxLength={200} placeholder={c.askPlaceholder} onChange={(e) => p.onQuestion?.(e.target.value)} /></label>
        <button type="submit" className={page.primary}>{c.ask}</button>
      </form>
      <div className={styles.chips}>{c.examples.map((q) => <button key={q} type="button" data-kind="hint" className={styles.chip} onClick={() => p.onAsk?.(q)}>{q}</button>)}</div>
      {p.recall && <div data-recall={p.recall.state}>
        <h3>{c.recallHeading(date(p.recall.period.from), date(p.recall.period.to))}</h3>
        {!p.recall.period.understood && <p className={page.meta}>{c.recallGuess}</p>}
        {p.recall.state === 'LOADING' && <p role="status">{c.reading}</p>}
        {p.recall.state === 'UNAVAILABLE' && <p role="alert">{c.unavailable}</p>}
        {p.recall.state === 'READY' && (p.recall.entries.length === 0 ? <p>{c.recallNone}</p> : <>
          <p>{c.recallCount(p.recall.entries.length)}</p>
          {p.recall.topics.length > 0 && <p>{c.recallTopics} {p.recall.topics.map((t) => t.count > 1 ? `${t.topic} (${t.count})` : t.topic).join(', ')}</p>}
          <EntryList entries={p.recall.entries} language={p.language} locked={p.locked} /></>)}
      </div>}
    </section>

    <section className={page.card} aria-labelledby="kai-journal-patterns">
      <h2 id="kai-journal-patterns">{c.patternsTitle}</h2>
      <p className={page.meta}>{c.patternsNote}</p>
      {p.suggestions.length === 0 ? <p>{c.patternsNone}</p>
        : <ul className={styles.suggestions}>{p.suggestions.map((s, i) => <li key={`${s.kind}-${i}`} data-suggestion={s.kind}>{c.suggestion(s, date)}</li>)}</ul>}
    </section>

    <section className={page.card} aria-labelledby="kai-journal-recent">
      <div className={page.cardHead}><h2 id="kai-journal-recent">{c.recentTitle}</h2>
        <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button></div>
      {recent.length === 0 ? <p>{c.recentEmpty}</p> : <EntryList entries={recent} language={p.language} locked={p.locked} onOpen={p.onOpen} />}
    </section>

    <section className={page.card} aria-labelledby="kai-journal-team" data-team={p.team.state}>
      <h2 id="kai-journal-team">{c.teamTitle}</h2>
      <p className={page.meta}>{c.teamNote}</p>
      {p.team.state === 'LOADING' && <p role="status">{c.reading}</p>}
      {p.team.state === 'DENIED' && <p>{c.teamDenied}</p>}
      {p.team.state === 'UNAVAILABLE' && <p role="alert">{c.teamUnavailable}</p>}
      {p.team.state === 'READY' && (p.team.entries.length === 0 ? <p>{c.teamEmpty}</p>
        : <ul className={styles.entries}>{p.team.entries.map((e) => <li key={e.entryId} className={styles.entry} data-team-entry={e.entryId}>
          <div className={styles.entryHead}><strong>{date(e.taughtOn)}{e.className ? ` · ${e.className}` : ''}</strong><span>{e.authorName}</span></div>
          <p className={styles.notes}>{e.notes}</p>
          {e.topics.length > 0 && <div className={styles.chips}>{e.topics.map((t) => <span key={t} className={styles.chip}>{t}</span>)}</div>}
        </li>)}</ul>)}
    </section>
  </main>;
}
