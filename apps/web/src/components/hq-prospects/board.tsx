'use client';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { HQ_PROSPECT_SOURCES, HQ_STAGE_COLORS, HQ_STAGE_NAME_MAX, type HqBoardProspect, type HqBoardSchool, type HqProspectBoard, type HqProspectOutcome,
  type HqProspectSource, type HqStageColor } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useConcealment } from '../hq-communications/model';
import { CommsError } from '../hq-communications/http';
import { HqProspects } from './hq-prospects';
import { prospectsApi, type ProspectsApi } from './http';
import { boardText, type BoardKey } from './board-copy';
import {
  HQ_BOARD_FILTERS, HQ_BOARD_SORTS, applyHqMove, callHref, emailHref, filterProspects, hqColumns, hqDraftErrors, hqDraftFrom, hqDraftInput, hqStats,
  initialsOf, moveChoices, moveDraftStageTo, moveTargets, schoolColumns, stagesNeedingMove, textHref, type HqBoardFilters, type HqBoardSort, type HqDraft, type HqDraftError,
} from './board-model';
import styles from '../lead-pipeline/pipeline.module.css';
import own from './board.module.css';

type T = (key: BoardKey, vars?: Record<string, string>) => string;
export type HqBoardState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; board: HqProspectBoard };
export type HqNotice = { tone: 'OK' | 'ERROR'; text: string } | null;
export type HqEditState = null | { draft: HqDraft; newName: string; phase: 'EDIT' | 'SAVING' | 'UNCERTAIN'; error: string | null };
export type HqBoardView = 'BOARD' | 'LIST';
export const PROSPECT_DRAG_TYPE = 'application/x-hon-hq-prospect';
const STAGE_DRAG_TYPE = 'application/x-hon-hq-stage';
const SAVE_REASON: Record<string, BoardKey> = {
  HQ_PROSPECT_STAGE_NAME_TAKEN: 'errName', HQ_PROSPECT_STAGE_VISIBLE_REQUIRED: 'errVisible', HQ_PROSPECT_STAGE_MOVE_REQUIRED: 'errMove',
  HQ_PROSPECT_STAGE_MOVE_INVALID: 'errMove',
};

/**
 * HQ prospects as one pipeline board (0715): HQ-editable prospect stages, drag and drop, Became a school / Not interested
 * drop zones, and two fixed read-only columns of customer schools by their real status. A session end hides the page at
 * once, retires every read and drops every kept command. The List view is the existing prospects list with Add prospect.
 */
