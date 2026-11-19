import React, { useRef, useState } from 'react';
import type { AutomationRunList, AutomationWorkflowList, AutomationWorkflowStatus, AutomationWorkflowSummary } from '@hon/contracts';
import { automationsText, type AutomationsKey } from './copy';
import type { AutomationScope } from './http';
import {
  CHANNELS, DATE_KINDS, GROUPS, MAX_SENDS, MERGE_FIELDS, STOPS, TEMPLATE_KEYS, WHEN_DAYS, WHEN_KINDS, blankSend, problems,
  type Channel, type DelayUnit, type Problem, type Send, type SimpleAutomation, type TemplateKey, type WhenKind,
} from './model';
import styles from './automations.module.css';

export type ListState = { state: 'LOADING' } | { state: 'READY'; list: AutomationWorkflowList } | { state: 'DENIED' } | { state: 'UNAVAILABLE' };
/** The open builder. draft null means the saved automation uses steps the simple builder cannot show (read-only summary). */
export type EditorState = null | {
  workflowId: string | null; revision: number | null; status: AutomationWorkflowStatus | null; name: string;
  draft: SimpleAutomation | null; showProblems: boolean; busy: boolean;
};
export type ActivityState = null | { workflowId: string; state: 'LOADING' } | { workflowId: string; state: 'ERROR' } | { workflowId: string; state: 'READY'; runs: AutomationRunList };
export type Notice = null | { tone: 'OK' | 'ERROR'; text: string };
/** Which box of the flow is open in the settings panel. */
export type NodeKey = 'trigger' | 'who' | `send${number}`;

export type AutomationsViewProps = {
  language: string; waiting: boolean; concealed: boolean; scope: AutomationScope | null;
  list: ListState; editor: EditorState; picking: boolean; activity: ActivityState; notice: Notice; busyId: string | null;
  /** Only for tests and screenshots: which flow box starts open. */
  initialNode?: NodeKey;
  onNew?: () => void; onTemplate?: (key: TemplateKey | null) => void; onEdit?: (workflowId: string) => void; onDraft?: (next: SimpleAutomation) => void;
  onSave?: (turnOn: boolean) => void; onCancel?: () => void; onToggle?: (workflowId: string) => void; onActivity?: (workflowId: string) => void; onRefresh?: () => void;
};

type T = (key: AutomationsKey, vars?: Record<string, string>) => string;
const noop = () => undefined;
const CH_ICON: Record<Channel, string> = { TEXT: '💬', EMAIL: '✉️', TASK: '✅', NOTIFY: '🔔' };
const ICON: Record<TemplateKey, string> = { NO_SHOW: '⏰', LEAD_NURTURE: '🌱', MIA: '👋', BIRTHDAY: '🎂', RENEWAL: '🔁', WELCOME: '🥋' };

