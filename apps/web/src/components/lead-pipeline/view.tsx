import React, { useId } from 'react';
import { CRM_PIPELINE_TEMPLATES, CRM_STAGE_COLORS, CRM_STAGE_NAME_MAX, type CrmPipelineTemplateCode, type CrmBoardLead, type CrmBoardStage, type CrmBoardStatus, type CrmPipelineBoard, type CrmStageColor } from '@hon/contracts';
import type { CrmAppointmentSummary } from '@hon/contracts';
import { crmFollowUpHref } from '../crm-follow-up-handoff';
import { leadMembershipHref, leadTrialHref, leadWorkflowHref } from '../crm-lead-memberships-http';
import type { TrialRecovery } from '../crm-journey/trial-recovery-http';
import { pipelineText, type PipelineKey } from './copy';
import type { BoardScope } from './http';
import {
  BOARD_SORTS, PROGRAM_NONE, applyFilters, callHref, emailHref, textHref, boardColumns, boardStats, cardLine, codeLabel, draftErrors, fullName, initials, moveChoices,
  moveDraftStage, moveDraftStageTo, moveTargets, programsOf, rateText, stagesNeedingMove, type BoardSort, type BoardView, type Draft, type DraftError, type Filters,
} from './model';
import styles from './pipeline.module.css';

type T = (key: PipelineKey, vars?: Record<string, string>) => string;
export type BoardState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; board: CrmPipelineBoard };
export type TrialState = { state: 'NONE' | 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; leadId: string; recovery: TrialRecovery };
export type Notice = { tone: 'OK' | 'ERROR'; text: string } | null;
export type CloseState = null | { leadId: string; status: 'WON' | 'LOST'; note: string; phase: 'ASK' | 'SAVING' | 'UNCERTAIN' | 'FAILED' };
export type SetupState = { state: 'IDLE' | 'WORKING' | 'DENIED' | 'FAILED' | 'UNKNOWN' };
export type TemplateState = null | { phase: 'PICK' | 'WORKING' | 'DENIED' | 'FAILED' | 'UNKNOWN' | 'LIMIT'; code: CrmPipelineTemplateCode | null };
export type EditState = null | { draft: Draft; newName: string; phase: 'EDIT' | 'SAVING' | 'UNCERTAIN'; error: string | null };
export const LEAD_DRAG_TYPE = 'application/x-hon-lead';
export const STAGE_DRAG_TYPE = 'application/x-hon-stage';

export type PipelineViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; scope: BoardScope | null;
  board: BoardState; status: CrmBoardStatus; filters: Filters; view: BoardView; selectedId: string | null; trials: TrialState;
  notice: Notice; movingId: string | null; close: CloseState; edit: EditState; adding: boolean; addLead?: React.ReactNode; setup?: SetupState; templates?: TemplateState;
  onStatus?: (status: CrmBoardStatus) => void; onFilters?: (filters: Filters) => void; onView?: (view: BoardView) => void;
  onPipeline?: (pipelineId: string) => void; onOpen?: (leadId: string | null) => void; onMove?: (leadId: string, stageId: string) => void;
  onAskClose?: (leadId: string, status: 'WON' | 'LOST') => void; onCloseNote?: (note: string) => void; onConfirmClose?: () => void; onCancelClose?: () => void;
  onTemplates?: (open: boolean) => void; onTemplate?: (code: CrmPipelineTemplateCode) => void;
  onEdit?: (open: boolean) => void; onDraft?: (edit: EditState) => void; onSave?: () => void;
  onAdd?: (open: boolean) => void; onRefresh?: () => void; onReloadTrials?: () => void;
}>;