export function HqProspectBoard({ api = prospectsApi }: { api?: ProspectsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const t: T = useCallback((key, vars) => boardText(language, key, vars), [language]);
  const [view, setView] = useState<HqBoardView>('BOARD');
  const [board, setBoard] = useState<HqBoardState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState<HqBoardFilters>(HQ_BOARD_FILTERS);
  const [notice, setNotice] = useState<HqNotice>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<HqEditState>(null);
  const generation = useRef(0), mounted = useRef(false), savedRequest = useRef<{ key: string; draft: HqDraft } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => {
    generation.current++; savedRequest.current = null; setEdit(null); setNotice(null); setMovingId(null); setBoard({ state: 'LOADING' });
  });
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    if (concealed || view !== 'BOARD') return;
    const current = ++generation.current, shown = privacy.current;
    const owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setBoard((prior) => prior.state === 'READY' ? prior : { state: 'LOADING' });
    api.board(signal, owned).then((next) => { if (owned()) setBoard({ state: 'READY', board: next }); }, (error: unknown) => {
      if (!owned() || abort.signal.aborted) return;
      const kind = error instanceof CommsError ? error.kind : 'UNKNOWN';
      if (kind !== 'SESSION') setBoard({ state: kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => abort.abort();
  }, [api, refresh, concealed, privacy, view]);

  const ready = board.state === 'READY' ? board.board : null;
  const onMove = useCallback((prospectId: string, target: { stageId: string } | { outcome: HqProspectOutcome }) => {
    if (!ready || movingId) return;
    const p = ready.prospects.find((x) => x.prospectId === prospectId);
    if (!p) return;
    const stage = 'stageId' in target ? ready.stages.find((s) => s.stageId === target.stageId && !s.hidden) : null;
    if ('stageId' in target && (!stage || p.stageId === target.stageId)) return;
    const input = { expectedVersion: p.version, stageId: 'stageId' in target ? target.stageId : null, outcome: 'outcome' in target ? target.outcome : null };
    const shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    setMovingId(p.prospectId); setNotice(null);
    api.move(p.prospectId, input, crypto.randomUUID(), AbortSignal.timeout(30000), owned).then((receipt) => {
      if (!owned()) return; setMovingId(null);
      setBoard((now) => now.state === 'READY' ? { state: 'READY', board: applyHqMove(now.board, receipt.prospect) } : now);
      setNotice({ tone: 'OK', text: stage ? t('moved', { name: p.fullName, stage: stage.name }) : t(input.outcome === 'WON' ? 'closedWon' : 'closedLost', { name: p.fullName }) });
    }, (error: unknown) => {
      if (!owned()) return; setMovingId(null);
      const kind = error instanceof CommsError ? error.kind : 'UNKNOWN';
      if (kind === 'SESSION') return;
      setNotice({ tone: 'ERROR', text: t(kind === 'UNKNOWN' ? 'moveUnknown' : kind === 'CHANGED' ? 'moveChanged' : kind === 'DENIED' ? 'errDenied' : 'moveFailed') });
      reload();
    });
  }, [api, ready, movingId, privacy, t, reload]);

  const onEdit = useCallback((open: boolean) => {
    const wasUncertain = edit?.phase === 'UNCERTAIN';
    savedRequest.current = null;
    if (!open || !ready) { setEdit(null); if (wasUncertain) reload(); return; }
    setEdit({ draft: hqDraftFrom(ready.stages), newName: '', phase: 'EDIT', error: null });
  }, [ready, edit, reload]);
  const onDraft = useCallback((next: HqEditState) => {
    // Changing the draft after an unknown outcome starts a new save; the old one is no longer retried.
    if (next && edit?.phase === 'UNCERTAIN' && next.draft !== edit.draft) { savedRequest.current = null; setEdit({ ...next, phase: 'EDIT' }); return; }
    setEdit(next);
  }, [edit]);
  const onSave = useCallback(() => {
    if (!ready || !edit || edit.phase === 'SAVING') return;
    const request = edit.phase === 'UNCERTAIN' && savedRequest.current?.draft === edit.draft ? savedRequest.current : { key: crypto.randomUUID(), draft: edit.draft };
    const target = edit, shown = privacy.current, owned = () => mounted.current && shown === privacy.current;
    savedRequest.current = request; setEdit({ ...target, phase: 'SAVING', error: null });
    api.saveStages(hqDraftInput(request.draft, ready.pipelineVersion), request.key, AbortSignal.timeout(30000), owned).then(() => {
      if (!owned()) return; savedRequest.current = null; setEdit(null); setNotice({ tone: 'OK', text: t('saved') }); reload();
    }, (error: unknown) => {
      if (!owned()) return;
      const kind = error instanceof CommsError ? error.kind : 'UNKNOWN';
      if (kind === 'UNKNOWN') { setEdit({ ...target, phase: 'UNCERTAIN' }); return; }
      savedRequest.current = null;
      if (kind === 'SESSION') { setEdit(null); return; }
      const code = error instanceof CommsError ? error.code : null;
      const text = kind === 'CHANGED' ? t('saveChanged') : kind === 'DENIED' ? t('errDenied') : t('saveFailed', { reason: t(SAVE_REASON[code ?? ''] ?? 'errName') });
      setEdit({ ...target, phase: 'EDIT', error: text });
    });
  }, [api, ready, edit, privacy, t, reload]);

  if (view === 'LIST') return <div data-testid="hq-prospect-list-view">
    <ViewToggle view={view} t={t} onView={setView}/>
    <HqProspects api={api}/>
  </div>;
  return <HqProspectBoardView language={language} concealed={concealed} board={board} filters={filters} notice={notice} movingId={movingId} edit={edit}
    onFilters={setFilters} onView={setView} onMove={onMove} onEdit={onEdit} onDraft={onDraft} onSave={onSave}
    onRefresh={() => { setNotice(null); reload(); }} onReveal={() => { reveal(); reload(); }}/>;
}

export type HqProspectBoardViewProps = Readonly<{
  language: string; concealed: boolean; board: HqBoardState; filters: HqBoardFilters; notice: HqNotice; movingId: string | null; edit: HqEditState;
  onFilters?: (f: HqBoardFilters) => void; onView?: (v: HqBoardView) => void;
  onMove?: (prospectId: string, target: { stageId: string } | { outcome: HqProspectOutcome }) => void;
  onEdit?: (open: boolean) => void; onDraft?: (e: HqEditState) => void; onSave?: () => void; onRefresh?: () => void; onReveal?: () => void;
}>;
type Inner = HqProspectBoardViewProps & { t: T; ready: HqProspectBoard };
const day = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });
const rate = (r: number | null, language: string) => r === null ? '–' : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(r);