export function AutomationsView(props: AutomationsViewProps): React.ReactElement {
  const { language, waiting, concealed, scope, list, editor, picking, notice } = props;
  const t: T = (key, vars) => automationsText(language, key, vars);
  const blocked = waiting ? t('waiting') : concealed ? t('concealed') : !scope ? t('noSchool') : null;
  const workflows = list.state === 'READY' ? list.list.workflows.filter(w => w.status !== 'ARCHIVED') : [];
  const count = (s: AutomationWorkflowStatus) => workflows.filter(w => w.status === s).length;
  if (!blocked && list.state === 'READY' && editor) {
    return <main className={styles.page} data-automations="">
      {notice && <p className={styles.flash} data-tone={notice.tone} role={notice.tone === 'ERROR' ? 'alert' : 'status'}>{notice.text}</p>}
      <Builder {...props} editor={editor} t={t}/>
    </main>;
  }
  return <main className={styles.page} data-automations="">
    <header className={styles.head}>
      <div>
        <p className={styles.eyebrow}>{t('eyebrow')}</p>
        <h1>{t('title')}</h1>
        <p className={styles.lead}>{t('lead')}</p>
      </div>
      {!blocked && list.state === 'READY' && <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={props.onRefresh ?? noop}>{t('refresh')}</button>
        <button type="button" className={styles.primary} onClick={props.onNew ?? noop}>＋ {t('newAutomation')}</button>
      </div>}
    </header>
    {blocked ? <p className={styles.state}>{blocked}</p>
      : list.state === 'LOADING' ? <p className={styles.state} role="status">{t('loading')}</p>
      : list.state === 'DENIED' ? <p className={styles.state} role="alert">{t('denied')}</p>
      : list.state === 'UNAVAILABLE' ? <div className={styles.state} role="alert"><p>{t('unavailable')}</p><button type="button" className={styles.secondary} onClick={props.onRefresh ?? noop}>{t('refresh')}</button></div>
      : <>
        {notice && <p className={styles.flash} data-tone={notice.tone} role={notice.tone === 'ERROR' ? 'alert' : 'status'}>{notice.text}</p>}
        {workflows.length > 0 && <ul className={styles.stats}>
          <li data-tone="on"><span>{t('statOn')}</span><strong>{count('ACTIVE')}</strong></li>
          <li data-tone="paused"><span>{t('statPaused')}</span><strong>{count('PAUSED')}</strong></li>
          <li><span>{t('statDraft')}</span><strong>{count('DRAFT')}</strong></li>
        </ul>}
        {(picking || workflows.length === 0) && <Recipes t={t} empty={workflows.length === 0} onTemplate={props.onTemplate ?? noop} onCancel={workflows.length > 0 ? props.onCancel ?? noop : null}/>}
        {workflows.length > 0 && <section className={styles.table} aria-label={t('title')}>
          <div className={styles.tableHead} aria-hidden="true"><span>{t('colName')}</span><span>{t('colStatus')}</span><span>{t('colUpdated')}</span><span/></div>
          <ul>{workflows.map(w => <WorkflowRow key={w.workflowId} w={w} t={t} {...props}/>)}</ul>
        </section>}
        <p className={styles.rails}>{t('rails')}</p>
      </>}
  </main>;
}