const when = (language: string, value: string, time = true) => new Date(value).toLocaleString(language, time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
const short = (language: string, value: string) => new Date(value).toLocaleString(language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
type Inner = Omit<PipelineViewProps, 'board' | 'scope'> & { board: CrmPipelineBoard; scope: BoardScope; t: T };
const colorKey = (color: CrmStageColor) => `color${color}` as PipelineKey;
const sortKey = (sort: BoardSort): PipelineKey => sort === 'NEWEST' ? 'sortNewest' : sort === 'OLDEST' ? 'sortOldest' : 'sortName';

/** Pure view. Every name, contact, stage and trial comes from the school's CRM reads; nothing shows before the shell verifies the school. */
export function PipelineView(props: PipelineViewProps): React.ReactElement {
  const { language, waiting, concealed, scope, board, onRefresh } = props;
  const t: T = (key, vars) => pipelineText(language, key, vars);
  const notice = waiting ? t('waiting') : concealed ? t('concealed') : !scope ? t('noSchool') : null;
  const ready = board.state === 'READY' ? board.board : null;
  const stats = ready ? boardStats(ready.totals) : null;
  return <section className={styles.page} aria-labelledby="pipeline-title" data-hon-native="" data-testid="lead-pipeline">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1 id="pipeline-title">{t('title')}</h1>
        {stats ? <p className={styles.summary}>{stats.rate === null ? t('summaryNoRate', { open: String(stats.open) })
          : t('summary', { open: String(stats.open), rate: rateText(stats.rate, language) })}</p> : null}
      </div>
      {notice === null ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={board.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {notice === null && scope ? <Body {...props} scope={scope} t={t}/> : null}
  </section>;
}

function Body(props: PipelineViewProps & { scope: BoardScope; t: T }): React.ReactElement {
  const { board, t, adding, addLead, onRefresh } = props;
  return <>
    {board.state === 'READY' ? <Stats {...props} board={board.board}/> : null}
    <Toolbar {...props}/>
    {adding && addLead ? <div className={styles.add}>{addLead}</div> : null}
    {props.notice ? <p className={styles.flash} data-tone={props.notice.tone} role={props.notice.tone === 'ERROR' ? 'alert' : 'status'}>{props.notice.text}</p> : null}
    {board.state === 'LOADING' ? <p className={styles.notice} role="status">{t('loading')}</p> : null}
    {board.state === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p> : null}
    {board.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('unavailable')}</p>
      <button type="button" className={styles.secondary} onClick={onRefresh}>{t('reload')}</button></div> : null}
    {board.state === 'READY' ? <Ready {...props} board={board.board}/> : null}
    {board.state === 'READY' && props.close ? <CloseDialog {...props} board={board.board} close={props.close}/> : null}
    {board.state === 'READY' && props.templates ? <TemplateDialog {...props} board={board.board} templates={props.templates}/> : null}
    {board.state === 'READY' && props.edit ? <EditDialog {...props} board={board.board} edit={props.edit}/> : null}
  </>;
}

function Stats({ board, status, language, onStatus, onView, t }: Inner) {
  const stats = boardStats(board.totals);
  const cards: Array<{ key: PipelineKey; value: string; target: CrmBoardStatus; tone: string }> = [
    { key: 'statOpen', value: String(stats.open), target: 'OPEN', tone: 'open' },
    { key: 'statWon', value: String(stats.won), target: 'WON', tone: 'won' },
    { key: 'statLost', value: String(stats.lost), target: 'LOST', tone: 'lost' },
    { key: 'statRate', value: rateText(stats.rate, language), target: 'CLOSED', tone: 'rate' },
  ];
  return <ul className={styles.stats} aria-label={t('statusLabel')}>{cards.map((card) => <li key={card.key}>
    <button type="button" className={styles.stat} data-tone={card.tone} aria-pressed={status === card.target}
      onClick={() => { onStatus?.(card.target); onView?.(card.target === 'OPEN' ? 'BOARD' : 'LIST'); }}>
      <span className={styles.statLabel}>{t(card.key)}</span><strong className={styles.statValue}>{card.value}</strong>
    </button>
  </li>)}</ul>;
}

function Toolbar(props: PipelineViewProps & { t: T }) {
  const { board, filters, status, view, language, adding, onFilters, onStatus, onView, onPipeline, onEdit, onAdd, t } = props;
  const ids = { search: useId(), program: useId(), status: useId(), sort: useId(), pipeline: useId() };
  const ready = board.state === 'READY' ? board.board : null;
  const programs = ready ? programsOf(ready.leads, language) : { programs: [], hasNone: false };
  const off = !ready;
  return <div className={styles.toolbar} role="search">
    <div className={styles.field} data-grow="">
      <label htmlFor={ids.search}>{t('searchLabel')}</label>
      <input id={ids.search} type="search" maxLength={120} autoComplete="off" placeholder={t('searchPlaceholder')} value={filters.search} disabled={off}
        onChange={(e) => onFilters?.({ ...filters, search: e.target.value })}/>
    </div>
    <div className={styles.field}>
      <label htmlFor={ids.program}>{t('programLabel')}</label>
      <select id={ids.program} value={filters.program} disabled={off} onChange={(e) => onFilters?.({ ...filters, program: e.target.value })}>
        <option value="">{t('programAll')}</option>
        {programs.programs.map((p) => <option key={p} value={p}>{codeLabel(p)}</option>)}
        {programs.hasNone ? <option value={PROGRAM_NONE}>{t('programNone')}</option> : null}
      </select>
    </div>
    <div className={styles.field}>
      <label htmlFor={ids.status}>{t('statusLabel')}</label>
      <select id={ids.status} value={status} disabled={off} onChange={(e) => { const next = e.target.value as CrmBoardStatus; onStatus?.(next); if (next !== 'OPEN') onView?.('LIST'); }}>
        {(['OPEN', 'WON', 'LOST', 'CLOSED'] as const).map((s) => <option key={s} value={s}>{t(`status${s}`)}</option>)}
      </select>
    </div>
    <div className={styles.field}>
      <label htmlFor={ids.sort}>{t('sortLabel')}</label>
      <select id={ids.sort} value={filters.sort} disabled={off} onChange={(e) => onFilters?.({ ...filters, sort: e.target.value as BoardSort })}>
        {BOARD_SORTS.map((s) => <option key={s} value={s}>{t(sortKey(s))}</option>)}
      </select>
    </div>
    {ready && ready.pipelines.length > 1 && ready.pipeline ? <div className={styles.field}>
      <label htmlFor={ids.pipeline}>{t('pipelineLabel')}</label>
      <select id={ids.pipeline} value={ready.pipeline.id} onChange={(e) => onPipeline?.(e.target.value)}>
        {ready.pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div> : null}
    <div className={styles.toggle} role="group" aria-label={t('viewLabel')}>
      <button type="button" aria-pressed={view === 'BOARD'} disabled={off || status !== 'OPEN'} onClick={() => onView?.('BOARD')}>{t('viewBoard')}</button>
      <button type="button" aria-pressed={view === 'LIST'} disabled={off} onClick={() => onView?.('LIST')}>{t('viewList')}</button>
    </div>
    <div className={styles.actions}>
      {ready?.pipeline ? <button type="button" className={styles.secondary} onClick={() => props.onTemplates?.(true)}>{t('newPipeline')}</button> : null}
      <button type="button" className={styles.secondary} disabled={!ready || props.setup?.state === 'WORKING' || (!ready.pipeline && props.setup?.state === 'DENIED')} onClick={() => onEdit?.(true)}>{t('editPipeline')}</button>
      <button type="button" className={styles.primary} aria-expanded={adding} onClick={() => onAdd?.(!adding)}>{adding ? t('closeAdd') : t('addLead')}</button>
    </div>
  </div>;
}

function Ready(props: Inner) {
  const { board, filters, view, status, language, t } = props;
  if (!board.pipeline) return <SetUpStages {...props}/>;
  const shown = applyFilters(board.leads, filters, language);
  const selected = props.selectedId ? board.leads.find((l) => l.id === props.selectedId) ?? null : null;
  return <div className={styles.workspace} data-panel={selected ? 'open' : undefined}>
    <div className={styles.main}>
      {board.leads.length > 0 && shown.length === 0 ? <p className={styles.notice}>{t('noneMatch')}</p> : null}
      {view === 'BOARD' && status === 'OPEN' ? <Board {...props} shown={shown}/> : <List {...props} shown={shown}/>}
      {board.truncated ? <p className={styles.meta}>{t('truncated', { n: String(board.limit) })}</p> : null}
    </div>
    {selected ? <Panel {...props} lead={selected}/> : null}
  </div>;
}

/** No stages yet: set them up now (the existing starter command), then the editor opens. No lead is needed first. */
function SetUpStages({ setup, onEdit, t }: Inner) {
  const state = setup?.state ?? 'IDLE';
  const message: PipelineKey | null = state === 'DENIED' ? 'setUpDenied' : state === 'FAILED' ? 'setUpFailed' : state === 'UNKNOWN' ? 'setUpUnknown' : null;
  return <div className={`${styles.notice} ${styles.setup}`} data-testid="pipeline-setup">
    <p>{t('noPipeline')}</p>
    {message ? <p className={styles.error} role="alert">{t(message)}</p> : null}
    {state === 'DENIED' ? null : <button type="button" className={styles.primary} disabled={state === 'WORKING'} onClick={() => onEdit?.(true)}>
      {state === 'WORKING' ? t('setUpWorking') : state === 'UNKNOWN' ? t('retry') : t('setUp')}</button>}
  </div>;
}

function stageOf(board: CrmPipelineBoard, id: string): CrmBoardStage | undefined { return board.stages.find((s) => s.id === id); }

function Board(props: Inner & { shown: CrmBoardLead[] }) {
  const { board, shown, onMove, onAskClose, t } = props;
  const columns = boardColumns(board, shown);
  const won = board.stages.find((s) => s.terminalStatus === 'WON'), lost = board.stages.find((s) => s.terminalStatus === 'LOST');
  const drop = (handler: (leadId: string) => void) => ({
    onDragOver: (e: React.DragEvent) => { if (Array.from(e.dataTransfer.types).includes(LEAD_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } },
    onDrop: (e: React.DragEvent) => { const leadId = e.dataTransfer.getData(LEAD_DRAG_TYPE); if (leadId) { e.preventDefault(); handler(leadId); } },
  });
  return <>
    <div className={styles.board} data-testid="pipeline-board">{columns.map(({ stage, leads }) =>
      <section key={stage.id} className={styles.column} data-color={stage.color} data-hidden={stage.hidden ? '' : undefined} aria-labelledby={`stage-${stage.id}`}
        {...(stage.hidden ? {} : drop((leadId) => { const lead = board.leads.find((l) => l.id === leadId); if (lead && lead.stageId !== stage.id) onMove?.(leadId, stage.id); }))}>
        <header className={styles.columnHead}>
          <span className={styles.dot} aria-hidden="true"/>
          <h2 id={`stage-${stage.id}`}>{stage.name}</h2>
          {stage.hidden ? <span className={styles.badge}>{t('hiddenStage')}</span> : null}
          <span className={styles.count}>{t('count', { n: String(leads.length) })}</span>
        </header>
        {leads.length === 0 ? <p className={styles.empty}>{t('dropHere')}</p>
          : <ul className={styles.cards}>{leads.map((lead) => <li key={lead.id}><Card {...props} lead={lead}/></li>)}</ul>}
      </section>)}
    </div>
    <div className={styles.drops}>
      {won ? <div className={styles.drop} data-tone="won" data-testid="drop-won" {...drop((leadId) => onAskClose?.(leadId, 'WON'))}>{t('dropWon')}</div> : null}
      {lost ? <div className={styles.drop} data-tone="lost" data-testid="drop-lost" {...drop((leadId) => onAskClose?.(leadId, 'LOST'))}>{t('dropLost')}</div> : null}
    </div>
  </>;
}

function Card({ board, lead, scope, language, selectedId, movingId, onOpen, onMove, onAskClose, t }: Inner & { lead: CrmBoardLead }) {
  const name = fullName(lead);
  const line = cardLine(lead);
  const targets = moveTargets(board.stages, lead);
  const busy = movingId === lead.id;
  return <article className={styles.card} data-moving={busy ? '' : undefined} draggable={!busy && lead.status === 'OPEN'} data-testid="lead-card"
    onDragStart={(e) => { e.dataTransfer.setData(LEAD_DRAG_TYPE, lead.id); e.dataTransfer.effectAllowed = 'move'; }}>
    <button type="button" className={styles.cardOpen} aria-current={lead.id === selectedId ? 'true' : undefined} onClick={() => onOpen?.(lead.id)}>
      <span className={styles.avatar} aria-hidden="true">{initials(lead)}</span>
      <span className={styles.cardText}>
        <strong>{name}</strong>
        {lead.programInterestCode ? <span className={styles.program}>{codeLabel(lead.programInterestCode)}</span> : null}
        <small>{line.kind === 'NEXT' ? t('cardTrialNext', { date: short(language, line.at) }) : line.kind === 'LAST' ? t('cardTrialLast', { date: short(language, line.at) })
          : line.kind === 'SOURCE' ? codeLabel(line.source) : t('cardAdded', { date: when(language, lead.createdAt, false) })}</small>
      </span>
    </button>
    {busy ? <span className={styles.meta} role="status">{t('moving')}</span> : lead.status === 'OPEN' ? <details className={styles.menu}>
      <summary aria-label={t('moveToLabel', { name })}>{t('moveTo')}</summary>
      <ul>
        {targets.map((stage) => <li key={stage.id}><button type="button" onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); onMove?.(lead.id, stage.id); }}>
          <span className={styles.dot} data-color={stage.color} aria-hidden="true"/>{stage.name}</button></li>)}
        <li><button type="button" data-tone="won" onClick={() => onAskClose?.(lead.id, 'WON')}>{t('markWon')}</button></li>
        <li><button type="button" data-tone="lost" onClick={() => onAskClose?.(lead.id, 'LOST')}>{t('markLost')}</button></li>
      </ul>
    </details> : null}
    {lead.status === 'OPEN' ? <QuickActions lead={lead} scope={scope} name={name} t={t} where="card"/> : null}
  </article>;
}

/** One-tap Call, Text and Book trial (Email too in the panel). Call, Text and Email open the staff member's own app; HON sends nothing. */
function QuickActions({ lead, scope, name, where, t }: { lead: CrmBoardLead; scope: BoardScope; name: string; where: 'card' | 'panel'; t: T }) {
  const call = callHref(lead.phoneE164), text = lead.textOptedOut ? null : textHref(lead.phoneE164), email = where === 'panel' ? emailHref(lead.email) : null;
  const trial = leadTrialHref({ organizationId: scope.organizationId, schoolId: scope.schoolId, leadId: lead.id });
  const id = where === 'card' ? 'quick' : 'panel';
  return <div className={styles.quick} data-where={where}>
    {call ? <a className={styles.quickLink} href={call} draggable={false} data-testid={`${id}-call`} aria-label={t('quickCallLabel', { name })}>{t('quickCall')}</a> : null}
    {text ? <a className={styles.quickLink} href={text} draggable={false} data-testid={`${id}-text`} aria-label={t('quickTextLabel', { name })}>{t('quickText')}</a> : null}
    {email ? <a className={styles.quickLink} href={email} draggable={false} data-testid={`${id}-email`}>{t('quickEmail')}</a> : null}
    <a className={styles.quickLink} data-tone="trial" href={trial} draggable={false} data-testid={`${id}-trial`} aria-label={t('quickTrialLabel', { name })}>{t('quickTrial')}</a>
  </div>;
}

function List({ board, shown, language, selectedId, onOpen, t }: Inner & { shown: CrmBoardLead[] }) {
  if (shown.length === 0) return board.leads.length === 0 ? <p className={styles.meta}>{t('noneMatch')}</p> : <></>;
  return <div className={styles.tableWrap}><table className={styles.table} data-testid="pipeline-list">
    <thead><tr><th scope="col">{t('listName')}</th><th scope="col">{t('listProgram')}</th><th scope="col">{t('listStage')}</th>
      <th scope="col">{t('listStatus')}</th><th scope="col">{t('listSource')}</th><th scope="col">{t('listAdded')}</th></tr></thead>
    <tbody>{shown.map((lead) => { const stage = stageOf(board, lead.stageId); return <tr key={lead.id} aria-current={lead.id === selectedId ? 'true' : undefined}>
      <th scope="row"><button type="button" className={styles.rowOpen} onClick={() => onOpen?.(lead.id)}>
        <span className={styles.avatar} aria-hidden="true">{initials(lead)}</span>{fullName(lead)}</button></th>
      <td>{lead.programInterestCode ? codeLabel(lead.programInterestCode) : '—'}</td>
      <td>{stage ? <span className={styles.stageTag} data-color={stage.color}><span className={styles.dot} aria-hidden="true"/>{stage.name}</span> : '—'}</td>
      <td><span className={styles.chip} data-status={lead.status}>{t(lead.status)}</span></td>
      <td>{lead.sourceCode ? codeLabel(lead.sourceCode) : t('noSource')}</td>
      <td>{when(language, lead.createdAt, false)}</td>
    </tr>; })}</tbody>
  </table></div>;
}

function Trial({ trial, language, t }: { trial: CrmAppointmentSummary; language: string; t: T }) {
  return <li className={styles.trial}><span>{when(language, trial.startsAt)}{trial.location ? ` · ${trial.location}` : ''}</span><span className={styles.chip} data-status={trial.status}>{trial.status.replace('_', ' ').toLowerCase()}</span></li>;
}

function Panel({ board, lead, scope, language, trials, movingId, onOpen, onMove, onAskClose, onReloadTrials, t }: Inner & { lead: CrmBoardLead }) {
  const stageId = useId();
  const stage = stageOf(board, lead.stageId);
  const selectors = { organizationId: scope.organizationId, schoolId: scope.schoolId, leadId: lead.id };
  const followUp = lead.status === 'OPEN' ? crmFollowUpHref(lead.id) : undefined;
  const choices = moveTargets(board.stages, lead);
  return <aside className={styles.panel} aria-labelledby="pipeline-panel-title" data-testid="lead-panel">
    <header className={styles.panelHead}>
      <span className={styles.avatar} data-size="lg" aria-hidden="true">{initials(lead)}</span>
      <div><h2 id="pipeline-panel-title">{fullName(lead)}</h2><span className={styles.chip} data-status={lead.status}>{t(lead.status)}</span></div>
      <button type="button" className={styles.ghost} onClick={() => onOpen?.(null)}>{t('panelClose')}</button>
    </header>
    <section aria-labelledby="pipeline-panel-contact">
      <h3 id="pipeline-panel-contact">{t('panelContact')}</h3>
      <dl className={styles.facts}>
        <div><dt>{t('email')}</dt><dd>{lead.email ?? t('notRecorded')}</dd></div>
        <div><dt>{t('phone')}</dt><dd>{lead.phoneE164 ?? t('notRecorded')}</dd></div>
        <div><dt>{t('program')}</dt><dd>{lead.programInterestCode ? codeLabel(lead.programInterestCode) : t('notRecorded')}</dd></div>
        <div><dt>{t('source')}</dt><dd>{lead.sourceCode ? codeLabel(lead.sourceCode) : t('notRecorded')}</dd></div>
        <div><dt>{t('added')}</dt><dd>{when(language, lead.createdAt, false)}</dd></div>
      </dl>
      {lead.status === 'OPEN' ? <><QuickActions lead={lead} scope={scope} name={fullName(lead)} t={t} where="panel"/>
        {lead.textOptedOut ? <p className={styles.meta} data-testid="text-opted-out">{t('textOptedOut')}</p> : null}
        {callHref(lead.phoneE164) || emailHref(lead.email) ? <p className={styles.meta}>{t('quickTextHelp')}</p> : null}</> : null}
    </section>
    <section className={styles.field}>
      <label htmlFor={stageId}>{t('stage')}</label>
      {lead.status === 'OPEN' ? <select id={stageId} value={lead.stageId} disabled={movingId === lead.id} onChange={(e) => { if (e.target.value !== lead.stageId) onMove?.(lead.id, e.target.value); }}>
        {stage ? <option value={stage.id}>{stage.name}</option> : null}
        {choices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select> : <p id={stageId} className={styles.meta}>{stage?.name ?? '—'}</p>}
    </section>
    <section aria-labelledby="pipeline-panel-trials">
      <h3 id="pipeline-panel-trials">{t('trials')}</h3>
      {trials.state === 'LOADING' || trials.state === 'NONE' ? <p className={styles.meta} role="status">{t('trialsLoading')}</p> : null}
      {trials.state === 'DENIED' ? <p className={styles.meta} role="status">{t('trialsDenied')}</p> : null}
      {trials.state === 'UNAVAILABLE' ? <div className={styles.inline} role="status"><p className={styles.meta}>{t('trialsUnavailable')}</p>
        <button type="button" className={styles.ghost} onClick={onReloadTrials}>{t('reload')}</button></div> : null}
      {trials.state === 'READY' && trials.leadId === lead.id ? <>
        {trials.recovery.activeTrial ? <p className={styles.upcoming}><strong>{t('upcoming')}</strong> {when(language, trials.recovery.activeTrial.startsAt)}</p> : null}
        {trials.recovery.trials.length === 0 ? <p className={styles.meta}>{t('trialsNone')}</p>
          : <ul className={styles.trials}>{trials.recovery.trials.map((trial) => <Trial key={trial.id} trial={trial} language={language} t={t}/>)}</ul>}
      </> : null}
    </section>
    <section aria-labelledby="pipeline-panel-next">
      <h3 id="pipeline-panel-next">{t('nextSteps')}</h3>
      <ul className={styles.next}>
        {lead.status !== 'ARCHIVED' ? <li><a className={styles.primary} href={leadWorkflowHref(selectors)}>{t('journey')}</a><span className={styles.meta}>{t('journeyHelp')}</span></li> : null}
        {followUp ? <li><a className={styles.secondary} href={followUp}>{t('followUp')}</a></li> : null}
        <li><a className={styles.secondary} href={leadMembershipHref(selectors)}>{t('memberships')}</a></li>
      </ul>
      {lead.status === 'OPEN' ? <div className={styles.inline}>
        <button type="button" className={styles.secondary} data-tone="won" onClick={() => onAskClose?.(lead.id, 'WON')}>{t('markWon')}</button>
        <button type="button" className={styles.secondary} data-tone="lost" onClick={() => onAskClose?.(lead.id, 'LOST')}>{t('markLost')}</button>
      </div> : null}
    </section>
  </aside>;
}

function CloseDialog({ board, close, onCloseNote, onConfirmClose, onCancelClose, t }: Inner & { close: NonNullable<CloseState> }) {
  const noteId = useId();
  const lead = board.leads.find((l) => l.id === close.leadId);
  if (!lead) return null;
  const name = fullName(lead), choice = t(close.status);
  const busy = close.phase === 'SAVING';
  return <div className={styles.overlay}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="pipeline-close-title" data-testid="close-dialog">
      <h2 id="pipeline-close-title">{t(close.status === 'WON' ? 'closeTitleWON' : 'closeTitleLOST', { name })}</h2>
      <p className={styles.meta}>{t('closeHelp')}</p>
      <div className={styles.field}>
        <label htmlFor={noteId}>{t('closeNote')}</label>
        <textarea id={noteId} rows={3} maxLength={2000} value={close.note} disabled={close.phase !== 'ASK' && close.phase !== 'FAILED'} onChange={(e) => onCloseNote?.(e.target.value)}/>
      </div>
      {close.phase === 'FAILED' ? <p className={styles.error} role="alert">{t('closeFailed')}</p> : null}
      {close.phase === 'UNCERTAIN' ? <p className={styles.error} role="alert">{t('closeUnknown')}</p> : null}
      <div className={styles.inline}>
        <button type="button" className={styles.primary} data-tone={close.status === 'WON' ? 'won' : 'lost'} disabled={busy || close.phase === 'FAILED'} onClick={onConfirmClose}>
          {busy ? t('closing') : close.phase === 'UNCERTAIN' ? t('retry') : t('closeConfirm', { choice })}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={onCancelClose}>{t('cancel')}</button>
      </div>
    </div>
  </div>;
}

const TEMPLATE_MESSAGE: Partial<Record<NonNullable<TemplateState>['phase'], PipelineKey>> = {
  DENIED: 'templateDenied', FAILED: 'templateFailed', UNKNOWN: 'templateUnknown', LIMIT: 'templateLimit',
};
/** Ready-made school funnels: one press adds the pipeline (server-defined stages), then the stage editor opens to adjust it. */
function TemplateDialog({ board, templates, onTemplates, onTemplate, onPipeline, t }: Inner & { templates: NonNullable<TemplateState> }) {
  const busy = templates.phase === 'WORKING';
  const message = TEMPLATE_MESSAGE[templates.phase];
  return <div className={styles.overlay}>
    <div className={styles.dialog} data-wide="" role="dialog" aria-modal="true" aria-labelledby="pipeline-templates-title" data-testid="template-dialog">
      <h2 id="pipeline-templates-title">{t('templatesTitle')}</h2>
      <p className={styles.meta}>{t('templatesHelp')}</p>
      <ul className={styles.templates}>{CRM_PIPELINE_TEMPLATES.map((template) => {
        const have = board.pipelines.find((p) => p.name === template.name);
        const retry = templates.phase === 'UNKNOWN' && templates.code === template.code;
        return <li key={template.code} className={styles.template} data-testid={`template-${template.code}`}>
          <h3>{t(`template${template.code}` as PipelineKey)}</h3>
          <ol className={styles.templateStages}>{template.stages.map((stage) => <li key={stage.name} data-color={stage.color} data-terminal={stage.terminalStatus ?? undefined}>
            <span className={styles.dot} data-color={stage.color} aria-hidden="true"/>{stage.name}</li>)}</ol>
          {have && !retry
            ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => { onPipeline?.(have.id); onTemplates?.(false); }}>{t('templateOpen')}</button>
            : <button type="button" className={styles.primary} disabled={busy || (templates.phase === 'UNKNOWN' && !retry)} onClick={() => onTemplate?.(template.code)}>
              {busy && templates.code === template.code ? t('templateWorking') : retry ? t('retry') : t('templateUse')}</button>}
        </li>;
      })}</ul>
      {message ? <p className={styles.error} role="alert">{t(message)}</p> : null}
      <div className={styles.inline}><button type="button" className={styles.secondary} disabled={busy} onClick={() => onTemplates?.(false)}>{t('cancel')}</button></div>
    </div>
  </div>;
}

const ERROR_KEY: Record<DraftError, PipelineKey> = { NAME: 'errName', VISIBLE: 'errVisible', MAX: 'errMax', MOVE: 'errMove' };

function EditDialog({ board, edit, onDraft, onSave, onEdit, t }: Inner & { edit: NonNullable<EditState> }) {
  const newId = useId();
  const terminal = [...board.stages].sort((a, b) => a.position - b.position).filter((s) => s.terminalStatus === 'WON' || s.terminalStatus === 'LOST');
  const { draft } = edit;
  const errors = draftErrors(draft, terminal.map((s) => s.name));
  const needing = stagesNeedingMove(draft), choices = moveChoices(draft);
  const busy = edit.phase === 'SAVING';
  const set = (next: Partial<NonNullable<EditState>>) => onDraft?.({ ...edit, ...next, error: null });
  const setStage = (index: number, patch: Partial<Draft['stages'][number]>) => set({ draft: { ...draft, stages: draft.stages.map((s, i) => i === index ? { ...s, ...patch } : s) } });
  const swap = (index: number, delta: -1 | 1) => set({ draft: moveDraftStage(draft, index, delta) });
  const dropOn = (event: React.DragEvent, to: number) => {
    const raw = event.dataTransfer.getData(STAGE_DRAG_TYPE);
    if (busy || !/^\d{1,2}$/.test(raw)) return;
    event.preventDefault();
    set({ draft: moveDraftStageTo(draft, Number(raw), to) });
  };
  const newName = edit.newName.trim();
  const canAdd = newName.length > 0 && newName.length <= CRM_STAGE_NAME_MAX && draft.stages.length < 20;
  return <div className={styles.overlay}>
    <div className={styles.dialog} data-wide="" role="dialog" aria-modal="true" aria-labelledby="pipeline-edit-title" data-testid="edit-dialog">
      <h2 id="pipeline-edit-title">{t('editTitle')}</h2>
      <p className={styles.meta}>{t('editHelp')} {t('dragHelp')}</p>
      <ol className={styles.stageList}>
        {draft.stages.map((stage, index) => <li key={stage.key} className={styles.stageRow} data-hidden={stage.hidden ? '' : undefined} data-testid="stage-row"
          onDragOver={(e) => { if (!busy && e.dataTransfer.types.includes(STAGE_DRAG_TYPE)) e.preventDefault(); }} onDrop={(e) => dropOn(e, index)}>
          <span className={styles.handle} draggable={busy ? undefined : true} title={t('dragStage', { name: stage.name })} aria-hidden="true"
            onDragStart={(e) => { e.dataTransfer.setData(STAGE_DRAG_TYPE, String(index)); e.dataTransfer.effectAllowed = 'move'; }}>⋮⋮</span>
          <span className={styles.dot} data-color={stage.color} aria-hidden="true"/>
          <input aria-label={t('stageName')} value={stage.name} maxLength={CRM_STAGE_NAME_MAX} disabled={busy} onChange={(e) => setStage(index, { name: e.target.value })}/>
          <select aria-label={t('stageColor')} value={stage.color} disabled={busy} onChange={(e) => setStage(index, { color: e.target.value as CrmStageColor })}>
            {CRM_STAGE_COLORS.map((c) => <option key={c} value={c}>{t(colorKey(c))}</option>)}
          </select>
          <button type="button" className={styles.ghost} aria-label={t('moveUp', { name: stage.name })} disabled={busy || index === 0} onClick={() => swap(index, -1)}>↑</button>
          <button type="button" className={styles.ghost} aria-label={t('moveDown', { name: stage.name })} disabled={busy || index === draft.stages.length - 1} onClick={() => swap(index, 1)}>↓</button>
          {stage.id === null ? <button type="button" className={styles.ghost} disabled={busy} onClick={() => set({ draft: { ...draft, stages: draft.stages.filter((_, i) => i !== index) } })}>{t('removeNew')}</button>
            : <button type="button" className={styles.ghost} aria-pressed={stage.hidden} disabled={busy} onClick={() => setStage(index, { hidden: !stage.hidden })}>{stage.hidden ? t('show') : t('hide')}</button>}
          {stage.hidden ? <span className={styles.badge}>{t('hiddenBadge')}</span> : null}
        </li>)}
        {terminal.map((stage) => <li key={stage.id} className={styles.stageRow} data-fixed="">
          <span aria-hidden="true"/><span className={styles.dot} data-color={stage.color} aria-hidden="true"/><span>{stage.name}</span>
          <span className={styles.badge}>{t(stage.terminalStatus === 'WON' ? 'terminalWON' : 'terminalLOST')}</span>
        </li>)}
      </ol>
      {needing.map((stage) => { const id = `move-${stage.key}`; return <div key={stage.key} className={styles.field}>
        <label htmlFor={id}>{t('leadsGoTo', { n: String(stage.openCount), name: stage.name })}</label>
        <select id={id} value={draft.moves[stage.id!] ?? ''} disabled={busy} onChange={(e) => set({ draft: { ...draft, moves: { ...draft.moves, [stage.id!]: e.target.value } } })}>
          <option value="">—</option>
          {choices.map((c) => <option key={c.key} value={c.id!}>{c.name}</option>)}
        </select>
      </div>; })}
      <div className={styles.inline}>
        <div className={styles.field} data-grow="">
          <label htmlFor={newId}>{t('newStage')}</label>
          <input id={newId} value={edit.newName} maxLength={CRM_STAGE_NAME_MAX} disabled={busy} onChange={(e) => set({ newName: e.target.value })}/>
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