function ViewToggle({ view, t, onView }: { view: HqBoardView; t: T; onView?: ((v: HqBoardView) => void) | undefined }) {
  return <div className={styles.toggle} role="group" aria-label={t('viewLabel')}>
    <button type="button" aria-pressed={view === 'BOARD'} onClick={() => onView?.('BOARD')}>{t('viewBoard')}</button>
    <button type="button" aria-pressed={view === 'LIST'} onClick={() => onView?.('LIST')}>{t('viewList')}</button>
  </div>;
}

/** Pure view. Every name, contact, stage and school comes from the board read; nothing here decides authority. */
export function HqProspectBoardView(props: HqProspectBoardViewProps): React.ReactElement {
  const { language, concealed, board, onRefresh, onReveal } = props;
  const t: T = (key, vars) => boardText(language, key, vars);
  const ready = board.state === 'READY' ? board.board : null;
  return <section className={styles.page} aria-labelledby="hq-board-title" data-hon-native="" data-testid="hq-prospect-board">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1 id="hq-board-title">{t('title')}</h1>
        <p className={styles.summary}>{t('intro')}</p>
      </div>
      {!concealed ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={board.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>
      <button type="button" className={styles.secondary} onClick={onReveal}>{t('reveal')}</button></div> : <>
      {ready ? <Stats {...props} t={t} ready={ready}/> : null}
      <Toolbar {...props} t={t}/>
      {props.notice ? <p className={styles.flash} data-tone={props.notice.tone} role={props.notice.tone === 'ERROR' ? 'alert' : 'status'}>{props.notice.text}</p> : null}
      {board.state === 'LOADING' ? <p className={styles.notice} role="status">{t('loading')}</p> : null}
      {board.state === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p> : null}
      {board.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('unavailable')}</p>
        <button type="button" className={styles.secondary} onClick={onRefresh}>{t('refresh')}</button></div> : null}
      {ready ? <Board {...props} t={t} ready={ready}/> : null}
      {ready && props.edit ? <EditDialog {...props} t={t} ready={ready} edit={props.edit}/> : null}
    </>}
  </section>;
}

function Stats({ ready, language, t }: Inner) {
  const s = hqStats(ready);
  const cards: Array<{ key: BoardKey; value: string; tone: string }> = [
    { key: 'statOpen', value: String(s.open), tone: 'open' }, { key: 'statActive', value: String(s.active), tone: 'won' },
    { key: 'statInactive', value: String(s.inactive), tone: 'lost' }, { key: 'statRate', value: rate(s.rate, language), tone: 'rate' },
  ];
  return <ul className={styles.stats} aria-label={t('statusLabel')}>{cards.map((c) => <li key={c.key}>
    <div className={styles.stat} data-tone={c.tone}><span className={styles.statLabel}>{t(c.key)}</span><strong className={styles.statValue}>{c.value}</strong></div>
  </li>)}</ul>;
}