function Recipes({ t, empty, onTemplate, onCancel }: { t: T; empty: boolean; onTemplate: (key: TemplateKey | null) => void; onCancel: (() => void) | null }) {
  return <section className={styles.starters} aria-labelledby="automation-recipes">
    <div className={styles.sectionHead}>
      <div>
        <h2 id="automation-recipes">{empty ? t('emptyTitle') : t('startersTitle')}</h2>
        <p className={styles.meta}>{empty ? t('emptyLine') : t('startersLine')}</p>
      </div>
      {onCancel && <button type="button" className={styles.ghost} onClick={onCancel}>{t('close')}</button>}
    </div>
    <ul className={styles.starterGrid}>
      <li><button type="button" className={styles.starter} data-template="BLANK" onClick={() => onTemplate(null)}>
        <span className={styles.starterIcon} aria-hidden="true">＋</span><strong>{t('startBlank')}</strong><span>{t('startBlankLine')}</span>
      </button></li>
      {TEMPLATE_KEYS.map(key => <li key={key}>
        <button type="button" className={styles.starter} data-template={key} onClick={() => onTemplate(key)}>
          <span className={styles.starterIcon} aria-hidden="true">{ICON[key]}</span>
          <strong>{t(`t${key}`)}</strong><span>{t(`t${key}Line`)}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}

function whenText(t: T, kind: string): string {
  return (WHEN_KINDS as readonly string[]).includes(kind) ? t(`w${kind as WhenKind}`) : t('wOther');
}
function pausedText(t: T, reason: string | null): string {
  return reason === 'STAFF_PAUSED' ? t('pausedSTAFF_PAUSED') : reason === 'AUTHORITY_LOST' ? t('pausedAUTHORITY_LOST') : reason === 'FAILURE_RATE' ? t('pausedFAILURE_RATE') : t('pausedOther');
}
const shortDate = (language: string, iso: string) => new Date(iso).toLocaleDateString(language === 'ko' ? 'ko-KR' : language === 'es' ? 'es' : 'en-US', { month: 'short', day: 'numeric' });

function WorkflowRow(props: AutomationsViewProps & { w: AutomationWorkflowSummary; t: T }) {
  const { w, t, busyId, activity, language } = props;
  const busy = busyId === w.workflowId, on = w.status === 'ACTIVE';
  const open = activity?.workflowId === w.workflowId;
  return <li className={styles.rowItem} data-status={w.status}>
    <div className={styles.rowMain}>
      <button type="button" className={styles.rowName} disabled={busy} onClick={() => (props.onEdit ?? noop)(w.workflowId)}>{w.name}</button>
      <span className={styles.meta}>⚡ {whenText(t, w.triggerKind)} · {w.stepCount === 1 ? t('step1') : t('steps', { n: String(w.stepCount) })}</span>
      {w.status === 'PAUSED' && <span className={styles.warn}>{pausedText(t, w.pausedReason)}</span>}
    </div>
    <div className={styles.rowStatus}>
      <button type="button" role="switch" aria-checked={on} className={styles.switch} disabled={busy} aria-label={`${w.name}: ${on ? t('pause') : t('turnOn')}`}
        onClick={() => (props.onToggle ?? noop)(w.workflowId)}><span aria-hidden="true"/></button>
      <span className={styles.chip} data-status={w.status}>{t(`status${w.status}`)}</span>
    </div>
    <span className={styles.rowDate}>{shortDate(language, w.updatedAt)}</span>
    <div className={styles.rowActions}>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => (props.onEdit ?? noop)(w.workflowId)}>{t('edit')}</button>
      {w.status !== 'DRAFT' && <button type="button" className={styles.ghost} aria-expanded={open} onClick={() => (props.onActivity ?? noop)(w.workflowId)}>{open ? t('hideActivity') : t('activity')}</button>}
    </div>
    {open && activity && <div className={styles.rowActivity}><Activity activity={activity} t={t} language={language}/></div>}
  </li>;
}

function Activity({ activity, t, language }: { activity: NonNullable<ActivityState>; t: T; language: string }) {
  if (activity.state === 'LOADING') return <p className={styles.meta} role="status">{t('activityLoading')}</p>;
  if (activity.state === 'ERROR') return <p className={styles.error} role="alert">{t('activityError')}</p>;
  const { runs, counts } = activity.runs;
  return <section className={styles.activity} aria-label={t('activityTitle')}>
    <h4>{t('activityTitle')}</h4>
    <p className={styles.activityCounts}>
      <span>{t('cRunning', { n: String(counts.running) })}</span><span>{t('cCompleted', { n: String(counts.completed) })}</span>
      <span>{t('cExited', { n: String(counts.exited) })}</span><span data-tone={counts.failed ? 'bad' : undefined}>{t('cFailed', { n: String(counts.failed) })}</span>
    </p>
    {runs.length === 0 ? <p className={styles.meta}>{t('activityEmpty')}</p>
      : <ul className={styles.runs}>{runs.slice(0, 15).map(r => <li key={r.runId}>
        <span>{r.contactFirstName ?? t('someone')}</span><span className={styles.runStatus} data-status={r.status}>{t(`run${r.status}`)}</span>
        <span className={styles.meta}>{t('startedOn', { date: shortDate(language, r.startedAt) })}</span>
      </li>)}</ul>}
  </section>;
}

function problemText(t: T, p: Problem): string {
  if (p === 'name') return t('pName'); if (p === 'days') return t('pDays'); if (p === 'tag') return t('pTag'); if (p === 'onlyTag') return t('pOnlyTag'); if (p === 'sends') return t('pSends');
  const m = /^send(\d+)\.(\w+)$/.exec(p);
  const n = String(Number(m?.[1] ?? 0) + 1), kind = m?.[2];
  return kind === 'subject' ? t('pSubject', { n }) : kind === 'delay' ? t('pDelay', { n }) : kind === 'video' ? t('pVideo', { n }) : t('pText', { n });
}
function problemNode(p: Problem): NodeKey | null {
  if (p === 'days' || p === 'tag') return 'trigger';
  if (p === 'onlyTag') return 'who';
  const m = /^send(\d+)\./.exec(p);
  return m ? `send${Number(m[1])}` : null;
}
function waitText(t: T, s: Send): string {
  return s.delayUnit === 'HOURS' ? t(s.delayAmount === 1 ? 'waitHour' : 'waitHours', { n: String(s.delayAmount) }) : t(s.delayAmount === 1 ? 'waitDay' : 'waitDays', { n: String(s.delayAmount) });
}
/** One line of the message for the flow box, with merge fields shown as plain names. */
function preview(t: T, s: Send): string {
  const text = (s.channel === 'EMAIL' && s.subject.trim() ? s.subject : s.text).replace(/\s+/g, ' ').trim()
    .replace(/\{\{(first_name|school_name|staff_name)\}\}/g, (_, f: typeof MERGE_FIELDS[number]) => `[${t(`field${f}`)}]`);
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}
function whoText(t: T, a: SimpleAutomation): string {
  const parts = [t(`group${a.group}`)];
  if (a.onlyTag.trim()) parts.push(t('whoTagged', { tag: a.onlyTag.trim() }));
  return parts.join(' · ');
}

function Builder(props: AutomationsViewProps & { editor: NonNullable<EditorState>; t: T }) {
  const { editor, t } = props;
  const onDraft = props.onDraft ?? noop, onSave = props.onSave ?? noop, onCancel = props.onCancel ?? noop;
  const [node, pickNode] = useState<NodeKey>(props.initialNode ?? 'trigger');
  const panel = useRef<HTMLElement | null>(null);
  // On a narrow screen the settings sit under the flow, so bring them into view when a box is picked.
  const setNode = (next: NodeKey) => { pickNode(next); if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 980px)').matches) setTimeout(() => panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); };
  const [adding, setAdding] = useState<number | null>(null);
  const active = editor.status === 'ACTIVE';
  const statusChip = editor.status ? <span className={styles.chip} data-status={editor.status}>{t(`status${editor.status}`)}</span> : <span className={styles.chip}>{t('statusNEW')}</span>;
  if (!editor.draft) {
    return <section className={styles.builder} aria-labelledby="automation-editor">
      <div className={styles.topbar}><button type="button" className={styles.ghost} onClick={onCancel}>← {t('back')}</button><h1 id="automation-editor" className={styles.topName}>{editor.name}</h1>{statusChip}</div>
      <p className={styles.notice}>{t('readOnly')}</p>
    </section>;
  }
  const a = editor.draft;
  const found = problems(a), shown = editor.showProblems ? found : [];
  const has = (p: Problem) => shown.includes(p);
  const flagged = new Set(shown.map(problemNode));
  const set = (patch: Partial<SimpleAutomation>) => onDraft({ ...a, ...patch });
  const setSend = (i: number, patch: Partial<Send>) => set({ sends: a.sends.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const insert = (at: number, c: Channel) => {
    const next = [...a.sends]; next.splice(at, 0, { ...blankSend(c), delayUnit: at === 0 ? 'NOW' : 'DAYS' });
    set({ sends: next }); setAdding(null); setNode(`send${at}`);
  };
  const move = (i: number, by: -1 | 1) => { const next = [...a.sends]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x!); set({ sends: next }); setNode(`send${i + by}`); };
  const remove = (i: number) => { set({ sends: a.sends.filter((_, j) => j !== i) }); setNode(i > 0 ? `send${i - 1}` : 'who'); };
  const selectedSend = node.startsWith('send') ? Number(node.slice(4)) : -1;
  const plus = (at: number) => <div className={styles.connector}>
    {a.sends.length < MAX_SENDS && <>
      <button type="button" className={styles.plus} aria-label={t('addStep')} aria-expanded={adding === at} onClick={() => setAdding(adding === at ? null : at)}>＋</button>
      {adding === at && <div className={styles.addMenu} role="menu" aria-label={t('addStep')}>
        {CHANNELS.map(c => <button key={c} type="button" role="menuitem" data-channel={c} onClick={() => insert(at, c)}><span aria-hidden="true">{CH_ICON[c]}</span>{t(`node${c}`)}</button>)}
      </div>}
    </>}
  </div>;
  return <form className={styles.builder} aria-labelledby="automation-editor" noValidate onSubmit={e => { e.preventDefault(); }}>
    <div className={styles.topbar}>
      <button type="button" className={styles.ghost} onClick={onCancel}>← {t('back')}</button>
      <label htmlFor="automation-name" className={styles.srOnly}>{t('nameLabel')}</label>
      <input id="automation-name" className={styles.topName} value={a.name} maxLength={100} placeholder={t('namePlaceholder')} aria-invalid={has('name') || undefined}
        disabled={editor.busy} onChange={e => set({ name: e.target.value })}/>
      {statusChip}
      <div className={styles.topActions}>
        {!active && <button type="button" className={styles.secondary} disabled={editor.busy} onClick={() => onSave(false)}>{editor.busy ? t('saving') : t('saveDraft')}</button>}
        <button type="button" className={styles.primary} disabled={editor.busy} onClick={() => onSave(true)}>{editor.busy ? t('saving') : active ? t('saveKeepOn') : t('saveOn')}</button>
      </div>
    </div>
    {shown.length > 0 && <div className={styles.problems} role="alert"><strong>{t('fixFirst', { n: String(shown.length) })}</strong>
      <ul>{shown.map(p => <li key={p}><button type="button" className={styles.linkish} onClick={() => { const k = problemNode(p); if (k) setNode(k); }}>{problemText(t, p)}</button></li>)}</ul></div>}
    <div className={styles.canvas}>
      <ol className={styles.flow} aria-label={t('flowLabel')}>
        <li><button type="button" className={styles.node} data-kind="trigger" aria-pressed={node === 'trigger'} data-problem={flagged.has('trigger') || undefined} onClick={() => setNode('trigger')}>
          <span className={styles.nodeIcon} aria-hidden="true">⚡</span>
          <span className={styles.nodeText}><small>{t('nodeTrigger')}</small><strong>{whenText(t, a.when)}{WHEN_DAYS[a.when] ? ` · ${t(`daysShort${a.when as 'ABSENT_DAYS' | 'BIRTHDAY' | 'MEMBERSHIP_ENDS_IN_DAYS'}`, { n: String(a.days) })}` : ''}{a.when === 'TAG_ADDED' && a.tag ? ` · ${a.tag}` : ''}</strong></span>
        </button></li>
        <li className={styles.line} aria-hidden="true"/>
        <li><button type="button" className={styles.node} data-kind="who" aria-pressed={node === 'who'} data-problem={flagged.has('who') || undefined} onClick={() => setNode('who')}>
          <span className={styles.nodeIcon} aria-hidden="true">👥</span>
          <span className={styles.nodeText}><small>{t('nodeWho')}</small><strong>{whoText(t, a)}</strong>
            {a.stopWhen.length > 0 && <span>{t('stopsWhen', { list: a.stopWhen.map(x => t(`stop${x}`).toLowerCase()).join(', ') })}</span>}</span>
        </button></li>
        {a.sends.map((s, i) => <React.Fragment key={i}>
          <li>{plus(i)}</li>
          {s.delayUnit !== 'NOW' && <><li><span className={styles.wait}>⏱ {waitText(t, s)}</span></li><li className={styles.line} aria-hidden="true"/></>}
          <li><button type="button" className={styles.node} data-kind="send" data-channel={s.channel} aria-pressed={selectedSend === i} data-problem={flagged.has(`send${i}`) || undefined} onClick={() => setNode(`send${i}`)}>
            <span className={styles.nodeIcon} aria-hidden="true">{CH_ICON[s.channel]}</span>
            <span className={styles.nodeText}><small>{t('stepTitle', { n: String(i + 1) })} · {t(`node${s.channel}`)}</small><strong>{preview(t, s) || t('emptyMessage')}</strong>
              {s.videoUrl.trim() && <span>🎬 {t('hasVideo')}</span>}</span>
          </button></li>
        </React.Fragment>)}
        <li>{plus(a.sends.length)}</li>
        <li><span className={styles.end}>{t('nodeEnd')}</span></li>
      </ol>
      <aside ref={panel} className={styles.panel} aria-label={t('panelLabel')}>
        {node === 'trigger' && <TriggerPanel a={a} t={t} has={has} set={set}/>}
        {node === 'who' && <WhoPanel a={a} t={t} has={has} set={set}/>}
        {selectedSend >= 0 && a.sends[selectedSend] && <SendPanel i={selectedSend} s={a.sends[selectedSend]!} count={a.sends.length} t={t} has={has} setSend={setSend} move={move} remove={remove}/>}
        <p className={styles.railsSmall}>{t('rails')}</p>
      </aside>
    </div>
  </form>;
}

function TriggerPanel({ a, t, has, set }: { a: SimpleAutomation; t: T; has: (p: Problem) => boolean; set: (p: Partial<SimpleAutomation>) => void }) {
  const range = WHEN_DAYS[a.when];
  return <section className={styles.panelBody}>
    <h2>⚡ {t('q1')}</h2>
    <div className={styles.whenGrid} role="radiogroup" aria-label={t('q1')}>
      {WHEN_KINDS.map(k => <button key={k} type="button" role="radio" aria-checked={a.when === k}
        onClick={() => set({ when: k, days: WHEN_DAYS[k]?.fallback ?? a.days })}>{t(`w${k}`)}</button>)}
    </div>
    {range && <div className={styles.field}>
      <label htmlFor="automation-days">{t(`days${a.when as 'ABSENT_DAYS' | 'BIRTHDAY' | 'MEMBERSHIP_ENDS_IN_DAYS'}`)}</label>
      <input id="automation-days" type="number" inputMode="numeric" min={range.min} max={range.max} step={1} value={Number.isFinite(a.days) ? a.days : ''} aria-invalid={has('days') || undefined}
        onChange={e => set({ days: e.target.value === '' ? NaN : Number(e.target.value) })}/>
    </div>}
    {a.when === 'TAG_ADDED' && <div className={styles.field}>
      <label htmlFor="automation-tag">{t('tagLabel')}</label>
      <input id="automation-tag" value={a.tag} maxLength={40} aria-invalid={has('tag') || undefined} onChange={e => set({ tag: e.target.value })}/>
      <small className={styles.meta}>{t('tagHint')}</small>
    </div>}
    {DATE_KINDS.includes(a.when) && <p className={styles.notice}>{t('dateNote')}</p>}
  </section>;
}

function WhoPanel({ a, t, has, set }: { a: SimpleAutomation; t: T; has: (p: Problem) => boolean; set: (p: Partial<SimpleAutomation>) => void }) {
  return <section className={styles.panelBody}>
    <h2>👥 {t('q2')}</h2>
    <div className={styles.segments} role="radiogroup" aria-label={t('q2')}>
      {GROUPS.map(g => <button key={g} type="button" role="radio" aria-checked={a.group === g} onClick={() => set({ group: g })}>
        <strong>{t(`group${g}`)}</strong><span>{t(`groupLine${g}`)}</span>
      </button>)}
    </div>
    <div className={styles.field}>
      <label htmlFor="automation-only-tag">{t('onlyTagLabel')}</label>
      <input id="automation-only-tag" value={a.onlyTag} maxLength={40} aria-invalid={has('onlyTag') || undefined} onChange={e => set({ onlyTag: e.target.value })}/>
    </div>
    <fieldset className={styles.checks}>
      <legend>{t('stopLabel')}</legend>
      {STOPS.map(x => <label key={x} className={styles.check}>
        <input type="checkbox" checked={a.stopWhen.includes(x)} onChange={e => set({ stopWhen: e.target.checked ? [...a.stopWhen, x] : a.stopWhen.filter(y => y !== x) })}/>{t(`stop${x}`)}
      </label>)}
    </fieldset>
    <fieldset className={styles.checks}>
      <legend>{t('repeatLabel')}</legend>
      <label className={styles.check}><input type="radio" name="automation-repeat" checked={!a.repeat} onChange={() => set({ repeat: false })}/>{t('repeatNo')}</label>
      <label className={styles.check}><input type="radio" name="automation-repeat" checked={a.repeat} onChange={() => set({ repeat: true })}/>{t('repeatYes')}</label>
    </fieldset>
  </section>;
}

function SendPanel({ i, s, count, t, has, setSend, move, remove }: {
  i: number; s: Send; count: number; t: T; has: (p: Problem) => boolean; setSend: (i: number, patch: Partial<Send>) => void; move: (i: number, by: -1 | 1) => void; remove: (i: number) => void;
}) {
  const textId = `send-${i}-text`, message = s.channel === 'TEXT' || s.channel === 'EMAIL';
  const max = s.channel === 'TEXT' ? 1000 : s.channel === 'EMAIL' ? 4000 : s.channel === 'TASK' ? 120 : 500;
  const insert = (field: string) => setSend(i, { text: `${s.text}${s.text && !/\s$/.test(s.text) ? ' ' : ''}{{${field}}}` });
  return <section className={styles.panelBody}>
    <div className={styles.panelHead}>
      <h2>{CH_ICON[s.channel]} {t('stepTitle', { n: String(i + 1) })}</h2>
      <div className={styles.sendTools}>
        <button type="button" className={styles.ghost} disabled={i === 0} aria-label={t('moveUp')} onClick={() => move(i, -1)}>↑</button>
        <button type="button" className={styles.ghost} disabled={i === count - 1} aria-label={t('moveDown')} onClick={() => move(i, 1)}>↓</button>
        <button type="button" className={styles.ghost} disabled={count === 1} onClick={() => remove(i)}>{t('remove')}</button>
      </div>
    </div>
    <div className={styles.channelPick} role="radiogroup" aria-label={t('channelLabel')}>
      {CHANNELS.map(c => <button key={c} type="button" role="radio" aria-checked={s.channel === c} onClick={() => setSend(i, { channel: c })}>{CH_ICON[c]} {t(`ch${c}`)}</button>)}
    </div>
    {(s.channel === 'TASK' || s.channel === 'NOTIFY') && <p className={styles.meta}>{t(s.channel === 'TASK' ? 'chLineTASK' : 'chLineNOTIFY')}</p>}
    <div className={styles.row}>
      <div className={styles.field}>
        <label htmlFor={`send-${i}-when`}>{t('whenLabel')}</label>
        <select id={`send-${i}-when`} value={s.delayUnit} onChange={e => setSend(i, { delayUnit: e.target.value as DelayUnit })}>
          <option value="NOW">{i === 0 ? t('whenFirstNOW') : t('whenNOW')}</option><option value="HOURS">{t('whenHOURS')}</option><option value="DAYS">{t('whenDAYS')}</option>
        </select>
      </div>
      {s.delayUnit !== 'NOW' && <div className={styles.field} data-small="">
        <label htmlFor={`send-${i}-amount`}>{t('amountLabel')}</label>
        <input id={`send-${i}-amount`} type="number" inputMode="numeric" min={1} step={1} value={Number.isFinite(s.delayAmount) ? s.delayAmount : ''} aria-invalid={has(`send${i}.delay`) || undefined}
          onChange={e => setSend(i, { delayAmount: e.target.value === '' ? NaN : Number(e.target.value) })}/>
      </div>}
    </div>
    {s.channel === 'EMAIL' && <div className={styles.field}>
      <label htmlFor={`send-${i}-subject`}>{t('subjectLabel')}</label>
      <input id={`send-${i}-subject`} value={s.subject} maxLength={150} aria-invalid={has(`send${i}.subject`) || undefined} onChange={e => setSend(i, { subject: e.target.value })}/>
    </div>}
    <div className={styles.field}>
      <label htmlFor={textId}>{t(`textLabel${s.channel}`)}</label>
      {s.channel === 'TASK'
        ? <input id={textId} value={s.text} maxLength={max} aria-invalid={has(`send${i}.text`) || undefined} onChange={e => setSend(i, { text: e.target.value })}/>
        : <textarea id={textId} value={s.text} rows={s.channel === 'EMAIL' ? 8 : 4} aria-invalid={has(`send${i}.text`) || undefined} onChange={e => setSend(i, { text: e.target.value })}/>}
      <div className={styles.fieldFoot}>
        <span className={styles.chips}><span className={styles.meta}>{t('insert')}</span>
          {MERGE_FIELDS.map(f => <button key={f} type="button" className={styles.chipButton} onClick={() => insert(f)}>{t(`field${f}`)}</button>)}
        </span>
        <span className={styles.meta}>{t('chars', { n: String([...s.text].length), max: String(max) })}</span>
      </div>
    </div>
    {message && <div className={styles.field}>
      <label htmlFor={`send-${i}-video`}>🎬 {t('videoLabel')}</label>
      <input id={`send-${i}-video`} type="url" inputMode="url" placeholder="https://" value={s.videoUrl} aria-invalid={has(`send${i}.video`) || undefined} onChange={e => setSend(i, { videoUrl: e.target.value })}/>
      <small className={styles.meta}>{t('videoHint')}</small>
    </div>}
  </section>;
}