function Toolbar(props: HqProspectBoardViewProps & { t: T }) {
  const { board, filters, onFilters, onView, onEdit, t } = props;
  const ids = { search: useId(), source: useId(), sort: useId() };
  const off = board.state !== 'READY';
  return <div className={styles.toolbar} role="search">
    <div className={styles.field} data-grow="">
      <label htmlFor={ids.search}>{t('searchLabel')}</label>
      <input id={ids.search} type="search" maxLength={120} autoComplete="off" placeholder={t('searchPlaceholder')} value={filters.search} disabled={off}
        onChange={(e) => onFilters?.({ ...filters, search: e.target.value })}/>
    </div>
    <div className={styles.field}>
      <label htmlFor={ids.source}>{t('sourceLabel')}</label>
      <select id={ids.source} value={filters.source} disabled={off} onChange={(e) => onFilters?.({ ...filters, source: e.target.value as HqProspectSource | '' })}>
        <option value="">{t('sourceAll')}</option>
        {HQ_PROSPECT_SOURCES.map((s) => <option key={s} value={s}>{t(s)}</option>)}
      </select>
    </div>
    <div className={styles.field}>
      <label htmlFor={ids.sort}>{t('sortLabel')}</label>
      <select id={ids.sort} value={filters.sort} disabled={off} onChange={(e) => onFilters?.({ ...filters, sort: e.target.value as HqBoardSort })}>
        {HQ_BOARD_SORTS.map((s) => <option key={s} value={s}>{t(s === 'NEWEST' ? 'sortNewest' : s === 'OLDEST' ? 'sortOldest' : 'sortName')}</option>)}
      </select>
    </div>
    <ViewToggle view="BOARD" t={t} onView={onView}/>
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} disabled={off} onClick={() => onEdit?.(true)}>{t('editStages')}</button>
      <button type="button" className={styles.primary} onClick={() => onView?.('LIST')}>{t('addProspect')}</button>
    </div>
  </div>;
}

function Board(props: Inner) {
  const { ready, filters, language, onMove, t } = props;
  const shown = filterProspects(ready.prospects, filters, language);
  const columns = hqColumns(ready, shown);
  const schools = schoolColumns(ready.schools, filters.search);
  const drop = (handler: (prospectId: string) => void) => ({
    onDragOver: (e: React.DragEvent) => { if (Array.from(e.dataTransfer.types).includes(PROSPECT_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } },
    onDrop: (e: React.DragEvent) => { const id = e.dataTransfer.getData(PROSPECT_DRAG_TYPE); if (id) { e.preventDefault(); handler(id); } },
  });
  return <>
    {ready.prospects.length > 0 && shown.length === 0 ? <p className={styles.notice}>{t('noneMatch')}</p> : null}
    <div className={styles.board} data-testid="hq-board">
      {columns.map(({ stage, prospects }) => <section key={stage.stageId} className={styles.column} data-color={stage.color} data-hidden={stage.hidden ? '' : undefined}
        aria-labelledby={`hq-stage-${stage.stageId}`} data-testid="hq-stage-column"
        {...(stage.hidden ? {} : drop((id) => onMove?.(id, { stageId: stage.stageId })))}>
        <header className={styles.columnHead}>
          <span className={styles.dot} aria-hidden="true"/>
          <h2 id={`hq-stage-${stage.stageId}`}>{stage.name}</h2>
          {stage.hidden ? <span className={styles.badge}>{t('hiddenStage')}</span> : null}
          <span className={styles.count}>{t('count', { n: String(prospects.length) })}</span>
        </header>
        {prospects.length === 0 ? <p className={styles.empty}>{t('dropHere')}</p>
          : <ul className={styles.cards}>{prospects.map((p) => <li key={p.prospectId}><Card {...props} prospect={p}/></li>)}</ul>}
      </section>)}
      <SchoolColumn title={t('activeSchool')} tone="GREEN" schools={schools.active} language={language} t={t} testId="hq-active-schools"/>
      <SchoolColumn title={t('inactiveSchool')} tone="SLATE" schools={schools.inactive} language={language} t={t} testId="hq-inactive-schools"/>
    </div>
    <div className={styles.drops}>
      <div className={styles.drop} data-tone="won" data-testid="hq-drop-won" {...drop((id) => onMove?.(id, { outcome: 'WON' }))}>{t('dropWon')}</div>
      <div className={styles.drop} data-tone="lost" data-testid="hq-drop-lost" {...drop((id) => onMove?.(id, { outcome: 'LOST' }))}>{t('dropLost')}</div>
    </div>
    {ready.truncated ? <p className={styles.meta}>{t('truncated', { n: String(ready.prospects.length) })}</p> : null}
  </>;
}

/** Customer schools by real status. Never a drop target, and cards are not draggable: pause, remove and restore stay on the school page. */
function SchoolColumn({ title, tone, schools, language, t, testId }: { title: string; tone: HqStageColor; schools: HqBoardSchool[]; language: string; t: T; testId: string }) {
  return <section className={styles.column} data-color={tone} data-fixed="" aria-label={title} data-testid={testId}>
    <header className={styles.columnHead}>
      <span className={styles.dot} aria-hidden="true"/><h2>{title}</h2><span className={styles.count}>{t('count', { n: String(schools.length) })}</span>
    </header>
    <p className={styles.meta}>{t('schoolAuto')}</p>
    {schools.length === 0 ? <p className={styles.empty}>{t('noSchools')}</p> : <ul className={styles.cards}>{schools.map((s) => <li key={s.schoolId}>
      <article className={styles.card} data-testid="hq-school-card">
        <a className={`${styles.cardOpen} ${own.link}`} href={`/hq/schools/${s.schoolId}`}>
          <span className={styles.avatar} aria-hidden="true">{initialsOf(s.schoolName)}</span>
          <span className={styles.cardText}>
            <strong>{s.schoolName}</strong>
            {s.organizationName !== s.schoolName ? <span className={styles.program}>{s.organizationName}</span> : null}
            <small>{[s.trialEndsAt ? t('trialUntil', { date: day(language, s.trialEndsAt) }) : s.tier ? s.tier.charAt(0) + s.tier.slice(1).toLowerCase().replace(/_/g, ' ') : null, s.status === 'SUSPENDED' ? t('paused') : s.status === 'ARCHIVED' ? t('removed') : null,
              t('since', { date: day(language, s.createdAt) })].filter(Boolean).join(' · ')}</small>
          </span>
        </a>
      </article>
    </li>)}</ul>}
  </section>;
}

function Card({ ready, prospect: p, movingId, onMove, t }: Inner & { prospect: HqBoardProspect }) {
  const busy = movingId === p.prospectId;
  const targets = moveTargets(ready.stages, p);
  const call = callHref(p.phone), text = textHref(p), email = emailHref(p.email);
  const close = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  return <article className={styles.card} data-moving={busy ? '' : undefined} draggable={!busy} data-testid="hq-prospect-card"
    onDragStart={(e) => { e.dataTransfer.setData(PROSPECT_DRAG_TYPE, p.prospectId); e.dataTransfer.effectAllowed = 'move'; }}>
    <a className={`${styles.cardOpen} ${own.link}`} href={`/hq/growth/prospects/${p.prospectId}`} draggable={false}>
      <span className={styles.avatar} aria-hidden="true">{initialsOf(p.fullName)}</span>
      <span className={styles.cardText}>
        <strong>{p.fullName}</strong>
        {p.schoolName ? <span className={styles.program}>{p.schoolName}</span> : null}
        <small>{t(p.source)}</small>
      </span>
    </a>
    {busy ? <span className={styles.meta} role="status">{t('moving')}</span> : <details className={styles.menu}>
      <summary aria-label={t('moveToLabel', { name: p.fullName })}>{t('moveTo')}</summary>
      <ul>
        {targets.map((s) => <li key={s.stageId}><button type="button" onClick={(e) => { close(e); onMove?.(p.prospectId, { stageId: s.stageId }); }}>
          <span className={styles.dot} data-color={s.color} aria-hidden="true"/>{s.name}</button></li>)}
        <li><button type="button" data-tone="won" onClick={(e) => { close(e); onMove?.(p.prospectId, { outcome: 'WON' }); }}>{t('markWon')}</button></li>
        <li><button type="button" data-tone="lost" onClick={(e) => { close(e); onMove?.(p.prospectId, { outcome: 'LOST' }); }}>{t('markLost')}</button></li>
      </ul>
    </details>}
    {call || text || email ? <div className={styles.quick} data-where="card">
      {call ? <a className={styles.quickLink} href={call} draggable={false} data-testid="hq-quick-call" aria-label={t('quickCallLabel', { name: p.fullName })}>{t('quickCall')}</a> : null}
      {text ? <a className={styles.quickLink} href={text} draggable={false} data-testid="hq-quick-text" aria-label={t('quickTextLabel', { name: p.fullName })}>{t('quickText')}</a> : null}
      {email ? <a className={styles.quickLink} href={email} draggable={false} data-testid="hq-quick-email" aria-label={t('quickEmailLabel', { name: p.fullName })}>{t('quickEmail')}</a> : null}
    </div> : null}
  </article>;
}

const ERROR_KEY: Record<HqDraftError, BoardKey> = { NAME: 'errName', VISIBLE: 'errVisible', MAX: 'errMax', MOVE: 'errMove' };
const colorKey = (c: HqStageColor) => `color${c}` as BoardKey;

function EditDialog({ edit, onDraft, onSave, onEdit, t }: Inner & { edit: NonNullable<HqEditState> }) {
  const newId = useId();
  const { draft } = edit;
  const errors = hqDraftErrors(draft);
  const needing = stagesNeedingMove(draft), choices = moveChoices(draft);
  const busy = edit.phase === 'SAVING';
  const set = (next: Partial<NonNullable<HqEditState>>) => onDraft?.({ ...edit, ...next, error: null });
  const setStage = (i: number, patch: Partial<HqDraft['stages'][number]>) => set({ draft: { ...draft, stages: draft.stages.map((s, j) => j === i ? { ...s, ...patch } : s) } });
  const dropOn = (e: React.DragEvent, to: number) => {
    const raw = e.dataTransfer.getData(STAGE_DRAG_TYPE);
    if (busy || !/^\d{1,2}$/.test(raw)) return;
    e.preventDefault(); set({ draft: moveDraftStageTo(draft, Number(raw), to) });
  };
  const newName = edit.newName.trim();
  const canAdd = newName.length > 0 && newName.length <= HQ_STAGE_NAME_MAX && draft.stages.length < 20;
  return <div className={styles.overlay}>
    <div className={styles.dialog} data-wide="" role="dialog" aria-modal="true" aria-labelledby="hq-edit-title" data-testid="hq-edit-dialog">
      <h2 id="hq-edit-title">{t('editTitle')}</h2>
      <p className={styles.meta}>{t('editHelp')}</p>
      <ol className={styles.stageList}>
        {draft.stages.map((s, i) => <li key={s.key} className={styles.stageRow} data-hidden={s.hidden ? '' : undefined} data-testid="hq-stage-row"
          onDragOver={(e) => { if (!busy && e.dataTransfer.types.includes(STAGE_DRAG_TYPE)) e.preventDefault(); }} onDrop={(e) => dropOn(e, i)}>
          <span className={styles.handle} draggable={busy ? undefined : true} title={t('dragStage', { name: s.name })} aria-hidden="true"
            onDragStart={(e) => { e.dataTransfer.setData(STAGE_DRAG_TYPE, String(i)); e.dataTransfer.effectAllowed = 'move'; }}>⋮⋮</span>
          <span className={styles.dot} data-color={s.color} aria-hidden="true"/>
          <input aria-label={t('stageName')} value={s.name} maxLength={HQ_STAGE_NAME_MAX} disabled={busy} onChange={(e) => setStage(i, { name: e.target.value })}/>
          <select aria-label={t('stageColor')} value={s.color} disabled={busy} onChange={(e) => setStage(i, { color: e.target.value as HqStageColor })}>
            {HQ_STAGE_COLORS.map((c) => <option key={c} value={c}>{t(colorKey(c))}</option>)}
          </select>
          <button type="button" className={styles.ghost} aria-label={t('moveUp', { name: s.name })} disabled={busy || i === 0} onClick={() => set({ draft: moveDraftStageTo(draft, i, i - 1) })}>↑</button>
          <button type="button" className={styles.ghost} aria-label={t('moveDown', { name: s.name })} disabled={busy || i === draft.stages.length - 1} onClick={() => set({ draft: moveDraftStageTo(draft, i, i + 1) })}>↓</button>
          {s.id === null ? <button type="button" className={styles.ghost} disabled={busy} onClick={() => set({ draft: { ...draft, stages: draft.stages.filter((_, j) => j !== i) } })}>{t('removeNew')}</button>
            : <button type="button" className={styles.ghost} aria-pressed={s.hidden} disabled={busy} onClick={() => setStage(i, { hidden: !s.hidden })}>{s.hidden ? t('show') : t('hide')}</button>}
          {s.hidden ? <span className={styles.badge}>{t('hiddenBadge')}</span> : null}
        </li>)}
        <li className={styles.stageRow} data-fixed=""><span aria-hidden="true"/><span className={styles.dot} data-color="GREEN" aria-hidden="true"/><span>{t('activeSchool')}</span>
          <span className={styles.badge}>{t('schoolAuto')}</span></li>
        <li className={styles.stageRow} data-fixed=""><span aria-hidden="true"/><span className={styles.dot} data-color="SLATE" aria-hidden="true"/><span>{t('inactiveSchool')}</span>
          <span className={styles.badge}>{t('schoolAuto')}</span></li>
      </ol>
      {needing.map((s) => { const id = `hq-move-${s.key}`; return <div key={s.key} className={styles.field}>
        <label htmlFor={id}>{t('prospectsGoTo', { n: String(s.openCount), name: s.name })}</label>
        <select id={id} value={draft.moves[s.id!] ?? ''} disabled={busy} onChange={(e) => set({ draft: { ...draft, moves: { ...draft.moves, [s.id!]: e.target.value } } })}>
          <option value="">—</option>
          {choices.map((c) => <option key={c.key} value={c.id!}>{c.name}</option>)}
        </select>
      </div>; })}
      <div className={styles.inline}>
        <div className={styles.field} data-grow="">
          <label htmlFor={newId}>{t('newStage')}</label>
          <input id={newId} value={edit.newName} maxLength={HQ_STAGE_NAME_MAX} disabled={busy} onChange={(e) => set({ newName: e.target.value })}/>
        </div>
        <button type="button" className={styles.secondary} disabled={busy || !canAdd}
          onClick={() => set({ newName: '', draft: { ...draft, stages: [...draft.stages, { key: `new-${crypto.randomUUID()}`, id: null, name: newName, color: 'BLUE', hidden: false, openCount: 0 }] } })}>{t('addStage')}</button>
      </div>
      {errors.map((e) => <p key={e} className={styles.error}>{t(ERROR_KEY[e])}</p>)}
      {edit.error ? <p className={styles.error} role="alert">{edit.error}</p> : null}
      {edit.phase === 'UNCERTAIN' ? <p className={styles.error} role="alert">{t('saveUnknown')}</p> : null}
      <div className={styles.inline}>
        <button type="button" className={styles.primary} disabled={busy || errors.length > 0} onClick={onSave}>{busy ? t('saving') : edit.phase === 'UNCERTAIN' ? t('retry') : t('save')}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => onEdit?.(false)}>{t('cancel')}</button>
      </div>
    </div>
  </div>;
}
